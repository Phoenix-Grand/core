//! The catalogue: what a rule may react to, and what it may do.
//!
//! ## A module can only write under its own name
//!
//! A module declares a trigger or an action by its **bare name** -
//! `document_shared`, not `office.document_shared` - and the core prefixes it
//! with the module identifier at registration. Identical to `settings_schema`
//! and to [`crate::authz::catalog`], and for the same reason: a namespace a
//! module can choose is a namespace it can *claim*, and the first thing a
//! careless module would claim is `core`.
//!
//! ## The core is not a special case
//!
//! [`register_core`] pushes the core's own triggers and actions through
//! [`upsert`], into the same two tables, with the same validation and the same
//! forced prefixing. There is no core-only column, no core-only branch in the
//! engine, and no module identifier written anywhere in `crate::rules` except
//! the constant `"core"` used for the core's own declarations. Installing a
//! module therefore requires **zero lines** here.
//!
//! ## What happens to a departed module's entries
//!
//! A trigger a rule still references cannot be deleted (`ON DELETE RESTRICT`),
//! and must not be: deleting it would either cascade into the rule - silently
//! changing what the instance does - or leave the rule pointing at nothing.
//! Entries that disappeared from a re-registration are therefore **deleted when
//! nothing references them and flagged `is_orphan` when something does**, which
//! is the same answer [`crate::authz::catalog`] gives for privileges.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use kubuno_db::dialect::{Assign, SqlType};
use kubuno_db::{params, Backend, DbPool, DbQueryBuilder, DbTx};

use crate::errors::AppError;

use super::condition::Operator;

/// The namespace the core declares under. A module may never take it.
pub const CORE_NAMESPACE: &str = "core";

/// Field type marking a **content part**: a piece of text the caller of the
/// synchronous gate submits for inspection, rather than a fact a rule compares.
///
/// The distinction is enforced by consequence rather than by decree. A content
/// field declares no operator, so `super::validate` refuses any comparison
/// against it; and content never enters [`super::facts::Facts`], so there is
/// nothing to compare even if one slipped through. What a rule may say about a
/// content part is therefore exactly one thing: a detector leaf.
///
/// Declaring it in the same `fields` array as everything else is what keeps the
/// console catalogue-driven: an editor that already renders a trigger's fields
/// learns which parts exist without the core growing a second manifest.
pub const CONTENT_TYPE: &str = "content";

/// Longest bare name a declaration may carry.
const MAX_NAME_LEN: usize = 60;

// ── Declarations ─────────────────────────────────────────────────────────────

/// One queryable field of a trigger, with the operators it accepts.
///
/// The operator list is what makes "no expression language" hold all the way
/// down: a rule may not merely use a known operator, it must use one this field
/// declares. Comparing a timestamp with `starts_with` is refused at write time
/// rather than silently answering `false` forever.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FieldDef {
    /// Dotted path into the fact, e.g. `subject.email`.
    pub name: String,
    /// `string` | `number` | `bool` | `uuid` | `timestamp`. Descriptive: the
    /// evaluator is duck-typed, this drives the editor and the validation.
    #[serde(rename = "type")]
    pub value_type: String,
    pub label: String,
    #[serde(default)]
    pub operators: Vec<Operator>,
}

/// A trigger as declared in a registration payload. `key` is **relative**.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TriggerDef {
    pub key: String,
    /// Event type on the bus. For a module this is the `event_type` of the
    /// `Custom` events it publishes.
    pub event_type: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub fields: Vec<FieldDef>,
}

/// An action as declared in a registration payload. `key` is **relative**.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ActionDef {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Internal route on the declaring module, POSTed by the dispatcher against
    /// its registered base URL. Mandatory for a module; `None` for the core's
    /// own in-process actions.
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub params: Vec<ParamDef>,
    /// Does the rest of the rule's action list wait for this one?
    #[serde(default)]
    pub blocking: bool,
    /// Can an operator walk the effect back?
    #[serde(default)]
    pub reversible: bool,
}

/// One parameter of an action.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ParamDef {
    pub name: String,
    /// `string` | `number` | `bool` | `enum`.
    #[serde(rename = "type")]
    pub value_type: String,
    pub label: String,
    #[serde(default)]
    pub required: bool,
    /// Domain for `type = "enum"`.
    #[serde(default)]
    pub values: Option<Vec<Value>>,
}

