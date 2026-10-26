//! Per-module storage declarations: the channel, and what the console reads
//! back from it.
//!
//! ## Why a declaration of state, and not an event
//!
//! The obvious alternative was the existing bus: a module publishes
//! `FileUploaded { size_bytes }`, the core adds it up. Three things rule it out.
//!
//! * **It is a delta.** `EventBus` is a `tokio::broadcast` channel, which drops
//!   messages for any subscriber that lags, and `/internal/events/publish` is
//!   fire-and-forget: the publisher never learns whether anybody counted. A
//!   running total built from a lossy stream of increments is wrong by an
//!   unknown amount and stays wrong forever, and the only repair is a full
//!   recount - i.e. the thing this channel does directly.
//! * **It cannot express "nothing changed".** A module that is up, healthy and
//!   holding a steady 4 GiB publishes no events at all, which is
//!   indistinguishable from a module that crashed last Tuesday. Freshness is
//!   exactly what an operator needs from a breakdown, and an event stream cannot
//!   carry it.
//! * **The envelope carries its own `module_id`.** `AppEvent::FileUploaded`
//!   names the module in its payload, chosen by the sender. Attribution that the
//!   sender writes is attribution any module can forge.
//!
//! So: a synchronous internal route that takes the module's **current total**
//! per account, and answers. Re-declaring the same total twice is a no-op
//! because the row is keyed by `(module_id, user_id)` - idempotence is a
//! property of the schema, not of the caller's care. A message lost in flight
//! costs one stale row until the next declaration, and the next declaration
//! repairs it completely rather than compounding the error.
//!
//! ## The module never names itself
//!
//! [`declare`] takes `module_id` as an argument, and its only caller derives it
//! from the authenticated `X-Internal-Secret` (see
//! [`crate::handlers::storage_usage`]). The core derives a distinct secret per
//! module, so "who is calling" is answered by cryptography rather than by a
//! field in the body. A module presenting its own secret can only ever write
//! under its own name.
//!
//! ## THE ATTRIBUTION RULE
//!
//! > **A byte is declared by the module that physically holds it, and by no
//! > other.**
//!
//! "Holds" means: the byte lives in a storage prefix that module owns, or in a
//! column of its own PostgreSQL schema. Three corollaries, and they are the
//! whole defence against double counting:
//!
//! 1. A module that writes **through** another module declares nothing for those
//!    bytes. `office`, `notes`, `flow`, `paintsharp` and friends write their
//!    documents into `drive` over `/ipc/*`; `drive` stores them, so `drive`
//!    declares them as [`Category::Content`]. Office declares only what sits in
//!    its own schema - and, optionally, a [`Category::Delegated`] line that names
//!    how many objects it is behind without weighing them again.
//! 2. A module that *indexes* files it did not write declares nothing for them
//!    (`media` scanning a folder that belongs to `drive`).
//! 3. Inside one module, one physical byte is declared once. Two rows of
//!    `drive.files` pointing at the same `storage_path` are one blob, not two.
//!
//! Why the holder and not the producer: the holder is the only party that can
//! *measure* rather than estimate (it knows about deduplication, compression and
//! the bin), the partition it produces is total (every byte has exactly one
//! holder, including bytes uploaded by hand that no module produced), and it is
//! stable - uninstalling `office` does not make its documents vanish from the
//! accounting, because they never were in its accounting.
//!
//! The rule is made *visible* rather than merely respected:
//! [`Category::Delegated`] is neither billed nor counted into any total, so a
//! module may name what it is behind and the console can show it without a
//! single byte being added twice.
//!
//! ## Converting a module to declare (the whole recipe)
//!
//! Nothing has to be added to the core: the channel is generic and the module
//! list comes from `core.modules`, which every module already writes itself into
//! at registration. A module becomes a declarant purely by calling the route.
//!
//! 1. **Decide what it holds**, by the rule above. Anything it writes through
//!    another module is not its.
//! 2. **Split that by category** - see [`crate::storage::categories`]. The split
//!    is what separates "what this person put here" (billed) from "what the
//!    module needed in order to work" (not billed).
//! 3. **Declare the complete state at startup and periodically.**
//!    `POST {core_url}/internal/storage/usage` with the module's
//!    `KUBUNO_INTERNAL_SECRET` in `X-Internal-Secret` and a body of
//!    `{"full": true, "usage": [{"user_id": …, "category": …, "used_bytes": …,
//!    "object_count": …}]}`. Retry with a backoff until it lands - the core is
//!    routinely not ready on the first attempt after a reboot.
//! 4. **Declare incrementally after each write.** Same route, `"full": false`,
//!    listing only the affected accounts with their *new absolute totals*, and
//!    listing every category for those accounts including the ones that dropped
//!    to zero - a partial declaration retires nothing, so an omitted category
//!    keeps its last value.
//! 5. **Nothing else.** No `module_id` in the body (the core takes it from the
//!    secret), no delta arithmetic, no ordering guarantees needed. Re-declaring
//!    is free; a lost call is repaired by the next one.
//!
//! A module that holds nothing still declares - `{"full": true, "usage": []}`.
//! "This module stores nothing" and "this module has never spoken" are different
//! facts and the console states them differently.
//!
//! `drive` is the worked example - see `drive/src/services/usage.rs`.
//!
//! ## `used_bytes` and the repair
//!
//! `core.users.used_bytes` keeps its own writer (the storing module, updated on
//! every write so a quota refusal is immediate). What is new is that the core may
//! now *repair* it from the declarations - see
//! [`crate::jobs::builtin`] - because two things make that safe which were not
//! true when this channel shipped: only **billable** categories are summed, so a
//! module declaring its thumbnails cannot inflate a quota; and the repair is
//! suspended whole while any declaring module is stale or has never completed a
//! full sync, so a slow module costs a stale figure rather than somebody's
//! ceiling. Every correction is audited.
//!
//! "Billable" is defined by one criterion, stated in
//! [`crate::storage::categories`]: **an account is billed for what it can free
//! itself**. Its files, its bin, a revision history it can purge - all things
//! with a handle it holds. Not the thumbnails, indexes and caches it never asked
//! for and cannot remove.

use chrono::{Duration, Utc};
use kubuno_db::dialect::{Assign, SqlType};
use kubuno_db::{params, DbPool, DbQueryBuilder};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::errors::AppError;
use crate::storage::categories::Category;

/// Upper bound on one declaration, so a single request cannot ask the database
/// for unbounded work. A module with more accounts than this declares in pages;
/// only the page that carries `full` retires stale rows.
///
/// Counted in **entries**, not accounts: one account can produce as many entries
/// as it has categories, so a module holding eight kinds of bytes fits roughly
/// six hundred accounts per call.
pub const MAX_ENTRIES: usize = 5_000;

/// The setting naming how long a module may stay silent before its share is
/// reported as stale.
pub const STALE_HOURS_SETTING: &str = "storage.usage_stale_hours";
const STALE_HOURS_DEFAULT: i64 = 24;

/// What one module holds for one account, in one category.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UsageEntry {
    pub user_id: Uuid,
    /// The module's **total** for this account and category, in bytes. Never a
    /// delta.
    pub used_bytes: i64,
    #[serde(default)]
    pub object_count: Option<i64>,
    /// What these bytes are, in the module's machinery. Absent means
    /// [`Category::Content`] - which keeps a module written against the first
    /// version of this channel correct, not merely accepted.
    #[serde(default)]
    pub category: Option<String>,
}

