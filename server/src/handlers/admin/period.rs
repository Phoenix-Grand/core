//! The window an administration dashboard reads, and the two ways of counting
//! over it.
//!
//! # Why this is one module and not one per page
//!
//! The console has more than one dashboard - the security overview and the
//! general one - and they answer the same three questions: *which* windows may
//! be asked for, *where* a window starts and stops, and *what* it is compared
//! against. Two implementations of that would drift on the first special case
//! (the month still running, the week that starts on Monday, the axis that has
//! to land on a `date_trunc` boundary), and the operator would meet two pages
//! whose "−12 %" means two different things. It is written once, here.
//!
//! Everything below was first written for `security_dashboard`; this module is
//! that code lifted out unchanged, not a re-derivation of it.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use kubuno_db::{dialect::SqlType, params, DbPool};
use serde::Serialize;
use uuid::Uuid;

use crate::errors::AppError;

/// The selectable windows, as a CLOSED list.
///
/// Closed because the console offers exactly these and an operator must not be
/// able to widen the window by editing the address: the longest one is capped at
/// 180 days, which is also where the shortest retention of the sources sits.
pub const PERIODS: [&str; 10] = [
    "today",
    "yesterday",
    "this_week",
    "last_week",
    "this_month",
    "last_month",
    "last_7_days",
    "last_30_days",
    "last_90_days",
    "last_180_days",
];

/// What a dashboard opens on: the month just elapsed.
pub const DEFAULT_PERIOD: &str = "last_30_days";

/// Validates a caller-supplied period id against [`PERIODS`].
///
/// An unknown value is REFUSED rather than silently defaulted: a mistyped
/// address must not be read back as a month of history the operator did not ask
/// for.
pub fn validate(asked: Option<&str>) -> Result<&'static str, AppError> {
    match asked {
        None | Some("") => Ok(DEFAULT_PERIOD),
        Some(asked) => PERIODS
            .iter()
            .copied()
            .find(|p| *p == asked)
            .ok_or_else(|| AppError::Validation(format!("Unknown period: '{asked}'"))),
    }
}

/// Bucket width of a series. A closed enum, because its two string forms are
/// interpolated into SQL and must never come from a caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bucket {
    Hour,
    Day,
    Week,
}

impl Bucket {
    /// `date_trunc` unit.
    pub const fn unit(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
            Self::Week => "week",
        }
    }

    /// `generate_series` step.
    pub const fn step(self) -> &'static str {
        match self {
            Self::Hour => "1 hour",
            Self::Day => "1 day",
            Self::Week => "1 week",
        }
    }

    /// Identifier the console formats its axis labels from.
    pub const fn id(self) -> &'static str {
        self.unit()
    }
}

/// One resolved window: the instants to filter on, the local instants to lay the
/// axis out in, and the comparison window of the same length behind it.
#[derive(Debug, Clone)]
pub struct Window {
    pub id: String,
    pub tz: Tz,
    pub bucket: Bucket,
    /// Inclusive lower bound of the reading, as an instant.
    pub from: DateTime<Utc>,
    /// Exclusive upper bound. Clamped to "now" for a period still running, so a
    /// month in progress is compared against the same number of elapsed days
    /// rather than against a full month it cannot yet match.
    pub to: DateTime<Utc>,
    /// The window of identical length immediately before `from`.
    pub previous_from: DateTime<Utc>,
    /// Start of the FIRST bucket, in the instance's zone.
    pub axis_from: NaiveDateTime,
    /// Start of the LAST bucket, in the instance's zone.
    pub axis_to: NaiveDateTime,
}

/// Local wall-clock instant → the instant it names.
///
/// A local time can be ambiguous (the hour a zone repeats in autumn) or absent
/// (the hour it skips in spring). The earliest reading is taken for the first,
/// and the following hour for the second: both keep the axis monotonic, which is
/// the only property a bucket boundary has to have.
fn to_utc(tz: Tz, local: NaiveDateTime) -> DateTime<Utc> {
    tz.from_local_datetime(&local)
        .earliest()
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|| (local + Duration::hours(1)).and_utc())
}