// ── Rows, as the API serves them ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct TriggerRow {
    pub key: String,
    pub module_id: String,
    pub event_type: String,
    pub label: String,
    pub description: Option<String>,
    pub fields: Value,
    pub is_orphan: bool,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ActionRow {
    pub key: String,
    pub module_id: String,
    pub label: String,
    pub description: Option<String>,
    pub params_schema: Value,
    pub is_blocking: bool,
    pub is_reversible: bool,
    pub is_orphan: bool,
}

// ── Qualification ────────────────────────────────────────────────────────────

/// Builds the full key, refusing anything that tries to escape the namespace.
fn qualify(namespace: &str, bare: &str) -> Result<String, AppError> {
    let bare = bare.trim();
    if bare.is_empty() || bare.len() > MAX_NAME_LEN {
        return Err(AppError::Validation(format!(
            "Invalid name '{bare}': expected 1 to {MAX_NAME_LEN} characters"
        )));
    }
    // A bare name carrying its own prefix is a module choosing its namespace.
    if bare.contains('.') {
        return Err(AppError::Validation(format!(
            "Invalid name '{bare}': a module declares a simple name; the core adds the prefix"
        )));
    }
    if !bare
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(AppError::Validation(format!(
            "Invalid name '{bare}': only lowercase letters, numbers, and underscores are allowed"
        )));
    }
    Ok(format!("{namespace}.{bare}"))
}

/// Guard on the module-facing entry point.
fn refuse_core_namespace(module_id: &str) -> Result<(), AppError> {
    if module_id == CORE_NAMESPACE {
        return Err(AppError::Validation(
            "The 'core' namespace is reserved for the core".into(),
        ));
    }
    Ok(())
}

// ── Registration ─────────────────────────────────────────────────────────────

/// Upserts a **module's** declared triggers and actions.
///
/// Runs inside the registration transaction, next to `settings_schema` and the
/// privilege catalogue. A malformed declaration is skipped with a loud log
/// rather than failing the whole registration: a typo in one trigger must not
/// keep a module offline.
pub async fn register_module(
    tx: &mut DbTx,
    module_id: &str,
    triggers: &[TriggerDef],
    actions: &[ActionDef],
) -> Result<(), AppError> {
    refuse_core_namespace(module_id)?;
    upsert(tx, module_id, triggers, actions, true).await
}

/// Upserts the **core's** own declarations. Same table, same validation, same
/// forced prefixing - see the module header for why that matters.
pub async fn register_core(
    tx: &mut DbTx,
    triggers: &[TriggerDef],
    actions: &[ActionDef],
) -> Result<(), AppError> {
    upsert(tx, CORE_NAMESPACE, triggers, actions, false).await
}

