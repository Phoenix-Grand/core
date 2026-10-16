//! The storage page: what the instance holds, where it sits, and who holds it.
//!
//! ## Two totals that are not the same number, and why both are shown
//!
//! * **Consumed** - `SUM(core.users.used_bytes)`. What accounts actually hold.
//!   The counter is maintained by whichever module stores the bytes; the core
//!   only sums it.
//! * **Allocated** - `SUM(core.users.quota_bytes)`. What the instance has
//!   *promised*. Routinely several times the physical volume, and that is not a
//!   bug: quotas are ceilings, and an instance that only ever allocated what it
//!   owns would be sized for a worst case that never happens.
//!
//! Neither of them is the disk. The volume figure comes from the same `statvfs`
//! read the health report uses, and it is the one that says whether uploads are
//! about to start failing. The three answer three different questions and the
//! page keeps them apart rather than averaging them into one reassuring bar.
//!
//! ## The breakdown per module, and what it does *not* claim
//!
//! `core.users.used_bytes` still has no provenance of its own - it is a single
//! number, and splitting it into plausible slices would be a chart that lies.
//! The breakdown is therefore not derived from it: it is assembled from what
//! each module **declared about itself** through `POST /internal/storage/usage`
//! (see [`crate::storage::usage`]). Three states, kept apart on purpose:
//!
//! * a module that declared - its own measurement, with the time it was taken;
//! * a module that declared **zero** - a measured zero;
//! * a module that has **never** declared - reported as unknown, not as zero.
//!
//! Whatever the declarations do not account for is returned as
//! `unattributed_bytes` and named on the page. That residue is the honest
//! measure of how much of the picture is still missing, and burying it inside
//! another slice is the one thing this endpoint must not do.
//!
//! ## No write path of its own
//!
//! Every mutation the page offers is performed by an existing audited endpoint:
//! `PATCH /admin/users/:id` for one account's quota, and
//! `PUT|DELETE /admin/settings/scoped/storage.default_quota_bytes` for the
//! default policy at instance or unit level. A second write path would be a
//! second place for the audit entry to be forgotten.

use std::path::Path as FsPath;

use axum::{
    extract::{Path, Query, State},
    Json,
};
use kubuno_db::{dialect::SqlType, params, DbPool, DbQueryBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    auth::middleware::AdminUser,
    authz::{keys, AdminCtx},
    errors::AppError,
    health::disk,
    state::AppState,
};

/// The five instance-wide account aggregates the overview header opens on.
#[derive(sqlx::FromRow)]
struct OverviewAgg {
    used:          i64,
    allocated:     i64,
    accounts:      i64,
    full_accounts: i64,
    near_accounts: i64,
}

/// One organisational unit's storage totals.
#[derive(sqlx::FromRow)]
struct UnitUsageRow {
    unit_id:   Option<Uuid>,
    unit_name: Option<String>,
    accounts:  i64,
    used:      i64,
    allocated: i64,
}

/// One daily storage sample.
#[derive(sqlx::FromRow)]
struct TrendRow {
    day:         chrono::NaiveDate,
    used_bytes:  i64,
    quota_bytes: i64,
    accounts:    i32,
    over_quota:  i32,
}

