//! `/admin/dashboard` - the instance overview, as panels of counted facts.
//!
//! # The rule, identical to its sibling
//!
//! This endpoint is the general counterpart of
//! [`super::security_dashboard`], and it obeys the same three rules on purpose:
//! one closed list of periods, one window resolver, one comparison against the
//! window of *identical length* immediately before the reading. Two dashboards
//! in one console whose "−12 %" meant two different things would be worse than
//! having only one of them, so the machinery is shared
//! ([`super::period`]) rather than re-derived here.
//!
//! Every figure is read from a table the core itself writes. Nothing is
//! estimated, extrapolated or seeded.
//!
//! # Events and snapshots are not the same kind of number
//!
//! Half of these panels count *things that happened* over the window (accounts
//! created, sessions opened, applications used); the other half describe *what
//! is true now* (how the accounts are spread between active and suspended, which
//! modules are healthy, how much of the storage is taken).
//!
//! A snapshot has no honest percentage: nothing records what the role
//! distribution looked like thirty days ago, and reconstructing it from
//! `created_at` would answer a question nobody asked. Those panels therefore
//! carry `previous_total: null` and the console prints "état actuel" instead of
//! an arrow. The single exception is storage, which *is* sampled daily
//! (`core.storage_samples`) and can therefore state a real variation.
//!
//! # What is missing, and why it is missing rather than zero
//!
//! The reference console this page is modelled on also panels **file sharing
//! exposure** - how much is shared, internally and externally. That fact lives
//! in `drive`, in `photos`, in `office`: module schemas the core never reads. It
//! is not rendered here, and the page says so in words, because a panel showing
//! `0` would be read as "nothing is shared" when it means "nobody measured".
//! The channel that would carry it is the one
//! [`super::security_dashboard`] already describes: a sibling of
//! `POST /internal/storage/usage`, authenticated by `X-Internal-Secret`,
//! attributed to the calling module, with a closed vocabulary of metric ids and
//! counters bucketed by day.
//!
//! # Serving a report as well as a page
//!
//! The console's report page (`/admin/reports/<panel>`) is a printable document
//! about ONE panel over ONE period, and it reads this same endpoint - narrowed
//! by `?panel=<id>` and widened by `?full=true`. Both are explicit parameters
//! rather than a change of default: a report must not truncate a ranking at six
//! accounts, and a dashboard must not pay a report's query cost to draw six.
//! Everything else - the window, the comparison, the privileges - is the same
//! reading, so a figure printed on paper and the figure on the card can never
//! disagree.
//!
//! # Scope
//!
//! Every panel is an INSTANCE-WIDE aggregate, so each is gated on its privilege
//! **at instance scope**. A delegated administrator who reads one organisational
//! unit is not shown an instance-wide figure with their unit's name implied on
//! it: the panel is withheld and named in `withheld`.

