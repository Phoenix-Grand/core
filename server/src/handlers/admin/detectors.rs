//! `/admin/detectors` - managing content detectors, and trying one out.
//!
//! Reads are gated on `core.rules.read`, **writes on `core.rules.manage`** -
//! the same pair the rules surface uses, and deliberately not a lesser one. A
//! detector does nothing on its own, so it is tempting to treat editing one as
//! ordinary administration. It is not: whoever can widen a pattern can make a
//! blocking rule stop blocking, without touching the rule, without appearing in
//! its version history, and while every screen still says the rule is armed.
//! The power to weaken a detector is the power to weaken the rule that uses it.
//!
//! Every mutation rides an audited transaction ([`crate::audit::AuditTx`]).
//!
//! ## The test screen, and the one rule it must never break
//!
//! `POST /admin/detectors/test` is the only place in the product where
//! inspected content is displayed. It is displayed **in the browser**, in the
//! textarea the administrator typed it into: the response carries offsets,
//! confidences and counters, and not one character of the text. Nothing is
//! written - no row, no audit entry, no log line - so a compliance officer can
//! paste a real example to check a threshold without that example becoming a
//! copy of the thing they are protecting.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::audit::{AdminAudit, AuditEntry};
use crate::authz::{keys, AdminCtx};
use crate::errors::AppError;
use crate::rules::detect::{
    checksum::Checksum,
    model::{Detector, Kind},
    scan::{self, Compiled, Limits},
    store::{self, DetectorDraft},
};
use crate::rules::store as rules_store;
use crate::state::AppState;

/// Audit target type for a detector.
const TARGET: &str = "content_detector";

const MAX_KEY_LEN: usize = 120;
const MAX_LABEL_LEN: usize = 200;
const MAX_DESCRIPTION_LEN: usize = 2_000;
/// Longest sample the test screen accepts. Generous enough for a realistic
/// document, small enough that the screen cannot be turned into a scanner for
/// something else.
const MAX_SAMPLE_BYTES: usize = 64 * 1024;

fn detector_json(d: &Detector) -> Value {
    json!({
        "id":                 d.id,
        "key":                d.key,
        "label":              d.label,
        "description":        d.description,
        "category":           d.category,
        "kind":               d.kind.as_str(),
        "pattern":            d.pattern,
        "terms":              d.terms,
        "checksum":           d.checksum.map(Checksum::as_str),
        "proximity_terms":    d.proximity_terms,
        "proximity_window":   d.proximity_window,
        "proximity_required": d.proximity_required,
        "base_confidence":    d.base_confidence,
        "checksum_bonus":     d.checksum_bonus,
        "proximity_bonus":    d.proximity_bonus,
        "min_confidence":     d.min_confidence,
        "min_matches":        d.min_matches,
        "min_unique_matches": d.min_unique_matches,
        "is_enabled":         d.is_enabled,
        "is_builtin":         d.is_builtin,
        "created_at":         d.created_at,
        "updated_at":         d.updated_at,
    })
}

/// What lands in the audit trail: what the detector became, never a sample.
fn audit_snapshot(d: &Detector) -> Value {
    json!({
        "key":                d.key,
        "label":              d.label,
        "kind":               d.kind.as_str(),
        "checksum":           d.checksum.map(Checksum::as_str),
        "pattern":            d.pattern,
        "terms":              d.terms.len(),
        "proximity_required": d.proximity_required,
        "min_confidence":     d.min_confidence,
        "min_matches":        d.min_matches,
        "min_unique_matches": d.min_unique_matches,
        "is_enabled":         d.is_enabled,
    })
}

// ── Input ────────────────────────────────────────────────────────────────────

