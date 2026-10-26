//! Persistence of the alert centre: raising (with deduplication), reading,
//! and the lifecycle transitions.
//!
//! Every statement targets the `core` schema and nothing else.
//!
//! ## Raising is an upsert, always
//!
//! [`raise`] never asks "have I already said this?". It states the observation
//! and lets the partial unique index decide whether that is a new problem or the
//! same one again. A producer therefore has no memory to keep, no window to
//! track, and no way to write two hundred rows about a module that has been down
//! since Tuesday.

use chrono::{DateTime, Duration, Utc};
use kubuno_db::dialect::Assign;
use kubuno_db::{new_id, params, Backend, DbPool, DbQueryBuilder, DbTx};
use serde_json::Value;
use uuid::Uuid;

use super::catalog;
use super::model::{
    Action, AlertEventRow, AlertRow, AlertSummary, AlertView, EventKind, NewAlert, RaiseOutcome,
    Severity, Status,
};
use crate::authz::AdminContext;
use crate::errors::AppError;

/// Page size ceiling: the queue paints cards on mobile and a dense table on the
/// desktop, and beyond this the payload costs more than it shows.
pub const MAX_LIMIT: i64 = 200;
pub const DEFAULT_LIMIT: i64 = 50;

/// Label recorded on the timeline for work the server did on its own.
pub const SYSTEM_ACTOR: &str = "System";

// Macros rather than `const`s so call sites splice them with `concat!`: each
// query is then a single `&'static str` literal fixed at compile time, and the
// caller's filters all travel as bind parameters.
macro_rules! select_columns {
    () => {
        r#"
    a.id, a.source, a.kind, a.severity, a.status, a.title, a.summary, a.payload,
    a.module_id, a.subject_user_id, a.org_unit_id, a.is_simulation,
    a.occurrences, a.first_seen_at, a.last_seen_at,
    a.assignee_id, a.assigned_at, a.closed_at, a.created_at,
    s.username        AS subject_label,
    COALESCE(NULLIF(g.display_name, ''), g.username) AS assignee_label
"#
    };
}

/// The clause that quarantines simulation alerts.
///
/// A rule in simulation still raises what it *would* have raised - that is the
/// point of the mode. But those alerts must never reach a badge, a counter or a
/// notification, or "simulation" becomes a synonym for "enabled, loudly". This
/// is applied to every default read; seeing them requires asking for them by
/// name (`?simulation=true` on the queue).
macro_rules! not_simulated {
    () => {
        "a.is_simulation = FALSE"
    };
}

macro_rules! from_joins {
    () => {
        r#"
    FROM core.alerts a
    LEFT JOIN core.users s ON s.id = a.subject_user_id
    LEFT JOIN core.users g ON g.id = a.assignee_id
"#
    };
}

/// The raw alert row as the joins return it, before its actions are computed.
#[derive(sqlx::FromRow)]
struct RawAlert {
    id: Uuid,
    source: String,
    kind: String,
    severity: String,
    status: String,
    title: String,
    summary: Option<String>,
    payload: Value,
    module_id: Option<String>,
    subject_user_id: Option<Uuid>,
    org_unit_id: Option<Uuid>,
    is_simulation: bool,
    occurrences: i32,
    first_seen_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    assignee_id: Option<Uuid>,
    assigned_at: Option<DateTime<Utc>>,
    closed_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    subject_label: Option<String>,
    assignee_label: Option<String>,
}

fn map_raw(r: RawAlert) -> AlertRow {
    let actions = catalog::actions_for(&r.kind, &r.payload, r.id);
    AlertRow {
        id: r.id,
        source: r.source,
        kind: r.kind,
        severity: r.severity,
        status: r.status,
        title: r.title,
        summary: r.summary,
        payload: r.payload,
        module_id: r.module_id,
        subject_user_id: r.subject_user_id,
        subject_label: r.subject_label,
        org_unit_id: r.org_unit_id,
        is_simulation: r.is_simulation,
        occurrences: r.occurrences,
        first_seen_at: r.first_seen_at,
        last_seen_at: r.last_seen_at,
        assignee_id: r.assignee_id,
        assignee_label: r.assignee_label,
        assigned_at: r.assigned_at,
        closed_at: r.closed_at,
        created_at: r.created_at,
        actions,
    }
}

/// Narrows a row's actions to the ones the caller may actually perform.
///
/// Called on every read. Offering a button the server would refuse tells the
/// operator the console is broken rather than that they lack a privilege.
pub fn visible_actions(ctx: &AdminContext, actions: Vec<Action>) -> Vec<Action> {
    actions.into_iter().filter(|a| ctx.has(&a.privilege)).collect()
}

/// Kinds the caller may **not** read.
///
/// Expressed as a deny-list rather than an allow-list on purpose: a row written
/// by a newer core, whose kind this build does not know, stays visible to anyone
/// holding `core.alerts.read` instead of silently vanishing from the queue.
pub fn denied_kinds(ctx: &AdminContext) -> Vec<String> {
    catalog::ALL_KINDS
        .iter()
        .filter(|k| !ctx.has(catalog::read_privilege(k)))
        .map(|k| (*k).to_string())
        .collect()
}