impl UsageEntry {
    /// The declared category, or the refusal that names it.
    ///
    /// An unknown identifier is a version skew between a module and this core.
    /// Guessing [`Category::Content`] would bill an account for bytes whose
    /// nature the core does not understand, so it is refused instead.
    fn category(&self) -> Result<Category, AppError> {
        match self.category.as_deref() {
            None => Ok(Category::default()),
            Some(s) => Category::parse(s).ok_or_else(|| {
                AppError::Validation(format!(
                    "Unknown storage category: '{s}'. Expected: {}",
                    Category::ALL
                        .iter()
                        .map(|c| c.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            }),
        }
    }
}

/// Whether a declaration describes every account the module holds anything for,
/// or only the ones it names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Only the listed accounts are refreshed. The cheap path, used after a
    /// single upload or deletion.
    Partial,
    /// The listed accounts *are* everything the module holds. Rows for any other
    /// account are retired - this is the path that repairs a breakdown after a
    /// declaration was lost, and the only one that can bring a module's share
    /// back down to zero.
    Full,
}

/// What the core did with a declaration. Returned to the module so a silent
/// partial acceptance is impossible to mistake for a complete one.
#[derive(Debug, Clone, Serialize)]
pub struct DeclarationOutcome {
    pub module_id: String,
    /// Entries written.
    pub accepted: i64,
    /// Entries dropped because the account does not exist (deleted between the
    /// module's read and its declaration). Not an error: reported so a module
    /// that is systematically wrong about who exists can be noticed.
    pub skipped_unknown_accounts: i64,
    /// Rows retired by a full declaration.
    pub retired: i64,
    /// The module's physically held total across every account, after the write:
    /// every category except `delegated`, which another module already counted.
    pub module_total_bytes: i64,
    /// The part of that total charged to the accounts' quotas - `content` plus
    /// `trash`. Always ≤ `module_total_bytes`.
    pub module_billable_bytes: i64,
    pub accounts: i64,
}

/// Rejects a declaration that cannot be stored, before touching the database,
/// and resolves each entry's category.
fn validate(entries: &[UsageEntry]) -> Result<Vec<Category>, AppError> {
    if entries.len() > MAX_ENTRIES {
        return Err(AppError::Validation(format!(
            "Declaration too large: {} entries, maximum {MAX_ENTRIES}",
            entries.len()
        )));
    }
    if let Some(bad) = entries.iter().find(|e| e.used_bytes < 0) {
        return Err(AppError::Validation(format!(
            "Negative usage declared for account {}",
            bad.user_id
        )));
    }
    if let Some(bad) = entries
        .iter()
        .find(|e| e.object_count.is_some_and(|c| c < 0))
    {
        return Err(AppError::Validation(format!(
            "Negative object count declared for account {}",
            bad.user_id
        )));
    }
    entries.iter().map(UsageEntry::category).collect()
}

/// True when `module_id` is a module this core has registered.
///
/// The foreign key would refuse an unknown module anyway; asking first turns a
/// constraint violation into a 404 that says which module was not found.
pub async fn module_exists(db: &DbPool, module_id: &str) -> Result<bool, AppError> {
    db.fetch_scalar::<bool>(
        "SELECT EXISTS(SELECT 1 FROM core.modules WHERE id = $1)",
        params![module_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, module_id = %module_id, "storage_usage: module existence");
        AppError::Database(e)
    })
}

/// Records `module_id`'s current storage usage.
///
/// Atomic: the upserts, the retirement of rows a full declaration did not
/// mention, and the reporter's freshness stamp either all land or none do. A
/// breakdown that is half of the new state and half of the old one would be a
/// number no operator could act on.
pub async fn declare(
    db: &DbPool,
    module_id: &str,
    entries: &[UsageEntry],
    scope: Scope,
) -> Result<DeclarationOutcome, AppError> {
    let resolved = validate(entries)?;

    if !module_exists(db, module_id).await? {
        return Err(AppError::NotFound(format!(
            "Module '{module_id}' is unknown to the core"
        )));
    }

    // Deduplicate before binding. `INSERT … ON CONFLICT DO UPDATE` refuses to
    // touch the same row twice in one statement ("cannot affect row a second
    // time"), so a module that listed one (account, category) pair twice would
    // have its entire declaration rejected. The last entry wins, which is the
    // same answer two successive declarations would have produced.
    let mut order: Vec<(Uuid, Category)> = Vec::with_capacity(entries.len());
    let mut latest: std::collections::HashMap<(Uuid, Category), (i64, Option<i64>)> =
        std::collections::HashMap::with_capacity(entries.len());
    for (e, cat) in entries.iter().zip(resolved.iter().copied()) {
        let key = (e.user_id, cat);
        if latest.insert(key, (e.used_bytes, e.object_count)).is_none() {
            order.push(key);
        }
    }
    if order.len() != entries.len() {
        tracing::debug!(
            module_id = %module_id,
            received = entries.len(),
            unique = order.len(),
            "Declaration carrying repeated account/category pairs: last value kept"
        );
    }

    let user_ids: Vec<Uuid> = order.iter().map(|(u, _)| *u).collect();

    // Which of the named accounts still exist. The former statement JOINed
    // core.users inside an UNNEST-driven upsert to skip unknown accounts; that
    // shape is PostgreSQL-only, so existence is checked here and each write is
    // filtered against this set below. A window narrower than the module's own
    // read-to-declare gap remains: an account deleted between this check and the
    // insert would raise the FK rather than be skipped in-statement.
    let mut existing: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    if !user_ids.is_empty() {
        let mut qb = DbQueryBuilder::new(db.backend(), "SELECT id FROM core.users WHERE id");
        qb.push_in(user_ids.clone());
        let found: Vec<(Uuid,)> = qb.fetch_all_as(db).await.map_err(|e| {
            tracing::error!(error = %e, module_id = %module_id, "storage_usage: account existence");
            AppError::Database(e)
        })?;
        existing = found.into_iter().map(|(id,)| id).collect();
    }

    // A single instant shared by every write in this call: accepted rows are
    // stamped with it, and a full declaration retires anything left with an
    // older stamp. This replaces the UNNEST + NOT EXISTS retirement, which no
    // other engine can run.
    let now = Utc::now();

    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, module_id = %module_id, "storage_usage: transaction open");
        AppError::Database(e)
    })?;

    // Upsert each declared (account, category), skipping accounts that no longer
    // exist. The last value per key already won during deduplication above.
    let upsert = db.backend().upsert(
        "core.storage_usage",
        &["module_id", "user_id", "category"],
        &[
            Assign::Incoming("used_bytes"),
            Assign::Incoming("object_count"),
            Assign::Incoming("declared_at"),
        ],
    );
    let insert_sql = format!(
        "INSERT INTO core.storage_usage \
             (module_id, user_id, category, used_bytes, object_count, declared_at) \
         VALUES ($1, $2, $3, $4, $5, $6){upsert}"
    );

    let mut accepted: i64 = 0;
    for (user_id, cat) in &order {
        if !existing.contains(user_id) {
            continue;
        }
        let (used_bytes, object_count) =
            latest.get(&(*user_id, *cat)).copied().unwrap_or((0, None));
        tx.execute(
            &insert_sql,
            params![module_id, user_id, cat.as_str(), used_bytes, object_count, now],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, module_id = %module_id, "storage_usage: writing declarations");
            AppError::Database(e)
        })?;
        accepted += 1;
    }

    // A full declaration is the module's complete state, so anything it did not
    // just stamp it no longer holds. Retiring by the shared instant is portable
    // and per (account, category): a module that emptied one account's bin loses
    // its `trash` row without losing its `content` row. An empty full
    // declaration deletes every row for the module - "I hold nothing at all".
    let retired: i64 = match scope {
        Scope::Partial => 0,
        Scope::Full => tx
            .execute(
                "DELETE FROM core.storage_usage WHERE module_id = $1 AND declared_at < $2",
                params![module_id, now],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, module_id = %module_id, "storage_usage: retiring undeclared accounts");
                AppError::Database(e)
            })? as i64,
    };

    // The reporter row exists from the first declaration onwards, even when that
    // declaration was empty. That is deliberate: "this module declares, and it
    // currently holds nothing" is a fact the console must be able to state.
    // `last_full_sync_at` is set only by a full declaration and otherwise kept;
    // computed in Rust rather than with a SQL CASE over NOW().
    let is_full = scope == Scope::Full;
    let full_sync: Option<chrono::DateTime<chrono::Utc>> = is_full.then_some(now);
    let reporter_upsert = db.backend().upsert(
        "core.storage_reporters",
        &["module_id"],
        &[
            Assign::Incoming("last_declared_at"),
            Assign::Expr { col: "last_full_sync_at", expr: "COALESCE({new}, {cur})" },
            Assign::Expr { col: "declarations", expr: "{cur} + 1" },
        ],
    );
    let reporter_sql = format!(
        "INSERT INTO core.storage_reporters \
             (module_id, first_declared_at, last_declared_at, last_full_sync_at, declarations) \
         VALUES ($1, $2, $3, $4, 1){reporter_upsert}"
    );
    tx.execute(&reporter_sql, params![module_id, now, now, full_sync])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, module_id = %module_id, "storage_usage: reporter timestamp");
            AppError::Database(e)
        })?;

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, module_id = %module_id, "storage_usage: transaction commit");
        AppError::Database(e)
    })?;

    // Totals for the module, read back after commit (a transaction cannot fetch
    // whole rows through this API). Summed per held/billable category in Rust
    // rather than with PostgreSQL's `SUM(...) FILTER (WHERE category = ANY(...))`.
    let (module_total_bytes, module_billable_bytes, accounts) =
        module_totals(db, module_id).await?;

    let outcome = DeclarationOutcome {
        module_id: module_id.to_owned(),
        accepted,
        skipped_unknown_accounts: entries.len() as i64 - accepted,
        retired,
        module_total_bytes,
        module_billable_bytes,
        accounts,
    };

    tracing::debug!(
        module_id = %module_id,
        accepted = outcome.accepted,
        skipped = outcome.skipped_unknown_accounts,
        retired = outcome.retired,
        held = outcome.module_total_bytes,
        billable = outcome.module_billable_bytes,
        full = scope == Scope::Full,
        "Storage usage declaration recorded"
    );

    Ok(outcome)
}

