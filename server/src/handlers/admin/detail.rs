//! The RECORDS behind a dashboard figure - one row per underlying fact.
//!
//! # Why a counter is not a report
//!
//! A panel answers "how many"; the question that follows is always "which
//! ones". A report of failed sign-ins that states `47` and draws a curve is a
//! counter printed on paper: nobody can act on it, because the accounts
//! concerned - the only thing worth acting on - are exactly what it does not
//! say. This module is the other half: the same window, the same predicate, the
//! same privilege, listed row by row.
//!
//! # It is the same reading, narrowed - never a second one
//!
//! [`super::period::Provenance`] already states *where* a figure comes from.
//! The catalogues below are that statement made readable: the same table, the
//! same `t.` alias, the same window bounds bound as parameters. A panel cannot
//! print rows its own count did not include, because the `WHERE` clause is
//! [`Counted`]'s and nothing here may add to it.
//!
//! # What a row may carry, and what it may never
//!
//! These rows name people. Three rules, and none of them is negotiable:
//!
//!   * **No secret, ever.** Not a password, not a token, not a hash, not a
//!     fingerprint, not even truncated. Every expression below is written in
//!     source and reviewed here; there is no path by which a caller adds one.
//!     `core.devices.correlation_hash` and `core.refresh_tokens.token_hash` are
//!     the two that would be tempting, and neither appears.
//!   * **The minimum that answers the question.** An account is named by the
//!     name an operator reads, not by its whole profile row: no e-mail address,
//!     no `user_agent`, no `payload`. A report is copied, printed and filed;
//!     every extra column is a copy of personal data that outlives its purpose.
//!   * **Nothing resurrected.** Rows are read from the live table only - the
//!     same one the panel counted, whose retention purge has already run. What
//!     was purged is absent from both, so the detail can never say more than the
//!     figure above it.
//!
//! # Ceiling
//!
//! [`DETAIL_LIMIT`] rows. Beyond that the reading stops and *says so*
//! ([`DetailTable::truncated`]), because a list that stopped is not a list that
//! ended and a printed page has nobody left to ask.

use kubuno_db::{params, DbPool};
use serde::Serialize;
use serde_json::json;
use sqlx::Row;

use crate::audit::{redact::target, AdminAudit, AuditEntry};
use crate::errors::AppError;
use crate::state::AppState;

use super::period::{Counted, Window};

/// A row of a detail table: the event instant, then every other cell projected
/// to text in SQL.
///
/// The instant is decoded as a true `DateTime<Utc>` (column 0) so it can be
/// formatted in Rust - portably, in place of PostgreSQL's `to_char(… AT TIME
/// ZONE 'UTC', …)`. The remaining column count is dynamic (it depends on the
/// catalogue), so those cells are collected positionally as `Option<String>`.
/// One generic `FromRow` covers the three engines, which is what `fetch_all_as`
/// requires - the pool exposes no positional multi-row read otherwise.
struct DetailRow {
    when: chrono::DateTime<chrono::Utc>,
    cells: Vec<Option<String>>,
}

impl<'r, R> sqlx::FromRow<'r, R> for DetailRow
where
    R: Row,
    usize: sqlx::ColumnIndex<R>,
    Option<String>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    chrono::DateTime<chrono::Utc>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    fn from_row(row: &'r R) -> Result<Self, sqlx::Error> {
        let when = row.try_get::<chrono::DateTime<chrono::Utc>, _>(0)?;
        let width = row.columns().len();
        let mut cells = Vec::with_capacity(width.saturating_sub(1));
        for index in 1..width {
            cells.push(row.try_get::<Option<String>, _>(index)?);
        }
        Ok(DetailRow { when, cells })
    }
}

impl DetailRow {
    /// The row as the console reads it: the instant as an ISO-8601 `…Z` string
    /// (the exact shape the old `to_char` produced), then every other cell
    /// clipped to [`MAX_CELL`] characters - the Rust stand-in for `left(…, N)`.
    fn into_cells(self) -> Vec<Option<String>> {
        let mut out = Vec::with_capacity(self.cells.len() + 1);
        out.push(Some(self.when.format("%Y-%m-%dT%H:%M:%SZ").to_string()));
        for cell in self.cells {
            out.push(cell.map(|s| {
                if s.chars().count() > MAX_CELL as usize {
                    s.chars().take(MAX_CELL as usize).collect()
                } else {
                    s
                }
            }));
        }
        out
    }
}