use axum::{
    extract::{Query, State},
    Json,
};
use chrono::{NaiveDate, Utc};
use kubuno_db::{params, DbPool, DbValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::audit::AdminAudit;
use crate::authz::{keys, AdminCtx};
use crate::errors::AppError;
use crate::state::AppState;

use super::detail::{self, DetailTable};
use super::period::{self, Counted, Point, Provenance, Slice, Window, PERIODS};

// ── The catalogue ────────────────────────────────────────────────────────────

/// One panel: its stable id and the privilege it takes to be shown it.
///
/// The id is the console's translation key AND its layout key, which is why it
/// is a `&'static str` fixed here rather than anything derived.
struct Panelled {
    id: &'static str,
    privilege: &'static str,
    /// An ADDITIONAL privilege, at instance scope, for the panel's records.
    ///
    /// A figure and the list behind it are not always the same disclosure. "How
    /// many accounts were created" is a statistic (`core.stats.read`); the list
    /// of who they are is the account directory (`core.users.read`), and serving
    /// it under the statistic's privilege would hand a delegated reporter the
    /// directory they were deliberately not given. `None` where the records are
    /// exactly the facts the panel's own privilege already opens.
    detail_privilege: Option<&'static str>,
}

impl Panelled {
    const fn new(id: &'static str, privilege: &'static str) -> Self {
        Self { id, privilege, detail_privilege: None }
    }

    /// The records of this panel name accounts, and reading them takes `key` as
    /// well as the panel's own privilege.
    const fn naming_accounts(mut self, key: &'static str) -> Self {
        self.detail_privilege = Some(key);
        self
    }
}

/// In the order the console lays them out by default.
///
/// Ordered as an operator reads the instance: the people first, then how they
/// get in, then what they use, then what it costs, then the machinery.
const PANELS: &[Panelled] = &[
    Panelled::new("new_users", keys::STATS_READ).naming_accounts(keys::USERS_READ),
    Panelled::new("account_status", keys::USERS_READ),
    Panelled::new("signins", keys::SESSIONS_READ),
    Panelled::new("unique_signins", keys::SESSIONS_READ),
    Panelled::new("app_usage", keys::STATS_READ),
    Panelled::new("storage", keys::STORAGE_READ),
    Panelled::new("top_storage", keys::STORAGE_READ),
    Panelled::new("user_roles", keys::USERS_READ),
    Panelled::new("device_sessions", keys::SESSIONS_READ),
    Panelled::new("module_status", keys::MODULES_READ),
    Panelled::new("events", keys::AUDIT_READ),
];

/// Slices kept in a breakdown. Beyond this the tail is folded by the console
/// rather than given a colour of its own.
const MAX_SLICES: i64 = 8;

/// Accounts named in the storage ranking. Six, like the panel it replaces: a
/// ranking that names everybody is a table, and the console has one of those.
const TOP_ACCOUNTS: i64 = 6;

/// One row per sign-in, written by every authentication path. See the note on
/// the `signins` panel for why `core.refresh_tokens` is NOT this source.
const SIGN_INS: Counted =
    Counted::rows("core.device_events", "occurred_at", "t.kind = 'session_opened'");

/// The same events, reduced to the accounts behind them.
const UNIQUE_SIGN_INS: Counted = Counted::distinct(
    "core.device_events",
    "occurred_at",
    "t.kind = 'session_opened'",
    "t.actor_id",
);

// ── One panel, as it goes over the wire ──────────────────────────────────────

#[derive(Debug, Serialize)]
struct Panel {
    id: &'static str,
    total: i64,
    /// The same measurement over the window of identical length before this one.
    ///
    /// `None` means the panel describes the present and nothing recorded its
    /// past - see the note at the top of the file. The console prints "état
    /// actuel" rather than inventing an arrow.
    previous_total: Option<i64>,
    /// Read as a top-N list rather than as parts of a whole.
    ranking: bool,
    /// How `total`, the series and the slices are to be spelt: `count` or
    /// `bytes`. Sent rather than inferred from the id, so a console that does
    /// not know a panel still formats its figure correctly.
    unit: &'static str,
    /// The ceiling `total` is a share of, when it has one (the promised storage
    /// against the storage taken). `None` for a figure that is not a fraction of
    /// anything.
    capacity: Option<i64>,
    series: Vec<Point>,
    breakdown: Vec<Slice>,
    /// The breakdown stopped at the ceiling rather than at its own end. Printed
    /// by a report, which would otherwise present a cut list as a complete one.
    breakdown_truncated: bool,
    /// A limit of the MEASUREMENT, printed under the chart. Never a warning
    /// about the instance - a statement about what the number can mean.
    caveat: Option<&'static str>,
    /// Where the figure comes from - the table, the predicate, the unit. Read by
    /// the report page, which states the method under the tables.
    ///
    /// Carried by the constructors rather than added afterwards: a panel whose
    /// provenance was forgotten would print a method section describing nothing,
    /// and the compiler is the only reviewer that never forgets.
    source: Provenance,
    /// The records behind the figure, when the caller asked for them
    /// (`?detail=true`) and the source has individual rows to give.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<DetailTable>,
    /// Why there are none. A closed vocabulary ([`detail::absent`]) the console
    /// turns into one sentence: half of this page describes what is true *now*,
    /// and "there is nothing to list" is a fact worth stating rather than a
    /// section quietly missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail_absent: Option<&'static str>,
}

/// What the caller asked of a panel's records, once the privileges are known.
///
/// Resolved by the handler, where the caller's scopes live, and handed to
/// [`compute`] so a panel cannot accidentally read rows the handler had already
/// decided to withhold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Records {
    /// Not asked for - a dashboard card. Nothing is read and nothing is said.
    NotAsked,
    /// Asked for, and the caller holds what it takes.
    Asked,
    /// Asked for, and refused: the rows name people this caller may not read.
    Withheld,
}

impl Panel {
    /// A count of things that happened over the window.
    fn events(id: &'static str, source: Provenance, total: i64, previous: i64) -> Self {
        Self {
            id,
            total,
            previous_total: Some(previous),
            ranking: false,
            unit: "count",
            capacity: None,
            series: Vec::new(),
            breakdown: Vec::new(),
            breakdown_truncated: false,
            caveat: None,
            source,
            detail: None,
            detail_absent: None,
        }
    }

