//! Validation of a rule against the catalogue, applied on every write.
//!
//! Everything expensive or refusable happens **here**, once, in front of the
//! person who can fix it - never on the hot path in front of the instance that
//! would pay for it. By the time a rule reaches [`super::engine`] it is known
//! to compare declared fields with permitted operators, to name actions that
//! exist, and to fit inside the depth and breadth ceilings.

use serde::Deserialize;
use serde_json::Value;
use kubuno_db::DbPool;
use uuid::Uuid;

use crate::errors::AppError;

use super::catalog::{self, ParamDef};
use super::condition::{self, Condition};
use super::detect;
use super::model::{ActionSpec, Mode, ScopeRef, Scope};
use super::store::{self, RuleDraft};

/// Most actions one rule may run. A rule is a reaction, not a script.
pub const MAX_ACTIONS: usize = 8;
/// Most detector leaves one rule may hold.
///
/// Well below the leaf ceiling, and deliberately so: each one is a scan of every
/// content part on a request a module is waiting on. Eight comparisons cost
/// nothing; eight scans are a budget.
pub const MAX_DETECTOR_LEAVES: usize = 8;
/// Most entries a scope may name, include and exclude combined.
pub const MAX_SCOPE_REFS: usize = 64;
const MAX_NAME_LEN: usize = 200;
const MAX_DESCRIPTION_LEN: usize = 2_000;

/// A rule as the API receives it.
#[derive(Debug, Clone, Deserialize)]
pub struct RuleInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub trigger: String,
    #[serde(default)]
    pub conditions: Condition,
    #[serde(default)]
    pub actions: Vec<ActionSpec>,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub scope: Scope,
    #[serde(default)]
    pub threshold_count: Option<i32>,
    #[serde(default)]
    pub threshold_window_s: Option<i32>,
    #[serde(default)]
    pub rollout_percent: Option<i16>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub priority: Option<i32>,
    /// Free-text note recorded on the version this write creates.
    #[serde(default)]
    pub change_note: Option<String>,
}

fn default_mode() -> String {
    // A rule that does not say otherwise is born doing nothing. The one default
    // that must never be "enabled".
    Mode::Inactive.as_str().to_string()
}