/// How many records one report may carry.
///
/// Two thousand: enough that a month of administrative activity on a real
/// instance fits whole, small enough that the statement stays cheap, the
/// response stays a few hundred kilobytes and the printed document stays a
/// document. A window that holds more is *truncated and labelled as such*,
/// never silently shortened.
pub const DETAIL_LIMIT: i64 = 2000;

/// Longest text one cell may carry.
///
/// A free-text column (`admin_audit.detail`, a device label somebody named) has
/// no natural bound. Clipped in SQL rather than in the console, so an oversized
/// row never crosses the wire in the first place.
const MAX_CELL: i64 = 200;

/// Why a panel has no records to list. A CLOSED vocabulary: the console turns
/// each of these into one sentence, and a value it does not know would leave a
/// heading with nothing under it.
pub mod absent {
    /// The figure describes the present. Nothing dated to list.
    pub const SNAPSHOT: &str = "snapshot";
    /// The figure counts DISTINCT values, so rows and total do not correspond.
    pub const DISTINCT: &str = "distinct";
    /// The source keeps counters, not individual facts.
    pub const AGGREGATED: &str = "aggregated";
    /// The breakdown printed above already IS the list of records.
    pub const BREAKDOWN: &str = "breakdown";
    /// The rows name people and the caller lacks the privilege that opens them.
    pub const WITHHELD: &str = "withheld";
}

/// One column of a detail table.
///
/// `kind` is what the console formats on: `instant` is an ISO-8601 instant to
/// be spelt in the instance's zone, `code` an identifier printed verbatim,
/// `text` a human string. A closed vocabulary, like everything else the server
/// asks the console to render.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct DetailColumn {
    /// Stable id - the console's translation key and the CSV header.
    pub id: &'static str,
    pub kind: &'static str,
    /// SQL producing the cell, over the alias `t`. **Written in source, always**:
    /// nothing here is ever assembled from a request.
    #[serde(skip)]
    expr: &'static str,
    /// Whether `expr` is a client-address column stored as PostgreSQL `inet` and
    /// read back through the dialect's `inet_text` - its canonical text on
    /// PostgreSQL, the plain column on MySQL/SQLite. Kept out of the wire form.
    #[serde(skip)]
    inet: bool,
}

impl DetailColumn {
    /// A human string - a name, a title, a reason.
    const fn text(id: &'static str, expr: &'static str) -> Self {
        Self { id, kind: "text", expr, inet: false }
    }

    /// An identifier printed as it is stored - an action, a severity, a country
    /// code. Never translated by guesswork: the console prints what the row says.
    const fn code(id: &'static str, expr: &'static str) -> Self {
        Self { id, kind: "code", expr, inet: false }
    }

    /// A client address column (`inet` on PostgreSQL). `expr` is the raw column,
    /// read back portably through [`read`]'s `inet_text`, not wrapped in
    /// `host(…)` - which exists on PostgreSQL only.
    const fn inet(id: &'static str, expr: &'static str) -> Self {
        Self { id, kind: "code", expr, inet: true }
    }

    /// The window's own timestamp column, synthesised by [`read`] as the first
    /// column of every table. It carries no expression of its own because the
    /// column it reads is [`Counted::time`], which varies by source.
    const fn when() -> Self {
        Self { id: "when", kind: "instant", expr: "", inet: false }
    }
}

// ── The catalogues, one per SOURCE TABLE ─────────────────────────────────────
//
// Keyed on the table rather than on the panel on purpose: three security panels
// count different predicates over `core.admin_audit`, and their records are the
// same records. One catalogue per table means the columns cannot disagree
// between two panels reading the same rows.

/// `core.admin_audit` - the attributable trail (migration 000040).
///
/// `actor_label` is the account whose credentials were presented; for
/// `core.auth.login_failed` it is filled from the account the attempt matched,
/// and the server records that event **for administrator accounts only** (see
/// `handlers::auth::login`), so no line here ever names a login the instance
/// does not hold. `detail` is the handler-written reason (`bad_credentials`);
/// the schema forbids a credential in it. `user_agent` is deliberately absent:
/// it identifies a machine far better than it explains an event.
pub const AUDIT: &[DetailColumn] = &[
    DetailColumn::code("action", "t.action"),
    DetailColumn::text("actor", "t.actor_label"),
    DetailColumn::text("target", "t.target_label"),
    DetailColumn::code("outcome", "t.outcome"),
    DetailColumn::text("reason", "t.detail"),
    DetailColumn::inet("ip", "t.ip_address"),
];