/// Start of the bucket `local` falls in, in local wall-clock terms.
///
/// Weeks start on Monday, matching PostgreSQL's `date_trunc('week', …)` - the
/// two must agree or the generated axis and the grouped rows never join.
fn floor_local(bucket: Bucket, local: NaiveDateTime) -> NaiveDateTime {
    let date = local.date();
    match bucket {
        Bucket::Hour => date.and_hms_opt(local.hour(), 0, 0).unwrap_or(local),
        Bucket::Day => date.and_hms_opt(0, 0, 0).unwrap_or(local),
        Bucket::Week => {
            let back = i64::from(date.weekday().num_days_from_monday());
            (date - Duration::days(back))
                .and_hms_opt(0, 0, 0)
                .unwrap_or(local)
        }
    }
}

/// Midnight, locally, on the day `local` falls in.
fn midnight(local: NaiveDateTime) -> NaiveDateTime {
    local.date().and_hms_opt(0, 0, 0).unwrap_or(local)
}

/// First instant of the month `local` falls in, locally.
fn month_start(local: NaiveDateTime) -> NaiveDateTime {
    local
        .date()
        .with_day(1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .unwrap_or_else(|| midnight(local))
}

/// First instant of the month BEFORE the one `local` falls in.
///
/// Walked backwards from this month's 1st rather than by subtracting a month,
/// so it never has to answer what "one month before the 31st" means.
fn previous_month_start(local: NaiveDateTime) -> NaiveDateTime {
    month_start(month_start(local) - Duration::days(1))
}

/// Resolves a period id into the two windows the panels read.
///
/// `id` has already been checked against [`PERIODS`]; an unknown value here
/// falls back to the default rather than panicking, because a closed list that
/// grows must never be able to take an endpoint down.
pub fn resolve_window(id: &str, tz: Tz) -> Window {
    let now_utc = Utc::now();
    let now = now_utc.with_timezone(&tz).naive_local();
    let today = midnight(now);

    // `end` is the period's own end; the reading is clamped to `now` below.
    let (start, end) = match id {
        "today" => (today, today + Duration::days(1)),
        "yesterday" => (today - Duration::days(1), today),
        "this_week" => {
            let monday = floor_local(Bucket::Week, now);
            (monday, monday + Duration::days(7))
        }
        "last_week" => {
            let monday = floor_local(Bucket::Week, now);
            (monday - Duration::days(7), monday)
        }
        "this_month" => {
            let first = month_start(now);
            (first, month_start(first + Duration::days(32)))
        }
        "last_month" => {
            let first = month_start(now);
            (previous_month_start(now), first)
        }
        "last_7_days" => (today - Duration::days(6), today + Duration::days(1)),
        "last_90_days" => (today - Duration::days(89), today + Duration::days(1)),
        "last_180_days" => (today - Duration::days(179), today + Duration::days(1)),
        // DEFAULT_PERIOD and anything unrecognised.
        _ => (today - Duration::days(29), today + Duration::days(1)),
    };

    let from = to_utc(tz, start);
    // A period still running is read up to now: comparing three days of this
    // month against a whole previous month would report a collapse that is only
    // the calendar.
    let to = to_utc(tz, end).min(now_utc).max(from);

    let span = to - from;
    let bucket = if span <= Duration::days(2) {
        Bucket::Hour
    } else if span <= Duration::days(92) {
        Bucket::Day
    } else {
        Bucket::Week
    };

    let axis_from = floor_local(bucket, start);
    // The last bucket is the one the final measured instant falls in. One second
    // back, so a window ending exactly on a boundary does not draw an empty
    // trailing bucket.
    let last_local = to.with_timezone(&tz).naive_local() - Duration::seconds(1);
    let axis_to = floor_local(bucket, last_local).max(axis_from);

    Window {
        id: id.to_string(),
        tz,
        bucket,
        from,
        to,
        previous_from: from - span,
        axis_from,
        axis_to,
    }
}

impl Window {
    /// The window as a pair of LOCAL calendar days, inclusive.
    ///
    /// For the sources keyed on a `DATE` rather than on an instant - the daily
    /// storage sample, the module attendance counters. Both stamp their day in
    /// the instance's zone, so this is the same calendar their rows were written
    /// against, not a conversion of one into another.
    pub fn local_days(&self) -> (NaiveDate, NaiveDate) {
        let first = self.from.with_timezone(&self.tz).date_naive();
        let last = (self.to - Duration::seconds(1))
            .with_timezone(&self.tz)
            .date_naive()
            .max(first);
        (first, last)
    }

    /// The comparison window, as local calendar days, inclusive.
    pub fn previous_local_days(&self) -> (NaiveDate, NaiveDate) {
        let first = self.previous_from.with_timezone(&self.tz).date_naive();
        let last = (self.from - Duration::seconds(1))
            .with_timezone(&self.tz)
            .date_naive()
            .max(first);
        (first, last)
    }
}

// ── Reading a series ─────────────────────────────────────────────────────────

/// One bucket of a series. `bucket` is a LOCAL wall-clock instant.
#[derive(Debug, Serialize)]
pub struct Point {
    pub bucket: String,
    pub value: i64,
}

/// Where a figure comes from, as facts rather than as prose.
///
/// A printed report has to be able to say *how* its number was obtained - six
/// months later, to somebody who was not there. Prose would have to be
/// translated into thirteen languages and would drift from the query it
/// describes; these three fields are the query itself, so they cannot drift, and
/// the console wraps them in a sentence it translates on its side.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Provenance {
    /// Table the figure is read from.
    pub table: &'static str,
    /// Predicate narrowing it to the fact being measured. `TRUE` means the whole
    /// table, which the console spells in words rather than printing `TRUE`.
    pub filter: &'static str,
    /// How the rows become one number. A CLOSED vocabulary - `count`,
    /// `count_distinct`, `sum` - because the console turns it into a sentence,
    /// and a value it does not know would leave the method section blank.
    pub measure: &'static str,
    /// The column `count_distinct` and `sum` apply to. `None` for `count`.
    pub column: Option<&'static str>,
}