// ── Raising ──────────────────────────────────────────────────────────────────

/// States an observation, creating the alert or folding it into the existing one.
///
/// A pre-existing alert whose problem is not `resolved` absorbs the observation
/// (counter up, `last_seen_at` moved, wording refreshed); an **ignored** alert
/// absorbs it silently - that is what the button promised; a **resolved** alert
/// does not, because the problem came back and a regression hidden inside
/// somebody else's counter is a regression nobody sees.
pub async fn raise(db: &DbPool, alert: NewAlert) -> Result<RaiseOutcome, AppError> {
    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, kind = %alert.kind, "alerts: ouverture de la transaction de levée");
        AppError::Database(e)
    })?;

    // The pre-existing open alert for this dedup key, read before the write so
    // the severity the row had *before* this observation is known - it is what
    // decides whether the timeline records an escalation. PostgreSQL folded the
    // read and the upsert into a single CTE with `(xmax = 0)` to tell insert
    // from update; neither the partial-index `ON CONFLICT` nor `xmax` has an
    // engine-agnostic form, so the read and the write are done explicitly here.
    let prev = tx
        .fetch_optional_row(
            "SELECT id, severity FROM core.alerts WHERE dedup_key = $1 AND status <> 'resolved'",
            params![&alert.dedup_key],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, kind = %alert.kind, "alerts: levée d'une alerte");
            AppError::Database(e)
        })?;

    let now = Utc::now();
    let (id, occurrences, created, prev_severity): (Uuid, i32, bool, Option<String>) =
        if let Some(row) = prev {
            let existing_id: Uuid = row.try_get("id").map_err(AppError::Database)?;
            let before: String = row.try_get("severity").map_err(AppError::Database)?;
            tx.execute(
                r#"UPDATE core.alerts
                      SET occurrences  = occurrences + 1,
                          last_seen_at = $1,
                          severity     = $2,
                          title        = $3,
                          summary      = $4,
                          payload      = $5
                    WHERE id = $6"#,
                params![
                    now,
                    alert.severity.as_str(),
                    &alert.title,
                    alert.summary.as_deref(),
                    alert.payload.clone(),
                    existing_id
                ],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, kind = %alert.kind, "alerts: levée d'une alerte");
                AppError::Database(e)
            })?;
            let occ: i32 = tx
                .fetch_optional_scalar::<i32>(
                    "SELECT occurrences FROM core.alerts WHERE id = $1",
                    params![existing_id],
                )
                .await
                .map_err(AppError::Database)?
                .unwrap_or(0);
            (existing_id, occ, false, Some(before))
        } else {
            let fresh = new_id();
            tx.execute(
                r#"INSERT INTO core.alerts
                       (id, source, kind, severity, title, summary, payload,
                        module_id, subject_user_id, org_unit_id, dedup_key, is_simulation,
                        occurrences, first_seen_at, last_seen_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $14)"#,
                params![
                    fresh,
                    alert.source,
                    alert.kind,
                    alert.severity.as_str(),
                    &alert.title,
                    alert.summary.as_deref(),
                    alert.payload.clone(),
                    alert.module_id.as_deref(),
                    alert.subject_user_id,
                    alert.org_unit_id,
                    &alert.dedup_key,
                    alert.is_simulation,
                    now,
                    now
                ],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, kind = %alert.kind, "alerts: levée d'une alerte");
                AppError::Database(e)
            })?;
            (fresh, 1, true, None)
        };

    if created {
        // No body: the summary is already the alert's own, rendered in the
        // reader's language two lines above the timeline. Copying the server's
        // English wording here would be the one untranslated sentence on the
        // screen - and a stale one, since the alert's summary is refreshed on
        // every recurrence while a timeline entry never changes.
        record_event(
            &mut tx,
            id,
            EventKind::Created,
            None,
            SYSTEM_ACTOR,
            None,
            Some(alert.severity.as_str()),
            None,
        )
        .await?;
    } else {
        // The recurrence itself. One line per observation would drown the
        // timeline, so it carries the running count instead.
        record_event(
            &mut tx,
            id,
            EventKind::Recurrence,
            None,
            SYSTEM_ACTOR,
            None,
            Some(&occurrences.to_string()),
            None,
        )
        .await?;

        if let Some(before) = prev_severity.as_deref() {
            if before != alert.severity.as_str() {
                record_event(
                    &mut tx,
                    id,
                    EventKind::SeverityChanged,
                    None,
                    SYSTEM_ACTOR,
                    Some(before),
                    Some(alert.severity.as_str()),
                    None,
                )
                .await?;
            }
        }
    }

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, kind = %alert.kind, "alerts: commit de la levée");
        AppError::Database(e)
    })?;

    Ok(RaiseOutcome { id, created, occurrences })
}