/// One module's held total, billable total and account count, read after a
/// declaration commits. Only categories the current binary knows as held /
/// billable are counted - the former query's `= ANY(<held/billable list>)`,
/// which excluded an unknown category from both totals.
async fn module_totals(db: &DbPool, module_id: &str) -> Result<(i64, i64, i64), AppError> {
    let backend = db.backend();

    #[derive(sqlx::FromRow)]
    struct CatSum {
        category: String,
        used: Option<i64>,
    }
    let rows = db
        .fetch_all_as::<CatSum>(
            &format!(
                "SELECT category, {used} AS used FROM core.storage_usage \
                 WHERE module_id = $1 GROUP BY category",
                used = backend.cast("SUM(used_bytes)", SqlType::BigInt),
            ),
            params![module_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, module_id = %module_id, "storage_usage: module total");
            AppError::Database(e)
        })?;

    let mut held = 0i64;
    let mut billable = 0i64;
    for r in &rows {
        let bytes = r.used.unwrap_or(0);
        let known = Category::parse(&r.category);
        if known.is_some_and(Category::is_held) {
            held += bytes;
        }
        if known.is_some_and(Category::is_billable) {
            billable += bytes;
        }
    }

    let accounts = db
        .fetch_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.storage_usage WHERE module_id = $1",
                backend.cast("COUNT(DISTINCT user_id)", SqlType::BigInt),
            ),
            params![module_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, module_id = %module_id, "storage_usage: module account count");
            AppError::Database(e)
        })?;

    Ok((held, billable, accounts))
}

// ── Reading it back ──────────────────────────────────────────────────────────

/// One category's share, wherever it is shown: instance-wide, inside one
/// module, or inside one account's sheet.
///
/// ⚠️ PRIVACY: this is the finest grain any administrator ever sees. It carries
/// a technical role, a volume and a count of objects - never a name, a path, a
/// folder, a MIME type or anything else that would say *what* a person keeps.
/// See `crate::storage::categories` for the rule and its guard test.
#[derive(Debug, Clone, Serialize)]
pub struct CategoryUsage {
    pub category: String,
    pub used_bytes: i64,
    pub object_count: Option<i64>,
    /// Counts against the account's quota.
    pub billable: bool,
    /// Counts toward the volume physically attributed to the declaring module.
    pub held: bool,
    /// Accounts this category has a declaration for. `None` inside a single
    /// account's sheet, where it would always be one.
    pub accounts: Option<i64>,
}

/// One module's line in the breakdown.
#[derive(Debug, Clone, Serialize)]
pub struct ModuleUsage {
    pub module_id: String,
    pub display_name: String,
    /// `false` means the module has **never** declared. Its `used_bytes` is not
    /// zero - it is unknown, and the console must say so rather than draw an
    /// empty bar next to modules that measured themselves.
    pub declared: bool,
    /// The **billable** share - `content` plus `trash`. `None` exactly when
    /// `declared` is false; never defaulted to 0.
    ///
    /// This field keeps the meaning it had before categories existed, because it
    /// is the one compared against `core.users.used_bytes`: mixing thumbnails
    /// into it would turn the reconciliation into a permanent false alarm.
    pub used_bytes: Option<i64>,
    /// Everything the module physically holds, billable or not - the figure a
    /// disk is sized on. Always ≥ `used_bytes`.
    pub held_bytes: Option<i64>,
    /// Bytes this module is behind but another module holds and counts. Shown,
    /// never summed. Usually 0 with a non-zero `delegated_objects`: a module
    /// that delegates rarely knows what its objects weigh - the holder does.
    pub delegated_bytes: Option<i64>,
    pub delegated_objects: Option<i64>,
    /// The split, in the vocabulary's display order. Empty for a module that
    /// never declared.
    pub categories: Vec<CategoryUsage>,
    pub object_count: Option<i64>,
    pub accounts: Option<i64>,
    pub first_declared_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_declared_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_full_sync_at: Option<chrono::DateTime<chrono::Utc>>,
    /// The module declared once and has since gone quiet past the configured
    /// window. Its figure is still shown - it is the last thing known to be
    /// true - but flagged.
    pub stale: bool,
    pub is_enabled: bool,
}

/// The whole breakdown: every module the console should account for, whether or
/// not it ever said anything.
#[derive(Debug, Clone, Serialize)]
pub struct Breakdown {
    pub modules: Vec<ModuleUsage>,
    /// Sum of every module's **billable** declaration. Compared against
    /// `SUM(core.users.used_bytes)` - same axis, so the difference below means
    /// something.
    pub declared_bytes: i64,
    /// `SUM(core.users.used_bytes) - declared_bytes`, floored at zero: the share
    /// of the authoritative total that no module has claimed. Named on the page,
    /// never folded into another slice.
    pub unattributed_bytes: i64,
    /// The opposite imbalance: declarations exceeding the authoritative total.
    /// Normally zero. Non-zero means a module is declaring bytes that the quota
    /// counter never learned about, which is a defect worth showing rather than
    /// clamping into silence.
    pub over_declared_bytes: i64,
    /// Everything the modules physically hold, billable or not. The disk-sizing
    /// figure, and always ≥ `declared_bytes`. It is deliberately *not* compared
    /// against `used_bytes`: they are different questions, and a page that
    /// subtracted one from the other would invent an imbalance.
    pub held_bytes: i64,
    /// Bytes named by a module that another module holds. Reported so the
    /// attribution rule is visible; never added to anything.
    pub delegated_bytes: i64,
    pub delegated_objects: i64,
    /// The instance-wide split by category.
    pub categories: Vec<CategoryUsage>,
    /// The vocabulary itself, so the console renders the categories it is told
    /// about rather than a list compiled into the frontend.
    pub catalog: Vec<super::categories::CategoryInfo>,
    /// How many of the listed modules have never declared.
    pub silent_modules: i64,
    pub stale_hours: i64,
}