/// `core.device_events` - the device timelines (migration 000065).
///
/// `actor_label` is NULL for events the system observed rather than an operator
/// performed - a sign-in is one of those (`handlers::auth::tokens` passes the
/// account id and no label), so the account is resolved from `actor_id` when the
/// label is absent. Without that fallback the sign-in report would list every
/// row with an empty "account" column, which is the exact complaint this feature
/// answers.
///
/// `core.devices.correlation_hash` is NOT here and must never be: it is the
/// secret that would let a caller claim an existing device row.
pub const DEVICE: &[DetailColumn] = &[
    DetailColumn::code("kind", "t.kind"),
    DetailColumn::text(
        "account",
        "COALESCE(NULLIF(t.actor_label, ''), \
         (SELECT COALESCE(NULLIF(u.display_name, ''), u.username) \
            FROM core.users u WHERE u.id = t.actor_id))",
    ),
    DetailColumn::text(
        "device",
        "(SELECT COALESCE(NULLIF(d.label, ''), \
                          NULLIF(CONCAT_WS(' ', d.browser, d.platform), ''), \
                          d.device_type) \
            FROM core.devices d WHERE d.id = t.device_id)",
    ),
    DetailColumn::code("country", "t.country"),
    DetailColumn::inet("ip", "t.ip_address"),
    DetailColumn::text("detail", "t.detail"),
];

/// `core.alerts` - raised alerts (migration 000056).
///
/// `payload` is excluded: it is a producer-shaped object meant for the console's
/// detail view, not a cell of a printed table.
pub const ALERT: &[DetailColumn] = &[
    DetailColumn::code("kind", "t.kind"),
    DetailColumn::code("severity", "t.severity"),
    DetailColumn::code("status", "t.status"),
    DetailColumn::text("title", "t.title"),
    DetailColumn::text(
        "subject",
        "(SELECT COALESCE(NULLIF(u.display_name, ''), u.username) \
            FROM core.users u WHERE u.id = t.subject_user_id)",
    ),
    DetailColumn::code("module", "t.module_id"),
];

/// `core.rule_executions` - the rule engine's log (migrations 000061, 000070).
///
/// The table stores structural references only - never the content a rule
/// inspected - so every column below is a verdict or a reference, by
/// construction rather than by filtering.
pub const RULE: &[DetailColumn] = &[
    DetailColumn::text(
        "rule",
        "(SELECT r.name FROM core.rules r WHERE r.id = t.rule_id)",
    ),
    DetailColumn::code("mode", "t.mode"),
    DetailColumn::code("outcome", "t.outcome"),
    DetailColumn::code("event", "t.event_type"),
    DetailColumn::text(
        "account",
        "(SELECT COALESCE(NULLIF(u.display_name, ''), u.username) \
            FROM core.users u WHERE u.id = t.actor_user_id)",
    ),
    DetailColumn::code("resource", "NULLIF(CONCAT_WS(' ', t.resource_type, t.resource_id), '')"),
    DetailColumn::code("gate", "t.gate_reference"),
];

/// `core.users`, read as the accounts CREATED in the window.
///
/// No e-mail address, no quota, no profile: the question is "which accounts
/// appeared", and a name plus a role answers it. The console's account list is
/// where a profile is read, under its own privilege.
pub const ACCOUNT: &[DetailColumn] = &[
    DetailColumn::text("username", "t.username"),
    DetailColumn::text("name", "t.display_name"),
    DetailColumn::code("role", "t.role"),
    // The same three states `account_status` breaks down, spelt by the same
    // `CASE` and in the same order - `deleted_at` first, because `is_active =
    // FALSE` covers both suspension and pending erasure (migration 000109).
    DetailColumn::code(
        "status",
        "CASE WHEN t.deleted_at IS NOT NULL THEN 'pending_deletion' \
              WHEN t.is_active THEN 'active' ELSE 'suspended' END",
    ),
];

/// `core.event_log` - the system event log (migration 000003).
///
/// `payload` is excluded: modules write it, its shape is theirs, and a report is
/// not a place to spill an unreviewed object.
pub const EVENT: &[DetailColumn] = &[
    DetailColumn::code("event", "t.event_type"),
    DetailColumn::code("module", "t.source_module"),
];