/// The stale open alert, read before the transitions that resolve it.
#[derive(sqlx::FromRow)]
struct StaleRow {
    id: Uuid,
    status: String,
}

/// Closes the open alerts of `kind` whose problem is no longer observed.
///
/// `live` is the exhaustive set of dedup keys the producer just saw. Anything
/// open outside it has gone away, and leaving it in the queue would teach the
/// operator that the queue lies. The closure is recorded as a system transition
/// with its reason, never as a silent delete.
///
/// Returns the number of alerts closed.
pub async fn auto_resolve(db: &DbPool, kind: &str, live: &[String]) -> Result<u64, AppError> {
    // The stale open alerts of this kind. `live` is the set still observed;
    // anything open outside it is stale. An empty `live` means the producer saw
    // nothing, so every open alert of the kind is stale.
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        "SELECT id, status FROM core.alerts WHERE kind = ",
    );
    qb.push_bind(kind);
    qb.push(" AND status").push_in([
        Status::New.as_str().to_string(),
        Status::Acknowledged.as_str().to_string(),
    ]);
    if !live.is_empty() {
        qb.push(" AND dedup_key NOT").push_in(live.iter().cloned());
    }
    let stale: Vec<StaleRow> = qb.fetch_all_as::<StaleRow>(db).await.map_err(|e| {
        tracing::error!(error = %e, kind = %kind, "alerts: recherche des alertes obsolètes");
        AppError::Database(e)
    })?;

    if stale.is_empty() {
        return Ok(0);
    }

    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "alerts: ouverture de la transaction de clôture automatique");
        AppError::Database(e)
    })?;

    let now = Utc::now();
    let mut closed = 0u64;
    for row in &stale {
        // The status guard replaces the former `FOR UPDATE`: the row transitions
        // only if it is still open, so a concurrent change cannot be overwritten.
        let affected = tx
            .execute(
                "UPDATE core.alerts SET status = 'resolved', closed_at = $1 \
                  WHERE id = $2 AND status IN ('new', 'acknowledged')",
                params![now, row.id],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, alert_id = %row.id, "alerts: clôture automatique");
                AppError::Database(e)
            })?;
        if affected == 1 {
            record_event(
                &mut tx,
                row.id,
                EventKind::StatusChanged,
                None,
                SYSTEM_ACTOR,
                Some(&row.status),
                Some(Status::Resolved.as_str()),
                Some("The condition is no longer observed."),
            )
            .await?;
            closed += 1;
        }
    }

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "alerts: commit de la clôture automatique");
        AppError::Database(e)
    })?;

    tracing::info!(kind = %kind, closed, "Alertes closes automatiquement");
    Ok(closed)
}

// ── Timeline ─────────────────────────────────────────────────────────────────

/// One timeline row as stored, before it becomes an [`AlertEventRow`].
#[derive(sqlx::FromRow)]
struct RawEvent {
    id: i64,
    kind: String,
    actor_id: Option<Uuid>,
    actor_label: String,
    from_value: Option<String>,
    to_value: Option<String>,
    body: Option<String>,
    occurred_at: DateTime<Utc>,
}

/// Appends one line to an alert's history.
///
/// Takes a transaction rather than a pool so a transition and its timeline entry
/// land in the same commit as the mutation - the same discipline as
/// [`crate::audit::AuditTx`], for the same reason.
#[allow(clippy::too_many_arguments)]
pub async fn record_event(
    tx: &mut DbTx,
    alert_id: Uuid,
    kind: EventKind,
    actor_id: Option<Uuid>,
    actor_label: &str,
    from_value: Option<&str>,
    to_value: Option<&str>,
    body: Option<&str>,
) -> Result<(), AppError> {
    tx.execute(
        r#"INSERT INTO core.alert_events
               (alert_id, kind, actor_id, actor_label, from_value, to_value, body)
           VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        params![
            alert_id,
            kind.as_str(),
            actor_id,
            actor_label,
            from_value,
            to_value,
            body
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, alert_id = %alert_id, "alerts: écriture d'un événement de fil");
        AppError::Database(e)
    })?;
    Ok(())
}

pub async fn timeline(db: &DbPool, alert_id: Uuid) -> Result<Vec<AlertEventRow>, AppError> {
    let rows = db
        .fetch_all_as::<RawEvent>(
            r#"SELECT id, kind, actor_id, actor_label, from_value, to_value, body, occurred_at
                 FROM core.alert_events
                WHERE alert_id = $1
                ORDER BY occurred_at ASC, id ASC
                LIMIT 500"#,
            params![alert_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, alert_id = %alert_id, "alerts: lecture du fil chronologique");
            AppError::Database(e)
        })?;

    Ok(rows
        .into_iter()
        .map(|r| AlertEventRow {
            id: r.id,
            kind: r.kind,
            actor_id: r.actor_id,
            actor_label: r.actor_label,
            from_value: r.from_value,
            to_value: r.to_value,
            body: r.body,
            occurred_at: r.occurred_at,
        })
        .collect())
}

