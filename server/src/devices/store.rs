//! Reads and writes of the device inventory.
//!
//! Every query lists its columns. `SELECT *` would carry
//! `core.devices.correlation_hash` - the one value in this feature that must
//! never leave the database - into a struct that serialises itself, and the
//! only reliable defence against that is to never write the star.
//!
//! ## One shape for both audiences
//!
//! The administrator's list and the user's own screen run through the *same*
//! functions, differing only in their `WHERE`. That is the trust contract of a
//! self-hosted platform stated as code: a user cannot be shown less about their
//! own machines than the operator sees, because there is no second query that
//! could drift.

use chrono::Utc;
use kubuno_db::{params, Backend, DbPool, DbQueryBuilder, DbTx};
use serde::Deserialize;
use sqlx::FromRow;
use uuid::Uuid;

use super::model::{event_kind, Approval, DeviceEventRow, DeviceRow, SessionRow};
use crate::authz::{keys, AdminContext};
use crate::errors::AppError;

/// Columns of `core.devices` that may leave the server, plus the two joins the
/// console needs. `correlation_hash` is absent, deliberately and permanently.
///
/// `host(d.last_ip)` and `NOW()` are spelled for the running engine
/// (`Backend::inet_text` / `Backend::now`); the active-session count is a bare
/// `COUNT(*)` (the former `::bigint` cast is redundant - `COUNT` already decodes
/// as `i64` on all three engines).
fn device_columns(backend: Backend) -> String {
    format!(
        r#"
    d.id, d.user_id,
    COALESCE(NULLIF(u.display_name, ''), u.username) AS user_label,
    d.correlation_kind, d.label, d.device_type, d.client_kind,
    d.platform, d.platform_version, d.browser, d.browser_version,
    d.signal_level, d.disk_encrypted, d.screen_lock,
    d.declared_platform, d.declared_version, d.declared_app_version, d.declared_at,
    d.first_seen_at, d.last_seen_at, {last_ip} AS last_ip, d.last_country,
    d.approval, d.approval_by, d.approval_label, d.approval_at, d.approval_reason,
    (SELECT COUNT(*) FROM core.refresh_tokens rt
      WHERE rt.device_id = d.id AND rt.revoked_at IS NULL AND rt.expires_at > {now})
      AS active_sessions
"#,
        last_ip = backend.inet_text("d.last_ip"),
        now = backend.now(),
    )
}

macro_rules! device_from {
    () => {
        " FROM core.devices d JOIN core.users u ON u.id = d.user_id "
    };
}
const DEVICE_FROM: &str = device_from!();

/// Columns of a session row. `token_hash` is absent for the same reason.
///
/// `host(rt.ip_address)` is spelled per engine (`Backend::inet_text`). `CONCAT_WS`
/// is native on all three (PostgreSQL 9.1+, MySQL, SQLite 3.44+, and the bundled
/// SQLite is newer).
fn session_columns(backend: Backend) -> String {
    format!(
        r#"
    rt.id, rt.user_id,
    COALESCE(NULLIF(u.display_name, ''), u.username) AS user_label,
    rt.device_id,
    COALESCE(d.label, NULLIF(TRIM(CONCAT_WS(' ', d.browser, d.platform)), ''), rt.device_name)
        AS device_label,
    rt.device_name, rt.device_type, rt.client_type,
    {ip} AS ip_address, rt.country, rt.auth_strength,
    rt.user_agent, rt.created_at, rt.last_used_at, rt.expires_at
"#,
        ip = backend.inet_text("rt.ip_address"),
    )
}

macro_rules! session_from {
    () => {
        r#"
     FROM core.refresh_tokens rt
     JOIN core.users u ON u.id = rt.user_id
     LEFT JOIN core.devices d ON d.id = rt.device_id
"#
    };
}
const SESSION_FROM: &str = session_from!();

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

