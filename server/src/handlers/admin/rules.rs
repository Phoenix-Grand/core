//! `/admin/rules` - the HTTP surface of the rule engine.
//!
//! Reads are gated on `core.rules.read`; **every write is gated on
//! `core.rules.manage`**, which no seeded role holds. That separation is the
//! point: writing a rule is the power to suspend accounts and revoke sessions,
//! automatically, over a population the author describes. "Can administer" must
//! not imply "can arm that".
//!
//! Every mutation rides an audited transaction ([`crate::audit::AuditTx`]), so a
//! rule cannot be created, edited, re-armed or deleted without its trail entry -
//! and a mode change is audited as its own action, because "who turned this on"
//! is the first question after an automatic suspension.

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
use crate::jobs::{queue, NewJob};
use crate::rules::{
    backtest, catalog, condition::Operator, index, model::Mode, store, validate::{self, RuleInput},
};
use crate::state::AppState;

/// Audit target type for a rule. Local to this surface: the redaction
/// whitelist has no rule shape, and a rule carries no secret - what is recorded
/// is its name and its mode, never its condition tree.
const TARGET_RULE: &str = "rule";

fn rule_json(rule: &crate::rules::Rule) -> Value {
    json!({
        "id":                 rule.id,
        "name":               rule.name,
        "description":        rule.description,
        "trigger":            rule.trigger_key,
        "conditions":         rule.conditions,
        "actions":            rule.actions,
        "mode":               rule.mode.as_str(),
        "scope":              rule.scope,
        "threshold_count":    rule.threshold_count,
        "threshold_window_s": rule.threshold_window_s,
        "rollout_percent":    rule.rollout_percent,
        "severity":           rule.severity,
        "priority":           rule.priority,
        "version":            rule.version,
        "created_at":         rule.created_at,
        "updated_at":         rule.updated_at,
    })
}

/// What lands in the audit trail. Deliberately not the whole rule: the trail is
/// read by more people than the rules surface, and the useful fields are the
/// ones that answer "what did this thing become".
fn audit_snapshot(rule: &crate::rules::Rule) -> Value {
    json!({
        "name":            rule.name,
        "trigger":         rule.trigger_key,
        "mode":            rule.mode.as_str(),
        "severity":        rule.severity,
        "rollout_percent": rule.rollout_percent,
        "actions":         rule.actions.iter().map(|a| a.action.clone()).collect::<Vec<_>>(),
        "version":         rule.version,
    })
}

// ── Catalogue ────────────────────────────────────────────────────────────────

/// `GET /api/v1/admin/rules/catalog` - everything a rule can react to and do.
///
/// Served from the tables modules fill at registration, so a module installed
/// five minutes ago is offered here without the core having heard of it.
pub async fn get_catalog(
    State(state): State<AppState>,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_READ)?;
    let triggers = catalog::list_triggers(&state.db).await?;
    let actions = catalog::list_actions(&state.db).await?;
    // Content detectors are catalogue entries like everything else, so the
    // condition builder learns about the `detector` leaf the same way it learns
    // about a trigger's fields - by reading this response. That is what let the
    // detector leaf arrive without the builder being rewritten for it.
    let detectors = crate::rules::detect::store::list(&state.db).await?;
    Ok(Json(json!({
        "triggers":  triggers,
        "actions":   actions,
        // The closed vocabulary, so the editor cannot offer an operator the
        // server would refuse.
        "operators": Operator::ALL.iter().map(|o| o.as_str()).collect::<Vec<_>>(),
        "modes":     Mode::SETTABLE.iter().map(|m| m.as_str()).collect::<Vec<_>>(),
        // The kinds of leaf a condition tree may hold. `compare` reads a fact,
        // `detector` reads a content part - and there is no third, because the
        // vocabulary is an enum rather than a language.
        "leaf_types": ["compare", "detector"],
        // Enabled detectors only: offering a disabled one would let an operator
        // save a rule the server then refuses, which reads as a broken console.
        "detectors": detectors
            .iter()
            .filter(|d| d.is_enabled)
            .map(|d| json!({
                "key":                d.key,
                "label":              d.label,
                "description":        d.description,
                "category":           d.category,
                "kind":               d.kind.as_str(),
                // The detector's own thresholds, which the builder proposes as
                // the leaf's starting point.
                "min_confidence":     d.min_confidence,
                "min_matches":        d.min_matches,
                "min_unique_matches": d.min_unique_matches,
            }))
            .collect::<Vec<_>>(),
        // The field type that marks a content part, so the builder can tell
        // "a fact to compare" from "a text to inspect" without a second list.
        "content_field_type": catalog::CONTENT_TYPE,
        "limits": {
            "condition_depth":  crate::rules::condition::MAX_DEPTH,
            "condition_leaves": crate::rules::condition::MAX_LEAVES,
            "actions":          validate::MAX_ACTIONS,
            "scope_refs":       validate::MAX_SCOPE_REFS,
            "detector_leaves":  validate::MAX_DETECTOR_LEAVES,
        },
    })))
}