// ── Reading ──────────────────────────────────────────────────────────────────

/// Filters of `GET /admin/alerts`. Every field is optional; an absent one means
/// "no restriction", never "match nothing".
#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct AlertQuery {
    /// Comma-separated statuses. Absent means the open queue (`new`,
    /// `acknowledged`) - the state an operator actually wants on arrival.
    pub status: Option<String>,
    pub severity: Option<String>,
    pub kind: Option<String>,
    pub source: Option<String>,
    pub module_id: Option<String>,
    /// `me` resolves to the caller; a uuid to that account; `none` to unassigned.
    pub assignee: Option<String>,
    /// The account an alert is about.
    pub subject_user_id: Option<Uuid>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    /// Free text over title, summary and kind.
    pub q: Option<String>,
    pub limit: Option<i64>,
    /// Offset-free position: `<rfc3339>|<uuid>` of the last row returned.
    pub cursor: Option<String>,
    /// Show what rules in **simulation** would have raised, instead of the real
    /// queue. Absent means the real queue: simulated alerts are opt-in by name,
    /// never mixed in and never merely filtered out by a default the console
    /// could forget to send.
    pub simulation: Option<bool>,
}

fn split_csv(raw: Option<&String>) -> Option<Vec<String>> {
    let value = raw?.trim();
    if value.is_empty() {
        return None;
    }
    let parts: Vec<String> = value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    (!parts.is_empty()).then_some(parts)
}

/// Opaque position in the descending `(last_seen_at, id)` ordering.
pub fn encode_cursor(at: DateTime<Utc>, id: Uuid) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{}|{id}", at.to_rfc3339()))
}

fn decode_cursor(raw: &str) -> Option<(DateTime<Utc>, Uuid)> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw.trim())
        .ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let (at, id) = text.rsplit_once('|')?;
    Some((
        DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&Utc),
        Uuid::parse_str(id).ok()?,
    ))
}

pub struct Page {
    pub rows: Vec<AlertRow>,
    pub next_cursor: Option<String>,
}

/// One page of the queue, worst-and-newest first, narrowed to what the caller
/// may read.
pub async fn list(db: &DbPool, q: &AlertQuery, ctx: &AdminContext) -> Result<Page, AppError> {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let cursor = q.cursor.as_deref().and_then(decode_cursor);

    // Default view: the work still to do. Asking for everything is explicit.
    let statuses = split_csv(q.status.as_ref())
        .unwrap_or_else(|| vec![Status::New.as_str().into(), Status::Acknowledged.as_str().into()]);
    let severities = split_csv(q.severity.as_ref());
    let kinds = split_csv(q.kind.as_ref());
    let denied = denied_kinds(ctx);

    // `me` / `none` are resolved here rather than in the query string, so a
    // saved filter set stays meaningful when another operator opens it.
    let (assignee_id, unassigned_only) = match q.assignee.as_deref().map(str::trim) {
        Some("me") => (Some(ctx.user_id), false),
        Some("none") => (None, true),
        Some(raw) if !raw.is_empty() => (Uuid::parse_str(raw).ok(), false),
        _ => (None, false),
    };

    let backend = db.backend();
    let mut qb = DbQueryBuilder::new(
        backend,
        concat!("SELECT ", select_columns!(), from_joins!()),
    );
    qb.push(" WHERE a.status").push_in(&statuses);
    if let Some(sev) = severities.as_ref() {
        qb.push(" AND a.severity").push_in(sev);
    }
    if let Some(k) = kinds.as_ref() {
        qb.push(" AND a.kind").push_in(k);
    }
    if !denied.is_empty() {
        qb.push(" AND a.kind NOT").push_in(&denied);
    }
    if let Some(src) = q.source.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND a.source = ").push_bind(src);
    }
    if let Some(m) = q.module_id.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND a.module_id = ").push_bind(m);
    }
    if let Some(aid) = assignee_id {
        qb.push(" AND a.assignee_id = ").push_bind(aid);
    }
    if unassigned_only {
        qb.push(" AND a.assignee_id IS NULL");
    }
    if let Some(subj) = q.subject_user_id {
        qb.push(" AND a.subject_user_id = ").push_bind(subj);
    }
    if let Some(from) = q.from {
        qb.push(" AND a.last_seen_at >= ").push_bind(from);
    }
    if let Some(to) = q.to {
        qb.push(" AND a.last_seen_at <= ").push_bind(to);
    }
    if let Some(text) = q.q.as_deref().filter(|s| !s.is_empty()) {
        let pat = format!("%{text}%");
        // Case-insensitive match over the three text columns, spelled per engine
        // (`dialect::ilike`, inlined so the builder can number each bind).
        qb.push(" AND (");
        for (i, col) in ["a.title", "a.summary", "a.kind"].iter().enumerate() {
            if i > 0 {
                qb.push(" OR ");
            }
            match backend {
                Backend::Postgres => {
                    qb.push(*col).push(" ILIKE ").push_bind(pat.clone());
                }
                _ => {
                    qb.push("LOWER(")
                        .push(*col)
                        .push(") LIKE LOWER(")
                        .push_bind(pat.clone())
                        .push(")");
                }
            }
        }
        qb.push(")");
    }
    if let Some((at, id)) = cursor {
        // The tuple comparison `(last_seen_at, id) < (at, id)`, expanded into the
        // portable form so the same page boundary holds on every engine.
        qb.push(" AND (a.last_seen_at < ")
            .push_bind(at)
            .push(" OR (a.last_seen_at = ")
            .push_bind(at)
            .push(" AND a.id < ")
            .push_bind(id)
            .push("))");
    }
    qb.push(" AND a.is_simulation = ")
        .push_bind(q.simulation.unwrap_or(false));
    qb.push_order_by("a.last_seen_at DESC, a.id DESC");
    // One extra row answers "is there a next page?" without a COUNT.
    qb.push(" LIMIT ").push_bind(limit + 1);

    let rows: Vec<RawAlert> = qb.fetch_all_as::<RawAlert>(db).await.map_err(|e| {
        tracing::error!(error = %e, "alerts: lecture de la file");
        AppError::Database(e)
    })?;

    let has_more = rows.len() as i64 > limit;
    let mut out: Vec<AlertRow> = rows
        .into_iter()
        .take(limit as usize)
        .map(|r| {
            let mut row = map_raw(r);
            row.actions = visible_actions(ctx, std::mem::take(&mut row.actions));
            row
        })
        .collect();

    let next_cursor = has_more
        .then(|| out.last().map(|r| encode_cursor(r.last_seen_at, r.id)))
        .flatten();

    // Nothing else touches `out` after this; the binding keeps the intent clear.
    out.shrink_to_fit();
    Ok(Page { rows: out, next_cursor })
}