/// One unit-level override of the default-quota policy.
#[derive(sqlx::FromRow)]
struct QuotaUnitRow {
    unit_id:    Uuid,
    unit_name:  String,
    value:      Value,
    locked:     bool,
    updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// One account in the top-consumers listing.
#[derive(sqlx::FromRow)]
struct ConsumerRow {
    id:           Uuid,
    username:     String,
    email:        String,
    display_name: Option<String>,
    is_active:    bool,
    used_bytes:   i64,
    quota_bytes:  i64,
    org_unit_id:  Option<Uuid>,
    unit_name:    Option<String>,
}

/// Fill ratio at which an account stops being "fine" and starts being a thing to
/// look at. Read from the same setting the alert producer uses, so the colour on
/// the page and the alert in the queue can never disagree about where the line
/// is.
const QUOTA_PERCENT_SETTING: &str = "alerts.quota_percent";
const QUOTA_PERCENT_DEFAULT: i64 = 90;

/// How far back the trend is read. Ninety days is the longest window the
/// reference consoles offer and roughly the horizon a purchase decision is made
/// on; the sampler keeps everything, so widening it later costs nothing.
const TREND_DAYS: i64 = 90;

async fn quota_percent(db: &DbPool) -> i64 {
    crate::settings::instance_value(db, QUOTA_PERCENT_SETTING)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(QUOTA_PERCENT_DEFAULT)
        // A threshold of 0 would paint every account red on the day it is
        // created, which is how an operator learns to stop reading the colour.
        .clamp(50, 100)
}

/// `GET /admin/storage/overview` - every instance-wide figure the page opens on.
pub async fn overview(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    // Instance aggregates: not confinable to a subtree, so they are gated on the
    // whole-instance key rather than narrowed like the consumers listing below.
    ctx.require(keys::STORAGE_READ)?;

    let warn_percent = quota_percent(&state.db).await;

    let backend = state.db.backend();

    // One pass over the accounts for every scalar the header needs. Splitting it
    // into five COUNT queries would let the numbers disagree with each other
    // whenever an upload lands between two of them. The conditional counts are
    // written as `SUM(CASE ...)` rather than PostgreSQL's `COUNT(*) FILTER`, and
    // every aggregate is width-cast so it decodes as `i64` on all engines.
    let agg_sql = format!(
        "SELECT {used} AS used, \
                {allocated} AS allocated, \
                {accounts} AS accounts, \
                {full} AS full_accounts, \
                {near} AS near_accounts \
           FROM core.users",
        used = backend.sum_bigint("used_bytes"),
        allocated = backend.sum_bigint("quota_bytes"),
        accounts = backend.count_bigint("*"),
        full = backend.sum_bigint("CASE WHEN used_bytes >= quota_bytes THEN 1 ELSE 0 END"),
        near = backend.sum_bigint(
            "CASE WHEN quota_bytes > 0 AND used_bytes < quota_bytes \
                   AND used_bytes * 100 >= quota_bytes * $1 THEN 1 ELSE 0 END"
        ),
    );
    let agg = state
        .db
        .fetch_one_as::<OverviewAgg>(&agg_sql, params![warn_percent])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storage_overview: agrégats des comptes");
            AppError::Database(e)
        })?;

    let used = agg.used;
    let allocated = agg.allocated;
    let accounts = agg.accounts;
    let full_accounts = agg.full_accounts;
    let near_accounts = agg.near_accounts;
    let ok_accounts = (accounts - full_accounts - near_accounts).max(0);

    // ── Where it sits: the physical volume ──────────────────────────────────
    // The same probe as `continuity.disk_space`, so the page and the health
    // report cannot report two different disks. `None` means the volume could
    // not be interrogated - reported as unknown, never as "plenty of room".
    let data_path = state.settings.storage.local_path().to_string();
    let volume = disk::usage_of(FsPath::new(&data_path)).map(|u| {
        json!({
            "path":            data_path,
            "total_bytes":     u.total_bytes,
            "available_bytes": u.available_bytes,
            "used_bytes":      u.used_bytes(),
        })
    });

    // ── Where it sits: the organisational tree ──────────────────────────────
    // The unit an account is *directly* attached to. Rolling child units up into
    // their parent would double-count the moment the page also shows the parent,
    // and the flat reading is the one that maps onto the per-unit quota policy.
    let unit_sql = format!(
        "SELECT u.org_unit_id AS unit_id, \
                o.name AS unit_name, \
                {accounts} AS accounts, \
                {used} AS used, \
                {allocated} AS allocated \
           FROM core.users u \
           LEFT JOIN core.org_units o ON o.id = u.org_unit_id \
          GROUP BY u.org_unit_id, o.name \
          ORDER BY used DESC, accounts DESC",
        accounts = backend.count_bigint("*"),
        used = backend.sum_bigint("u.used_bytes"),
        allocated = backend.sum_bigint("u.quota_bytes"),
    );
    let unit_rows = state
        .db
        .fetch_all_as::<UnitUsageRow>(&unit_sql, params![])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storage_overview: répartition par unité");
            AppError::Database(e)
        })?;

    let by_unit: Vec<Value> = unit_rows
        .iter()
        .map(|r| {
            json!({
                "unit_id":         r.unit_id,
                "unit_name":       r.unit_name,
                "accounts":        r.accounts,
                "used_bytes":      r.used,
                "allocated_bytes": r.allocated,
            })
        })
        .collect();

    // ── The trend ───────────────────────────────────────────────────────────
    // Read as-is, gaps included: a core that was switched off for a week leaves
    // no points for that week, and interpolating them would draw growth nobody
    // measured. The console renders the curve only once two points exist.
    // The cutoff is computed here and bound, rather than derived in SQL with
    // PostgreSQL's `make_interval`, and `day` is read as a date and formatted in
    // Rust rather than with `to_char`.
    let trend_cutoff = chrono::Utc::now().date_naive() - chrono::Duration::days(TREND_DAYS);
    let trend_rows = state
        .db
        .fetch_all_as::<TrendRow>(
            r#"SELECT day, used_bytes, quota_bytes, accounts, over_quota
                 FROM core.storage_samples
                WHERE day > $1
                ORDER BY day"#,
            params![trend_cutoff],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storage_overview: série journalière");
            AppError::Database(e)
        })?;

    let trend: Vec<Value> = trend_rows
        .iter()
        .map(|r| {
            json!({
                "day":             r.day.format("%Y-%m-%d").to_string(),
                "used_bytes":      r.used_bytes,
                "allocated_bytes": r.quota_bytes,
                "accounts":        r.accounts,
                "over_quota":      r.over_quota,
            })
        })
        .collect();

    // ── Where it came from: the per-module breakdown ────────────────────────
    // Built from what the modules declared about themselves - never from
    // splitting `used`, which carries no provenance. Modules that never declared
    // are listed with a null figure rather than a zero, and the share no module
    // claimed is reported as its own named quantity. See
    // `crate::storage::usage` for the channel.
    let breakdown = crate::storage::usage::breakdown(&state.db, used).await?;

    // ── The repair's current position, computed without applying anything ───
    // The hourly job is what corrects; this is only the page's reading of where
    // it stands, so an operator can see that the counter is being realigned -
    // or why it is not - without waiting for a log line.
    let reconciliation = crate::storage::usage::repair_preview(&state.db).await?;

    // ── The policy in force ─────────────────────────────────────────────────
    let policy = default_quota_policy(&state.db).await?;

    Ok(Json(json!({
        "used_bytes":      used,
        "allocated_bytes": allocated,
        "accounts":        accounts,
        "volume":          volume,
        "quota_states": {
            "ok":      ok_accounts,
            "near":    near_accounts,
            "full":    full_accounts,
        },
        "by_unit":         by_unit,
        "by_module":       breakdown,
        "reconciliation":  reconciliation,
        "trend":           trend,
        "policy":          policy,
        "warn_percent":    warn_percent,
        "sampled_days":    trend.len(),
    })))
}