/// A detector as the API receives it.
#[derive(Debug, Clone, Deserialize)]
pub struct DetectorInput {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub terms: Vec<String>,
    #[serde(default)]
    pub checksum: Option<String>,
    #[serde(default)]
    pub proximity_terms: Vec<String>,
    #[serde(default)]
    pub proximity_window: Option<i32>,
    #[serde(default)]
    pub proximity_required: bool,
    #[serde(default)]
    pub base_confidence: Option<f32>,
    #[serde(default)]
    pub checksum_bonus: Option<f32>,
    #[serde(default)]
    pub proximity_bonus: Option<f32>,
    #[serde(default)]
    pub min_confidence: Option<f32>,
    #[serde(default)]
    pub min_matches: Option<i32>,
    #[serde(default)]
    pub min_unique_matches: Option<i32>,
    #[serde(default = "default_true")]
    pub is_enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Turns a submitted detector into one that is safe to store **and to run**.
///
/// The pattern is compiled here, under the same ceilings the gate runs it
/// under. That is the whole denial-of-service story in one line: a pattern that
/// would be expensive is refused once, in front of the administrator who wrote
/// it, instead of on every request of every module for ever.
fn prepare(input: &DetectorInput) -> Result<DetectorDraft, AppError> {
    let key = input.key.trim().to_lowercase();
    if key.is_empty() || key.len() > MAX_KEY_LEN {
        return Err(AppError::Validation(format!(
            "The detector key must contain 1 to {MAX_KEY_LEN} characters"
        )));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_')
    {
        return Err(AppError::Validation(
            "The key only accepts lowercase letters, numbers, dots, and underscores".into(),
        ));
    }

    let label = input.label.trim();
    if label.is_empty() || label.chars().count() > MAX_LABEL_LEN {
        return Err(AppError::Validation(format!(
            "The label must contain 1 to {MAX_LABEL_LEN} characters"
        )));
    }
    if let Some(d) = input.description.as_deref() {
        if d.chars().count() > MAX_DESCRIPTION_LEN {
            return Err(AppError::Validation(format!(
                "The description exceeds {MAX_DESCRIPTION_LEN} characters"
            )));
        }
    }

    let kind = Kind::parse(input.kind.trim()).ok_or_else(|| {
        AppError::Validation(format!(
            "Unknown detector type '{}': expected {}",
            input.kind,
            Kind::ALL
                .iter()
                .map(|k| k.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })?;

    let checksum = match input.checksum.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(raw) => Some(Checksum::parse(raw).ok_or_else(|| {
            AppError::Validation(format!(
                "Unknown checksum '{raw}': expected {}",
                Checksum::ALL
                    .iter()
                    .map(|c| c.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })?),
    };
    if checksum.is_some() && kind != Kind::Checksum {
        return Err(AppError::Validation(
            "A checksum only applies to a checksum detector"
                .into(),
        ));
    }
    if kind == Kind::Checksum && checksum.is_none() {
        return Err(AppError::Validation(
            "A checksum detector must specify the algorithm to use".into(),
        ));
    }

    let unit = |name: &str, value: Option<f32>, default: f32| -> Result<f32, AppError> {
        let v = value.unwrap_or(default);
        if !(0.0..=1.0).contains(&v) || v.is_nan() {
            return Err(AppError::Validation(format!("{name} must be between 0 and 1")));
        }
        Ok(v)
    };

    let draft = DetectorDraft {
        key,
        label: label.to_string(),
        description: input
            .description
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        category: input
            .category
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("other")
            .to_lowercase(),
        kind,
        pattern: input
            .pattern
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        terms: clean_terms(&input.terms),
        checksum,
        proximity_terms: clean_terms(&input.proximity_terms),
        proximity_window: input.proximity_window.unwrap_or(120).clamp(0, 4_000),
        proximity_required: input.proximity_required,
        base_confidence: unit("La confiance de base", input.base_confidence, 0.5)?,
        checksum_bonus: unit("The checksum bonus", input.checksum_bonus, 0.35)?,
        proximity_bonus: unit("The proximity bonus", input.proximity_bonus, 0.2)?,
        min_confidence: unit("Le seuil de confiance", input.min_confidence, 0.7)?,
        min_matches: input.min_matches.unwrap_or(1).clamp(1, 10_000),
        min_unique_matches: input.min_unique_matches.unwrap_or(1).clamp(1, 10_000),
        is_enabled: input.is_enabled,
    };

    if draft.min_unique_matches > draft.min_matches {
        return Err(AppError::Validation(
            "The distinct value count cannot exceed the match count; this threshold would never be reached".into(),
        ));
    }
    if draft.proximity_required && draft.proximity_terms.is_empty() {
        return Err(AppError::Validation(
            "'Keyword required' requires at least one proximity keyword".into(),
        ));
    }

    // Compiles under the ceilings the gate will run it under. Refused here or
    // never.
    compile_draft(&draft)?;
    Ok(draft)
}

fn clean_terms(raw: &[String]) -> Vec<String> {
    raw.iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .take(scan::MAX_TERMS)
        .collect()
}

/// Builds the compiled form of a draft, for validation and for the test screen.
fn compile_draft(draft: &DetectorDraft) -> Result<Compiled, AppError> {
    Compiled::build(Detector {
        id: Uuid::nil(),
        key: draft.key.clone(),
        label: draft.label.clone(),
        description: draft.description.clone(),
        category: draft.category.clone(),
        kind: draft.kind,
        pattern: draft.pattern.clone(),
        terms: draft.terms.clone(),
        checksum: draft.checksum,
        proximity_terms: draft.proximity_terms.clone(),
        proximity_window: draft.proximity_window,
        proximity_required: draft.proximity_required,
        base_confidence: draft.base_confidence,
        checksum_bonus: draft.checksum_bonus,
        proximity_bonus: draft.proximity_bonus,
        min_confidence: draft.min_confidence,
        min_matches: draft.min_matches,
        min_unique_matches: draft.min_unique_matches,
        is_enabled: draft.is_enabled,
        is_builtin: false,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    })
}

// ── Reads ────────────────────────────────────────────────────────────────────

/// `GET /api/v1/admin/detectors`
pub async fn list_detectors(
    State(state): State<AppState>,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_READ)?;
    let detectors = store::list(&state.db).await?;
    Ok(Json(json!({
        "detectors": detectors.iter().map(detector_json).collect::<Vec<_>>(),
        // The vocabulary, so the editor cannot offer something the server
        // would refuse.
        "kinds":     Kind::ALL.iter().map(|k| k.as_str()).collect::<Vec<_>>(),
        "checksums": Checksum::ALL.iter().map(|c| c.as_str()).collect::<Vec<_>>(),
        "limits": {
            "pattern_len":    scan::MAX_PATTERN_LEN,
            "terms":          scan::MAX_TERMS,
            "term_len":       scan::MAX_TERM_LEN,
            "sample_bytes":   MAX_SAMPLE_BYTES,
            "compiled_bytes": scan::MAX_COMPILED_BYTES,
        },
    })))
}

/// `GET /api/v1/admin/detectors/:id` - the detector plus which rules use it.
pub async fn get_detector(
    State(state): State<AppState>,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_READ)?;
    let detector = store::get(&state.db, id).await?;
    let used_by = store::rules_using(&state.db, &detector.key).await?;
    Ok(Json(json!({
        "detector": detector_json(&detector),
        "used_by":  used_by,
    })))
}

// ── Writes ───────────────────────────────────────────────────────────────────

pub async fn create_detector(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(input): Json<DetectorInput>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_MANAGE)?;

    let draft = prepare(&input)?;
    if store::key_exists(&state.db, &draft.key, None).await? {
        return Err(AppError::Validation(format!(
            "Key '{}' is already taken",
            draft.key
        )));
    }

    let mut tx = audit.begin(&state.db).await?;
    let detector = match store::insert(&mut tx, &draft, Some(audit.admin.id)).await {
        Ok(d) => d,
        Err(e) => {
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.detectors.create")
                        .module("core")
                        .target_kind(TARGET, draft.label.clone()),
                    e,
                )
                .await)
        }
    };

    tx.commit(
        AuditEntry::new("core.detectors.create")
            .module("core")
            .target(TARGET, detector.id, detector.label.clone())
            .after(audit_snapshot(&detector)),
    )
    .await?;

    rules_store::notify_reload(&state.db).await;
    Ok(Json(json!({ "detector": detector_json(&detector) })))
}

pub async fn update_detector(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(input): Json<DetectorInput>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_MANAGE)?;

    let before = store::get(&state.db, id).await?;
    let draft = prepare(&input)?;
    // A built-in may be tuned - an instance whose regulator disagrees with our
    // idea of a phone number must not have to fork the core - but not renamed:
    // its key is what rules written before this edit point at.
    if before.is_builtin && draft.key != before.key {
        return Err(AppError::Validation(
            "A detector bundled with the core cannot change its key because rules reference it".into(),
        ));
    }
    if store::key_exists(&state.db, &draft.key, Some(id)).await? {
        return Err(AppError::Validation(format!(
            "Key '{}' is already taken",
            draft.key
        )));
    }
    let mut tx = audit.begin(&state.db).await?;
    let detector = match store::update(&mut tx, id, &draft, Some(audit.admin.id)).await {
        Ok(d) => d,
        Err(e) => {
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.detectors.update")
                        .module("core")
                        .target(TARGET, id, before.label.clone()),
                    e,
                )
                .await)
        }
    };

    // Disarming a detector is audited as its own action. "Who turned this off"
    // is the first question after something got through, and it must be
    // findable without reading the diff of an update entry.
    if before.is_enabled != detector.is_enabled {
        tx.also(
            AuditEntry::new("core.detectors.set_enabled")
                .module("core")
                .target(TARGET, id, detector.label.clone())
                .before(json!({ "is_enabled": before.is_enabled }))
                .after(json!({ "is_enabled": detector.is_enabled }))
                .reversible(),
        );
    }

    tx.commit(
        AuditEntry::new("core.detectors.update")
            .module("core")
            .target(TARGET, id, detector.label.clone())
            .before(audit_snapshot(&before))
            .after(audit_snapshot(&detector))
            .reversible(),
    )
    .await?;

    rules_store::notify_reload(&state.db).await;
    Ok(Json(json!({ "detector": detector_json(&detector) })))
}