/// One alert. Refuses a kind the caller may not read, exactly like the list.
pub async fn get(db: &DbPool, id: Uuid, ctx: &AdminContext) -> Result<AlertRow, AppError> {
    let sql = concat!("SELECT ", select_columns!(), from_joins!(), " WHERE a.id = $1");
    let row = db
        .fetch_optional_as::<RawAlert>(sql, params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, alert_id = %id, "alerts: lecture d'une alerte");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Alert not found".into()))?;

    let mut alert = map_raw(row);
    if !ctx.has(catalog::read_privilege(&alert.kind)) {
        tracing::warn!(
            user_id = %ctx.user_id, kind = %alert.kind,
            "alerts: type d'alerte hors du périmètre de l'appelant"
        );
        return Err(AppError::Forbidden);
    }
    alert.actions = visible_actions(ctx, alert.actions);
    Ok(alert)
}

/// Alerts that share the same problem space: same kind, or same account.
///
/// The point is the question an operator asks after opening one alert - "is this
/// the only one?" - answered without going back to the queue and re-filtering.
pub async fn related(db: &DbPool, alert: &AlertRow, ctx: &AdminContext) -> Result<Vec<AlertRow>, AppError> {
    let denied = denied_kinds(ctx);
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        concat!("SELECT ", select_columns!(), from_joins!()),
    );
    qb.push(" WHERE a.id <> ").push_bind(alert.id);
    if !denied.is_empty() {
        qb.push(" AND a.kind NOT").push_in(&denied);
    }
    qb.push(" AND ").push(not_simulated!());
    qb.push(" AND (a.kind = ").push_bind(&alert.kind);
    if let Some(subj) = alert.subject_user_id {
        qb.push(" OR a.subject_user_id = ").push_bind(subj);
    }
    qb.push(")");
    qb.push_order_by("a.last_seen_at DESC");
    qb.push(" LIMIT 10");

    let rows: Vec<RawAlert> = qb.fetch_all_as::<RawAlert>(db).await.map_err(|e| {
        tracing::error!(error = %e, alert_id = %alert.id, "alerts: lecture des alertes liées");
        AppError::Database(e)
    })?;
    Ok(rows.into_iter().map(map_raw).collect())
}

/// The badge counts, hand-mapped from a single aggregate row.
#[derive(sqlx::FromRow)]
struct SummaryRow {
    open: i64,
    fresh: i64,
    acknowledged: i64,
    critical: i64,
    warning: i64,
    info: i64,
    ignored: i64,
    resolved: i64,
    mine: i64,
}