    /// A description of what is true now, with no past to compare against.
    ///
    /// A snapshot has no records to list either, and for the same reason: there
    /// is no window over which they would have happened. The absence is stated
    /// here, once, rather than remembered at seven call sites.
    fn snapshot(id: &'static str, source: Provenance, total: i64) -> Self {
        Self {
            id,
            total,
            previous_total: None,
            ranking: false,
            unit: "count",
            capacity: None,
            series: Vec::new(),
            breakdown: Vec::new(),
            breakdown_truncated: false,
            caveat: None,
            source,
            detail: None,
            detail_absent: Some(detail::absent::SNAPSHOT),
        }
    }

    fn with_series(mut self, series: Vec<Point>) -> Self {
        self.series = series;
        self
    }

    /// The breakdown, and whether it stopped at the ceiling `limit` rather than
    /// at its own end.
    fn with_breakdown(mut self, breakdown: Vec<Slice>, limit: i64) -> Self {
        self.breakdown_truncated = breakdown.len() as i64 >= limit;
        self.breakdown = breakdown;
        self
    }

    /// A breakdown read WITHOUT a ceiling: the grouping is closed (three account
    /// states, four module statuses) and the statement carries no `LIMIT` to
    /// hit, so the list is complete by construction.
    fn with_all(mut self, breakdown: Vec<Slice>) -> Self {
        self.breakdown = breakdown;
        self
    }

    fn into_ranking(mut self) -> Self {
        self.ranking = true;
        self
    }

    fn in_bytes(mut self, capacity: Option<i64>) -> Self {
        self.unit = "bytes";
        self.capacity = capacity;
        self
    }

    fn caveat(mut self, caveat: &'static str) -> Self {
        self.caveat = Some(caveat);
        self
    }

    /// The records read behind the figure, or the reason there are none - the
    /// pair [`records_of`] returns.
    fn with_records(mut self, records: (Option<DetailTable>, Option<&'static str>)) -> Self {
        self.detail = records.0;
        self.detail_absent = records.1;
        self
    }

    /// This panel has no records to list, and this is why. Overrides whatever
    /// the constructor assumed, so a ranking says "the breakdown above is the
    /// list" rather than the snapshot's "there is no window".
    fn without_records(mut self, why: &'static str) -> Self {
        self.detail = None;
        self.detail_absent = Some(why);
        self
    }
}

/// Reads the records behind a windowed panel, or states why it did not.
///
/// The three answers are the three states of [`Records`], and they are decided
/// by the handler rather than here: a panel must not be able to read rows the
/// privilege check already refused.
async fn records_of(
    db: &DbPool,
    what: &Counted,
    win: &Window,
    ask: Records,
    columns: &'static [detail::DetailColumn],
    label: &'static str,
) -> Result<(Option<DetailTable>, Option<&'static str>), AppError> {
    match ask {
        Records::NotAsked => Ok((None, None)),
        Records::Withheld => Ok((None, Some(detail::absent::WITHHELD))),
        Records::Asked => Ok((
            Some(detail::read(db, what, win, columns, label).await?),
            None,
        )),
    }
}

// ── Small readers ────────────────────────────────────────────────────────────

/// `(key, count)` rows, for a breakdown whose grouping is not a plain column.
///
/// `sql` is always assembled in this file (engine-neutral aggregates via the
/// backend helpers); the window bounds, when there are any, are bound parameters.
async fn key_counts(
    db: &DbPool,
    sql: &str,
    binds: Vec<DbValue>,
    label: &'static str,
) -> Result<Vec<Slice>, AppError> {
    let rows: Vec<(String, i64)> = db
        .fetch_all_as(sql, binds)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, panel = %label, "dashboard : répartition");
            AppError::Database(e)
        })?;
    Ok(rows.into_iter().map(|(k, v)| Slice::new(k, v)).collect())
}

/// The two totals of a day-keyed source, read in ONE statement so the reading
/// and its comparison can never come from different instants.
async fn day_keyed_totals(
    db: &DbPool,
    sql: &str,
    binds: Vec<DbValue>,
    label: &'static str,
) -> Result<(i64, i64), AppError> {
    db.fetch_one_as::<(i64, i64)>(sql, binds)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, panel = %label, "dashboard : totaux");
            AppError::Database(e)
        })
}

// ── The panels ───────────────────────────────────────────────────────────────