// ── Rules ────────────────────────────────────────────────────────────────────

pub async fn list_rules(
    State(state): State<AppState>,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_READ)?;
    let rules = store::list_rules(&state.db).await?;
    let indexed = index::snapshot().len;
    Ok(Json(json!({
        "rules": rules.iter().map(rule_json).collect::<Vec<_>>(),
        // What the engine is actually running right now, which is not always
        // what the table says - a rule whose trigger vanished is stored but not
        // indexed, and an operator must be able to see the difference.
        "indexed": indexed,
        "engine_enabled": store::engine_enabled(&state.db).await,
    })))
}

pub async fn get_rule(
    State(state): State<AppState>,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_READ)?;
    let rule = store::get_rule(&state.db, id).await?;
    let versions = store::versions(&state.db, id).await?;
    let backtests = store::list_backtests(&state.db, id).await?;
    Ok(Json(json!({
        "rule":      rule_json(&rule),
        "versions":  versions,
        "backtests": backtests,
    })))
}

pub async fn create_rule(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(input): Json<RuleInput>,
) -> Result<Json<Value>, AppError> {
    // Not `require`: writing a rule is its own capability.
    ctx.require(keys::RULES_MANAGE)?;

    let draft = validate::prepare(&state.db, &input).await?;
    let author = Some(audit.admin.id);

    let mut tx = audit.begin(&state.db).await?;
    let rule = match store::insert_rule(
        &mut tx,
        &draft,
        author,
        input.change_note.as_deref(),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.rules.create")
                        .module("core")
                        .target_kind(TARGET_RULE, draft.name.clone()),
                    e,
                )
                .await)
        }
    };

    tx.commit(
        AuditEntry::new("core.rules.create")
            .module("core")
            .target(TARGET_RULE, rule.id, rule.name.clone())
            .after(audit_snapshot(&rule)),
    )
    .await?;

    store::notify_reload(&state.db).await;
    Ok(Json(json!({ "rule": rule_json(&rule) })))
}

pub async fn update_rule(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(input): Json<RuleInput>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_MANAGE)?;

    let before = store::get_rule(&state.db, id).await?;
    let draft = validate::prepare(&state.db, &input).await?;
    let author = Some(audit.admin.id);

    let mut tx = audit.begin(&state.db).await?;
    let rule = match store::update_rule(
        &mut tx,
        id,
        &draft,
        author,
        input.change_note.as_deref(),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.rules.update")
                        .module("core")
                        .target(TARGET_RULE, id, before.name.clone()),
                    e,
                )
                .await)
        }
    };

    // A mode change is audited as its own action. "Who armed this" must be
    // findable without reading the diff of an update entry.
    if before.mode != rule.mode {
        tx.also(
            AuditEntry::new("core.rules.set_mode")
                .module("core")
                .target(TARGET_RULE, id, rule.name.clone())
                .before(json!({ "mode": before.mode.as_str() }))
                .after(json!({ "mode": rule.mode.as_str() }))
                .reversible(),
        );
    }

    tx.commit(
        AuditEntry::new("core.rules.update")
            .module("core")
            .target(TARGET_RULE, id, rule.name.clone())
            .before(audit_snapshot(&before))
            .after(audit_snapshot(&rule))
            .reversible(),
    )
    .await?;

    store::notify_reload(&state.db).await;
    Ok(Json(json!({ "rule": rule_json(&rule) })))
}

#[derive(Debug, Deserialize)]
pub struct ModeDto {
    pub mode: String,
    #[serde(default)]
    pub change_note: Option<String>,
}