/// How long a module may stay silent before its share is called stale.
pub async fn stale_hours(db: &DbPool) -> i64 {
    crate::settings::instance_value(db, STALE_HOURS_SETTING)
        .await
        .as_ref()
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(STALE_HOURS_DEFAULT)
        // An hour is the shortest window that survives a module restart; a year
        // is a threshold that never fires, which is the same as no threshold.
        .clamp(1, 8_760)
}

/// Builds the breakdown against an authoritative total (`SUM(used_bytes)`), which
/// the caller has usually already read for its own header.
///
/// The module list comes from `core.modules` - the registry every module writes
/// itself into at startup. No identifier is compiled in anywhere: a module the
/// core has never met simply is not in the table, and a module installed
/// tomorrow appears without a line of code changing.
pub async fn breakdown(db: &DbPool, authoritative_used: i64) -> Result<Breakdown, AppError> {
    let stale_hours = stale_hours(db).await;

    // Listed: every enabled, non-internal module (what the administration's
    // module list shows), plus any module that has declarations on file even
    // after being disabled - its bytes are still on the disk, and dropping it
    // from the breakdown would quietly move them into "unattributed".
    // "N hours ago" is computed in Rust and bound, rather than expressed with
    // NOW() - make_interval(...) which no other engine spells the same way.
    let stale_before = Utc::now() - Duration::hours(stale_hours);
    let backend = db.backend();

    #[derive(sqlx::FromRow)]
    struct ModuleRow {
        id: String,
        display_name: String,
        is_enabled: bool,
        declared: bool,
        first_declared_at: Option<chrono::DateTime<chrono::Utc>>,
        last_declared_at: Option<chrono::DateTime<chrono::Utc>>,
        last_full_sync_at: Option<chrono::DateTime<chrono::Utc>>,
        stale: Option<bool>,
    }
    let rows = db
        .fetch_all_as::<ModuleRow>(
            r#"SELECT m.id,
                  COALESCE(NULLIF(m.display_name, ''), m.id) AS display_name,
                  m.is_enabled,
                  r.module_id IS NOT NULL                    AS declared,
                  r.first_declared_at,
                  r.last_declared_at,
                  r.last_full_sync_at,
                  r.last_declared_at < $1                     AS stale
             FROM core.modules m
             LEFT JOIN core.storage_reporters r ON r.module_id = m.id
            WHERE (m.is_enabled = TRUE AND m.is_core_module = FALSE)
               OR r.module_id IS NOT NULL"#,
            params![stale_before],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storage_usage: per-module breakdown");
            AppError::Database(e)
        })?;

    // The split, read once and grouped in memory. One query rather than one per
    // module: the table is keyed by module and the whole point of the page is to
    // compare modules, so reading it whole and pivoting here is both cheaper and
    // easier to keep consistent than N round trips.
    #[derive(sqlx::FromRow)]
    struct CatRow {
        module_id: String,
        category: String,
        used: Option<i64>,
        objects: Option<i64>,
        accounts: Option<i64>,
    }
    let cat_rows = db
        .fetch_all_as::<CatRow>(
            &format!(
                r#"SELECT module_id, category,
                      {used}     AS used,
                      {objects}  AS objects,
                      {accounts} AS accounts
                 FROM core.storage_usage
                GROUP BY module_id, category"#,
                used = backend.cast("SUM(used_bytes)", SqlType::BigInt),
                objects = backend.cast("SUM(object_count)", SqlType::BigInt),
                accounts = backend.cast("COUNT(DISTINCT user_id)", SqlType::BigInt),
            ),
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storage_usage: per-category breakdown");
            AppError::Database(e)
        })?;

    let mut per_module: std::collections::HashMap<String, Vec<CategoryUsage>> =
        std::collections::HashMap::new();
    for r in &cat_rows {
        let raw = r.category.clone();
        // A row whose category the current binary does not know can only come
        // from a downgrade. It is shown under its stored name and treated as
        // held-but-not-billed: the conservative choice, since billing bytes the
        // core cannot classify is the one outcome with consequences.
        let known = Category::parse(&raw);
        per_module.entry(r.module_id.clone()).or_default().push(CategoryUsage {
            used_bytes: r.used.unwrap_or(0),
            object_count: r.objects,
            billable: known.is_some_and(Category::is_billable),
            held: known.is_none_or(Category::is_held),
            accounts: r.accounts,
            category: raw,
        });
    }
    for list in per_module.values_mut() {
        sort_categories(list);
    }

    let mut modules: Vec<ModuleUsage> = rows
        .iter()
        .map(|r| {
            let declared = r.declared;
            let module_id = r.id.clone();
            let categories = per_module.remove(&module_id).unwrap_or_default();
            let sum = |f: fn(&CategoryUsage) -> bool| -> i64 {
                categories.iter().filter(|c| f(c)).map(|c| c.used_bytes).sum()
            };
            let objects = |f: fn(&CategoryUsage) -> bool| -> i64 {
                categories
                    .iter()
                    .filter(|c| f(c))
                    .filter_map(|c| c.object_count)
                    .sum()
            };
            let accounts = categories.iter().filter_map(|c| c.accounts).max().unwrap_or(0);
            ModuleUsage {
                module_id,
                display_name: r.display_name.clone(),
                declared,
                // A declaring module with no rows holds zero - a real, measured
                // zero. A module that never declared holds `None`. Collapsing
                // the two is the mistake this whole feature exists to avoid.
                used_bytes: declared.then(|| sum(|c| c.billable)),
                held_bytes: declared.then(|| sum(|c| c.held)),
                delegated_bytes: declared.then(|| sum(|c| !c.held)),
                delegated_objects: declared.then(|| objects(|c| !c.held)),
                object_count: declared.then(|| objects(|c| c.held)),
                accounts: declared.then_some(accounts),
                categories,
                first_declared_at: r.first_declared_at,
                last_declared_at: r.last_declared_at,
                last_full_sync_at: r.last_full_sync_at,
                stale: r.stale.unwrap_or(false),
                is_enabled: r.is_enabled,
            }
        })
        .collect();

    // Biggest billable share first - the order the page reads in. Ties and
    // never-declared modules fall back to the identifier so the list is stable
    // between two refreshes.
    modules.sort_by(|a, b| {
        b.used_bytes
            .cmp(&a.used_bytes)
            .then_with(|| a.module_id.cmp(&b.module_id))
    });

    let declared_bytes: i64 = modules.iter().filter_map(|m| m.used_bytes).sum();
    let held_bytes: i64 = modules.iter().filter_map(|m| m.held_bytes).sum();
    let delegated_bytes: i64 = modules.iter().filter_map(|m| m.delegated_bytes).sum();
    let delegated_objects: i64 = modules.iter().filter_map(|m| m.delegated_objects).sum();
    let silent_modules = modules.iter().filter(|m| !m.declared).count() as i64;
    let categories = fold_categories(modules.iter().flat_map(|m| m.categories.iter()));

    Ok(Breakdown {
        modules,
        declared_bytes,
        unattributed_bytes: (authoritative_used - declared_bytes).max(0),
        over_declared_bytes: (declared_bytes - authoritative_used).max(0),
        held_bytes,
        delegated_bytes,
        delegated_objects,
        categories,
        catalog: super::categories::catalog(),
        silent_modules,
        stale_hours,
    })
}