/// Turns a submitted rule into one that is safe to store and to run.
pub async fn prepare(db: &DbPool, input: &RuleInput) -> Result<RuleDraft, AppError> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
        return Err(AppError::Validation(format!(
            "Le nom de la règle doit faire 1 à {MAX_NAME_LEN} caractères"
        )));
    }
    if let Some(d) = input.description.as_deref() {
        if d.chars().count() > MAX_DESCRIPTION_LEN {
            return Err(AppError::Validation(format!(
                "La description dépasse {MAX_DESCRIPTION_LEN} caractères"
            )));
        }
    }

    let mode = Mode::parse_settable(input.mode.trim())?;

    let severity = input
        .severity
        .as_deref()
        .map(str::trim)
        .unwrap_or("warning")
        .to_string();
    if crate::alerts::Severity::parse(&severity).is_none() {
        return Err(AppError::Validation(format!(
            "Gravité inconnue « {severity} » : attendues critical, warning ou info"
        )));
    }

    // ── Trigger ──────────────────────────────────────────────────────────────
    let trigger_key = input.trigger.trim();
    let trigger = catalog::get_trigger(db, trigger_key)
        .await?
        .ok_or_else(|| {
            AppError::Validation(format!(
                "Déclencheur « {trigger_key} » inconnu du catalogue"
            ))
        })?;
    if trigger.is_orphan {
        // Writing a rule on a trigger whose module is gone would produce a rule
        // that can never fire, and would look enabled while doing so.
        return Err(AppError::Validation(format!(
            "Le déclencheur « {trigger_key} » appartient à un module absent : la règle ne pourrait jamais s'exécuter"
        )));
    }

    // ── Conditions ───────────────────────────────────────────────────────────
    let max_depth = store::setting_u64(db, "rules.max_condition_depth", 5, 1, 12).await as usize;
    let max_leaves = store::setting_u64(db, "rules.max_condition_leaves", 32, 1, 256).await as usize;
    condition::validate(&input.conditions, max_depth, max_leaves)?;

    let fields = catalog::parse_fields(&trigger.fields);
    for (field, op) in input.conditions.comparisons() {
        let Some(declared) = fields.iter().find(|f| f.name == field) else {
            return Err(AppError::Validation(format!(
                "Le déclencheur « {trigger_key} » n'expose pas le champ « {field} »"
            )));
        };
        if !declared.operators.contains(&op) {
            return Err(AppError::Validation(format!(
                "L'opérateur « {} » n'est pas permis sur le champ « {field} » ({})",
                op.as_str(),
                declared.value_type
            )));
        }
    }

    // ── Detector leaves ──────────────────────────────────────────────────────
    check_detectors(db, trigger_key, &fields, &input.conditions).await?;

    // ── Actions ──────────────────────────────────────────────────────────────
    if input.actions.len() > MAX_ACTIONS {
        return Err(AppError::Validation(format!(
            "Une règle exécute au plus {MAX_ACTIONS} actions"
        )));
    }
    if mode.acts() && input.actions.is_empty() {
        return Err(AppError::Validation(
            "Le mode « actif avec actions » exige au moins une action".into(),
        ));
    }
    for spec in &input.actions {
        let key = spec.action.trim();
        let row = catalog::list_actions(db)
            .await?
            .into_iter()
            .find(|a| a.key == key)
            .ok_or_else(|| {
                AppError::Validation(format!("Action « {key} » inconnue du catalogue"))
            })?;
        if row.is_orphan {
            return Err(AppError::Validation(format!(
                "L'action « {key} » appartient à un module absent"
            )));
        }
        let params: Vec<ParamDef> =
            serde_json::from_value(row.params_schema.clone()).unwrap_or_default();
        check_params(key, &params, &spec.params)?;
    }

    // ── Scope ────────────────────────────────────────────────────────────────
    let refs: Vec<&ScopeRef> = input.scope.referenced().collect();
    if refs.len() > MAX_SCOPE_REFS {
        return Err(AppError::Validation(format!(
            "Une portée nomme au plus {MAX_SCOPE_REFS} entrées"
        )));
    }
    for r in refs {
        if let ScopeRef::OrgUnit { id, .. } = r {
            if !catalog::org_unit_exists(db, *id).await? {
                return Err(AppError::Validation(format!(
                    "L'unité organisationnelle {id} n'existe pas"
                )));
            }
        }
    }

    // ── Threshold ────────────────────────────────────────────────────────────
    let (threshold_count, threshold_window_s) =
        match (input.threshold_count, input.threshold_window_s) {
            (None, None) => (None, None),
            (Some(c), Some(w)) => {
                if c < 2 {
                    return Err(AppError::Validation(
                        "Un seuil compte au moins 2 occurrences ; sans seuil, la règle réagit dès la première".into(),
                    ));
                }
                if !(10..=604_800).contains(&w) {
                    return Err(AppError::Validation(
                        "La fenêtre d'un seuil va de 10 secondes à 7 jours".into(),
                    ));
                }
                (Some(c), Some(w))
            }
            _ => {
                return Err(AppError::Validation(
                    "Un seuil exige un nombre d'occurrences ET une fenêtre".into(),
                ))
            }
        };

    // ── Rollout ──────────────────────────────────────────────────────────────
    let rollout_percent = input.rollout_percent.unwrap_or(100);
    if !(0..=100).contains(&rollout_percent) {
        return Err(AppError::Validation(
            "Le pourcentage de déploiement va de 0 à 100".into(),
        ));
    }

    Ok(RuleDraft {
        name: name.to_string(),
        description: input
            .description
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        trigger_key: trigger.key,
        conditions: input.conditions.clone(),
        actions: input
            .actions
            .iter()
            .map(|s| ActionSpec {
                action: s.action.trim().to_string(),
                params: s.params.clone(),
            })
            .collect(),
        mode,
        scope: input.scope.clone(),
        threshold_count,
        threshold_window_s,
        rollout_percent,
        severity,
        priority: input.priority.unwrap_or(100).clamp(0, 10_000),
    })
}

/// Everything a `detector` leaf must satisfy, checked once at write time.
///
/// Four separate refusals, and each of them replaces a rule that would have
/// looked armed while doing nothing:
///
/// * a trigger with no content part cannot carry one - there is nothing to
///   inspect, so the rule could never fire;
/// * a part the trigger does not declare is a typo, and a typo in a part name
///   is a detector leaf that silently reads no text at all;
/// * an unknown detector is a rule pointing at a catalogue entry that is not
///   there;
/// * a disabled detector is refused too, because "saved and armed but inert"
///   is precisely the state an operator must never be able to reach by
///   accident.
async fn check_detectors(
    db: &DbPool,
    trigger_key: &str,
    fields: &[catalog::FieldDef],
    conditions: &Condition,
) -> Result<(), AppError> {
    let leaves = conditions.detectors();
    if leaves.is_empty() {
        return Ok(());
    }

    let parts = catalog::content_parts(fields);
    if parts.is_empty() {
        return Err(AppError::Validation(format!(
            "Le déclencheur « {trigger_key} » ne transmet aucune partie de contenu : une condition de détection n'y trouverait rien à inspecter"
        )));
    }

    if leaves.len() > MAX_DETECTOR_LEAVES {
        return Err(AppError::Validation(format!(
            "Une règle utilise au plus {MAX_DETECTOR_LEAVES} conditions de détection"
        )));
    }

    let catalogue = detect::store::list(db).await?;
    for leaf in leaves {
        let key = leaf.detector.trim();
        let Some(detector) = catalogue.iter().find(|d| d.key == key) else {
            return Err(AppError::Validation(format!(
                "Détecteur « {key} » inconnu du catalogue"
            )));
        };
        if !detector.is_enabled {
            return Err(AppError::Validation(format!(
                "Le détecteur « {} » est désactivé : la règle serait enregistrée sans jamais rien détecter",
                detector.label
            )));
        }
        if !(0.0..=1.0).contains(&leaf.min_confidence) {
            return Err(AppError::Validation(
                "Le seuil de confiance va de 0 à 1".into(),
            ));
        }
        if !(1..=10_000).contains(&leaf.min_matches) {
            return Err(AppError::Validation(
                "Le nombre minimal de correspondances va de 1 à 10 000".into(),
            ));
        }
        if !(1..=10_000).contains(&leaf.min_unique_matches) {
            return Err(AppError::Validation(
                "Le nombre minimal de correspondances uniques va de 1 à 10 000".into(),
            ));
        }
        if leaf.min_unique_matches > leaf.min_matches {
            // Not merely odd: unreachable. Distinct values are a subset of
            // occurrences, so the rule could never fire - and would sit in the
            // console looking armed.
            return Err(AppError::Validation(format!(
                "Le détecteur « {} » exige {} valeurs distinctes pour {} correspondances : ce seuil ne peut jamais être atteint",
                detector.label, leaf.min_unique_matches, leaf.min_matches
            )));
        }
        for part in &leaf.parts {
            if !parts.contains(&part.as_str()) {
                return Err(AppError::Validation(format!(
                    "Le déclencheur « {trigger_key} » ne transmet pas la partie de contenu « {part} »"
                )));
            }
        }
    }
    Ok(())
}