/// Filters offered by the administration list.
#[derive(Debug, Default, Deserialize)]
pub struct DeviceQuery {
    /// Free text over label, platform, browser and the account.
    pub q: Option<String>,
    pub device_type: Option<String>,
    pub platform: Option<String>,
    pub approval: Option<String>,
    pub country: Option<String>,
    /// Seen within the last N days. `0`/absent means no bound.
    pub seen_days: Option<i64>,
    pub user_id: Option<Uuid>,
    pub signal_level: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

fn clean(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// A distinct-values row for the [`facets`] scan.
#[derive(Debug, FromRow)]
struct FacetRow {
    platform: Option<String>,
    last_country: Option<String>,
    device_type: String,
}

/// Appends the organisational perimeter of the caller.
///
/// A delegated operator confined to a branch sees the devices of the accounts
/// in that branch and nothing else. An empty subtree matches nothing, which is
/// the correct answer for somebody who does not hold the key at all.
fn push_scope(
    builder: &mut DbQueryBuilder,
    ctx: &AdminContext,
    // Spliced into the SQL text, so only a compile-time literal is accepted.
    column: &'static str,
) {
    if let Some(units) = ctx.subtree_filter(keys::SESSIONS_READ) {
        builder.push(format!(" AND {column} IS NOT NULL AND {column}"));
        builder.push_in(units);
    }
}

/// The administration list.
pub async fn list(
    db: &DbPool,
    query: &DeviceQuery,
    ctx: &AdminContext,
) -> Result<(Vec<DeviceRow>, i64), AppError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let mut builder = DbQueryBuilder::new(db.backend(), "SELECT ");
    builder.push(device_columns(db.backend())).push(DEVICE_FROM).push(" WHERE TRUE ");
    push_filters(&mut builder, query, ctx);
    builder.push_order_by("d.last_seen_at DESC, d.id DESC");
    builder.push_limit_offset(limit, offset);

    let rows = builder.fetch_all_as::<DeviceRow>(db).await.map_err(|e| {
        tracing::error!(error = %e, "devices: reading the inventory");
        AppError::Database(e)
    })?;

    // The total obeys the same perimeter and the same filters, or the pagination
    // announces devices the caller may not see.
    let mut counter = DbQueryBuilder::new(
        db.backend(),
        format!("SELECT {}", db.backend().count_bigint("*")),
    );
    counter.push(DEVICE_FROM).push(" WHERE TRUE ");
    push_filters(&mut counter, query, ctx);
    let total: i64 = counter.fetch_scalar::<i64>(db).await.map_err(|e| {
        tracing::error!(error = %e, "devices: inventory total");
        AppError::Database(e)
    })?;

    Ok((rows, total))
}

fn push_filters(builder: &mut DbQueryBuilder, query: &DeviceQuery, ctx: &AdminContext) {
    push_scope(builder, ctx, "u.org_unit_id");

    if let Some(text) = clean(&query.q) {
        // Case-insensitive contains, spelled per engine (`Backend::ilike`), with
        // the `%text%` wildcards carried by the bind rather than concatenated in
        // SQL (the old `'%' || $n || '%'` used `||`, which is logical-OR on
        // MySQL). One bind per column keeps the placeholder order positional.
        let backend = builder.backend();
        let pat = format!("%{text}%");
        builder.push(" AND (");
        for (i, col) in ["d.label", "d.platform", "d.browser", "u.username", "u.email"]
            .iter()
            .enumerate()
        {
            if i > 0 {
                builder.push(" OR ");
            }
            let n = builder.bind_only(pat.clone());
            builder.push(backend.ilike(col, n));
        }
        builder.push(")");
    }
    if let Some(value) = clean(&query.device_type) {
        builder.push(" AND d.device_type = ");
        builder.push_bind(value.to_string());
    }
    if let Some(value) = clean(&query.platform) {
        builder.push(" AND d.platform = ");
        builder.push_bind(value.to_string());
    }
    if let Some(value) = clean(&query.approval) {
        builder.push(" AND d.approval = ");
        builder.push_bind(value.to_string());
    }
    if let Some(value) = clean(&query.signal_level) {
        builder.push(" AND d.signal_level = ");
        builder.push_bind(value.to_string());
    }
    if let Some(value) = clean(&query.country) {
        builder.push(" AND d.last_country = ");
        builder.push_bind(value.to_uppercase());
    }
    if let Some(days) = query.seen_days.filter(|d| *d > 0) {
        // Compute the cutoff in Rust rather than lean on PostgreSQL's
        // `make_interval`, which no other engine offers.
        let cutoff = Utc::now() - chrono::Duration::days(days);
        builder.push(" AND d.last_seen_at >= ");
        builder.push_bind(cutoff);
    }
    if let Some(user_id) = query.user_id {
        builder.push(" AND d.user_id = ");
        builder.push_bind(user_id);
    }
}

/// Distinct values present in the caller's perimeter, so the filter selects
/// offer what exists rather than a catalogue of empty answers.
pub async fn facets(
    db: &DbPool,
    ctx: &AdminContext,
) -> Result<(Vec<String>, Vec<String>, Vec<String>), AppError> {
    let mut builder = DbQueryBuilder::new(
        db.backend(),
        "SELECT DISTINCT d.platform, d.last_country, d.device_type",
    );
    builder.push(DEVICE_FROM).push(" WHERE TRUE ");
    push_scope(&mut builder, ctx, "u.org_unit_id");

    let rows = builder.fetch_all_as::<FacetRow>(db).await.map_err(|e| {
        tracing::error!(error = %e, "devices: facets");
        AppError::Database(e)
    })?;

    let mut platforms: Vec<String> = Vec::new();
    let mut countries: Vec<String> = Vec::new();
    let mut types: Vec<String> = Vec::new();
    for row in &rows {
        if let Some(p) = row.platform.clone() {
            if !platforms.contains(&p) {
                platforms.push(p);
            }
        }
        if let Some(c) = row.last_country.clone() {
            if !countries.contains(&c) {
                countries.push(c);
            }
        }
        if !types.contains(&row.device_type) {
            types.push(row.device_type.clone());
        }
    }
    platforms.sort();
    countries.sort();
    types.sort();
    Ok((platforms, countries, types))
}

/// One device, checked against the caller's perimeter.
pub async fn get(db: &DbPool, id: Uuid, ctx: &AdminContext) -> Result<DeviceRow, AppError> {
    let mut builder = DbQueryBuilder::new(db.backend(), "SELECT ");
    builder.push(device_columns(db.backend())).push(DEVICE_FROM).push(" WHERE d.id = ");
    builder.push_bind(id);
    push_scope(&mut builder, ctx, "u.org_unit_id");

    let row = builder.fetch_optional_as::<DeviceRow>(db).await.map_err(|e| {
        tracing::error!(error = %e, device_id = %id, "devices: reading one device");
        AppError::Database(e)
    })?;

    // Outside the perimeter reads as "does not exist", which is also what an
    // enumeration attempt must be told.
    row.ok_or_else(|| AppError::NotFound("Appareil introuvable".into()))
}

/// One device owned by a given account. Used by the personal screen, where the
/// only perimeter is "is it mine".
pub async fn get_owned(db: &DbPool, id: Uuid, user_id: Uuid) -> Result<DeviceRow, AppError> {
    let sql = format!(
        "SELECT {}{} WHERE d.id = $1 AND d.user_id = $2",
        device_columns(db.backend()),
        DEVICE_FROM
    );
    let row = db
        .fetch_optional_as::<DeviceRow>(&sql, params![id, user_id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, device_id = %id, "devices: reading a personal device");
            AppError::Database(e)
        })?;
    row.ok_or_else(|| AppError::NotFound("Appareil introuvable".into()))
}

