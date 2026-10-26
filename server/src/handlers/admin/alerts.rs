//! `/admin/alerts` - the HTTP surface of the alert centre.
//!
//! Reads are gated on `core.alerts.read` and narrowed per alert *type*; every
//! write is gated on `core.alerts.manage` and rides an audited transaction, so
//! a status change or an assignment can never land without its trail entry (see
//! [`crate::audit::AuditTx`]).
//!
//! The two verbs the console cannot delegate to another screen - putting a
//! dead-lettered job back in the queue, or discarding it - live here too. That
//! is deliberate: the catalogue refuses to ship an alert type with no action,
//! and there is no background-jobs page to send the operator to.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use kubuno_db::params;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::alerts::{
    catalog,
    model::{clean_comment, Status},
    store::{self, AlertQuery},
};
use crate::audit::{redact::target, AdminAudit, AuditEntry};
use crate::auth::middleware::AdminUser;
use crate::authz::{keys, AdminCtx};
use crate::errors::AppError;
use crate::jobs::queue;
use crate::state::AppState;

/// Ceiling on a bulk operation. High enough to clear a screenful of noise in one
/// gesture, low enough that a mistyped selection is not a thousand audit rows.
const MAX_BULK: usize = 100;

/// Display label of the acting operator, denormalised onto the timeline so the
/// history stays readable once the account is gone.
fn actor_label(user: &crate::models::user::User) -> String {
    match user.display_name.as_deref() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => user.username.clone(),
    }
}

// ── Reads ────────────────────────────────────────────────────────────────────

/// `GET /api/v1/admin/alerts` - one page of the queue.
pub async fn list_alerts(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Query(q): Query<AlertQuery>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_READ)?;
    let page = store::list(&state.db, &q, &ctx).await?;
    Ok(Json(json!({
        "alerts":      page.rows,
        "next_cursor": page.next_cursor,
    })))
}

/// `GET /api/v1/admin/alerts/summary` - the counters behind the badges.
///
/// Computed server-side so the bell, the landing card and the queue cannot
/// disagree about how many criticals are open.
pub async fn alerts_summary(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_READ)?;
    let summary = store::summary(&state.db, &ctx).await?;
    Ok(Json(json!(summary)))
}

/// `GET /api/v1/admin/alerts/facets` - distinct kinds and sources present, plus
/// the accounts an alert may be handed to.
pub async fn alerts_facets(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_READ)?;
    let (kinds, sources) = store::facets(&state.db, &ctx).await?;
    let assignees: Vec<Value> = store::eligible_assignees(&state.db)
        .await?
        .into_iter()
        .map(|(id, label)| json!({ "id": id, "label": label }))
        .collect();
    // The whole catalogue travels too, so the filter select offers a type the
    // instance has not produced yet instead of only what is already wrong.
    Ok(Json(json!({
        "kinds":       kinds,
        "sources":     sources,
        "assignees":   assignees,
        "all_kinds":   catalog::ALL_KINDS,
    })))
}

/// `GET /api/v1/admin/alerts/:id` - one alert, its timeline and its siblings.
pub async fn get_alert(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_READ)?;
    let alert = store::get(&state.db, id, &ctx).await?;
    let timeline = store::timeline(&state.db, id).await?;
    let related = store::related(&state.db, &alert, &ctx).await?;
    Ok(Json(json!({
        "alert":    alert,
        "timeline": timeline,
        "related":  related,
    })))
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct StatusDto {
    pub status: String,
    /// Optional note recorded on the timeline with the transition - "why did you
    /// close this?" is the question the next operator always asks.
    #[serde(default)]
    pub comment: Option<String>,
}