/// Orders a category list by the vocabulary's display order - billed first, then
/// the module's own machinery, then the pointer to another module's books.
/// Anything the binary does not know sorts last, under its stored name.
fn sort_categories(list: &mut [CategoryUsage]) {
    let rank = |c: &CategoryUsage| {
        Category::parse(&c.category)
            .and_then(|k| Category::ALL.iter().position(|x| *x == k))
            .unwrap_or(usize::MAX)
    };
    list.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.category.cmp(&b.category)));
}

/// Sums category lines coming from several modules into one instance-wide split.
fn fold_categories<'a>(it: impl Iterator<Item = &'a CategoryUsage>) -> Vec<CategoryUsage> {
    let mut acc: std::collections::HashMap<String, CategoryUsage> = std::collections::HashMap::new();
    for c in it {
        let e = acc.entry(c.category.clone()).or_insert_with(|| CategoryUsage {
            category: c.category.clone(),
            used_bytes: 0,
            object_count: None,
            billable: c.billable,
            held: c.held,
            accounts: None,
        });
        e.used_bytes += c.used_bytes;
        if let Some(n) = c.object_count {
            e.object_count = Some(e.object_count.unwrap_or(0) + n);
        }
        // Accounts do not add across modules - the same person can hold content
        // in two of them. The largest single-module figure is the only honest
        // lower bound available without a second query, and it is labelled as
        // such on the page.
        if let Some(n) = c.accounts {
            e.accounts = Some(e.accounts.unwrap_or(0).max(n));
        }
    }
    let mut out: Vec<CategoryUsage> = acc.into_values().collect();
    sort_categories(&mut out);
    out
}

/// Modules that declared once and have since gone quiet past `stale_hours`.
///
/// Used by the reconciliation job to raise an alert. A module that has *never*
/// declared is deliberately not returned: it never promised anything, and
/// alerting on every module that does not store bytes is how an operator learns
/// to dismiss the alert.
pub async fn stale_reporters(
    db: &DbPool,
) -> Result<Vec<(String, String, chrono::DateTime<chrono::Utc>, i64)>, AppError> {
    let hours = stale_hours(db).await;
    let stale_before = Utc::now() - Duration::hours(hours);
    let backend = db.backend();

    #[derive(sqlx::FromRow)]
    struct StaleRow {
        module_id: String,
        display_name: String,
        last_declared_at: chrono::DateTime<chrono::Utc>,
        used: i64,
    }
    let rows = db
        .fetch_all_as::<StaleRow>(
            &format!(
                r#"SELECT r.module_id,
                      COALESCE(NULLIF(m.display_name, ''), m.id) AS display_name,
                      r.last_declared_at,
                      {used} AS used
                 FROM core.storage_reporters r
                 JOIN core.modules m ON m.id = r.module_id
                WHERE m.is_enabled = TRUE
                  AND r.last_declared_at < $1
                ORDER BY r.last_declared_at"#,
                used = backend.cast(
                    "COALESCE((SELECT SUM(used_bytes) FROM core.storage_usage s \
                       WHERE s.module_id = r.module_id), 0)",
                    SqlType::BigInt,
                ),
            ),
            params![stale_before],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storage_usage: silent reporters");
            AppError::Database(e)
        })?;

    Ok(rows
        .into_iter()
        .map(|r| (r.module_id, r.display_name, r.last_declared_at, r.used))
        .collect())
}

// ── One account's sheet ──────────────────────────────────────────────────────

/// Everything the core knows about where one account's bytes live.
///
/// ⚠️ PRIVACY - THE LINE THIS TYPE MUST NOT CROSS.
///
/// This is the most detailed storage view an administrator has of a person, and
/// it is deliberately made of nothing but **volumes, counts of objects and
/// technical categories**. It must never carry, and must never be extended to
/// carry, a file name, a folder name, a path, a MIME type, an extension, a
/// document title, a thumbnail, a date of last access, or any per-object row.
///
/// The reason is not squeamishness. An administrator needs to size a server and
/// to answer "why is this account full"; both are answered by volumes. Knowing
/// that somebody keeps 400 files whose names end in `.docx` in a folder called
/// "Divorce" answers neither, and is not something running the mail server
/// should let you find out. Category identifiers are chosen under the same
/// constraint - see `crate::storage::categories`.
#[derive(Debug, Clone, Serialize)]
pub struct AccountUsage {
    pub user_id: Uuid,
    pub quota_bytes: i64,
    /// The counter quotas are enforced against.
    pub used_bytes: i64,
    /// What the modules say is chargeable to this account. Compared with
    /// `used_bytes` just above: the two should agree, and the page shows the gap
    /// rather than picking a winner.
    pub billable_bytes: i64,
    /// Everything physically held for this account, billed or not.
    pub held_bytes: i64,
    pub delegated_bytes: i64,
    pub delegated_objects: i64,
    /// `used_bytes - billable_bytes`, floored at zero.
    pub unattributed_bytes: i64,
    /// `billable_bytes - used_bytes`, floored at zero.
    pub over_declared_bytes: i64,
    pub modules: Vec<AccountModuleUsage>,
    /// Instance-wide category split for this account, across modules.
    pub categories: Vec<CategoryUsage>,
    pub catalog: Vec<super::categories::CategoryInfo>,
    pub stale_hours: i64,
}

/// One module's line inside one account's sheet.
#[derive(Debug, Clone, Serialize)]
pub struct AccountModuleUsage {
    pub module_id: String,
    pub display_name: String,
    pub billable_bytes: i64,
    pub held_bytes: i64,
    pub delegated_bytes: i64,
    pub delegated_objects: i64,
    pub object_count: i64,
    pub categories: Vec<CategoryUsage>,
    pub last_declared_at: Option<chrono::DateTime<chrono::Utc>>,
    pub stale: bool,
}