/// The one implementation both entry points share.
///
/// `endpoint_required` is the only thing that differs, and it is a property of
/// the transport rather than of the declarer: a separate process must say where
/// to reach it, the core need not.
async fn upsert(
    tx: &mut DbTx,
    namespace: &str,
    triggers: &[TriggerDef],
    actions: &[ActionDef],
    endpoint_required: bool,
) -> Result<(), AppError> {
    let backend = tx.backend();
    let mut trigger_keys: Vec<String> = Vec::with_capacity(triggers.len());
    for def in triggers {
        let full = match qualify(namespace, &def.key) {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(module_id = %namespace, key = %def.key, error = %e,
                    "Déclencheur ignoré : déclaration invalide");
                continue;
            }
        };
        if def.event_type.trim().is_empty() || def.event_type.len() > 160 {
            tracing::warn!(module_id = %namespace, key = %full,
                "Déclencheur ignoré : type d'événement absent ou trop long");
            continue;
        }
        let fields = serde_json::to_value(&def.fields).unwrap_or_else(|_| Value::Array(vec![]));

        let clause = backend.upsert(
            "core.rule_triggers",
            &["key"],
            &[
                Assign::Incoming("event_type"),
                Assign::Incoming("label"),
                Assign::Incoming("description"),
                Assign::Incoming("fields"),
                Assign::Incoming("is_orphan"),
            ],
        );
        let sql = format!(
            "INSERT INTO core.rule_triggers \
                 (\"key\", module_id, event_type, label, description, fields, is_orphan) \
             VALUES ($1, $2, $3, $4, $5, $6, FALSE){clause}"
        );
        tx.execute(
            &sql,
            params![
                &full,
                namespace,
                def.event_type.trim(),
                &def.label,
                def.description.as_deref(),
                fields
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, key = %full, "rules: enregistrement d'un déclencheur");
            AppError::Database(e)
        })?;
        trigger_keys.push(full);
    }

    let mut action_keys: Vec<String> = Vec::with_capacity(actions.len());
    for def in actions {
        let full = match qualify(namespace, &def.key) {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(module_id = %namespace, key = %def.key, error = %e,
                    "Action ignorée : déclaration invalide");
                continue;
            }
        };
        let endpoint = def.endpoint.as_deref().map(str::trim).filter(|s| !s.is_empty());
        if endpoint_required && endpoint.is_none() {
            tracing::warn!(module_id = %namespace, key = %full,
                "Action ignorée : un module doit déclarer l'endpoint interne qui l'exécute");
            continue;
        }
        if let Some(ep) = endpoint {
            if !ep.starts_with('/') || ep.len() > 500 {
                tracing::warn!(module_id = %namespace, key = %full, endpoint = %ep,
                    "Action ignorée : endpoint interne invalide (chemin absolu attendu)");
                continue;
            }
        }
        let params_schema =
            serde_json::to_value(&def.params).unwrap_or_else(|_| Value::Array(vec![]));

        let clause = backend.upsert(
            "core.rule_actions",
            &["key"],
            &[
                Assign::Incoming("label"),
                Assign::Incoming("description"),
                Assign::Incoming("endpoint"),
                Assign::Incoming("params_schema"),
                Assign::Incoming("is_blocking"),
                Assign::Incoming("is_reversible"),
                Assign::Incoming("is_orphan"),
            ],
        );
        let sql = format!(
            "INSERT INTO core.rule_actions \
                 (\"key\", module_id, label, description, endpoint, params_schema, \
                  is_blocking, is_reversible, is_orphan) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE){clause}"
        );
        tx.execute(
            &sql,
            params![
                &full,
                namespace,
                &def.label,
                def.description.as_deref(),
                endpoint,
                params_schema,
                def.blocking,
                def.reversible
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, key = %full, "rules: enregistrement d'une action");
            AppError::Database(e)
        })?;
        action_keys.push(full);
    }

    purge_vanished(tx, namespace, &trigger_keys, &action_keys).await
}

/// Removes entries this namespace no longer declares - and only those a rule
/// does not depend on. The rest survive, flagged, so an existing rule keeps
/// meaning something and the console can grey it out.
async fn purge_vanished(
    tx: &mut DbTx,
    namespace: &str,
    trigger_keys: &[String],
    action_keys: &[String],
) -> Result<(), AppError> {
    let backend = tx.backend();

    // `NOT (key = ANY($keys))` becomes a `NOT (key IN (...))` built variadically.
    // An empty declared set means "keep nothing", so the membership clause is
    // omitted entirely rather than emitted as `IN (NULL)` (which matches no row
    // and would wrongly spare everything).
    let mut qb = DbQueryBuilder::new(
        backend,
        "DELETE FROM core.rule_triggers WHERE module_id = ",
    );
    qb.push_bind(namespace);
    if !trigger_keys.is_empty() {
        qb.push(" AND NOT (\"key\"")
            .push_in(trigger_keys.iter().map(String::as_str))
            .push(")");
    }
    // No alias on the DELETE target: SQLite refuses one. The subquery names the
    // outer table instead, which every engine resolves.
    qb.push(" AND NOT EXISTS (SELECT 1 FROM core.rules r WHERE r.trigger_key = rule_triggers.\"key\")");
    qb.tx_execute(tx).await.map_err(|e| {
        tracing::error!(error = %e, module_id = %namespace, "rules: purge des déclencheurs disparus");
        AppError::Database(e)
    })?;

    let mut qb = DbQueryBuilder::new(
        backend,
        "UPDATE core.rule_triggers SET is_orphan = TRUE WHERE module_id = ",
    );
    qb.push_bind(namespace);
    if !trigger_keys.is_empty() {
        qb.push(" AND NOT (\"key\"")
            .push_in(trigger_keys.iter().map(String::as_str))
            .push(")");
    }
    qb.push(" AND is_orphan = FALSE");
    qb.tx_execute(tx).await.map_err(|e| {
        tracing::error!(error = %e, module_id = %namespace, "rules: marquage des déclencheurs orphelins");
        AppError::Database(e)
    })?;

    // An action is referenced from a JSON array rather than by a foreign key,
    // so the dependency test is a containment check on `core.rules.actions`
    // (an array of `{"action": "<key>", …}` objects), written per engine: there
    // is no portable spelling of "an element of this JSON array has this field".
    let mut qb = DbQueryBuilder::new(
        backend,
        "DELETE FROM core.rule_actions WHERE module_id = ",
    );
    qb.push_bind(namespace);
    if !action_keys.is_empty() {
        qb.push(" AND NOT (\"key\"")
            .push_in(action_keys.iter().map(String::as_str))
            .push(")");
    }
    qb.push(action_in_use_clause(backend));
    qb.tx_execute(tx).await.map_err(|e| {
        tracing::error!(error = %e, module_id = %namespace, "rules: purge des actions disparues");
        AppError::Database(e)
    })?;

    let mut qb = DbQueryBuilder::new(
        backend,
        "UPDATE core.rule_actions SET is_orphan = TRUE WHERE module_id = ",
    );
    qb.push_bind(namespace);
    if !action_keys.is_empty() {
        qb.push(" AND NOT (\"key\"")
            .push_in(action_keys.iter().map(String::as_str))
            .push(")");
    }
    qb.push(" AND is_orphan = FALSE");
    qb.tx_execute(tx).await.map_err(|e| {
        tracing::error!(error = %e, module_id = %namespace, "rules: marquage des actions orphelines");
        AppError::Database(e)
    })?;

    Ok(())
}