/// Every device of one account, most recently seen first.
pub async fn for_user(db: &DbPool, user_id: Uuid) -> Result<Vec<DeviceRow>, AppError> {
    let sql = format!(
        "SELECT {}{} WHERE d.user_id = $1 ORDER BY d.last_seen_at DESC, d.id DESC",
        device_columns(db.backend()),
        DEVICE_FROM
    );
    let rows = db
        .fetch_all_as::<DeviceRow>(&sql, params![user_id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "devices: devices of an account");
            AppError::Database(e)
        })?;
    Ok(rows)
}

/// Live sessions attached to a device.
pub async fn sessions_of(db: &DbPool, device_id: Uuid) -> Result<Vec<SessionRow>, AppError> {
    let sql = format!(
        "SELECT {}{} WHERE rt.device_id = $1 AND rt.revoked_at IS NULL AND rt.expires_at > $2 \
         ORDER BY rt.last_used_at DESC",
        session_columns(db.backend()),
        SESSION_FROM
    );
    let rows = db
        .fetch_all_as::<SessionRow>(&sql, params![device_id, Utc::now()])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, device_id = %device_id, "devices: sessions of the device");
            AppError::Database(e)
        })?;
    Ok(rows)
}

/// Live sessions of one account, whatever their device.
pub async fn sessions_of_user(db: &DbPool, user_id: Uuid) -> Result<Vec<SessionRow>, AppError> {
    let sql = format!(
        "SELECT {}{} WHERE rt.user_id = $1 AND rt.revoked_at IS NULL AND rt.expires_at > $2 \
         ORDER BY rt.last_used_at DESC",
        session_columns(db.backend()),
        SESSION_FROM
    );
    let rows = db
        .fetch_all_as::<SessionRow>(&sql, params![user_id, Utc::now()])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "devices: sessions of the account");
            AppError::Database(e)
        })?;
    Ok(rows)
}