/// Reads one account's breakdown, module by module and category by category.
///
/// Only modules that hold something for this account are listed. A module that
/// declares but holds nothing for this person is absent rather than shown at
/// zero: on an instance with twenty modules, nineteen zeroes bury the one line
/// that matters.
pub async fn account_usage(db: &DbPool, user_id: Uuid) -> Result<AccountUsage, AppError> {
    let stale_hours = stale_hours(db).await;

    let (quota_bytes, used_bytes) = db
        .fetch_optional_as::<(i64, i64)>(
            "SELECT quota_bytes, used_bytes FROM core.users WHERE id = $1",
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "storage_usage: account read");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound(format!("Account {user_id}")))?;

    let stale_before = Utc::now() - Duration::hours(stale_hours);
    #[derive(sqlx::FromRow)]
    struct AcctRow {
        module_id: String,
        display_name: String,
        category: String,
        used_bytes: i64,
        object_count: Option<i64>,
        last_declared_at: Option<chrono::DateTime<chrono::Utc>>,
        stale: Option<bool>,
    }
    let rows = db
        .fetch_all_as::<AcctRow>(
            r#"SELECT s.module_id,
                  COALESCE(NULLIF(m.display_name, ''), m.id) AS display_name,
                  s.category,
                  s.used_bytes,
                  s.object_count,
                  r.last_declared_at,
                  r.last_declared_at < $2 AS stale
             FROM core.storage_usage s
             JOIN core.modules m           ON m.id = s.module_id
             LEFT JOIN core.storage_reporters r ON r.module_id = s.module_id
            WHERE s.user_id = $1"#,
            params![user_id, stale_before],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "storage_usage: account sheet");
            AppError::Database(e)
        })?;

    let mut modules: Vec<AccountModuleUsage> = Vec::new();
    for r in &rows {
        let raw = r.category.clone();
        let known = Category::parse(&raw);
        let line = CategoryUsage {
            used_bytes: r.used_bytes,
            object_count: r.object_count,
            billable: known.is_some_and(Category::is_billable),
            held: known.is_none_or(Category::is_held),
            // Always this one account - a number that would say nothing.
            accounts: None,
            category: raw,
        };
        match modules.iter_mut().find(|m| m.module_id == r.module_id) {
            Some(m) => m.categories.push(line),
            None => modules.push(AccountModuleUsage {
                module_id: r.module_id.clone(),
                display_name: r.display_name.clone(),
                billable_bytes: 0,
                held_bytes: 0,
                delegated_bytes: 0,
                delegated_objects: 0,
                object_count: 0,
                categories: vec![line],
                last_declared_at: r.last_declared_at,
                stale: r.stale.unwrap_or(false),
            }),
        }
    }

    for m in &mut modules {
        sort_categories(&mut m.categories);
        m.billable_bytes = m.categories.iter().filter(|c| c.billable).map(|c| c.used_bytes).sum();
        m.held_bytes = m.categories.iter().filter(|c| c.held).map(|c| c.used_bytes).sum();
        m.delegated_bytes = m.categories.iter().filter(|c| !c.held).map(|c| c.used_bytes).sum();
        m.delegated_objects = m
            .categories
            .iter()
            .filter(|c| !c.held)
            .filter_map(|c| c.object_count)
            .sum();
        m.object_count = m
            .categories
            .iter()
            .filter(|c| c.held)
            .filter_map(|c| c.object_count)
            .sum();
    }
    modules.sort_by(|a, b| {
        b.billable_bytes
            .cmp(&a.billable_bytes)
            .then_with(|| b.held_bytes.cmp(&a.held_bytes))
            .then_with(|| a.module_id.cmp(&b.module_id))
    });

    let billable_bytes: i64 = modules.iter().map(|m| m.billable_bytes).sum();
    let held_bytes: i64 = modules.iter().map(|m| m.held_bytes).sum();
    let delegated_bytes: i64 = modules.iter().map(|m| m.delegated_bytes).sum();
    let delegated_objects: i64 = modules.iter().map(|m| m.delegated_objects).sum();
    let categories = fold_categories(modules.iter().flat_map(|m| m.categories.iter()));

    Ok(AccountUsage {
        user_id,
        quota_bytes,
        used_bytes,
        billable_bytes,
        held_bytes,
        delegated_bytes,
        delegated_objects,
        unattributed_bytes: (used_bytes - billable_bytes).max(0),
        over_declared_bytes: (billable_bytes - used_bytes).max(0),
        modules,
        categories,
        catalog: super::categories::catalog(),
        stale_hours,
    })
}

// ── The repair path ──────────────────────────────────────────────────────────

/// Why a reconciliation pass declined to correct anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RepairBlocker {
    /// A module has declared at some point but never completed a full sync, so
    /// its rows may be a partial picture. Correcting from a partial picture
    /// lowers ceilings for bytes that exist.
    NeverFullySynced,
    /// A module's declarations are older than the staleness window. Its figures
    /// may describe a state that has since changed.
    Stale,
    /// **No module declares at all.** Without this the repair would read "the
    /// modules bill nobody anything", conclude that every counter should be
    /// zero, and wipe the quota accounting of an instance whose only fault is
    /// that the channel has not been wired yet. The one blocker that is about
    /// the instance rather than about a module.
    NoDeclarant,
}

/// A declarant that is not in a state to be trusted for a correction.
///
/// Carries the reason as well as the name: "the repair is suspended" is not
/// actionable, "photos has never sent a complete state" is.
#[derive(Debug, Clone, Serialize)]
pub struct BlockedDeclarant {
    /// Empty for [`RepairBlocker::NoDeclarant`], which is about the instance
    /// rather than about any one module.
    pub module_id: String,
    pub blocker: RepairBlocker,
}

/// Modules whose condition suspends the whole repair.
///
/// The check is deliberately *global*: a correction driven by all-but-one module
/// would silently subtract the missing one's share from every account it holds
/// bytes for. There is no safe partial repair, so a single unfit declarant stops
/// the pass - and the existing staleness alert already tells an operator which.
pub async fn repair_blockers(db: &DbPool) -> Result<Vec<BlockedDeclarant>, AppError> {
    let hours = stale_hours(db).await;
    let stale_before = Utc::now() - Duration::hours(hours);
    #[derive(sqlx::FromRow)]
    struct BlockerRow {
        module_id: String,
        never_full: bool,
        stale: Option<bool>,
    }
    let rows = db
        .fetch_all_as::<BlockerRow>(
            r#"SELECT r.module_id,
                  r.last_full_sync_at IS NULL AS never_full,
                  r.last_declared_at < $1 AS stale
             FROM core.storage_reporters r
             JOIN core.modules m ON m.id = r.module_id
            WHERE m.is_enabled = TRUE
            ORDER BY r.module_id"#,
            params![stale_before],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storage_usage: declarant fitness for realignment");
            AppError::Database(e)
        })?;

    // An instance where nobody declares is not an instance where nobody stores
    // anything. Reading the empty table as "every account bills zero" would zero
    // every counter on the platform, which is the single worst thing this job
    // could do - so the absence of declarants is itself a blocker.
    if rows.is_empty() {
        return Ok(vec![BlockedDeclarant {
            module_id: String::new(),
            blocker: RepairBlocker::NoDeclarant,
        }]);
    }

    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let module_id = r.module_id;
            if r.never_full {
                Some(BlockedDeclarant { module_id, blocker: RepairBlocker::NeverFullySynced })
            } else if r.stale.unwrap_or(false) {
                Some(BlockedDeclarant { module_id, blocker: RepairBlocker::Stale })
            } else {
                None
            }
        })
        .collect())
}

/// One account whose counter disagrees with what the modules bill it.
#[derive(Debug, Clone)]
pub struct CounterDrift {
    pub user_id: Uuid,
    pub email: String,
    pub quota_bytes: i64,
    /// What `core.users.used_bytes` says today.
    pub counter_bytes: i64,
    /// What the modules' billable declarations add up to.
    pub declared_bytes: i64,
}

impl CounterDrift {
    pub fn delta(&self) -> i64 {
        self.declared_bytes - self.counter_bytes
    }
    /// True when applying the correction would put this account past its ceiling
    /// while it was under it before. The one outcome worth stopping for: a
    /// person who could save this morning and cannot this afternoon, for reasons
    /// entirely internal to the platform.
    pub fn would_newly_exceed_quota(&self) -> bool {
        self.quota_bytes > 0
            && self.declared_bytes > self.quota_bytes
            && self.counter_bytes <= self.quota_bytes
    }
}