/// Counts for the badges, and when the producers last ran.
pub async fn summary(db: &DbPool, ctx: &AdminContext) -> Result<AlertSummary, AppError> {
    let backend = db.backend();
    let denied = denied_kinds(ctx);

    // `COUNT(*) FILTER (WHERE c)` has no MySQL form, so every conditional count
    // is expressed as `SUM(CASE WHEN c THEN 1 ELSE 0 END)`, wrapped by
    // `sum_bigint` (COALESCE to 0, cast to bigint) so it decodes as `i64`.
    let open = backend.sum_bigint("CASE WHEN status IN ('new','acknowledged') THEN 1 ELSE 0 END");
    let fresh = backend.sum_bigint("CASE WHEN status = 'new' THEN 1 ELSE 0 END");
    let ack = backend.sum_bigint("CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END");
    let critical = backend
        .sum_bigint("CASE WHEN status IN ('new','acknowledged') AND severity = 'critical' THEN 1 ELSE 0 END");
    let warning = backend
        .sum_bigint("CASE WHEN status IN ('new','acknowledged') AND severity = 'warning' THEN 1 ELSE 0 END");
    let info = backend
        .sum_bigint("CASE WHEN status IN ('new','acknowledged') AND severity = 'info' THEN 1 ELSE 0 END");
    let ignored = backend.sum_bigint("CASE WHEN status = 'ignored' THEN 1 ELSE 0 END");
    let resolved = backend.sum_bigint("CASE WHEN status = 'resolved' THEN 1 ELSE 0 END");
    // `$1` is the caller's id (see the params below); it appears in the SELECT
    // list, so it must be the first placeholder - the denied list follows.
    let mine = backend
        .sum_bigint("CASE WHEN status IN ('new','acknowledged') AND assignee_id = $1 THEN 1 ELSE 0 END");

    let denied_clause = if denied.is_empty() {
        String::new()
    } else {
        format!(" AND kind NOT IN ({})", backend.in_list(2, denied.len()))
    };

    let sql = format!(
        "SELECT {open} AS open, {fresh} AS fresh, {ack} AS acknowledged, \
                {critical} AS critical, {warning} AS warning, {info} AS info, \
                {ignored} AS ignored, {resolved} AS resolved, {mine} AS mine \
           FROM core.alerts \
          WHERE is_simulation = FALSE{denied_clause}"
    );

    let mut p = params![ctx.user_id];
    for k in &denied {
        p.push(k.clone().into());
    }

    let row = db
        .fetch_one_as::<SummaryRow>(&sql, p)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "alerts: comptage du résumé");
            AppError::Database(e)
        })?;

    Ok(AlertSummary {
        open: row.open,
        new: row.fresh,
        acknowledged: row.acknowledged,
        critical: row.critical,
        warning: row.warning,
        info: row.info,
        ignored: row.ignored,
        resolved: row.resolved,
        mine: row.mine,
        last_scan_at: super::producers::last_scan_at(db).await?,
    })
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/// Applies a status transition inside an already-open transaction.
///
/// Returns the previous status so the caller can put it in the audit entry -
/// "who closed this, and what it was before" is the pair that makes the trail
/// worth keeping.
pub async fn set_status(
    tx: &mut DbTx,
    alert_id: Uuid,
    next: Status,
    actor_id: Uuid,
    actor_label: &str,
    note: Option<&str>,
) -> Result<Status, AppError> {
    let for_update = tx.backend().for_update();
    let current: String = tx
        .fetch_optional_scalar::<String>(
            &format!(
                "SELECT status FROM core.alerts WHERE id = $1{}",
                for_update
            ),
            params![alert_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, alert_id = %alert_id, "alerts: lecture de l'état courant");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Alert not found".into()))?;

    let previous = Status::parse(&current)
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("État d'alerte inconnu : {current}")))?;

    if !previous.may_move_to(next) {
        return Err(AppError::Validation(
            "The alert is already in this state".into(),
        ));
    }

    // `closed_at` / `closed_by` are set on the closing transitions only; computed
    // in Rust rather than with an in-SQL `CASE ... NOW()`.
    let (closed_at, closed_by) = if next.is_closed() {
        (Some(Utc::now()), Some(actor_id))
    } else {
        (None, None)
    };

    tx.execute(
        "UPDATE core.alerts SET status = $1, closed_at = $2, closed_by = $3 WHERE id = $4",
        params![next.as_str(), closed_at, closed_by, alert_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, alert_id = %alert_id, "alerts: changement d'état");
        AppError::Database(e)
    })?;

    record_event(
        tx,
        alert_id,
        EventKind::StatusChanged,
        Some(actor_id),
        actor_label,
        Some(previous.as_str()),
        Some(next.as_str()),
        note,
    )
    .await?;

    Ok(previous)
}