/// Computes one panel, or `None` for an id this build does not know.
///
/// One function per panel would scatter eleven near-identical error paths; one
/// match keeps them in a single place where the discipline (log before
/// returning) is visible at a glance.
///
/// `full` says whether the caller is a REPORT: every ranking is then read up to
/// the shared ceiling instead of stopping at the handful a card draws.
/// Breakdowns over a CLOSED vocabulary ignore it - their statements carry no
/// `LIMIT` and are complete either way.
/// `ask` says whether the caller wants the RECORDS behind the figure, and
/// whether it may have them. Only the windowed panels can answer it; the
/// snapshots state their absence through their own constructor.
async fn compute(
    db: &DbPool,
    id: &'static str,
    win: &Window,
    full: bool,
    ask: Records,
) -> Result<Option<Panel>, AppError> {
    let slices = period::slice_limit(full, MAX_SLICES);
    let accounts = period::slice_limit(full, TOP_ACCOUNTS);
    let backend = db.backend();

    let mut panel = match id {
        // ── Accounts ─────────────────────────────────────────────────────────
        "new_users" => {
            let what = Counted::rows("core.users", "created_at", "TRUE");
            let (total, previous) = period::totals(db, &what, win, id).await?;
            Panel::events(id, what.provenance(), total, previous)
                .with_series(period::series(db, &what, win, id).await?)
                // The accounts themselves, which is the whole point of the
                // figure: "twelve accounts appeared" is not actionable, "these
                // twelve did" is. Gated on `core.users.read` as well - see
                // `Panelled::naming_accounts`.
                .with_records(records_of(db, &what, win, ask, detail::ACCOUNT, id).await?)
        }

        // The states `core.users` can actually be in, and no others.
        //
        // There are exactly three, and it matters that the list is short: this
        // instance has no "archived" account, so no such slice is drawn. The
        // subtlety is that `is_active = FALSE` covers TWO different situations -
        // suspended and awaiting erasure - and only `deleted_at` tells them
        // apart (see migration 000109, which exists precisely because the
        // confusion was destroying suspended accounts). The `CASE` below reads
        // `deleted_at` FIRST for that reason.
        "account_status" => {
            let states = key_counts(
                db,
                &format!(
                    "SELECT CASE WHEN deleted_at IS NOT NULL THEN 'pending_deletion' \
                                 WHEN is_active THEN 'active' \
                                 ELSE 'suspended' END, \
                            {count} \
                       FROM core.users GROUP BY 1 ORDER BY 2 DESC, 1",
                    count = backend.count_bigint("*"),
                ),
                params![],
                "account_status",
            )
            .await?;
            let total = states.iter().map(|s| s.value).sum();
            Panel::snapshot(id, Provenance::rows("core.users", "TRUE"), total)
                .with_all(states)
                .caveat("account_states")
        }

        "user_roles" => {
            let roles = key_counts(
                db,
                &format!(
                    "SELECT role, {count} FROM core.users GROUP BY 1 ORDER BY 2 DESC, 1",
                    count = backend.count_bigint("*"),
                ),
                params![],
                "user_roles",
            )
            .await?;
            let total = roles.iter().map(|s| s.value).sum();
            Panel::snapshot(id, Provenance::rows("core.users", "TRUE"), total).with_all(roles)
        }

        // ── Getting in ───────────────────────────────────────────────────────
        //
        // Counted from `core.device_events`, NOT from `core.refresh_tokens`.
        //
        // The obvious source is wrong, and quietly: a refresh token is re-minted
        // on every ROTATION (`handlers::auth::refresh`), so rows of that table
        // count "how often a session renewed itself" - a figure that rises with
        // the length of a working day and not at all with the number of people.
        // A `session_opened` event is written exactly once per sign-in, by both
        // the password path and the OIDC one, and it is the same source the
        // security overview counts: the two pages agree by construction rather
        // than by coincidence.
        "signins" => {
            let what = SIGN_INS;
            let (total, previous) = period::totals(db, &what, win, id).await?;
            Panel::events(id, what.provenance(), total, previous)
                .with_series(period::series(db, &what, win, id).await?)
                .with_records(records_of(db, &what, win, ask, detail::DEVICE, id).await?)
        }

        // The same events, counted by PERSON - the figure the reference console
        // calls "unique sign-ins", and a different question from the one above:
        // one account signing in from three machines is three sign-ins and one
        // person. `actor_id` is the account the event was recorded for.
        "unique_signins" => {
            let what = UNIQUE_SIGN_INS;
            let (total, previous) = period::totals(db, &what, win, id).await?;
            Panel::events(id, what.provenance(), total, previous)
                .with_series(period::series(db, &what, win, id).await?)
                .caveat("distinct_per_bucket")
                // The events exist, but they are not what this panel counts: a
                // list of five thousand sign-ins under a total of forty people
                // would read as a contradiction. The sign-in panel above lists
                // exactly those rows, under the figure they do add up to.
                .without_records(detail::absent::DISTINCT)
        }

        "device_sessions" => {
            let kinds = key_counts(
                db,
                &format!(
                    "SELECT COALESCE(NULLIF(device_type, ''), 'unknown'), {count} \
                       FROM core.refresh_tokens \
                      WHERE revoked_at IS NULL AND expires_at > $1 \
                      GROUP BY 1 ORDER BY 2 DESC, 1",
                    count = backend.count_bigint("*"),
                ),
                params![Utc::now()],
                "device_sessions",
            )
            .await?;
            let total = kinds.iter().map(|s| s.value).sum();
            Panel::snapshot(
                id,
                Provenance::rows(
                    "core.refresh_tokens",
                    "t.revoked_at IS NULL AND t.expires_at > NOW()",
                ),
                total,
            )
            .with_all(kinds)
        }

        // ── What the instance is actually used for ───────────────────────────
        //
        // Counted by the core's own proxy, which every browser call to every
        // module crosses (`crate::modules::usage`). No module declares anything,
        // none can opt out, and the counter holds nothing finer than
        // `(day, module, account)` - see migration 000123 for what it refuses to
        // store and why.
        "app_usage" => {
            let (first, last) = win.local_days();
            let (previous_first, _) = win.previous_local_days();
            // `COUNT(DISTINCT CASE ...)` replaces PostgreSQL's `COUNT(...) FILTER`,
            // and the split day is bound at two DISTINCT placeholders ($2 and $3)
            // rather than reused, because the non-PostgreSQL engines consume `?`
            // positionally.
            let totals_sql = format!(
                "SELECT {cur}, {prev} \
                   FROM core.module_usage_daily \
                  WHERE day >= $1 AND day <= $4",
                cur = backend.count_bigint("DISTINCT CASE WHEN day >= $2 THEN user_id END"),
                prev = backend.count_bigint("DISTINCT CASE WHEN day < $3 THEN user_id END"),
            );
            let (total, previous) = day_keyed_totals(
                db,
                &totals_sql,
                params![previous_first, first, first, last],
                "app_usage",
            )
            .await?;

            let rows: Vec<(String, i64)> = db
                .fetch_all_as(
                    &format!(
                        "SELECT module_id, {count} \
                           FROM core.module_usage_daily \
                          WHERE day >= $1 AND day <= $2 \
                          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT $3",
                        count = backend.count_bigint("DISTINCT user_id"),
                    ),
                    params![first, last, slices],
                )
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, panel = "app_usage", "dashboard : répartition");
                    AppError::Database(e)
                })?;

            Panel::events(
                id,
                Provenance::distinct("core.module_usage_daily", "TRUE", "t.user_id"),
                total,
                previous,
            )
            .into_ranking()
            .with_breakdown(
                rows.into_iter().map(|(k, v)| Slice::new(k, v)).collect(),
                slices,
            )
            .caveat("app_usage_scope")
            // `core.module_usage_daily` holds nothing finer than
            // `(day, module, account)` - by design, see migration 000123. There
            // is no individual visit to list, and inventing one would be worse
            // than saying so.
            .without_records(detail::absent::AGGREGATED)
        }

        // ── What it costs ────────────────────────────────────────────────────
        //
        // The live figure, not the sample: `SUM(core.users.used_bytes)` is what
        // quotas are enforced against, so it is the one an operator acts on. The
        // sample is used only for the COMPARISON, because consumption is a level
        // and a level has no past unless somebody wrote it down (see
        // `crate::storage::samples`).
        "storage" => {
            let (used, quota): (i64, i64) = db
                .fetch_one_as::<(i64, i64)>(
                    &format!(
                        "SELECT {used}, {quota} FROM core.users",
                        used = backend.sum_bigint("used_bytes"),
                        quota = backend.sum_bigint("quota_bytes"),
                    ),
                    params![],
                )
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, panel = "storage", "dashboard : stockage");
                    AppError::Database(e)
                })?;

            let (first, _) = win.local_days();
            // The last point measured BEFORE the window opened. `None` when the
            // instance is younger than the window, or was switched off then -
            // and `None` prints no percentage at all rather than a change from
            // an imagined zero.
            let previous: Option<i64> = db
                .fetch_optional_scalar::<i64>(
                    "SELECT used_bytes FROM core.storage_samples \
                      WHERE day < $1 ORDER BY day DESC LIMIT 1",
                    params![first],
                )
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, panel = "storage", "dashboard : échantillon de stockage");
                    AppError::Database(e)
                })?;

            Panel {
                previous_total: previous,
                ..Panel::snapshot(id, Provenance::sum("core.users", "TRUE", "used_bytes"), used)
            }
            .in_bytes(Some(quota))
        }

        // Which accounts hold it. Named accounts, hence `core.storage.read`
        // rather than the instance-total privilege.
        "top_storage" => {
            let total: i64 = db
                .fetch_scalar::<i64>(
                    &format!(
                        "SELECT {used} FROM core.users",
                        used = backend.sum_bigint("used_bytes"),
                    ),
                    params![],
                )
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, panel = "top_storage", "dashboard : total");
                    AppError::Database(e)
                })?;

            // A report names every holder; a card names six. Both go through the
            // same statement, with the ceiling as its only difference.
            let rows: Vec<(String, i64, i64)> = db
                .fetch_all_as(
                    "SELECT COALESCE(NULLIF(display_name, ''), username), used_bytes, quota_bytes \
                       FROM core.users WHERE used_bytes > 0 \
                      ORDER BY used_bytes DESC, username LIMIT $1",
                    params![accounts],
                )
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, panel = "top_storage", "dashboard : classement");
                    AppError::Database(e)
                })?;

            Panel::snapshot(id, Provenance::sum("core.users", "TRUE", "used_bytes"), total)
                .into_ranking()
                .in_bytes(None)
                // Each account is drawn against ITS OWN quota, not against the
                // largest holder: "80 % of what they were promised" is the fact
                // an operator acts on, and it is invisible on a relative bar.
                .with_breakdown(
                    rows.into_iter()
                        .map(|(name, used, quota)| Slice {
                            key: name,
                            value: used,
                            capacity: (quota > 0).then_some(quota),
                        })
                        .collect(),
                    accounts,
                )
                // The breakdown above IS the list of records: one row per
                // account holding storage, named, with its own ceiling. A
                // "detail" section repeating it would be the same table twice.
                .without_records(detail::absent::BREAKDOWN)
        }

        // ── The machinery ────────────────────────────────────────────────────
        "module_status" => {
            let statuses = key_counts(
                db,
                &format!(
                    "SELECT status, {count} FROM core.module_instances \
                      GROUP BY 1 ORDER BY 2 DESC, 1",
                    count = backend.count_bigint("*"),
                ),
                params![],
                "module_status",
            )
            .await?;
            let total = statuses.iter().map(|s| s.value).sum();
            Panel::snapshot(id, Provenance::rows("core.module_instances", "TRUE"), total)
                .with_all(statuses)
        }

        "events" => {
            let what = Counted::rows("core.event_log", "created_at", "TRUE");
            let (total, previous) = period::totals(db, &what, win, id).await?;
            Panel::events(id, what.provenance(), total, previous)
                .with_series(period::series(db, &what, win, id).await?)
                .caveat("event_log_retention")
                .with_records(records_of(db, &what, win, ask, detail::EVENT, id).await?)
        }

        _ => return Ok(None),
    };

    // A caller that did not ask about the records is told nothing about them:
    // an absence needs no explanation when nobody enquired, and a dashboard card
    // would carry the sentence to no reader.
    if ask == Records::NotAsked {
        panel.detail_absent = None;
    }

    Ok(Some(panel))
}