impl Provenance {
    /// How many rows of `table` match `filter`.
    pub const fn rows(table: &'static str, filter: &'static str) -> Self {
        Self { table, filter, measure: "count", column: None }
    }

    /// How many DISTINCT values of `column` those rows carry - how many
    /// *somebodies*, not how many rows.
    pub const fn distinct(
        table: &'static str,
        filter: &'static str,
        column: &'static str,
    ) -> Self {
        Self { table, filter, measure: "count_distinct", column: Some(column) }
    }

    /// The total of `column` over those rows - a volume, not a population.
    pub const fn sum(table: &'static str, filter: &'static str, column: &'static str) -> Self {
        Self { table, filter, measure: "sum", column: Some(column) }
    }
}

/// One slice of a breakdown.
#[derive(Debug, Serialize)]
pub struct Slice {
    pub key: String,
    pub value: i64,
    /// What this slice's own ceiling is, when it has one - an account's quota
    /// against the volume it holds. `None` for a slice that is simply a share of
    /// a whole, which the console then draws against the largest slice.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<i64>,
}

impl Slice {
    pub fn new(key: String, value: i64) -> Self {
        Self { key, value, capacity: None }
    }
}

/// What is being counted, as SQL fragments this crate wrote.
///
/// **Every field is a `&'static str` written in source.** None of them is ever
/// assembled from a request: the only caller-supplied values in the generated
/// statements are bound parameters (the window bounds and the zone name).
#[derive(Debug, Clone, Copy)]
pub struct Counted {
    /// Table, aliased `t`.
    pub table: &'static str,
    /// Timestamp column of `t` the window applies to.
    pub time: &'static str,
    /// Predicate narrowing `t` to the fact being counted.
    pub filter: &'static str,
    /// Column of `t` whose DISTINCT values are the unit. `None` counts rows.
    ///
    /// "How many sign-ins" and "how many people signed in" are different
    /// questions and never the same answer; this is where a panel says which one
    /// it is asking.
    pub distinct: Option<&'static str>,
}

impl Counted {
    /// Every row of `table` that falls in the window.
    pub const fn rows(table: &'static str, time: &'static str, filter: &'static str) -> Self {
        Self { table, time, filter, distinct: None }
    }

    /// The distinct values of one column of `t` - how many *somebodies*, not how
    /// many rows.
    pub const fn distinct(
        table: &'static str,
        time: &'static str,
        filter: &'static str,
        column: &'static str,
    ) -> Self {
        Self { table, time, filter, distinct: Some(column) }
    }

    /// What this count is, said in the terms a report prints.
    pub const fn provenance(&self) -> Provenance {
        match self.distinct {
            Some(column) => Provenance::distinct(self.table, self.filter, column),
            None => Provenance::rows(self.table, self.filter),
        }
    }

    /// The aggregate expression, assembled from fragments written in source.
    fn aggregate(&self) -> String {
        match self.distinct {
            Some(column) => format!("COUNT(DISTINCT {column})"),
            None => "COUNT(*)".to_owned(),
        }
    }