/// Assigns the alert, or clears the assignment when `assignee` is `None`.
///
/// The caller is responsible for having checked that the account may read the
/// alert centre ([`eligible_assignee`]): assigning work to somebody who cannot
/// open it is how an alert sits untouched for a week.
pub async fn set_assignee(
    tx: &mut DbTx,
    alert_id: Uuid,
    assignee: Option<(Uuid, String)>,
    actor_id: Uuid,
    actor_label: &str,
) -> Result<Option<String>, AppError> {
    let previous: Option<String> = tx
        .fetch_optional_row(
            r#"SELECT COALESCE(NULLIF(u.display_name, ''), u.username) AS label
                 FROM core.alerts a LEFT JOIN core.users u ON u.id = a.assignee_id
                WHERE a.id = $1"#,
            params![alert_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, alert_id = %alert_id, "alerts: lecture de l'assigné courant");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Alert not found".into()))?
        .try_get::<Option<String>>("label")
        .map_err(AppError::Database)?;

    let (assignee_id, assigned_at) = match assignee.as_ref() {
        Some((id, _)) => (Some(*id), Some(Utc::now())),
        None => (None, None),
    };

    tx.execute(
        "UPDATE core.alerts SET assignee_id = $1, assigned_at = $2 WHERE id = $3",
        params![assignee_id, assigned_at, alert_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, alert_id = %alert_id, "alerts: assignation");
        AppError::Database(e)
    })?;

    record_event(
        tx,
        alert_id,
        EventKind::Assigned,
        Some(actor_id),
        actor_label,
        previous.as_deref(),
        assignee.as_ref().map(|(_, label)| label.as_str()),
        None,
    )
    .await?;

    Ok(previous)
}

/// Appends a free comment to the timeline.
pub async fn add_comment(
    tx: &mut DbTx,
    alert_id: Uuid,
    body: &str,
    actor_id: Uuid,
    actor_label: &str,
) -> Result<(), AppError> {
    let exists: Option<Uuid> = tx
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM core.alerts WHERE id = $1",
            params![alert_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, alert_id = %alert_id, "alerts: vérification de l'alerte commentée");
            AppError::Database(e)
        })?;
    if exists.is_none() {
        return Err(AppError::NotFound("Alert not found".into()));
    }

    record_event(
        tx,
        alert_id,
        EventKind::Comment,
        Some(actor_id),
        actor_label,
        None,
        None,
        Some(body),
    )
    .await
}

/// An eligible assignee: an account id and its display label.
#[derive(sqlx::FromRow)]
struct IdLabel {
    id: Uuid,
    label: String,
}

/// Accounts that may be handed an alert: those holding `core.alerts.read`,
/// directly or through a group, with a live assignment. Super-users are
/// included by the marker join.
///
/// Reusing the same resolution rules as [`crate::authz::context::resolve`]
/// rather than a second, looser query: an eligibility list that is broader than
/// the actual privilege check would offer names the assignment then refuses.
pub async fn eligible_assignees(db: &DbPool) -> Result<Vec<(Uuid, String)>, AppError> {
    // `$1` = the expiry cut-off (bound from Rust in place of `NOW()`), `$2` = the
    // privilege key; numbered by their position in the text.
    let now = Utc::now();
    let rows = db
        .fetch_all_as::<IdLabel>(
            r#"
        WITH live AS (
            SELECT a.role_id,
                   COALESCE(a.subject_user_id, m.user_id) AS user_id
              FROM core.role_assignments a
              LEFT JOIN core.user_group_members m ON m.group_id = a.subject_group_id
             WHERE (a.expires_at IS NULL OR a.expires_at > $1)
        )
        SELECT DISTINCT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS label
          FROM live
          JOIN core.users u ON u.id = live.user_id AND u.is_active
          JOIN core.roles r ON r.id = live.role_id
         WHERE r.is_superuser
            OR EXISTS (
                SELECT 1 FROM core.role_privileges rp
                 WHERE rp.role_id = live.role_id AND rp.privilege_key = $2
            )
         ORDER BY label
         LIMIT 500
        "#,
            params![now, super::keys::ALERTS_READ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "alerts: liste des assignés éligibles");
            AppError::Database(e)
        })?;

    Ok(rows.into_iter().map(|r| (r.id, r.label)).collect())
}

/// Is this account allowed to be handed an alert? Returns its display label.
pub async fn eligible_assignee(db: &DbPool, user_id: Uuid) -> Result<String, AppError> {
    eligible_assignees(db)
        .await?
        .into_iter()
        .find(|(id, _)| *id == user_id)
        .map(|(_, label)| label)
        .ok_or_else(|| {
            tracing::warn!(user_id = %user_id, "alerts: assignation à un compte sans accès au centre d'alertes");
            AppError::Validation(
                "This account cannot access the alert center and cannot be assigned an alert".into(),
            )
        })
}

// ── Saved filter sets ────────────────────────────────────────────────────────

/// A saved filter set row, as stored.
#[derive(sqlx::FromRow)]
struct RawView {
    id: Uuid,
    name: String,
    filters: Value,
    created_at: DateTime<Utc>,
}

pub async fn list_views(db: &DbPool, owner: Uuid) -> Result<Vec<AlertView>, AppError> {
    let rows = db
        .fetch_all_as::<RawView>(
            "SELECT id, name, filters, created_at FROM core.alert_views WHERE owner_id = $1 ORDER BY name",
            params![owner],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "alerts: lecture des jeux de filtres");
            AppError::Database(e)
        })?;

    Ok(rows
        .into_iter()
        .map(|r| AlertView {
            id: r.id,
            name: r.name,
            filters: r.filters,
            created_at: r.created_at,
        })
        .collect())
}