/// ` AND NOT EXISTS (<a rule whose actions name rule_actions."key">)`, per engine.
fn action_in_use_clause(backend: Backend) -> &'static str {
    match backend {
        Backend::Postgres => {
            " AND NOT EXISTS (\
                SELECT 1 FROM core.rules r, \
                     LATERAL jsonb_array_elements(r.actions) AS spec \
                 WHERE spec->>'action' = rule_actions.\"key\")"
        }
        // An array contains a candidate object when one of its elements does.
        Backend::MySql => {
            " AND NOT EXISTS (\
                SELECT 1 FROM core.rules r \
                 WHERE JSON_CONTAINS(r.actions, JSON_OBJECT('action', rule_actions.\"key\")))"
        }
        Backend::Sqlite => {
            " AND NOT EXISTS (\
                SELECT 1 FROM core.rules r, json_each(r.actions) AS spec \
                 WHERE json_extract(spec.value, '$.action') = rule_actions.\"key\")"
        }
    }
}

/// Flags as orphan every non-core entry whose module is no longer installed,
/// and clears the flag on those whose module came back. Cheap enough to run at
/// startup and after an uninstall; never deletes a row.
pub async fn refresh_orphans(db: &DbPool) -> Result<(), AppError> {
    // One statement per catalogue table, each a whole compile-time literal: the
    // table name is part of the query text, so it is written out rather than
    // spliced in at run time. The label beside it is only for the log line.
    // Portable spelling: no alias on the UPDATE target (SQLite refuses one, so the
    // subquery names the outer table), and each `NOT EXISTS` parenthesised (MySQL
    // does not parse `x <> NOT EXISTS (…)`).
    macro_rules! refresh {
        ($table:literal, $bare:literal) => {
            concat!(
                "UPDATE core.",
                $table,
                " SET is_orphan = (NOT EXISTS (SELECT 1 FROM core.modules m WHERE m.id = ",
                $bare,
                ".module_id)) WHERE module_id <> 'core' AND is_orphan <> \
                 (NOT EXISTS (SELECT 1 FROM core.modules m WHERE m.id = ",
                $bare,
                ".module_id))"
            )
        };
    }
    for (table, sql) in [
        ("core.rule_triggers", refresh!("rule_triggers", "rule_triggers")),
        ("core.rule_actions", refresh!("rule_actions", "rule_actions")),
    ] {
        if let Err(e) = db.execute(sql, params![]).await {
            tracing::error!(error = %e, table = %table, "rules: réévaluation des orphelins");
            return Err(AppError::Database(e));
        }
    }
    Ok(())
}

// ── Reads ────────────────────────────────────────────────────────────────────