// ── Retention ────────────────────────────────────────────────────────────────

/// How far back each source can actually answer.
///
/// Served with the page so the console can say, on a 180-day window, that the
/// attendance counters only keep 90 - instead of drawing a flat start that reads
/// as a quiet quarter when it is a purged one. `usage_since` covers the other
/// end of the same problem: a counter that started last Tuesday must not make
/// the applications look abandoned before that.
async fn retention(db: &DbPool) -> Value {
    let days: Option<Value> = db
        .fetch_optional_scalar::<Option<Value>>(
            "SELECT value FROM core.settings WHERE \"key\" = 'usage.retention_days'",
            params![],
        )
        .await
        .unwrap_or_else(|e| {
            // Best-effort: a missing retention note must not cost the
            // operator the whole page.
            tracing::error!(error = %e, "dashboard : rétention de la fréquentation");
            None
        })
        .flatten();

    let since: Option<NaiveDate> = db
        .fetch_optional_scalar::<Option<NaiveDate>>(
            "SELECT MIN(day) FROM core.module_usage_daily",
            params![],
        )
        .await
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "dashboard : début des compteurs de fréquentation");
            None
        })
        .flatten();

    json!({
        "module_usage_days":  days.and_then(|v| v.as_i64()).unwrap_or(90),
        "module_usage_since": since,
        // Fixed in `core.cleanup_event_log()`, not a setting.
        "event_log_days":     30,
    })
}