/// Creates or replaces a saved filter set. Upsert on `(owner, name)`: saving
/// twice under the same name overwrites rather than failing on the constraint.
pub async fn save_view(
    db: &DbPool,
    owner: Uuid,
    name: &str,
    filters: &Value,
) -> Result<AlertView, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("The filter name is empty".into()));
    }
    if name.chars().count() > 120 {
        return Err(AppError::Validation("The filter name is too long".into()));
    }
    if !filters.is_object() {
        return Err(AppError::Validation("Invalid filter".into()));
    }

    // Upsert then reselect: `RETURNING` is not portable, and on the conflict path
    // the surviving row keeps its original id, so the read gives the right one.
    let backend = db.backend();
    let id = new_id();
    let clause = backend.upsert(
        "core.alert_views",
        &["owner_id", "name"],
        &[Assign::Incoming("filters")],
    );
    let sql = format!(
        "INSERT INTO core.alert_views (id, owner_id, name, filters) VALUES ($1, $2, $3, $4){clause}"
    );
    db.execute(&sql, params![id, owner, name, filters.clone()])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "alerts: enregistrement d'un jeu de filtres");
            AppError::Database(e)
        })?;

    let row = db
        .fetch_one_as::<RawView>(
            "SELECT id, name, filters, created_at FROM core.alert_views WHERE owner_id = $1 AND name = $2",
            params![owner, name],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "alerts: relecture du jeu de filtres");
            AppError::Database(e)
        })?;

    Ok(AlertView {
        id: row.id,
        name: row.name,
        filters: row.filters,
        created_at: row.created_at,
    })
}

pub async fn delete_view(db: &DbPool, owner: Uuid, id: Uuid) -> Result<(), AppError> {
    let affected = db
        .execute(
            "DELETE FROM core.alert_views WHERE id = $1 AND owner_id = $2",
            params![id, owner],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "alerts: suppression d'un jeu de filtres");
            AppError::Database(e)
        })?;
    if affected == 0 {
        return Err(AppError::NotFound("Filter not found".into()));
    }
    Ok(())
}

/// A single distinct facet value.
#[derive(sqlx::FromRow)]
struct FacetRow {
    v: String,
}

/// Distinct values present in the table, for the filter selects.
///
/// Bounded by construction (a handful of kinds, one row per module), so this
/// stays cheap and never hard-codes a catalogue that drifts.
pub async fn facets(db: &DbPool, ctx: &AdminContext) -> Result<(Vec<String>, Vec<String>), AppError> {
    let denied = denied_kinds(ctx);
    let backend = db.backend();

    let mut kq = DbQueryBuilder::new(
        backend,
        "SELECT DISTINCT kind AS v FROM core.alerts WHERE is_simulation = FALSE",
    );
    if !denied.is_empty() {
        kq.push(" AND kind NOT").push_in(&denied);
    }
    kq.push_order_by("kind");
    kq.push(" LIMIT 100");
    let kinds: Vec<String> = kq
        .fetch_all_as::<FacetRow>(db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "alerts: facettes (types)");
            AppError::Database(e)
        })?
        .into_iter()
        .map(|r| r.v)
        .collect();

    let mut sq = DbQueryBuilder::new(
        backend,
        "SELECT DISTINCT source AS v FROM core.alerts WHERE is_simulation = FALSE",
    );
    if !denied.is_empty() {
        sq.push(" AND kind NOT").push_in(&denied);
    }
    sq.push_order_by("source");
    sq.push(" LIMIT 50");
    let sources: Vec<String> = sq
        .fetch_all_as::<FacetRow>(db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "alerts: facettes (sources)");
            AppError::Database(e)
        })?
        .into_iter()
        .map(|r| r.v)
        .collect();

    Ok((kinds, sources))
}

/// Purges closed alerts older than the configured window, with their history
/// (the `ON DELETE CASCADE` on `core.alert_events` does the second half).
///
/// Open alerts are never purged, whatever their age: an alert that has been open
/// for a year is the most important row in the table, not the stalest.
pub async fn purge_closed(db: &DbPool, retention_days: i64) -> Result<u64, AppError> {
    let days = retention_days.clamp(7, 3_650);
    // The cut-off is computed in Rust and bound, in place of the former
    // `NOW() - ($1 || ' days')::interval`.
    let cutoff = Utc::now() - Duration::days(days);
    let deleted = db
        .execute(
            r#"DELETE FROM core.alerts
                WHERE status IN ('resolved', 'ignored')
                  AND closed_at < $1"#,
            params![cutoff],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "alerts: purge des alertes closes");
            AppError::Database(e)
        })?;
    Ok(deleted)
}

/// Severity of an alert, read back for the audit entry of a transition.
pub async fn severity_of(db: &DbPool, id: Uuid) -> Result<Severity, AppError> {
    let raw: String = db
        .fetch_optional_scalar::<String>(
            "SELECT severity FROM core.alerts WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, alert_id = %id, "alerts: lecture de la gravité");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Alert not found".into()))?;
    Severity::parse(&raw)
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("Gravité d'alerte inconnue : {raw}")))
}