/// Filters of the instance-wide session list.
#[derive(Debug, Default, Deserialize)]
pub struct SessionQuery {
    pub q: Option<String>,
    pub client_type: Option<String>,
    pub country: Option<String>,
    pub user_id: Option<Uuid>,
    /// `true` keeps only sessions that never passed a second factor.
    pub without_2fa: Option<bool>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Every live session of the instance - a view that simply did not exist.
///
/// Until now the only way to answer "who is currently signed in" was to open
/// each account in turn, which meant nobody ever asked.
pub async fn all_sessions(
    db: &DbPool,
    query: &SessionQuery,
    ctx: &AdminContext,
) -> Result<(Vec<SessionRow>, i64), AppError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let mut builder = DbQueryBuilder::new(db.backend(), "SELECT ");
    builder
        .push(session_columns(db.backend()))
        .push(SESSION_FROM)
        .push(" WHERE rt.revoked_at IS NULL AND rt.expires_at > ");
    builder.push_bind(Utc::now());
    builder.push(" ");
    push_session_filters(&mut builder, query, ctx);
    builder.push_order_by("rt.last_used_at DESC, rt.id DESC");
    builder.push_limit_offset(limit, offset);

    let rows = builder.fetch_all_as::<SessionRow>(db).await.map_err(|e| {
        tracing::error!(error = %e, "devices: global session list");
        AppError::Database(e)
    })?;

    let mut counter = DbQueryBuilder::new(
        db.backend(),
        format!("SELECT {}", db.backend().count_bigint("*")),
    );
    counter
        .push(SESSION_FROM)
        .push(" WHERE rt.revoked_at IS NULL AND rt.expires_at > ");
    counter.push_bind(Utc::now());
    counter.push(" ");
    push_session_filters(&mut counter, query, ctx);
    let total: i64 = counter.fetch_scalar::<i64>(db).await.map_err(|e| {
        tracing::error!(error = %e, "devices: session total");
        AppError::Database(e)
    })?;

    Ok((rows, total))
}

fn push_session_filters(builder: &mut DbQueryBuilder, query: &SessionQuery, ctx: &AdminContext) {
    push_scope(builder, ctx, "u.org_unit_id");

    if let Some(text) = clean(&query.q) {
        // Case-insensitive contains per engine (`Backend::ilike`); the `host()`
        // accessor is spelled by `Backend::inet_text` and matched with a plain
        // `LIKE` (an address has no case to fold). The `%text%` wildcards ride
        // on the binds, not on `||` (logical-OR on MySQL).
        let backend = builder.backend();
        let pat = format!("%{text}%");
        builder.push(" AND (");
        for (i, col) in ["u.username", "u.email", "rt.device_name"].iter().enumerate() {
            if i > 0 {
                builder.push(" OR ");
            }
            let n = builder.bind_only(pat.clone());
            builder.push(backend.ilike(col, n));
        }
        let n = builder.bind_only(pat.clone());
        builder.push(format!(" OR {} LIKE ${n}", backend.inet_text("rt.ip_address")));
        builder.push(")");
    }
    if let Some(value) = clean(&query.client_type) {
        builder.push(" AND rt.client_type = ");
        builder.push_bind(value.to_string());
    }
    if let Some(value) = clean(&query.country) {
        builder.push(" AND rt.country = ");
        builder.push_bind(value.to_uppercase());
    }
    if let Some(user_id) = query.user_id {
        builder.push(" AND rt.user_id = ");
        builder.push_bind(user_id);
    }
    if query.without_2fa == Some(true) {
        // NULL is "we do not know", and an unknown strength must not be counted
        // as "passed 2FA" - the tri-state rule, applied to a session.
        builder.push(" AND (rt.auth_strength IS NULL OR rt.auth_strength NOT IN ('password_totp', 'backup_code'))");
    }
}

/// The last lines of a device timeline.
pub async fn events_of(
    db: &DbPool,
    device_id: Uuid,
    limit: i64,
) -> Result<Vec<DeviceEventRow>, AppError> {
    // `host(ip_address)` is spelled per engine (`Backend::inet_text`).
    let rows = db
        .fetch_all_as::<DeviceEventRow>(
            &format!(
                "SELECT id, occurred_at, kind, {ip} AS ip_address, country,
                actor_id, actor_label, detail
           FROM core.device_events
          WHERE device_id = $1
          ORDER BY occurred_at DESC, id DESC
          LIMIT $2",
                ip = db.backend().inet_text("ip_address")
            ),
            params![device_id, limit.clamp(1, 200)],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, device_id = %device_id, "devices: device timeline");
            AppError::Database(e)
        })?;
    Ok(rows)
}