/// `POST /api/v1/admin/alerts/:id/status`
pub async fn set_alert_status(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<StatusDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_MANAGE)?;

    let next = Status::parse(dto.status.trim())
        .ok_or_else(|| AppError::Validation("Unknown alert state".into()))?;
    let note = match dto.comment.as_deref() {
        Some(raw) if !raw.trim().is_empty() => Some(clean_comment(raw)?),
        _ => None,
    };

    // Read first so the entry can name the alert even if the transition is
    // refused, and so the caller's perimeter is checked before anything moves.
    let alert = store::get(&state.db, id, &ctx).await?;

    let label = actor_label(&audit.admin);
    let mut tx = audit.begin(&state.db).await?;
    let previous = match store::set_status(
        &mut tx,
        id,
        next,
        audit.admin.id,
        &label,
        note.as_deref(),
    )
    .await
    {
        Ok(previous) => previous,
        Err(e) => {
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.alerts.status")
                        .module("core")
                        .target(target::ALERT, id, alert.title.clone()),
                    e,
                )
                .await)
        }
    };

    tx.commit(
        AuditEntry::new("core.alerts.status")
            .module("core")
            .target(target::ALERT, id, alert.title.clone())
            .before(json!({ "status": previous.as_str() }))
            .after(json!({ "status": next.as_str() }))
            .detail(note.clone().unwrap_or_else(|| alert.kind.clone())),
    )
    .await?;

    Ok(Json(json!({ "status": next.as_str(), "previous": previous.as_str() })))
}

#[derive(Debug, Deserialize)]
pub struct AssignDto {
    /// `null` clears the assignment. Exactly one assignee, never a list: a list
    /// is how everybody assumes somebody else is on it.
    pub assignee_id: Option<Uuid>,
}

/// `POST /api/v1/admin/alerts/:id/assign`
pub async fn assign_alert(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<AssignDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_MANAGE)?;
    let alert = store::get(&state.db, id, &ctx).await?;

    // Refused before anything is written: handing work to somebody who cannot
    // open the alert centre is how an alert sits untouched for a week.
    let assignee = match dto.assignee_id {
        Some(uid) => Some((uid, store::eligible_assignee(&state.db, uid).await?)),
        None => None,
    };

    let label = actor_label(&audit.admin);
    let mut tx = audit.begin(&state.db).await?;
    let previous = store::set_assignee(&mut tx, id, assignee.clone(), audit.admin.id, &label).await?;

    tx.commit(
        AuditEntry::new("core.alerts.assign")
            .module("core")
            .target(target::ALERT, id, alert.title.clone())
            .before(json!({ "assignee": previous }))
            .after(json!({ "assignee": assignee.as_ref().map(|(_, l)| l.clone()) })),
    )
    .await?;

    Ok(Json(json!({
        "assignee_id":    assignee.as_ref().map(|(uid, _)| *uid),
        "assignee_label": assignee.map(|(_, l)| l),
    })))
}

#[derive(Debug, Deserialize)]
pub struct CommentDto {
    pub comment: String,
}

/// `POST /api/v1/admin/alerts/:id/comment`
///
/// Not audited: a comment changes nothing about the instance, and an audit row
/// per handover note would bury the transitions that matter. It lands on the
/// alert's own timeline, with its author, which is where it is read.
pub async fn comment_alert(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<CommentDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_MANAGE)?;
    let body = clean_comment(&dto.comment)?;
    // Perimeter check: `get` refuses a kind the caller may not read.
    store::get(&state.db, id, &ctx).await?;

    let label = actor_label(&audit.admin);
    let mut tx = state.db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "alerts: connexion pour l'ajout d'un commentaire");
        AppError::Database(e)
    })?;
    store::add_comment(&mut tx, id, &body, audit.admin.id, &label).await?;
    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "alerts: validation de l'ajout d'un commentaire");
        AppError::Database(e)
    })?;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct BulkDto {
    pub ids: Vec<Uuid>,
    /// Applied to every alert in `ids`. One of the two must be present.
    #[serde(default)]
    pub status: Option<String>,
    /// `Some(None)` is not expressible in JSON, so clearing an assignment in
    /// bulk is done by sending `assign: true` with a null `assignee_id`.
    #[serde(default)]
    pub assign: Option<bool>,
    #[serde(default)]
    pub assignee_id: Option<Uuid>,
}