/// The catalogue for a source table, or `None` when this build describes none.
///
/// A table with no catalogue yields no detail section at all - never an
/// improvised one. Guessing columns from a schema is how a report ends up
/// printing a column nobody meant to publish.
pub fn for_table(table: &str) -> Option<&'static [DetailColumn]> {
    match table {
        "core.admin_audit" => Some(AUDIT),
        "core.device_events" => Some(DEVICE),
        "core.alerts" => Some(ALERT),
        "core.rule_executions" => Some(RULE),
        "core.users" => Some(ACCOUNT),
        "core.event_log" => Some(EVENT),
        _ => None,
    }
}

// ── Reading ──────────────────────────────────────────────────────────────────

/// The records of one panel, as a table the console can print without knowing
/// what it is looking at.
#[derive(Debug, Serialize)]
pub struct DetailTable {
    /// In display order. The first is always the record's own timestamp.
    pub columns: Vec<DetailColumn>,
    /// One entry per column, `null` for a value the row does not carry.
    pub rows: Vec<Vec<Option<String>>>,
    /// The reading stopped at [`DETAIL_LIMIT`] rather than at the window's end.
    pub truncated: bool,
    /// The ceiling that applied, so the document can name it.
    pub limit: i64,
}

/// Reads the rows behind a count.
///
/// Newest first: a reader looking for what just happened should not have to turn
/// to the last page. The tie-break on `t.id` is what makes the ordering total -
/// two events in the same millisecond would otherwise come back in an order the
/// planner chose, and two printings of the same report would disagree.
///
/// Every source table below has a monotonic `id`, which is also why the ceiling
/// is honest: the rows dropped by `LIMIT` are the *oldest* of the window, never
/// an arbitrary sample.
pub async fn read(
    db: &DbPool,
    what: &Counted,
    win: &Window,
    columns: &'static [DetailColumn],
    label: &str,
) -> Result<DetailTable, AppError> {
    // Portable across the three engines. Two constructs were PostgreSQL-only and
    // are gone:
    //   * `to_char(t.{time} AT TIME ZONE 'UTC', …)` - the instant is read as a
    //     real `DateTime<Utc>` (first column) and formatted in Rust below.
    //   * `left((expr)::text, N)` - each cell is cast to text through the dialect
    //     (`::text` off PostgreSQL becomes `CAST(… AS CHAR/TEXT)`) and clipped in
    //     Rust, so no engine-specific `left`/`substr` is needed.
    // A client-address column is read through `inet_text` rather than `host(…)`,
    // which does not exist off PostgreSQL.
    let backend = db.backend();
    let mut select = format!("t.{time}", time = what.time);
    for column in columns {
        let cell = if column.inet {
            // `inet_text` already yields text on every engine.
            backend.inet_text(column.expr)
        } else {
            backend.cast(column.expr, kubuno_db::dialect::SqlType::Text)
        };
        select.push_str(", ");
        select.push_str(&cell);
    }

    let sql = format!(
        "SELECT {select} \
           FROM {table} t \
          WHERE ({filter}) AND t.{time} >= $1 AND t.{time} < $2 \
          ORDER BY t.{time} DESC, t.id DESC \
          LIMIT {ceiling}",
        table = what.table,
        filter = what.filter,
        time = what.time,
        // One more than the ceiling: the extra row is never returned, it is how
        // the reading knows it was cut.
        ceiling = DETAIL_LIMIT + 1,
    );

    // Safe: every fragment is a `&'static str` written in source - `Counted`'s
    // table, time column and filter, and each `DetailColumn::expr` (a private
    // field only the const catalogues below set). The ceiling is an integer
    // constant; the window bounds are bound parameters.
    let fetched = db
        .fetch_all_as::<DetailRow>(&sql, params![win.from, win.to])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, panel = %label, "tableau de bord : détail");
            AppError::Database(e)
        })?;

    let truncated = fetched.len() as i64 > DETAIL_LIMIT;
    let width = columns.len() + 1;
    let rows: Vec<Vec<Option<String>>> = fetched
        .into_iter()
        .take(DETAIL_LIMIT as usize)
        .map(DetailRow::into_cells)
        .collect();

    let mut all = Vec::with_capacity(width);
    all.push(DetailColumn::when());
    all.extend_from_slice(columns);

    Ok(DetailTable { columns: all, rows, truncated, limit: DETAIL_LIMIT })
}