/// Sets the approval state of a device, inside a caller-supplied transaction.
///
/// Returns the previous state so the audit entry can carry a real `before`.
pub async fn set_approval(
    tx: &mut DbTx,
    device_id: Uuid,
    next: Approval,
    actor_id: Uuid,
    actor_label: &str,
    reason: Option<&str>,
) -> Result<Approval, AppError> {
    // The row lock is spelled per engine via `Backend::for_update` (empty on
    // SQLite, whose writes are already serialized).
    let for_update = tx.backend().for_update();
    let previous: String = tx
        .fetch_optional_scalar::<String>(
            &format!(
                "SELECT approval FROM core.devices WHERE id = $1{}",
                for_update
            ),
            params![device_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, device_id = %device_id, "devices: reading the approval");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Appareil introuvable".into()))?;

    // Placeholders must appear once each in ascending order (portable rewrite),
    // so the WHERE key is numbered after the SET assignments.
    tx.execute(
        "UPDATE core.devices
            SET approval = $1, approval_by = $2, approval_label = $3,
                approval_at = $4, approval_reason = $5
          WHERE id = $6",
        params![
            next.as_str(),
            actor_id,
            actor_label,
            Utc::now(),
            reason,
            device_id
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, device_id = %device_id, "devices: writing the approval");
        AppError::Database(e)
    })?;

    let kind = match next {
        Approval::Approved => event_kind::APPROVED,
        Approval::Blocked => event_kind::BLOCKED,
        Approval::Pending => event_kind::UNBLOCKED,
    };
    super::correlate::record_event_tx(tx, device_id, kind, Some(actor_id), Some(actor_label), reason)
        .await?;

    Ok(Approval::parse(&previous).unwrap_or(Approval::Pending))
}

/// Revokes every live session of a device. Returns how many were closed.
pub async fn revoke_sessions(
    tx: &mut DbTx,
    device_id: Uuid,
    reason: &str,
) -> Result<u64, AppError> {
    let affected = tx
        .execute(
            "UPDATE core.refresh_tokens
            SET revoked_at = $1, revoke_reason = $2
          WHERE device_id = $3 AND revoked_at IS NULL",
            params![Utc::now(), reason, device_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, device_id = %device_id, "devices: revoking sessions");
            AppError::Database(e)
        })?;
    Ok(affected)
}

/// Removes an inventory row.
///
/// ⚠ This erases **nothing on the device**. It deletes what the server
/// remembered about it; the machine keeps every file it already holds, and the
/// interface says so in as many words because it is the misreading everybody
/// makes. `refresh_tokens.device_id` is `ON DELETE SET NULL`, so sessions
/// survive - forgetting is not a sign-out, and the console offers both.
pub async fn forget(tx: &mut DbTx, device_id: Uuid) -> Result<(), AppError> {
    let affected = tx
        .execute(
            "DELETE FROM core.devices WHERE id = $1",
            params![device_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, device_id = %device_id, "devices: forgetting the device");
            AppError::Database(e)
        })?;
    if affected == 0 {
        return Err(AppError::NotFound("Appareil introuvable".into()));
    }
    Ok(())
}

/// Renames a device. Empty clears the custom name and restores the description
/// derived from the user agent.
pub async fn rename(
    db: &DbPool,
    device_id: Uuid,
    user_id: Uuid,
    label: Option<&str>,
) -> Result<(), AppError> {
    let affected = db
        .execute(
            "UPDATE core.devices SET label = $1 WHERE id = $2 AND user_id = $3",
            params![label, device_id, user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, device_id = %device_id, "devices: rename");
            AppError::Database(e)
        })?;
    if affected == 0 {
        return Err(AppError::NotFound("Appareil introuvable".into()));
    }
    Ok(())
}

/// The device a live session belongs to, if any.
pub async fn device_of_session(db: &DbPool, session_id: Uuid) -> Option<Uuid> {
    db.fetch_optional_scalar::<Option<Uuid>>(
        "SELECT device_id FROM core.refresh_tokens WHERE id = $1",
        params![session_id],
    )
    .await
    .ok()
    .flatten()
    .flatten()
}