    /// The same aggregate restricted to the rows matching `cond`, expressed with
    /// a `CASE` inside `COUNT` rather than the `agg FILTER (WHERE ...)` clause
    /// MySQL does not support. `COUNT` skips the `NULL` the `CASE` yields when
    /// `cond` is false, so `COUNT(CASE WHEN c THEN 1 END)` equals
    /// `COUNT(*) FILTER (WHERE c)` and `COUNT(DISTINCT CASE WHEN c THEN col END)`
    /// equals `COUNT(DISTINCT col) FILTER (WHERE c)`, on all three engines.
    ///
    /// `cond` is a `&'static str`-derived fragment (a bind-parameter comparison);
    /// no request data is spliced.
    fn aggregate_when(&self, cond: &str) -> String {
        match self.distinct {
            Some(column) => format!("COUNT(DISTINCT CASE WHEN {cond} THEN {column} END)"),
            None => format!("COUNT(CASE WHEN {cond} THEN 1 END)"),
        }
    }
}

/// Advances a local wall-clock instant by one bucket, the portable stand-in for
/// `generate_series(..., INTERVAL '<step>')`. Weeks and days are whole-day steps
/// over naive local time (no DST arithmetic), exactly as `generate_series` over a
/// `timestamp` (without zone) produced them.
fn advance_bucket(bucket: Bucket, t: NaiveDateTime) -> NaiveDateTime {
    match bucket {
        Bucket::Hour => t + Duration::hours(1),
        Bucket::Day => t + Duration::days(1),
        Bucket::Week => t + Duration::days(7),
    }
}

/// Formats a bucket boundary the way the series keys are compared and returned -
/// the portable equivalent of `to_char(d, 'YYYY-MM-DD"T"HH24:MI:SS')`.
fn bucket_key(t: NaiveDateTime) -> String {
    t.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// The series, zero-filled over the window.
///
/// Zero-filling is correct for an APPEND-ONLY record of things that happened: a
/// bucket with no row means nothing happened, not that nothing was measured. It
/// would be a lie over a sampled gauge, which is why the storage panel reads its
/// samples itself and leaves its gaps as gaps.
pub async fn series(
    db: &DbPool,
    what: &Counted,
    win: &Window,
    label: &str,
) -> Result<Vec<Point>, AppError> {
    // The zero-filled axis of local wall-clock bucket boundaries, built in Rust
    // the way `generate_series($axis_from, $axis_to, INTERVAL '<step>')` built it
    // (both endpoints inclusive). A bucket with no row stays at 0.
    let mut keys: Vec<String> = Vec::new();
    let mut cursor = win.axis_from;
    while cursor <= win.axis_to {
        keys.push(bucket_key(cursor));
        cursor = advance_bucket(win.bucket, cursor);
    }

    // The counts, bucketed in Rust rather than through PostgreSQL-only SQL
    // (`generate_series`, `date_trunc(... AT TIME ZONE ...)`, `to_char`, the
    // `::timestamp/::text/::bigint` casts): read the raw rows in the window and
    // fold each into its bucket. Truncating a row's instant to a bucket in the
    // instance zone reuses `floor_local`, which already matches
    // `date_trunc('week', …)` (weeks starting Monday) and its hour/day cases.
    //
    // Safe: `Counted`'s table, time column, filter and distinct column are all
    // `&'static str` written in source; the two window bounds are bound.
    let time = what.time;
    let table = what.table;
    let filter = what.filter;
    let map_err = |e: sqlx::Error| {
        tracing::error!(error = %e, panel = %label, "tableau de bord : série");
        AppError::Database(e)
    };

    let counts: HashMap<String, i64> = if let Some(column) = what.distinct {
        // "How many distinct somebodies per bucket": collect the distinct ids in
        // each bucket, then take each set's size. The distinct columns in use are
        // UUID keys (`actor_id`), decoded natively as `Uuid` on every engine.
        let sql = format!(
            "SELECT t.{time}, {column} FROM {table} t \
              WHERE ({filter}) AND t.{time} >= $1 AND t.{time} < $2"
        );
        let rows: Vec<(DateTime<Utc>, Option<Uuid>)> = db
            .fetch_all_as::<(DateTime<Utc>, Option<Uuid>)>(&sql, params![win.from, win.to])
            .await
            .map_err(map_err)?;
        let mut sets: HashMap<String, HashSet<Uuid>> = HashMap::new();
        for (ts, id) in rows {
            if let Some(id) = id {
                let key = bucket_key(floor_local(win.bucket, ts.with_timezone(&win.tz).naive_local()));
                sets.entry(key).or_default().insert(id);
            }
        }
        sets.into_iter().map(|(k, s)| (k, s.len() as i64)).collect()
    } else {
        let sql = format!(
            "SELECT t.{time} FROM {table} t \
              WHERE ({filter}) AND t.{time} >= $1 AND t.{time} < $2"
        );
        let rows: Vec<(DateTime<Utc>,)> = db
            .fetch_all_as::<(DateTime<Utc>,)>(&sql, params![win.from, win.to])
            .await
            .map_err(map_err)?;
        let mut counts: HashMap<String, i64> = HashMap::new();
        for (ts,) in rows {
            let key = bucket_key(floor_local(win.bucket, ts.with_timezone(&win.tz).naive_local()));
            *counts.entry(key).or_default() += 1;
        }
        counts
    };

    Ok(keys
        .into_iter()
        .map(|bucket| {
            let value = counts.get(&bucket).copied().unwrap_or(0);
            Point { bucket, value }
        })
        .collect())
}

/// The window's total and the total of the window of equal length before it -
/// read in ONE statement, so the two can never come from different instants.
pub async fn totals(
    db: &DbPool,
    what: &Counted,
    win: &Window,
    label: &str,
) -> Result<(i64, i64), AppError> {
    let sql = format!(
        // `agg FILTER (WHERE ...)` is PostgreSQL/SQLite-only (MySQL has no
        // `FILTER`), so the sub-range restriction moves inside the aggregate as a
        // `CASE` (see `aggregate_when`). Placeholders must appear once each, in
        // ascending order - the prepare scanner rejects reuse on every engine -
        // so `win.from` is bound twice, as $1 (current half) and $2 (previous).
        "SELECT {current}, {previous} \
           FROM {table} t \
          WHERE ({filter}) AND t.{time} >= $3 AND t.{time} < $4",
        current = what.aggregate_when(&format!("t.{} >= $1", what.time)),
        previous = what.aggregate_when(&format!("t.{} < $2", what.time)),
        time = what.time,
        table = what.table,
        filter = what.filter,
    );

    // Safe: `Counted`'s table, time column, filter and aggregate are all
    // `&'static str` written in source; the instants are bound. Bind order
    // matches the placeholders: $1/$2 = win.from, $3 = previous_from, $4 = to.
    let row: (i64, i64) = db
        .fetch_one_as::<(i64, i64)>(
            &sql,
            params![win.from, win.from, win.previous_from, win.to],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, panel = %label, "tableau de bord : totaux");
            AppError::Database(e)
        })?;

    Ok(row)
}