pub async fn delete_detector(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_MANAGE)?;

    let before = store::get(&state.db, id).await?;
    if before.is_builtin {
        // Disabling is the supported way to silence one. Deleting it would
        // leave every rule that names it pointing at nothing, and the next
        // migration would put it back.
        return Err(AppError::Validation(
            "A detector bundled with the core can be disabled but cannot be deleted".into(),
        ));
    }
    let used_by = store::rules_using(&state.db, &before.key).await?;
    if !used_by.is_empty() {
        return Err(AppError::Validation(format!(
            "{} rule(s) use this detector: {}",
            used_by.len(),
            used_by.join(", ")
        )));
    }

    let mut tx = audit.begin(&state.db).await?;
    if let Err(e) = store::delete(&mut tx, id).await {
        return Err(tx
            .abort(
                &state.db,
                AuditEntry::new("core.detectors.delete")
                    .module("core")
                    .target(TARGET, id, before.label.clone()),
                e,
            )
            .await);
    }

    tx.commit(
        AuditEntry::new("core.detectors.delete")
            .module("core")
            .target(TARGET, id, before.label.clone())
            .before(audit_snapshot(&before)),
    )
    .await?;

    rules_store::notify_reload(&state.db).await;
    Ok(Json(json!({ "deleted": true })))
}