/// One account's storage sheet: every module, every category, volumes and object
/// counts.
///
/// ## ⚠️ PRIVACY - THE LINE THIS ENDPOINT HOLDS
///
/// This is the most detailed view an administrator has of what one person
/// stores, and it is made of **nothing but volumes, counts of objects and
/// technical categories**. It must never return, and must never be extended to
/// return, a file name, a folder name, a path, a MIME type, an extension, a
/// document title, a thumbnail, or any per-object row.
///
/// The reason is a boundary, not a preference. An administrator has two
/// legitimate questions - "how big a disk do I need" and "why is this account
/// full" - and both are answered entirely by volumes. "What does this person
/// keep" is a third question, it is not theirs to ask, and an interface that
/// answers it turns running a server into reading somebody's life. Category
/// identifiers are chosen under the same constraint: see
/// `crate::storage::categories` and its `no_category_names_a_kind_of_content`
/// test, which is the guard against a future addition that would look useful on
/// a chart.
///
/// Gated on `core.storage.read` **and** `core.users.read`, and confined to the
/// caller's subtree: naming one account's consumption is a narrower thing to be
/// trusted with than an instance total, and it is exactly the pair of keys the
/// consumers listing already requires.
pub async fn account_usage(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::STORAGE_READ)?;
    ctx.require(keys::USERS_READ)?;

    // The org-unit confinement that applies to the consumers listing applies
    // here too: an administrator of one unit must not read the sheet of an
    // account in another by guessing its identifier.
    let unit: Option<Uuid> = state
        .db
        .fetch_optional_scalar::<Option<Uuid>>(
            "SELECT org_unit_id FROM core.users WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %id, "storage: unité du compte");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound(format!("Compte {id}")))?;
    ctx.require_for_unit(keys::USERS_READ, unit)?;

    let sheet = crate::storage::usage::account_usage(&state.db, id).await?;
    Ok(Json(json!(sheet)))
}

/// The default-quota policy: the instance value plus every unit that overrides it.
///
/// Read straight from the scoped table rather than resolved unit by unit: only
/// the levels that actually *carry* a row are a policy somebody wrote, and a
/// listing of every unit with its inherited value would bury the three that were
/// decided among forty that were not.
async fn default_quota_policy(db: &DbPool) -> Result<Value, AppError> {
    let key = crate::models::user::DEFAULT_QUOTA_SETTING;

    let instance = crate::settings::chain::resolve_for(
        db,
        key,
        &crate::settings::SettingScope::INSTANCE,
    )
    .await?;

    let rows = db
        .fetch_all_as::<QuotaUnitRow>(
            r#"SELECT v.scope_id AS unit_id, o.name AS unit_name, v.value, v.locked, v.updated_at
                 FROM core.setting_values v
                 JOIN core.org_units o ON o.id = v.scope_id
                WHERE v."key" = $1 AND v.scope_type = 'org_unit'
                ORDER BY o.name"#,
            params![key],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storage_overview: surcharges du quota par défaut");
            AppError::Database(e)
        })?;

    let units: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "unit_id":    r.unit_id,
                "unit_name":  r.unit_name,
                "bytes":      r.value.as_i64(),
                "locked":     r.locked,
                "updated_at": r.updated_at,
            })
        })
        .collect();

    Ok(json!({
        "key":            key,
        "instance_bytes": instance.value.as_ref().and_then(Value::as_i64),
        "instance_locked": instance.locked_here,
        "units":          units,
    }))
}