/// `POST /api/v1/admin/alerts/bulk` - the same transition over a selection.
///
/// Each alert gets its **own** audited transaction: a bulk gesture is a
/// convenience for the operator, not a reason for the trail to lose track of
/// which alerts actually moved. A failure part-way leaves the ones already
/// committed committed, and says how many.
pub async fn bulk_alerts(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<BulkDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_MANAGE)?;

    if dto.ids.is_empty() {
        return Err(AppError::Validation("No alerts selected".into()));
    }
    if dto.ids.len() > MAX_BULK {
        return Err(AppError::Validation(format!(
            "Selection too large: maximum {MAX_BULK} alerts"
        )));
    }

    let next = match dto.status.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(
            Status::parse(raw).ok_or_else(|| AppError::Validation("Unknown alert state".into()))?,
        ),
        None => None,
    };
    let assign = dto.assign.unwrap_or(false);
    if next.is_none() && !assign {
        return Err(AppError::Validation("No operation requested".into()));
    }

    let assignee = match (assign, dto.assignee_id) {
        (true, Some(uid)) => Some((uid, store::eligible_assignee(&state.db, uid).await?)),
        _ => None,
    };

    let label = actor_label(&audit.admin);
    let mut applied = 0usize;
    let mut skipped = 0usize;

    for id in &dto.ids {
        // Perimeter and existence, per alert. A selection built from a stale
        // page must not become a way to touch something out of reach.
        let alert = match store::get(&state.db, *id, &ctx).await {
            Ok(a) => a,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        let mut tx = audit.begin(&state.db).await?;
        let mut entry = AuditEntry::new("core.alerts.bulk")
            .module("core")
            .target(target::ALERT, id, alert.title.clone());

        let mut moved = false;
        if let Some(next) = next {
            match store::set_status(&mut tx, *id, next, audit.admin.id, &label, None).await {
                Ok(previous) => {
                    entry = entry
                        .before(json!({ "status": previous.as_str() }))
                        .after(json!({ "status": next.as_str() }));
                    moved = true;
                }
                // Already in that state: not an error, just nothing to do.
                Err(AppError::Validation(_)) => {}
                Err(e) => return Err(tx.abort(&state.db, entry, e).await),
            }
        }
        if assign {
            let previous =
                store::set_assignee(&mut tx, *id, assignee.clone(), audit.admin.id, &label).await?;
            entry = entry
                .before(json!({ "assignee": previous }))
                .after(json!({ "assignee": assignee.as_ref().map(|(_, l)| l.clone()) }));
            moved = true;
        }

        if moved {
            tx.commit(entry).await?;
            applied += 1;
        } else {
            skipped += 1;
        }
    }

    Ok(Json(json!({ "applied": applied, "skipped": skipped })))
}

// ── Verbs the alert centre performs itself ───────────────────────────────────

/// Reads the job type an alert is about, refusing anything that is not a
/// dead-letter alert.
async fn dead_letter_job_type(
    state: &AppState,
    ctx: &AdminCtx,
    id: Uuid,
) -> Result<(crate::alerts::AlertRow, String), AppError> {
    let alert = store::get(&state.db, id, ctx).await?;
    if alert.kind != catalog::JOB_DEAD_LETTER {
        return Err(AppError::Validation(
            "This action only applies to failed-job alerts".into(),
        ));
    }
    let job_type = alert
        .payload
        .get("job_type")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            tracing::error!(alert_id = %id, "alerts: alerte de tâche sans type de tâche");
            AppError::Validation("Incomplete alert: missing job type".into())
        })?
        .to_string();
    Ok((alert, job_type))
}