// ── The test screen ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct TestDto {
    /// The sample to inspect. Never stored, never logged, never echoed back.
    pub sample: String,
    /// Try a detector already saved…
    #[serde(default)]
    pub detector_id: Option<Uuid>,
    /// …or one being written, before it is saved.
    #[serde(default)]
    pub draft: Option<DetectorInput>,
    /// Threshold to apply, defaulting to the detector's own.
    #[serde(default)]
    pub min_confidence: Option<f32>,
}

/// `POST /api/v1/admin/detectors/test`
///
/// Answers with **offsets**, not text. The browser already holds the sample -
/// the administrator typed it - so it highlights locally, and the response can
/// keep the promise the rest of the feature makes: no inspected value in a JSON
/// body, ever, not even here.
///
/// Requires `core.rules.manage` rather than `read`: this is the screen where a
/// pattern is tuned until it is right, and reading a detector is not the same
/// permission as running one against arbitrary text.
pub async fn test_detector(
    State(state): State<AppState>,
    ctx: AdminCtx,
    Json(dto): Json<TestDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_MANAGE)?;

    if dto.sample.len() > MAX_SAMPLE_BYTES {
        return Err(AppError::Validation(format!(
            "The sample exceeds {} KB",
            MAX_SAMPLE_BYTES / 1024
        )));
    }

    // Either a saved detector or a draft, never both silently.
    let (compiled, defaults) = match (&dto.draft, dto.detector_id) {
        (Some(draft), _) => {
            let prepared = prepare(draft)?;
            let thresholds = (
                prepared.min_confidence,
                prepared.min_matches,
                prepared.min_unique_matches,
            );
            (compile_draft(&prepared)?, thresholds)
        }
        (None, Some(id)) => {
            let d = store::get(&state.db, id).await?;
            let thresholds = (d.min_confidence, d.min_matches, d.min_unique_matches);
            (Compiled::build(d)?, thresholds)
        }
        (None, None) => {
            return Err(AppError::Validation(
                "Specify an existing detector or a draft to try".into(),
            ))
        }
    };

    // The same bounds the gate runs under, so what an administrator sees here
    // is what a module would get - including the truncation.
    let limits = Limits {
        max_part_bytes: MAX_SAMPLE_BYTES,
        ..crate::rules::detect::limits_from_settings(&state.db).await
    };
    let result = compiled.scan(&dto.sample, &limits);

    let floor = dto.min_confidence.unwrap_or(defaults.0).clamp(0.0, 1.0);
    let (matches, unique, best) = result.tally(floor);

    Ok(Json(json!({
        // Offsets and confidences. Not one character of the sample.
        "matches": result
            .hits
            .iter()
            .map(|h| json!({
                "start":      h.start,
                "end":        h.end,
                "confidence": (h.confidence * 100.0).round() / 100.0,
                "counted":    h.confidence >= floor,
            }))
            .collect::<Vec<_>>(),
        "summary": {
            "min_confidence":     floor,
            "matches":            matches,
            "unique_matches":     unique,
            "best_confidence":    (best * 100.0).round() / 100.0,
            "min_matches":        defaults.1,
            "min_unique_matches": defaults.2,
            // Would a leaf using the detector's own thresholds hold?
            "would_match":        matches >= defaults.1 && unique >= defaults.2,
        },
        "scan": {
            "bytes":     result.bytes_scanned,
            "truncated": result.truncated,
            "timed_out": result.timed_out,
            "saturated": result.saturated,
        },
    })))
}