#[derive(Deserialize)]
pub struct ConsumersQuery {
    pub limit: Option<i64>,
    /// `all` (default), `near` - at or past the warning threshold, `full` - at or
    /// past their own quota.
    pub filter: Option<String>,
    /// `used` (default) or `percent`. They rank differently on purpose: the first
    /// answers "who holds the bytes", the second "who is about to be stopped",
    /// and a 200 MiB account on a 200 MiB quota is invisible to the first.
    pub sort: Option<String>,
}

/// `GET /admin/storage/consumers` - the accounts holding the most, with what an
/// operator needs to act on one.
///
/// **Confined to the caller's organisational subtree**, on the account key: the
/// list names people and says how much each holds, so it obeys the same
/// perimeter as `GET /admin/users`. A delegated administrator sees the accounts
/// they may already read, and nobody else's.
pub async fn consumers(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Query(q): Query<ConsumersQuery>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::STORAGE_READ)?;
    // Naming an account is `core.users.read`, whatever else the caller holds.
    ctx.require(keys::USERS_READ)?;

    let limit = q.limit.unwrap_or(25).clamp(1, 200);
    let scope_units = ctx.subtree_filter(keys::USERS_READ);
    let warn_percent = quota_percent(&state.db).await;

    let filter = match q.filter.as_deref() {
        Some("near") => "near",
        Some("full") => "full",
        _ => "all",
    };

    // The `= ANY($n)` array membership, the fixed predicate and the fixed order
    // are assembled with the builder rather than a raw format string: the unit
    // list becomes an `IN (...)` and the warning threshold a bound placeholder.
    let backend = state.db.backend();
    let mut qb = DbQueryBuilder::new(
        backend,
        "SELECT u.id, u.username, u.email, u.display_name, u.is_active, \
                u.used_bytes, u.quota_bytes, \
                u.org_unit_id, o.name AS unit_name \
           FROM core.users u \
           LEFT JOIN core.org_units o ON o.id = u.org_unit_id \
          WHERE ",
    );
    match scope_units.as_ref() {
        Some(units) => {
            qb.push("u.org_unit_id IS NOT NULL AND u.org_unit_id")
                .push_in(units.iter().copied());
        }
        None => {
            qb.push("1 = 1");
        }
    }
    match filter {
        "full" => {
            qb.push(" AND u.used_bytes >= u.quota_bytes");
        }
        "near" => {
            qb.push(" AND u.quota_bytes > 0 AND u.used_bytes * 100 >= u.quota_bytes * ")
                .push_bind(warn_percent);
        }
        _ => {}
    }
    // NULLIF guards the division: an account with no quota has no percentage, and
    // it sinks rather than sorting as infinity. `NULLS LAST` is PostgreSQL-only,
    // so absences are sent to the end with `(expr IS NULL)` first; the width cast
    // is written per-engine.
    let order_sql = match q.sort.as_deref() {
        Some("percent") => {
            let pct = format!(
                "({} / NULLIF(u.quota_bytes, 0))",
                backend.cast("u.used_bytes", SqlType::Double)
            );
            format!("({pct} IS NULL), {pct} DESC, u.used_bytes DESC")
        }
        _ => "u.used_bytes DESC".to_string(),
    };
    qb.push(" ORDER BY ").push(&order_sql);
    qb.push(" LIMIT ").push_bind(limit);

    let rows = qb
        .fetch_all_as::<ConsumerRow>(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storage_consumers");
            AppError::Database(e)
        })?;

    let consumers: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":          r.id,
                "username":    r.username,
                "email":       r.email,
                "display_name": r.display_name,
                "is_active":   r.is_active,
                "used_bytes":  r.used_bytes,
                "quota_bytes": r.quota_bytes,
                "unit_id":     r.org_unit_id,
                "unit_name":   r.unit_name,
            })
        })
        .collect();

    Ok(Json(json!({
        "consumers":    consumers,
        "limit":        limit,
        "filter":       filter,
        "warn_percent": warn_percent,
        // True when the listing was narrowed: the console says so rather than
        // letting a delegate read a partial total as an instance total.
        "scoped":       scope_units.is_some(),
    })))
}