// ── Handler ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DashboardQuery {
    /// One of [`PERIODS`]. Absent means [`period::DEFAULT_PERIOD`].
    #[serde(default)]
    pub period: Option<String>,
    /// Restricts the reading to ONE panel, named by its id.
    ///
    /// For the report page, which is a document about a single panel: computing
    /// the other ten to throw them away is eleven times the database work for a
    /// page that shows one of them.
    #[serde(default)]
    pub panel: Option<String>,
    /// Read the breakdowns in FULL rather than as the card's top-N.
    ///
    /// An explicit request rather than a raised ceiling: a dashboard drawing
    /// forty arcs would be a texture, and every caller paying a report's query
    /// cost to render six rows would be a regression nobody asked for.
    #[serde(default)]
    pub full: Option<bool>,
    /// List the RECORDS behind each panel, not only their count.
    ///
    /// Explicit, and audited when it is honoured: these rows name people, and
    /// consulting them is an act of its own. A dashboard never asks; a report
    /// always does.
    #[serde(default)]
    pub detail: Option<bool>,
}

/// `GET /api/v1/admin/dashboard` - every panel the caller may see.
pub async fn dashboard(
    State(state): State<AppState>,
    // `AdminAudit` performs the exact same authorisation `AdminUser` did - it is
    // built on it - and additionally carries the context needed to record the
    // consultation of the records below.
    audit: AdminAudit,
    ctx: AdminCtx,
    Query(q): Query<DashboardQuery>,
) -> Result<Json<Value>, AppError> {
    // Opening the page at all - the same key the nav entry is gated on. Each
    // panel is narrowed again below, at instance scope.
    ctx.require(keys::STATS_READ)?;

    // Validated before anything reaches the database.
    let period = period::validate(q.period.as_deref())?;
    // Same discipline for the panel: an id nobody serves is refused, never
    // answered with an empty page that reads as "this panel has no data".
    let only = match q.panel.as_deref() {
        None | Some("") => None,
        Some(asked) => Some(
            PANELS
                .iter()
                .find(|p| p.id == asked)
                .map(|p| p.id)
                .ok_or_else(|| AppError::Validation(format!("Unknown panel: '{asked}'")))?,
        ),
    };
    let full = q.full.unwrap_or(false);
    let wants_detail = q.detail.unwrap_or(false);

    let tz = crate::settings::intl::instance_timezone(&state.db).await;
    let win = period::resolve_window(period, tz);

    let mut panels: Vec<Panel> = Vec::with_capacity(PANELS.len());
    let mut withheld: Vec<&'static str> = Vec::new();

    for spec in PANELS {
        if only.is_some_and(|id| id != spec.id) {
            continue;
        }
        if !ctx.has_at_instance(spec.privilege) {
            withheld.push(spec.id);
            continue;
        }
        // The records take the panel's own privilege - held already, or the
        // panel would not be here - plus, where the rows name accounts, the one
        // that opens the directory. Both at INSTANCE scope, like the figure.
        let ask = match (wants_detail, spec.detail_privilege) {
            (false, _) => Records::NotAsked,
            (true, None) => Records::Asked,
            (true, Some(key)) if ctx.has_at_instance(key) => Records::Asked,
            (true, Some(_)) => Records::Withheld,
        };
        if let Some(panel) = compute(&state.db, spec.id, &win, full, ask).await? {
            panels.push(panel);
        }
    }

    // Reading the records is audited; reading the counts is not. See
    // `detail::record_consultation`.
    let served: Vec<(&'static str, usize, bool)> = panels
        .iter()
        .filter_map(|p| p.detail.as_ref().map(|d| (p.id, d.rows.len(), d.truncated)))
        .collect();
    detail::record_consultation(&state, &audit, period, &served).await;

    Ok(Json(json!({
        "period": {
            "id":            &win.id,
            "from":          win.from,
            "to":            win.to,
            "previous_from": win.previous_from,
            "previous_to":   win.from,
            "bucket":        win.bucket.id(),
            "timezone":      win.tz.name(),
        },
        "periods":   PERIODS,
        "panels":    panels,
        "withheld":  withheld,
        "retention": retention(&state.db).await,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Panel ids are the console's translation keys AND its layout keys. Two
    /// panels sharing one would make a hidden panel hide its twin.
    #[test]
    fn panel_ids_are_unique() {
        let mut ids: Vec<&str> = PANELS.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "deux panneaux portent le même identifiant");
    }

    /// Every panel names a privilege that exists. A typo here would withhold a
    /// panel from everybody, silently, for as long as nobody noticed.
    #[test]
    fn every_panel_names_a_known_privilege() {
        const KNOWN: [&str; 6] = [
            keys::STATS_READ,
            keys::USERS_READ,
            keys::SESSIONS_READ,
            keys::STORAGE_READ,
            keys::MODULES_READ,
            keys::AUDIT_READ,
        ];
        for spec in PANELS {
            assert!(
                KNOWN.contains(&spec.privilege),
                "{} exige un privilège inconnu : {}",
                spec.id,
                spec.privilege
            );
        }
    }

    /// A snapshot must never claim a comparison, and an event panel must always
    /// offer one: the console draws its arrow from exactly this distinction.
    #[test]
    fn a_snapshot_carries_no_comparison_and_an_event_panel_does() {
        let what = Provenance::rows("core.users", "TRUE");
        assert!(Panel::snapshot("x", what, 3).previous_total.is_none());
        assert_eq!(Panel::events("x", what, 3, 2).previous_total, Some(2));
    }

    /// A panel whose records name accounts must ask for the privilege that
    /// opens the directory. Without this, a delegated reporter holding
    /// statistics alone would be handed the list of who was created - a figure
    /// they may read, turned into a directory they may not.
    #[test]
    fn the_records_that_name_accounts_take_the_directory_privilege() {
        let new_users = PANELS
            .iter()
            .find(|p| p.id == "new_users")
            .expect("le panneau des créations existe");
        assert_eq!(new_users.detail_privilege, Some(keys::USERS_READ));

        // Sign-ins are the device timelines, which the panel's own privilege
        // already opens: no second key, or the records would be refused to
        // somebody entitled to them.
        let signins = PANELS
            .iter()
            .find(|p| p.id == "signins")
            .expect("le panneau des connexions existe");
        assert_eq!(signins.detail_privilege, None);
    }

    /// A snapshot has no window, therefore no dated records to list. Said by the
    /// constructor, so no panel can forget to say it - and an event panel starts
    /// with nothing said, because its records depend on what the caller asked.
    #[test]
    fn a_snapshot_states_that_it_has_no_records() {
        let what = Provenance::rows("core.users", "TRUE");
        let snapshot = Panel::snapshot("x", what, 3);
        assert_eq!(snapshot.detail_absent, Some(detail::absent::SNAPSHOT));
        assert!(snapshot.detail.is_none());
        assert_eq!(Panel::events("x", what, 3, 2).detail_absent, None);
    }

    /// A ranking that already names its entries points at itself rather than
    /// inheriting the snapshot's "there is no window": the reason printed on the
    /// page has to be the true one.
    #[test]
    fn a_ranking_points_at_its_own_breakdown() {
        let panel = Panel::snapshot(
            "top_storage",
            Provenance::sum("core.users", "TRUE", "used_bytes"),
            1,
        )
        .without_records(detail::absent::BREAKDOWN);
        assert_eq!(panel.detail_absent, Some(detail::absent::BREAKDOWN));
        assert!(panel.detail.is_none());
    }

    /// A ranking is drawn from its breakdown; one without would render empty.
    /// Expressed on the builder, which is what every ranking goes through.
    #[test]
    fn a_ranking_keeps_its_breakdown() {
        let panel = Panel::snapshot("x", Provenance::rows("core.users", "TRUE"), 1)
            .into_ranking()
            .with_breakdown(vec![Slice::new("drive".into(), 1)], 6);
        assert!(panel.ranking);
        assert_eq!(panel.breakdown.len(), 1);
        assert!(!panel.breakdown_truncated);
    }

    /// A list that stopped at the ceiling must SAY so: a report presenting a cut
    /// ranking as an exhaustive one is the exact failure the report exists to
    /// avoid.
    #[test]
    fn a_breakdown_that_reached_the_ceiling_says_it_is_truncated() {
        let slices = vec![Slice::new("a".into(), 2), Slice::new("b".into(), 1)];
        assert!(
            Panel::snapshot("x", Provenance::rows("core.users", "TRUE"), 3)
                .with_breakdown(slices, 2)
                .breakdown_truncated
        );
        // A closed vocabulary has no ceiling to reach.
        assert!(
            !Panel::snapshot("x", Provenance::rows("core.users", "TRUE"), 3)
                .with_all(vec![Slice::new("active".into(), 3)])
                .breakdown_truncated
        );
    }

    /// A report asks for everything; a card asks for its handful. The two must
    /// come from the same helper, or "the report is not truncated" becomes a
    /// limit somebody raised for every caller.
    #[test]
    fn a_report_reads_further_than_a_card() {
        assert_eq!(period::slice_limit(false, MAX_SLICES), MAX_SLICES);
        assert_eq!(period::slice_limit(false, TOP_ACCOUNTS), TOP_ACCOUNTS);
        assert!(period::slice_limit(true, TOP_ACCOUNTS) > TOP_ACCOUNTS);
    }
}