// ── Auditing the consultation ────────────────────────────────────────────────

/// Records that somebody read the RECORDS, not merely the count.
///
/// # Why the count is not audited and the detail is
///
/// Opening a dashboard is reading aggregates about an instance; opening the
/// records behind one is reading a list of named people, their addresses and
/// their failures. The second is the act `core.audit.export` is already audited
/// for, and for the same reason: whoever answers "who consulted this" months
/// later must find the answer in the trail rather than in a web server log.
///
/// Nothing is recorded when nothing was served - a caller that asked for the
/// detail of a panel that has none has read nothing and must not appear to have.
///
/// Best-effort, like every [`crate::audit::AuditContext::record`]: an audit
/// failure is logged loudly and must never turn a report into a 500.
pub async fn record_consultation(
    state: &AppState,
    audit: &AdminAudit,
    period: &str,
    served: &[(&'static str, usize, bool)],
) {
    if served.is_empty() {
        return;
    }

    let panels: Vec<_> = served
        .iter()
        .map(|(id, rows, truncated)| {
            json!({ "panel": id, "rows": rows, "truncated": truncated })
        })
        .collect();

    audit
        .record(
            &state.db,
            AuditEntry::new("core.reports.detail")
                .module("core")
                .target_kind(target::REPORT, "Rapport d'administration")
                // What was consulted, never what it contained: an audit entry
                // holding the rows would be a second, permanent copy of exactly
                // the personal data this entry exists to keep track of.
                .after(json!({ "period": period, "panels": panels })),
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Column ids are the console's translation keys and the CSV headers. Two
    /// columns of one table sharing one would print the same heading twice over
    /// two different facts.
    #[test]
    fn column_ids_are_unique_within_a_catalogue() {
        for catalogue in [AUDIT, DEVICE, ALERT, RULE, ACCOUNT, EVENT] {
            let mut ids: Vec<&str> = catalogue.iter().map(|c| c.id).collect();
            ids.push(DetailColumn::when().id);
            ids.sort_unstable();
            let count = ids.len();
            ids.dedup();
            assert_eq!(ids.len(), count, "deux colonnes portent le même identifiant");
        }
    }

    /// `kind` is what the console formats on. A value it does not know would be
    /// printed by no branch at all.
    #[test]
    fn every_column_declares_a_known_kind() {
        for catalogue in [AUDIT, DEVICE, ALERT, RULE, ACCOUNT, EVENT] {
            for column in catalogue {
                assert!(
                    matches!(column.kind, "text" | "code"),
                    "{} déclare un type inconnu : {}",
                    column.id,
                    column.kind
                );
                assert!(!column.expr.is_empty(), "{} n'a pas d'expression", column.id);
            }
        }
    }

    /// The one column the reader synthesises must be the one the console formats
    /// as an instant, or every record would be dated by a raw string.
    #[test]
    fn the_first_column_is_the_instant() {
        assert_eq!(DetailColumn::when().kind, "instant");
    }

    /// No catalogue may name a secret. Spelt as a test rather than as a comment
    /// because the next column added is the one nobody re-reads the comment for.
    #[test]
    fn no_catalogue_reads_a_secret() {
        const FORBIDDEN: [&str; 6] = [
            "password_hash",
            "token_hash",
            "correlation_hash",
            "totp_secret",
            "client_secret",
            "api_token",
        ];
        for catalogue in [AUDIT, DEVICE, ALERT, RULE, ACCOUNT, EVENT] {
            for column in catalogue {
                for secret in FORBIDDEN {
                    assert!(
                        !column.expr.contains(secret),
                        "{} lit {secret}",
                        column.id
                    );
                }
            }
        }
    }

    /// Every table a catalogue is keyed on is one the dashboards actually count
    /// from; a typo would silently withdraw the detail of every panel on it.
    #[test]
    fn the_lookup_answers_for_the_tables_the_dashboards_read() {
        for table in [
            "core.admin_audit",
            "core.device_events",
            "core.alerts",
            "core.rule_executions",
            "core.users",
            "core.event_log",
        ] {
            assert!(for_table(table).is_some(), "{table} n'a pas de catalogue");
        }
        assert!(for_table("core.module_usage_daily").is_none());
    }
}