/// `POST /api/v1/admin/rules/:id/mode` - the one-click arm/disarm.
///
/// Goes through the same validation and the same versioning as a full edit: a
/// mode change is a new version of the rule, because "which version acted" must
/// stay answerable and the mode is part of what a version means.
pub async fn set_mode(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<ModeDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_MANAGE)?;

    let before = store::get_rule(&state.db, id).await?;
    let mode = Mode::parse_settable(dto.mode.trim())?;
    if mode.acts() && before.actions.is_empty() {
        return Err(AppError::Validation(
            "Cette règle ne déclare aucune action : le mode « actif avec actions » n'aurait aucun effet".into(),
        ));
    }

    let draft = store::RuleDraft {
        name: before.name.clone(),
        description: before.description.clone(),
        trigger_key: before.trigger_key.clone(),
        conditions: before.conditions.clone(),
        actions: before.actions.clone(),
        mode,
        scope: before.scope.clone(),
        threshold_count: before.threshold_count,
        threshold_window_s: before.threshold_window_s,
        rollout_percent: before.rollout_percent,
        severity: before.severity.clone(),
        priority: before.priority,
    };

    let mut tx = audit.begin(&state.db).await?;
    let rule = match store::update_rule(
        &mut tx,
        id,
        &draft,
        Some(audit.admin.id),
        dto.change_note.as_deref(),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.rules.set_mode")
                        .module("core")
                        .target(TARGET_RULE, id, before.name.clone()),
                    e,
                )
                .await)
        }
    };

    tx.commit(
        AuditEntry::new("core.rules.set_mode")
            .module("core")
            .target(TARGET_RULE, id, rule.name.clone())
            .before(json!({ "mode": before.mode.as_str() }))
            .after(json!({ "mode": rule.mode.as_str() }))
            .reversible(),
    )
    .await?;

    store::notify_reload(&state.db).await;
    Ok(Json(json!({ "rule": rule_json(&rule) })))
}

pub async fn delete_rule(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_MANAGE)?;

    let before = store::get_rule(&state.db, id).await?;

    let mut tx = audit.begin(&state.db).await?;
    if let Err(e) = store::delete_rule(&mut tx, id).await {
        return Err(tx
            .abort(
                &state.db,
                AuditEntry::new("core.rules.delete")
                    .module("core")
                    .target(TARGET_RULE, id, before.name.clone()),
                e,
            )
            .await);
    }

    tx.commit(
        AuditEntry::new("core.rules.delete")
            .module("core")
            .target(TARGET_RULE, id, before.name.clone())
            .before(audit_snapshot(&before)),
    )
    .await?;

    store::notify_reload(&state.db).await;
    Ok(Json(json!({ "deleted": true })))
}

// ── Versions and run log ─────────────────────────────────────────────────────

pub async fn list_versions(
    State(state): State<AppState>,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_READ)?;
    Ok(Json(json!({
        "versions": store::versions(&state.db, id).await?,
    })))
}

/// `GET /api/v1/admin/rules/executions` - what the engine actually did.
pub async fn list_executions(
    State(state): State<AppState>,
    ctx: AdminCtx,
    Query(q): Query<store::ExecutionQuery>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_READ)?;
    Ok(Json(json!({
        "executions": store::list_executions(&state.db, &q).await?,
    })))
}

// ── Backtest ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct BacktestDto {
    #[serde(default)]
    pub from: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub to: Option<chrono::DateTime<chrono::Utc>>,
}

/// `POST /api/v1/admin/rules/:id/backtest` - "what would this have done?"
///
/// Requires only `core.rules.read`: a replay changes nothing, acts on nobody and
/// alerts no one. Making it a write privilege would push operators to arm a rule
/// in order to find out what it does, which is the exact opposite of the point.
pub async fn start_backtest(
    State(state): State<AppState>,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<BacktestDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_READ)?;

    let rule = store::get_rule(&state.db, id).await?;
    let (from, to) = backtest::clamp_window(dto.from, dto.to)?;
    let row = store::create_backtest(&state.db, &rule, from, to, Some(ctx.user_id)).await?;

    // Driven by the existing runner, so a replay of a month of events cannot
    // hold an HTTP request open - or die with it.
    queue::enqueue(
        &state.db,
        NewJob::new(backtest::BACKTEST_JOB)
            .payload(json!({ "backtest_id": row.id }))
            .max_attempts(1),
    )
    .await
    .map_err(AppError::Database)?;

    Ok(Json(json!({ "backtest": row })))
}

pub async fn get_backtest(
    State(state): State<AppState>,
    ctx: AdminCtx,
    Path((_id, backtest_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::RULES_READ)?;
    Ok(Json(json!({
        "backtest": store::get_backtest(&state.db, backtest_id).await?,
    })))
}