/// Slices a REPORT may name, as opposed to the handful a card draws.
///
/// A panel keeps a top-N because a chart with forty arcs is a texture; a printed
/// report is read for its figures and must not stop at the eighth. The ceiling
/// still exists - an unbounded `GROUP BY` over an account table is a page nobody
/// can print and a statement nobody metered - and when it is reached the panel
/// says so (`breakdown_truncated`) rather than letting a cut list read as a
/// complete one.
pub const FULL_SLICES: i64 = 1000;

/// How many slices to read: the panel's own top-N, or a report's ceiling.
///
/// Taken through one function so that "the report is not truncated" is a
/// property of the request, never of a limit quietly raised for every caller.
pub const fn slice_limit(full: bool, panel_limit: i64) -> i64 {
    if full { FULL_SLICES } else { panel_limit }
}

/// The breakdown, largest first.
///
/// A NULL grouping value becomes the explicit key `unknown`: "we do not know" is
/// a state the console names, never one it hides by dropping the row.
pub async fn breakdown(
    db: &DbPool,
    what: &Counted,
    win: &Window,
    // Spliced into the SQL text: `&'static str` so the compiler refuses
    // anything a request could have produced.
    expr: &'static str,
    limit: i64,
    label: &str,
) -> Result<Vec<Slice>, AppError> {
    // `(expr)::text` becomes the dialect cast (`CAST(... AS CHAR/TEXT)` off
    // PostgreSQL); the grouping value is text on every engine. The `::bigint`
    // cast on `COUNT(...)` is dropped - `COUNT` already decodes as `i64`. The
    // positional `GROUP BY 1 / ORDER BY 2` is portable.
    let key_expr = db.backend().cast(expr, SqlType::Text);
    let sql = format!(
        "SELECT COALESCE(NULLIF({key_expr}, ''), 'unknown'), {agg} \
           FROM {table} t \
          WHERE ({filter}) AND t.{time} >= $1 AND t.{time} < $2 \
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT {limit}",
        agg = what.aggregate(),
        table = what.table,
        filter = what.filter,
        time = what.time,
    );

    // Safe: the grouping expression and `Counted`'s fragments are all
    // `&'static str`, and `limit` is an integer. The bounds are bound.
    let rows: Vec<(String, i64)> = db
        .fetch_all_as::<(String, i64)>(&sql, params![win.from, win.to])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, panel = %label, "tableau de bord : répartition");
            AppError::Database(e)
        })?;

    Ok(rows
        .into_iter()
        .map(|(key, value)| Slice::new(key, value))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default a page opens on must be one the endpoints accept, or every
    /// first load is a 422.
    #[test]
    fn the_default_period_is_in_the_closed_list() {
        assert!(PERIODS.contains(&DEFAULT_PERIOD));
    }

    /// An address may not widen the window by naming a period nobody offers.
    #[test]
    fn an_unknown_period_is_refused_and_an_absent_one_defaults() {
        assert_eq!(validate(None).ok(), Some(DEFAULT_PERIOD));
        assert_eq!(validate(Some("")).ok(), Some(DEFAULT_PERIOD));
        assert_eq!(validate(Some("last_7_days")).ok(), Some("last_7_days"));
        assert!(validate(Some("last_10_years")).is_err());
    }

    /// The comparison window sits immediately behind the reading and is exactly
    /// as long, or the percentage under each panel compares two different spans.
    #[test]
    fn the_comparison_window_matches_the_reading() {
        let win = resolve_window("last_30_days", Tz::Europe__Paris);
        assert_eq!(win.to - win.from, win.from - win.previous_from);
        assert_eq!(win.bucket, Bucket::Day);
    }

    /// A window still running stops at "now": a month three days in must not be
    /// compared against a full one.
    #[test]
    fn a_running_period_is_clamped_to_now() {
        let win = resolve_window("this_month", Tz::UTC);
        assert!(win.to <= Utc::now());
        assert!(win.from <= win.to);
    }

    /// Long windows collapse to weekly buckets: 180 daily bars is a texture, not
    /// a reading.
    #[test]
    fn long_windows_are_bucketed_by_week() {
        assert_eq!(resolve_window("last_180_days", Tz::UTC).bucket, Bucket::Week);
        assert_eq!(resolve_window("today", Tz::UTC).bucket, Bucket::Hour);
    }

    /// The generated axis starts on a bucket boundary - PostgreSQL's
    /// `date_trunc` will only ever join on one.
    #[test]
    fn the_axis_starts_on_a_bucket_boundary() {
        let win = resolve_window("last_180_days", Tz::UTC);
        assert_eq!(win.axis_from.weekday(), chrono::Weekday::Mon);
        assert!(win.axis_to >= win.axis_from);
    }

    /// What a panel counts and what its report SAYS it counts are the same
    /// statement, derived rather than restated - a report describing a query
    /// nobody runs is worse than one describing none.
    #[test]
    fn the_provenance_describes_the_count_it_came_from() {
        let rows = Counted::rows("core.event_log", "created_at", "TRUE").provenance();
        assert_eq!(rows.measure, "count");
        assert_eq!(rows.table, "core.event_log");
        assert_eq!(rows.column, None);

        let people = Counted::distinct("core.device_events", "occurred_at", "TRUE", "t.actor_id")
            .provenance();
        assert_eq!(people.measure, "count_distinct");
        assert_eq!(people.column, Some("t.actor_id"));
    }

    /// A report reads further than a card, and only because it asked.
    #[test]
    fn only_a_report_lifts_the_slice_ceiling() {
        assert_eq!(slice_limit(false, 8), 8);
        assert_eq!(slice_limit(true, 8), FULL_SLICES);
        const { assert!(FULL_SLICES > 8) };
    }

    /// The day-keyed sources are read over the same calendar their rows were
    /// stamped in, and the comparison window stops the day before the reading
    /// starts - never overlapping it by a day.
    #[test]
    fn the_local_day_bounds_are_contiguous_and_do_not_overlap() {
        let win = resolve_window("last_7_days", Tz::Europe__Paris);
        let (first, last) = win.local_days();
        let (prev_first, prev_last) = win.previous_local_days();
        assert!(first <= last);
        assert!(prev_first <= prev_last);
        assert!(prev_last < first);
        assert_eq!((last - first).num_days(), 6);
    }
}