/// Accounts whose counter differs from the modules' billable declarations by at
/// least `min_delta` bytes.
///
/// Accounts with no declarations at all are included with `declared_bytes = 0`
/// only when their counter is non-zero - otherwise every account on the instance
/// would be a candidate for a correction to the value it already has.
pub async fn counter_drifts(db: &DbPool, min_delta: i64) -> Result<Vec<CounterDrift>, AppError> {
    let billable: Vec<String> = Category::ALL
        .iter()
        .filter(|c| c.is_billable())
        .map(|c| c.as_str().to_owned())
        .collect();

    // `= ANY($1::text[])` over the billable category list becomes an ` IN (...)`
    // built by the query builder; the `::text`/`::bigint` casts become the
    // engine-aware cast. The staleness threshold and the sums stay the same.
    let backend = db.backend();
    let mut qb = DbQueryBuilder::new(
        backend,
        format!(
            r#"SELECT u.id, {email} AS email, u.quota_bytes, u.used_bytes,
                  {declared} AS declared
             FROM core.users u
             LEFT JOIN (
                   SELECT user_id, {subsum} AS declared
                     FROM core.storage_usage
                    WHERE category"#,
            email = backend.cast("u.email", SqlType::Text),
            declared = backend.cast("COALESCE(d.declared, 0)", SqlType::BigInt),
            subsum = backend.cast("SUM(used_bytes)", SqlType::BigInt),
        ),
    );
    qb.push_in(billable);
    qb.push(
        " GROUP BY user_id \
             ) d ON d.user_id = u.id \
            WHERE (d.declared IS NOT NULL OR u.used_bytes <> 0) \
              AND ABS(COALESCE(d.declared, 0) - u.used_bytes) >= ",
    );
    qb.push_bind(min_delta);
    qb.push(" ORDER BY ABS(COALESCE(d.declared, 0) - u.used_bytes) DESC");

    #[derive(sqlx::FromRow)]
    struct DriftRow {
        id: Uuid,
        email: String,
        quota_bytes: i64,
        used_bytes: i64,
        declared: i64,
    }
    let rows: Vec<DriftRow> = qb.fetch_all_as(db).await.map_err(|e| {
        tracing::error!(error = %e, "storage_usage: counter drifts");
        AppError::Database(e)
    })?;

    Ok(rows
        .into_iter()
        .map(|r| CounterDrift {
            user_id: r.id,
            email: r.email,
            quota_bytes: r.quota_bytes,
            counter_bytes: r.used_bytes,
            declared_bytes: r.declared,
        })
        .collect())
}

/// The setting that turns the repair on, and the one that says how small a
/// difference is not worth touching.
pub const AUTHORITATIVE_SETTING: &str = "storage.usage_authoritative";
pub const CORRECTION_MIN_SETTING: &str = "storage.usage_correction_min_bytes";
const CORRECTION_MIN_DEFAULT: i64 = 4_096;

/// What a repair pass did, or refused to do.
#[derive(Debug, Clone, Serialize)]
pub struct RepairReport {
    /// `storage.usage_authoritative`.
    pub enabled: bool,
    /// Declarants whose condition suspends the whole pass, each with its reason.
    /// Non-empty means nothing was corrected, whatever else this report says.
    pub blocked_by: Vec<BlockedDeclarant>,
    pub min_delta_bytes: i64,
    /// Accounts whose counter disagrees with the declarations by at least
    /// `min_delta_bytes`.
    pub drifting_accounts: i64,
    /// Accounts actually rewritten.
    pub corrected_accounts: i64,
    /// Net movement applied to `SUM(core.users.used_bytes)`.
    pub bytes_moved: i64,
    /// Accounts deliberately left alone because the correction would have taken
    /// them from under their quota to over it. Never corrected silently: this is
    /// a person who could save this morning and could not this afternoon, for
    /// reasons entirely internal to the platform.
    pub held_back: Vec<HeldBackAccount>,
}

/// An account the repair refused to push over its own ceiling.
#[derive(Debug, Clone, Serialize)]
pub struct HeldBackAccount {
    pub user_id: Uuid,
    pub email: String,
    pub quota_bytes: i64,
    pub counter_bytes: i64,
    pub declared_bytes: i64,
}

impl From<&CounterDrift> for HeldBackAccount {
    fn from(d: &CounterDrift) -> Self {
        Self {
            user_id: d.user_id,
            email: d.email.clone(),
            quota_bytes: d.quota_bytes,
            counter_bytes: d.counter_bytes,
            declared_bytes: d.declared_bytes,
        }
    }
}

/// How small a difference is left alone.
pub async fn correction_min_bytes(db: &DbPool) -> i64 {
    crate::settings::instance_value(db, CORRECTION_MIN_SETTING)
        .await
        .as_ref()
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(CORRECTION_MIN_DEFAULT)
        // Zero would correct on every rounding difference and journalise it;
        // a gibibyte is a threshold that never fires.
        .clamp(1, 1_073_741_824)
}

/// Whether the core is allowed to rewrite `core.users.used_bytes`.
pub async fn repair_enabled(db: &DbPool) -> bool {
    crate::settings::instance_value(db, AUTHORITATIVE_SETTING)
        .await
        .as_ref()
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

/// Assembles the repair's current position **without changing anything**, for
/// the administration console: is it on, is it suspended and by whom, what would
/// it do, and whom is it holding back.
pub async fn repair_preview(db: &DbPool) -> Result<RepairReport, AppError> {
    build_report(db, false).await
}

/// Realigns `core.users.used_bytes` on what the modules bill each account.
///
/// ## Why this is safe where migration 000095 said it was not
///
/// * Only **billable** categories are summed. A module declaring its thumbnails
///   cannot move anybody's ceiling.
/// * A single unfit declarant - stale, or never having completed a full sync -
///   suspends the pass entirely. There is no safe partial repair: correcting
///   from all-but-one module's books silently subtracts the missing one's share
///   from every account it holds bytes for.
/// * An account that would cross its quota *because of the correction* is left
///   alone and named. Raising a figure is arithmetic; taking away somebody's
///   ability to save is a decision, and it is not one a job makes at 4 a.m.
/// * Every write is audited with its before and after.
///
/// The update is conditional on the counter still holding the value that was
/// read, so a module writing concurrently wins and the repair simply retries an
/// hour later against the newer figure.
pub async fn repair_counters(db: &DbPool) -> Result<RepairReport, AppError> {
    build_report(db, true).await
}

async fn build_report(db: &DbPool, apply: bool) -> Result<RepairReport, AppError> {
    let enabled = repair_enabled(db).await;
    let min_delta = correction_min_bytes(db).await;
    let blockers = repair_blockers(db).await?;
    let drifts = counter_drifts(db, min_delta).await?;

    let mut report = RepairReport {
        enabled,
        blocked_by: blockers.clone(),
        min_delta_bytes: min_delta,
        drifting_accounts: drifts.len() as i64,
        corrected_accounts: 0,
        bytes_moved: 0,
        held_back: drifts
            .iter()
            .filter(|d| d.would_newly_exceed_quota())
            .map(HeldBackAccount::from)
            .collect(),
    };

    if !apply || !enabled || !blockers.is_empty() {
        return Ok(report);
    }

    let ctx = crate::audit::AuditContext::system("Recalage du stockage (core)");

    for d in drifts.iter().filter(|d| !d.would_newly_exceed_quota()) {
        // Conditional on the value read: a module that wrote in the meantime is
        // more current than this pass, and its figure must stand.
        let updated = db
            .execute(
                "UPDATE core.users SET used_bytes = $1 WHERE id = $2 AND used_bytes = $3",
                params![d.declared_bytes, d.user_id, d.counter_bytes],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, user_id = %d.user_id, "storage_usage: counter realignment");
                AppError::Database(e)
            })?;

        if updated == 0 {
            tracing::debug!(
                user_id = %d.user_id,
                "Realignment skipped: the counter moved between read and write"
            );
            continue;
        }

        report.corrected_accounts += 1;
        report.bytes_moved += d.delta();

        ctx.record(
            db,
            crate::audit::AuditEntry::new("core.storage.usage_correct")
                .module("core")
                .target(crate::audit::redact::target::USER, d.user_id, d.email.clone())
                .before(serde_json::json!({ "used_bytes": d.counter_bytes }))
                .after(serde_json::json!({ "used_bytes": d.declared_bytes }))
                .detail(format!(
                    "Compteur recalé sur les déclarations des modules ({:+} octet(s))",
                    d.delta()
                )),
        )
        .await;
    }

    if report.corrected_accounts > 0 {
        tracing::info!(
            comptes = report.corrected_accounts,
            octets = report.bytes_moved,
            "Recalage du stockage : compteurs réalignés sur les déclarations"
        );
    }
    if !report.held_back.is_empty() {
        // Loud on purpose: this is the state that needs a human, and it is
        // invisible everywhere else until somebody opens the storage page.
        tracing::warn!(
            comptes = report.held_back.len(),
            "Recalage du stockage suspendu pour des comptes que la correction ferait passer au-dessus de leur quota"
        );
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(bytes: i64) -> UsageEntry {
        UsageEntry {
            user_id: Uuid::new_v4(),
            used_bytes: bytes,
            object_count: None,
            category: None,
        }
    }

    fn cat(category: &str, bytes: i64, objects: Option<i64>) -> CategoryUsage {
        let known = Category::parse(category);
        CategoryUsage {
            category: category.to_owned(),
            used_bytes: bytes,
            object_count: objects,
            billable: known.is_some_and(Category::is_billable),
            held: known.is_none_or(Category::is_held),
            accounts: None,
        }
    }

    #[test]
    fn a_negative_total_is_refused() {
        assert!(validate(&[entry(-1)]).is_err());
    }

    #[test]
    fn a_negative_object_count_is_refused() {
        let mut e = entry(10);
        e.object_count = Some(-3);
        assert!(validate(&[e]).is_err());
    }

    #[test]
    fn an_oversized_declaration_is_refused_before_touching_the_database() {
        let entries: Vec<UsageEntry> = (0..=MAX_ENTRIES).map(|_| entry(1)).collect();
        assert!(validate(&entries).is_err());
    }

    #[test]
    fn an_empty_declaration_is_valid() {
        // A module that holds nothing must be able to say so: that is what makes
        // "declared zero" distinguishable from "never declared".
        assert!(validate(&[]).is_ok());
    }

    #[test]
    fn a_zero_total_is_valid() {
        assert!(validate(&[entry(0)]).is_ok());
    }

    // ── Categories on the wire ───────────────────────────────────────────────

    #[test]
    fn omitting_the_category_declares_user_content() {
        // Back-compatibility that is correct rather than merely tolerant: a
        // module written against the first version of this channel declared
        // exactly one kind of bytes, and it was the billable one.
        assert_eq!(validate(&[entry(10)]).ok(), Some(vec![Category::Content]));
    }

    #[test]
    fn an_unknown_category_is_refused_rather_than_billed_as_content() {
        let mut e = entry(10);
        e.category = Some("thumbs".into());
        let err = validate(&[e]).expect_err("an unknown category must be refused");
        // The refusal must name the vocabulary, or the module author is left
        // guessing what the core would have accepted.
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("thumbnails")), "{err:?}");
    }

    #[test]
    fn every_category_of_the_vocabulary_is_accepted() {
        for c in Category::ALL {
            let mut e = entry(1);
            e.category = Some(c.as_str().into());
            assert_eq!(validate(&[e]).ok(), Some(vec![*c]), "{c}");
        }
    }

    // ── No double counting ───────────────────────────────────────────────────

    #[test]
    fn a_document_written_by_one_module_and_stored_by_another_is_counted_once() {
        // The scenario the attribution rule exists for: office creates a
        // document, drive stores it. Drive declares the bytes as content;
        // office names the same object as delegated. The account is billed for
        // one copy and the physical total counts one copy.
        let drive = [cat("content", 4_096, Some(1))];
        let office = [
            cat("delegated", 4_096, Some(1)), // office naming what it is behind
            cat("cache", 512, Some(2)),       // its own Yjs machinery
        ];

        let billable: i64 = drive
            .iter()
            .chain(office.iter())
            .filter(|c| c.billable)
            .map(|c| c.used_bytes)
            .sum();
        let held: i64 = drive
            .iter()
            .chain(office.iter())
            .filter(|c| c.held)
            .map(|c| c.used_bytes)
            .sum();

        assert_eq!(billable, 4_096, "the document must be billed exactly once");
        assert_eq!(held, 4_096 + 512, "delegated bytes must not inflate the physical total");
    }

    #[test]
    fn delegated_bytes_never_enter_any_total() {
        let folded = fold_categories([cat("content", 100, Some(1)), cat("delegated", 100, Some(1))].iter());
        let billable: i64 = folded.iter().filter(|c| c.billable).map(|c| c.used_bytes).sum();
        let held: i64 = folded.iter().filter(|c| c.held).map(|c| c.used_bytes).sum();
        assert_eq!(billable, 100);
        assert_eq!(held, 100);
    }

    // ── The sums are consistent ──────────────────────────────────────────────

    #[test]
    fn what_is_billed_is_a_subset_of_what_is_held() {
        let lines: Vec<CategoryUsage> = Category::ALL.iter().map(|c| cat(c.as_str(), 1_000, Some(1))).collect();
        let billable: i64 = lines.iter().filter(|c| c.billable).map(|c| c.used_bytes).sum();
        let held: i64 = lines.iter().filter(|c| c.held).map(|c| c.used_bytes).sum();
        assert!(billable < held, "only what the account can free is billed");
        assert_eq!(billable, 3_000, "content + trash + versions");
        assert_eq!(held, 9_000, "every category except delegated");
    }

    #[test]
    fn folding_categories_adds_bytes_and_objects_but_not_accounts() {
        let mut a = cat("content", 10, Some(2));
        a.accounts = Some(3);
        let mut b = cat("content", 5, Some(1));
        b.accounts = Some(4);
        let folded = fold_categories([a, b].iter());
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].used_bytes, 15);
        assert_eq!(folded[0].object_count, Some(3));
        // The same person can hold content in two modules, so account counts do
        // not add; the largest single-module figure is the honest lower bound.
        assert_eq!(folded[0].accounts, Some(4));
    }

    #[test]
    fn categories_are_shown_in_the_vocabulary_s_order_with_the_unknown_last() {
        let mut lines = vec![
            cat("delegated", 1, None),
            cat("zzz_from_the_future", 1, None),
            cat("thumbnails", 1, None),
            cat("content", 1, None),
        ];
        sort_categories(&mut lines);
        let order: Vec<&str> = lines.iter().map(|c| c.category.as_str()).collect();
        assert_eq!(order, ["content", "thumbnails", "delegated", "zzz_from_the_future"]);
    }

    #[test]
    fn a_category_this_binary_does_not_know_is_held_but_never_billed() {
        // Only reachable by downgrading the core under a newer module. Billing
        // bytes the core cannot classify is the one mistake with consequences.
        let c = cat("from_the_future", 999, None);
        assert!(!c.billable);
        assert!(c.held);
    }

    // ── The repair refuses to make anybody's ceiling worse ───────────────────

    fn drift(counter: i64, declared: i64, quota: i64) -> CounterDrift {
        CounterDrift {
            user_id: Uuid::new_v4(),
            email: "someone@example.invalid".into(),
            quota_bytes: quota,
            counter_bytes: counter,
            declared_bytes: declared,
        }
    }

    #[test]
    fn a_correction_that_newly_exceeds_a_quota_is_flagged() {
        assert!(drift(900, 1_500, 1_000).would_newly_exceed_quota());
    }

    #[test]
    fn a_correction_on_an_account_already_over_quota_is_not_a_new_breach() {
        // It was already over; raising the figure does not take away a capability
        // it still had this morning.
        assert!(!drift(1_200, 1_500, 1_000).would_newly_exceed_quota());
    }

    #[test]
    fn a_correction_that_stays_under_the_quota_is_not_flagged() {
        assert!(!drift(900, 950, 1_000).would_newly_exceed_quota());
    }

    #[test]
    fn a_downward_correction_is_never_a_breach() {
        assert!(!drift(1_500, 900, 1_000).would_newly_exceed_quota());
    }

    #[test]
    fn an_account_without_a_quota_cannot_newly_exceed_one() {
        assert!(!drift(900, 9_000_000, 0).would_newly_exceed_quota());
    }
}