/// `POST /api/v1/admin/alerts/:id/retry-jobs`
///
/// Puts every job of the alert's type that gave up back in the queue, resets its
/// attempt counter and wakes the runners. Then closes the alert: the condition
/// that produced it no longer holds, and the next scan would close it anyway -
/// doing it here is what makes the button feel like it worked.
pub async fn retry_dead_jobs(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_MANAGE)?;
    let (alert, job_type) = dead_letter_job_type(&state, &ctx, id).await?;

    let requeued = state
        .db
        .execute(
            r#"UPDATE core.jobs
                  SET status = 'pending', attempts = 0, run_after = $2,
                      error = NULL, started_at = NULL, done_at = NULL
                WHERE status = 'failed' AND job_type = $1"#,
            params![&job_type, chrono::Utc::now()],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, job_type = %job_type, "alerts: remise en file des tâches en échec");
            AppError::Database(e)
        })?;

    queue::notify_runners(&state.db).await;

    let label = actor_label(&audit.admin);
    let note = format!("{requeued} tâche(s) « {job_type} » remise(s) en file.");
    let mut tx = audit.begin(&state.db).await?;
    // The alert may already be closed (two operators, one button); that is not
    // an error worth failing the retry over.
    if let Err(e) = store::set_status(
        &mut tx,
        id,
        Status::Resolved,
        audit.admin.id,
        &label,
        Some(&note),
    )
    .await
    {
        if !matches!(e, AppError::Validation(_)) {
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.alerts.retry_jobs")
                        .module("core")
                        .target(target::ALERT, id, alert.title.clone()),
                    e,
                )
                .await);
        }
    }
    tx.commit(
        AuditEntry::new("core.alerts.retry_jobs")
            .module("core")
            .target(target::ALERT, id, alert.title.clone())
            .after(json!({ "job_type": job_type, "requeued": requeued }))
            .detail(note.clone()),
    )
    .await?;

    Ok(Json(json!({ "requeued": requeued, "job_type": job_type })))
}

/// `POST /api/v1/admin/alerts/:id/discard-jobs`
///
/// The other honest answer to a dead-lettered job: this work is not worth
/// retrying. Deletes the failed rows and closes the alert, both recorded.
pub async fn discard_dead_jobs(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_MANAGE)?;
    let (alert, job_type) = dead_letter_job_type(&state, &ctx, id).await?;

    let discarded = state
        .db
        .execute(
            "DELETE FROM core.jobs WHERE status = 'failed' AND job_type = $1",
            params![&job_type],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, job_type = %job_type, "alerts: abandon des tâches en échec");
            AppError::Database(e)
        })?;

    let label = actor_label(&audit.admin);
    let note = format!("{discarded} tâche(s) « {job_type} » abandonnée(s).");
    let mut tx = audit.begin(&state.db).await?;
    if let Err(e) = store::set_status(
        &mut tx,
        id,
        Status::Resolved,
        audit.admin.id,
        &label,
        Some(&note),
    )
    .await
    {
        if !matches!(e, AppError::Validation(_)) {
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.alerts.discard_jobs")
                        .module("core")
                        .target(target::ALERT, id, alert.title.clone()),
                    e,
                )
                .await);
        }
    }
    tx.commit(
        AuditEntry::new("core.alerts.discard_jobs")
            .module("core")
            .target(target::ALERT, id, alert.title.clone())
            .after(json!({ "job_type": job_type, "discarded": discarded }))
            .detail(note.clone()),
    )
    .await?;

    Ok(Json(json!({ "discarded": discarded, "job_type": job_type })))
}

/// `POST /api/v1/admin/alerts/scan` - run the producers now.
///
/// The scan is a scheduled job; this is the "I just fixed it, check again"
/// button, and it is the same code path rather than a second implementation.
pub async fn scan_now(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_MANAGE)?;
    let report = crate::alerts::producers::run_all(&state.db, &state.settings).await?;
    Ok(Json(json!(report)))
}

// ── Saved filter sets ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ViewDto {
    pub name: String,
    pub filters: Value,
}

/// `GET /api/v1/admin/alerts/views`
pub async fn list_alert_views(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_READ)?;
    let views = store::list_views(&state.db, ctx.user_id).await?;
    Ok(Json(json!({ "views": views })))
}

/// `POST /api/v1/admin/alerts/views` - save (or overwrite) a filter set.
///
/// Owned by the caller, so it needs no management privilege: a personal working
/// set changes nothing anybody else sees.
pub async fn save_alert_view(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Json(dto): Json<ViewDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_READ)?;
    let view = store::save_view(&state.db, ctx.user_id, &dto.name, &dto.filters).await?;
    Ok(Json(json!(view)))
}

/// `DELETE /api/v1/admin/alerts/views/:id`
pub async fn delete_alert_view(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ALERTS_READ)?;
    store::delete_view(&state.db, ctx.user_id, id).await?;
    Ok(Json(json!({ "ok": true })))
}