pub async fn list_triggers(db: &DbPool) -> Result<Vec<TriggerRow>, AppError> {
    db.fetch_all_as::<TriggerRow>(
        r#"SELECT "key", module_id, event_type, label, description, fields, is_orphan
             FROM core.rule_triggers ORDER BY module_id, "key""#,
        params![],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "rules: lecture du catalogue des déclencheurs");
        AppError::Database(e)
    })
}

pub async fn list_actions(db: &DbPool) -> Result<Vec<ActionRow>, AppError> {
    db.fetch_all_as::<ActionRow>(
        r#"SELECT "key", module_id, label, description, params_schema,
                  is_blocking, is_reversible, is_orphan
             FROM core.rule_actions ORDER BY module_id, "key""#,
        params![],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "rules: lecture du catalogue des actions");
        AppError::Database(e)
    })
}

/// Everything the dispatcher needs to run one action.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ResolvedAction {
    pub key: String,
    pub module_id: String,
    pub endpoint: Option<String>,
    pub is_blocking: bool,
    pub is_reversible: bool,
}

pub async fn resolve_action(db: &DbPool, key: &str) -> Result<Option<ResolvedAction>, AppError> {
    db.fetch_optional_as::<ResolvedAction>(
        r#"SELECT "key", module_id, endpoint, is_blocking, is_reversible
             FROM core.rule_actions WHERE "key" = $1"#,
        params![key],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, action = %key, "rules: résolution d'une action");
        AppError::Database(e)
    })
}

/// The trigger a rule points at, with its declared fields - used to validate a
/// rule's comparisons against the vocabulary its trigger actually offers.
pub async fn get_trigger(db: &DbPool, key: &str) -> Result<Option<TriggerRow>, AppError> {
    db.fetch_optional_as::<TriggerRow>(
        r#"SELECT "key", module_id, event_type, label, description, fields, is_orphan
             FROM core.rule_triggers WHERE "key" = $1"#,
        params![key],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, trigger = %key, "rules: lecture d'un déclencheur");
        AppError::Database(e)
    })
}

/// Parses the `fields` column back into declarations.
pub fn parse_fields(raw: &Value) -> Vec<FieldDef> {
    serde_json::from_value(raw.clone()).unwrap_or_default()
}

/// The content parts a trigger declares, in declaration order.
///
/// A trigger with none of them cannot carry a detector leaf: there would be
/// nothing to inspect, and a rule that can never fire must be refused when it is
/// written rather than discovered when it does not block anything.
pub fn content_parts(fields: &[FieldDef]) -> Vec<&str> {
    fields
        .iter()
        .filter(|f| f.value_type == CONTENT_TYPE)
        .map(|f| f.name.as_str())
        .collect()
}

/// Does `unit` exist? Used when validating a scope, so a rule cannot name a
/// unit that was deleted last week and quietly apply to nobody.
pub async fn org_unit_exists(db: &DbPool, unit: Uuid) -> Result<bool, AppError> {
    // An existence probe: a constant cast to one decodable width, present or
    // absent, rather than a boolean `EXISTS(...)` whose type differs per engine.
    let found = db
        .fetch_optional_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.org_units WHERE id = $1 LIMIT 1",
                db.backend().cast("1", SqlType::BigInt)
            ),
            params![unit],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "rules: vérification d'une unité organisationnelle");
            AppError::Database(e)
        })?
        .is_some();
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prefix_is_added_by_the_core() {
        assert_eq!(
            qualify("office", "document_shared").expect("valide"),
            "office.document_shared"
        );
        assert_eq!(
            qualify(CORE_NAMESPACE, "login_failed").expect("valide"),
            "core.login_failed"
        );
    }

    #[test]
    fn a_module_cannot_choose_its_namespace() {
        // Not by smuggling a prefix in…
        assert!(qualify("office", "core.login_failed").is_err());
        // …nor with an empty or oversized name…
        assert!(qualify("office", "").is_err());
        assert!(qualify("office", &"a".repeat(MAX_NAME_LEN + 1)).is_err());
        // …nor with characters that would break the key grammar.
        assert!(qualify("office", "Document Shared").is_err());
        assert!(qualify("office", "doc-shared").is_err());
        // …and not by calling itself `core` through the module entry point.
        assert!(refuse_core_namespace("core").is_err());
        assert!(refuse_core_namespace("office").is_ok());
    }
}