/// Every required parameter present, nothing outside the declared domain.
fn check_params(action: &str, schema: &[ParamDef], supplied: &Value) -> Result<(), AppError> {
    let empty = serde_json::Map::new();
    let given = supplied.as_object().unwrap_or(&empty);

    for p in schema {
        let value = given.get(&p.name);
        if p.required && value.map(Value::is_null).unwrap_or(true) {
            return Err(AppError::Validation(format!(
                "L'action « {action} » exige le paramètre « {} »",
                p.name
            )));
        }
        if let (Some(v), Some(domain)) = (value, p.values.as_ref()) {
            if !v.is_null() && !domain.contains(v) {
                return Err(AppError::Validation(format!(
                    "Valeur hors domaine pour « {}.{} »",
                    action, p.name
                )));
            }
        }
    }

    // An unknown parameter is refused rather than ignored: silently dropping it
    // means the rule does not do what its author read back on the screen.
    for key in given.keys() {
        if !schema.iter().any(|p| &p.name == key) {
            return Err(AppError::Validation(format!(
                "Paramètre « {key} » inconnu pour l'action « {action} »"
            )));
        }
    }
    Ok(())
}

/// Ids named by a scope, for the console to resolve into labels.
pub fn scope_user_ids(scope: &Scope) -> Vec<Uuid> {
    scope
        .referenced()
        .filter_map(|r| match r {
            ScopeRef::User { id } => Some(*id),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Vec<ParamDef> {
        vec![
            ParamDef {
                name: "title".into(),
                value_type: "string".into(),
                label: "Titre".into(),
                required: true,
                values: None,
            },
            ParamDef {
                name: "severity".into(),
                value_type: "enum".into(),
                label: "Gravité".into(),
                required: false,
                values: Some(vec![json!("warning"), json!("info")]),
            },
        ]
    }

    #[test]
    fn a_missing_required_parameter_is_refused() {
        assert!(check_params("core.raise_alert", &schema(), &json!({})).is_err());
        assert!(check_params("core.raise_alert", &schema(), &json!({ "title": null })).is_err());
        assert!(check_params("core.raise_alert", &schema(), &json!({ "title": "x" })).is_ok());
    }

    #[test]
    fn a_value_outside_the_declared_domain_is_refused() {
        let ok = json!({ "title": "x", "severity": "info" });
        assert!(check_params("core.raise_alert", &schema(), &ok).is_ok());
        let bad = json!({ "title": "x", "severity": "catastrophic" });
        assert!(check_params("core.raise_alert", &schema(), &bad).is_err());
    }

    #[test]
    fn an_unknown_parameter_is_refused_rather_than_ignored() {
        // Ignoring it means the rule does not do what its author read back.
        let bad = json!({ "title": "x", "sevrity": "info" });
        assert!(check_params("core.raise_alert", &schema(), &bad).is_err());
    }

    #[test]
    fn a_rule_that_says_nothing_about_its_mode_is_born_inactive() {
        let parsed: RuleInput = serde_json::from_str(
            r#"{"name":"essai","trigger":"core.account_created"}"#,
        )
        .expect("forme valide");
        assert_eq!(parsed.mode, "inactive");
        assert!(parsed.actions.is_empty());
        // …and with a condition tree that matches everything, stated rather
        // than implied.
        assert_eq!(parsed.conditions.leaves(), 0);
    }
}