// ── Where a blocked user's reference leads ───────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct LookupQuery {
    pub reference: String,
}

/// `GET /api/v1/admin/detectors/reference?reference=XXXX`
///
/// The other half of the contract with a blocked user. They were told a
/// reference and nothing else; somebody holding `core.rules.read` pastes it here
/// and gets the run - which rule, which version, which mode, how many matches.
/// The asymmetry is the design: the person who must not learn the policy holds a
/// token that means nothing, and the person who may learn it can resolve it.
pub async fn lookup_reference(
    State(state): State<AppState>,
    ctx: AdminCtx,
    Query(q): Query<LookupQuery>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_READ)?;
    let reference = q.reference.trim().to_uppercase();
    if reference.is_empty() || reference.len() > 16 {
        return Err(AppError::Validation("Invalid reference".into()));
    }
    let executions = rules_store::list_executions(
        &state.db,
        &rules_store::ExecutionQuery {
            reference: Some(reference),
            limit: Some(10),
            ..Default::default()
        },
    )
    .await?;
    Ok(Json(json!({ "executions": executions })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: &str) -> DetectorInput {
        DetectorInput {
            key: "org.test".into(),
            label: "Essai".into(),
            description: None,
            category: None,
            kind: kind.into(),
            pattern: Some(r"\b\d{4}\b".into()),
            terms: vec![],
            checksum: None,
            proximity_terms: vec![],
            proximity_window: None,
            proximity_required: false,
            base_confidence: None,
            checksum_bonus: None,
            proximity_bonus: None,
            min_confidence: None,
            min_matches: None,
            min_unique_matches: None,
            is_enabled: true,
        }
    }

    #[test]
    fn a_workable_detector_is_accepted_with_its_defaults() {
        let draft = prepare(&input("regex")).expect("valide");
        assert_eq!(draft.key, "org.test");
        assert_eq!(draft.min_confidence, 0.7);
        assert_eq!(draft.min_matches, 1);
        assert_eq!(draft.min_unique_matches, 1);
        assert_eq!(draft.category, "other");
    }

    #[test]
    fn a_key_that_could_collide_with_a_namespace_is_refused() {
        let mut i = input("regex");
        i.key = "Org Test".into();
        assert!(prepare(&i).is_err());
        i.key = "org/test".into();
        assert!(prepare(&i).is_err());
        i.key = String::new();
        assert!(prepare(&i).is_err());
    }

    #[test]
    fn a_pattern_that_would_be_expensive_is_refused_when_it_is_written() {
        // The whole denial-of-service answer in one assertion: refused once, in
        // front of the person who can fix it, rather than on every request.
        let mut i = input("regex");
        i.pattern = Some(r"(?:\w{500}){500}".into());
        let err = prepare(&i).expect_err("doit être refusé");
        assert!(matches!(err, AppError::Validation(_)));

        i.pattern = Some("a".repeat(scan::MAX_PATTERN_LEN + 1));
        assert!(prepare(&i).is_err());

        // …and a plain syntax error is refused the same way.
        i.pattern = Some("(unclosed".into());
        assert!(prepare(&i).is_err());
    }

    #[test]
    fn an_unreachable_threshold_is_refused_rather_than_stored() {
        // More distinct values than occurrences can never happen: the rule
        // would sit in the console looking armed and never fire.
        let mut i = input("regex");
        i.min_matches = Some(2);
        i.min_unique_matches = Some(5);
        assert!(prepare(&i).is_err());

        i.min_unique_matches = Some(2);
        assert!(prepare(&i).is_ok());
    }

    #[test]
    fn a_checksum_and_its_kind_have_to_agree() {
        let mut i = input("regex");
        i.checksum = Some("luhn".into());
        assert!(prepare(&i).is_err(), "somme de contrôle sur un type « motif »");

        i.kind = "checksum".into();
        assert!(prepare(&i).is_ok());

        i.checksum = None;
        assert!(prepare(&i).is_err(), "type « somme de contrôle » sans algorithme");

        i.checksum = Some("sha256".into());
        assert!(prepare(&i).is_err(), "algorithme hors de l'énumération");
    }

    #[test]
    fn a_required_keyword_with_no_keyword_is_a_detector_that_never_fires() {
        let mut i = input("regex");
        i.proximity_required = true;
        assert!(prepare(&i).is_err());
        i.proximity_terms = vec!["carte".into()];
        assert!(prepare(&i).is_ok());
    }

    #[test]
    fn a_word_list_needs_words_and_a_pattern_needs_a_pattern() {
        let mut i = input("wordlist");
        i.pattern = None;
        i.terms = vec![];
        assert!(prepare(&i).is_err());
        i.terms = vec!["confidentiel".into()];
        assert!(prepare(&i).is_ok());

        let mut i = input("regex");
        i.pattern = None;
        assert!(prepare(&i).is_err());
    }

    #[test]
    fn confidences_outside_the_unit_interval_are_refused() {
        for field in 0..4 {
            let mut i = input("regex");
            match field {
                0 => i.base_confidence = Some(1.5),
                1 => i.checksum_bonus = Some(-0.1),
                2 => i.proximity_bonus = Some(f32::NAN),
                _ => i.min_confidence = Some(2.0),
            }
            assert!(prepare(&i).is_err(), "champ {field} hors [0,1] accepté");
        }
    }

    #[test]
    fn the_audit_snapshot_carries_configuration_and_no_sample() {
        // A pattern is policy and belongs in the trail; a sample is content and
        // never goes anywhere near it.
        let draft = prepare(&input("regex")).expect("valide");
        let detector = Detector {
            id: Uuid::nil(),
            key: draft.key.clone(),
            label: draft.label.clone(),
            description: None,
            category: draft.category.clone(),
            kind: draft.kind,
            pattern: draft.pattern.clone(),
            terms: draft.terms.clone(),
            checksum: draft.checksum,
            proximity_terms: draft.proximity_terms.clone(),
            proximity_window: draft.proximity_window,
            proximity_required: draft.proximity_required,
            base_confidence: draft.base_confidence,
            checksum_bonus: draft.checksum_bonus,
            proximity_bonus: draft.proximity_bonus,
            min_confidence: draft.min_confidence,
            min_matches: draft.min_matches,
            min_unique_matches: draft.min_unique_matches,
            is_enabled: true,
            is_builtin: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        let snap = audit_snapshot(&detector);
        assert_eq!(snap["key"], json!("org.test"));
        // Terms are counted, not quoted: a word list can hold the very words an
        // instance is trying not to spread.
        assert_eq!(snap["terms"], json!(0));
        assert!(snap.get("sample").is_none());
    }
}
