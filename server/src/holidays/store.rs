//! Reading the referential, and folding the overlay into it.
//!
//! ## The one query that matters
//!
//! [`feed`] answers "what are the special days between these two dates, for
//! somebody here". Everything it does is about *not* fanning out: a subdivision
//! inherits its country's days through one recursive CTE, exclusions and the
//! organisational-unit overlay are applied in the same pass, and the expansion
//! into dates happens in memory afterwards, where it is pure arithmetic.

use chrono::NaiveDate;
use kubuno_db::{params, Backend, DbPool, DbQueryBuilder};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

use super::model::{self, Category, Holiday, HolidayCalendar, Observance, Occurrence, Rule};
use super::rules;
use crate::errors::AppError;

/// A calendar plus what the console needs to judge it without opening it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CalendarSummary {
    #[serde(flatten)]
    pub calendar: HolidayCalendar,
    /// Days declared on the calendar itself.
    pub holiday_count: i64,
    /// Days it takes from its country, exclusions already deducted.
    pub inherited_count: i64,
    /// How many of its own days an administrator has edited.
    pub overridden_count: i64,
    pub subdivision_count: i64,
    /// The country name, for the console's grouping.
    pub display_name: String,
}

// ── Raw row shapes ────────────────────────────────────────────────────────────
//
// `HolidayCalendar` and `Holiday` carry parsed value types (`Category`, `Rule`,
// …) that no `FromRow` can build directly, and `kubuno_db` has no
// `fetch_all_row`. Every read therefore lands in one of these raw structs first
// and is folded into the domain type in Rust.

/// The base columns of a `core.holiday_calendars` row.
#[derive(Debug, Clone, FromRow)]
struct CalendarRow {
    id: Uuid,
    code: String,
    country_code: Option<String>,
    subdivision: Option<String>,
    parent_id: Option<Uuid>,
    name: String,
    names: Value,
    is_builtin: bool,
    enabled: bool,
    coverage_from: Option<i32>,
    coverage_to: Option<i32>,
}

impl CalendarRow {
    fn into_calendar(self) -> HolidayCalendar {
        HolidayCalendar {
            id: self.id,
            code: self.code,
            country_code: self.country_code,
            subdivision: self.subdivision,
            parent_id: self.parent_id,
            name: self.name,
            names: self.names,
            is_builtin: self.is_builtin,
            enabled: self.enabled,
            coverage_from: self.coverage_from,
            coverage_to: self.coverage_to,
        }
    }
}

/// A calendar row plus the console's four counts.
#[derive(Debug, FromRow)]
struct CalendarSummaryRow {
    #[sqlx(flatten)]
    calendar: CalendarRow,
    holiday_count: i64,
    inherited_count: i64,
    overridden_count: i64,
    subdivision_count: i64,
}

/// The raw columns of a `core.holidays` row.
#[derive(Debug, Clone, FromRow)]
struct HolidayRaw {
    id: Uuid,
    calendar_id: Uuid,
    key: String,
    name: String,
    names: Value,
    category: String,
    kind: String,
    rule: Value,
    observance: String,
    from_year: Option<i32>,
    to_year: Option<i32>,
    color: Option<String>,
    enabled: bool,
    is_builtin: bool,
    is_overridden: bool,
    is_orphan: bool,
}

impl HolidayRaw {
    fn into_holiday(self) -> Result<Holiday, AppError> {
        Ok(Holiday {
            id: self.id,
            calendar_id: self.calendar_id,
            key: self.key,
            name: self.name,
            names: self.names,
            category: Category::parse(&self.category)?,
            rule: Rule::from_parts(&self.kind, &self.rule)?,
            observance: Observance::parse(&self.observance)?,
            from_year: self.from_year,
            to_year: self.to_year,
            color: self.color,
            enabled: self.enabled,
            is_builtin: self.is_builtin,
            is_overridden: self.is_overridden,
            is_orphan: self.is_orphan,
        })
    }
}

/// A holiday row with the "is this inherited from the parent" flag.
#[derive(Debug, FromRow)]
struct HolidayInheritedRow {
    #[sqlx(flatten)]
    holiday: HolidayRaw,
    inherited: bool,
}

/// A holiday row carrying the requested (root) calendar's identity.
#[derive(Debug, FromRow)]
struct FeedRow {
    #[sqlx(flatten)]
    holiday: HolidayRaw,
    root_id: Uuid,
    root_code: String,
    root_name: String,
    root_names: Value,
}

/// One row of the organisational-unit overlay walk.
#[derive(Debug, FromRow)]
struct UnitPrefRow {
    calendar_id: Option<Uuid>,
    holiday_id: Option<Uuid>,
    enabled: bool,
    depth: i32,
}

/// Every calendar, with its counts. `search` matches the code and every
/// localised name, so an operator typing "Maroc" finds `MA` in a French console
/// and one typing "Morocco" finds it in an English one.
pub async fn list_calendars(
    db: &DbPool,
    search: Option<&str>,
    countries_only: bool,
    only_enabled: bool,
    locale: &str,
) -> Result<Vec<CalendarSummary>, AppError> {
    let needle = search
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{}%", s.to_lowercase()));

    // Multi-DBMS: iterating a JSON object's values has no shared spelling, so the
    // translated-names match is written per engine (it was PostgreSQL-only, and
    // the whole calendar list failed on MySQL/SQLite). `NULLS FIRST` is replaced
    // by `(parent_id IS NOT NULL)` (false sorts first), redundant `::bigint`/
    // `::bool`/`::text` casts are dropped, and `needle` is bound once per use so
    // no placeholder is reused.
    let names_match = match db.backend() {
        Backend::Postgres => "EXISTS (SELECT 1 FROM jsonb_each_text(c.names) t WHERE LOWER(t.value) LIKE $6)",
        // JSON_SEARCH matches string values (not keys) against a LIKE pattern.
        Backend::MySql => "JSON_SEARCH(LOWER(CAST(c.names AS CHAR)), 'one', $6) IS NOT NULL",
        Backend::Sqlite => "EXISTS (SELECT 1 FROM json_each(c.names) t WHERE LOWER(t.value) LIKE $6)",
    };
    let rows = db
        .fetch_all_as::<CalendarSummaryRow>(
            &format!(r#"
        SELECT c.id, c.code, c.country_code, c.subdivision, c.parent_id, c.name, c.names,
               c.is_builtin, c.enabled, c.coverage_from, c.coverage_to,
               (SELECT COUNT(*) FROM core.holidays h WHERE h.calendar_id = c.id) AS holiday_count,
               (SELECT COUNT(*) FROM core.holidays h
                 WHERE h.calendar_id = c.parent_id
                   AND NOT EXISTS (SELECT 1 FROM core.holiday_exclusions e
                                    WHERE e.calendar_id = c.id AND e."key" = h."key")) AS inherited_count,
               (SELECT COUNT(*) FROM core.holidays h
                 WHERE h.calendar_id = c.id AND h.is_overridden) AS overridden_count,
               (SELECT COUNT(*) FROM core.holiday_calendars s WHERE s.parent_id = c.id) AS subdivision_count
          FROM core.holiday_calendars c
         WHERE ($1 IS NOT TRUE OR c.parent_id IS NULL)
           AND ($2 IS NOT TRUE OR c.enabled)
           AND ($3 IS NULL
                OR LOWER(c.code) LIKE $4
                OR LOWER(c.name) LIKE $5
                -- Every translated name, so the search speaks the reader's
                -- language without the console shipping a country list of its own.
                OR {names_match})
         ORDER BY (c.parent_id IS NOT NULL), LOWER(c.name)
        "#),
            params![
                countries_only,
                only_enabled,
                needle.as_deref(),
                needle.as_deref(),
                needle.as_deref(),
                needle.as_deref()
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "holidays: liste des calendriers");
            AppError::Database(e)
        })?;

    rows.into_iter()
        .map(|row| {
            let calendar = row.calendar.into_calendar();
            let display_name = calendar.localized_name(locale);
            Ok(CalendarSummary {
                display_name,
                holiday_count: row.holiday_count,
                inherited_count: row.inherited_count,
                overridden_count: row.overridden_count,
                subdivision_count: row.subdivision_count,
                calendar,
            })
        })
        .collect()
}

/// One calendar by its id.
pub async fn calendar(db: &DbPool, id: Uuid) -> Result<HolidayCalendar, AppError> {
    let row = db
        .fetch_optional_as::<CalendarRow>(
            "SELECT id, code, country_code, subdivision, parent_id, name, names, is_builtin, enabled, \
                coverage_from, coverage_to \
           FROM core.holiday_calendars WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "holidays: lecture d'un calendrier");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Calendrier introuvable".into()))?;
    Ok(row.into_calendar())
}

/// The days declared on one calendar, and - when `include_inherited` - the ones
/// it takes from its country, exclusions already applied.
///
/// Returns `(holiday, inherited)` so the console can show an inherited row as
/// what it is: readable, and edited on the country rather than here.
pub async fn holidays_of(
    db: &DbPool,
    calendar_id: Uuid,
    include_inherited: bool,
) -> Result<Vec<(Holiday, bool)>, AppError> {
    // `calendar_id` is bound once per appearance (no reused placeholder).
    let rows = db
        .fetch_all_as::<HolidayInheritedRow>(
            r#"
        SELECT h.id, h.calendar_id, h."key", h.name, h.names, h.category, h.kind, h.rule,
               h.observance, h.from_year, h.to_year, h.color, h.enabled,
               h.is_builtin, h.is_overridden, h.is_orphan,
               (h.calendar_id <> $1) AS inherited
          FROM core.holidays h
         WHERE h.calendar_id = $2
            OR ($3 AND h.calendar_id = (SELECT parent_id FROM core.holiday_calendars WHERE id = $4)
                   AND NOT EXISTS (SELECT 1 FROM core.holiday_exclusions e
                                    WHERE e.calendar_id = $5 AND e."key" = h."key"))
         ORDER BY inherited, LOWER(h.name)
        "#,
            params![
                calendar_id,
                calendar_id,
                include_inherited,
                calendar_id,
                calendar_id
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "holidays: liste des journées");
            AppError::Database(e)
        })?;

    rows.into_iter()
        .map(|row| {
            let inherited = row.inherited;
            Ok((row.holiday.into_holiday()?, inherited))
        })
        .collect()
}

/// The keys of the parent's days a subdivision does not observe.
pub async fn exclusions(db: &DbPool, calendar_id: Uuid) -> Result<Vec<String>, AppError> {
    let rows = db
        .fetch_all_as::<(String,)>(
            "SELECT \"key\" FROM core.holiday_exclusions WHERE calendar_id = $1 ORDER BY \"key\"",
            params![calendar_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "holidays: lecture des exclusions");
            AppError::Database(e)
        })?;
    Ok(rows.into_iter().map(|(key,)| key).collect())
}

/// What one organisational unit turns on or off, closest ancestor first.
///
/// The walk goes *up*: a unit inherits its parent's adjustments, and its own
/// answer wins over theirs - the same rule as `core.setting_values`, so an
/// operator does not have to hold two inheritance models in their head.
pub async fn unit_prefs(
    db: &DbPool,
    org_unit_id: Uuid,
) -> Result<Vec<(Option<Uuid>, Option<Uuid>, bool, i32)>, AppError> {
    let rows = db
        .fetch_all_as::<UnitPrefRow>(
            r#"
        WITH RECURSIVE chain AS (
            SELECT id, parent_id, 0 AS depth FROM core.org_units WHERE id = $1
            UNION ALL
            SELECT u.id, u.parent_id, c.depth + 1
              FROM core.org_units u JOIN chain c ON u.id = c.parent_id
             -- A cycle written by a past bug must not hang a page request.
             WHERE c.depth < 32
        )
        SELECT p.calendar_id, p.holiday_id, p.enabled, c.depth
          FROM core.holiday_unit_prefs p
          JOIN chain c ON c.id = p.org_unit_id
         ORDER BY c.depth
        "#,
            params![org_unit_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "holidays: lecture de la surcouche d'unité");
            AppError::Database(e)
        })?;

    Ok(rows
        .into_iter()
        .map(|r| (r.calendar_id, r.holiday_id, r.enabled, r.depth))
        .collect())
}

/// What a request asks the feed for.
pub struct FeedQuery<'a> {
    /// Calendar codes, already resolved for the reader.
    pub codes: &'a [String],
    pub from: NaiveDate,
    pub to: NaiveDate,
    /// Empty means every category - a module that has not filtered wants the
    /// whole answer, not a silently narrowed one.
    pub categories: &'a [Category],
    pub locale: &'a str,
    /// The reader's unit, when known: what the overlay is applied for.
    pub org_unit_id: Option<Uuid>,
    /// `intl.holidays_enabled` - when false, only what this instance declared
    /// itself is served.
    pub builtin_enabled: bool,
}

/// Every occurrence in the range, for the calendars that apply.
pub async fn feed(db: &DbPool, query: FeedQuery<'_>) -> Result<Vec<Occurrence>, AppError> {
    if query.codes.is_empty() || query.from > query.to {
        return Ok(Vec::new());
    }

    let codes: Vec<String> = query.codes.iter().map(|c| c.to_uppercase()).collect();
    let categories: Vec<String> = query.categories.iter().map(|c| c.as_str().to_string()).collect();

    // The recursive part walks from the requested calendar up to its country,
    // carrying the *requested* calendar's identity along: a French inherited day
    // shown for `FR-6AE` must still say it is displayed under Alsace-Moselle.
    //
    // `= ANY($n)` over the text arrays becomes a portable `IN (...)` list, and the
    // PostgreSQL `cardinality($3::text[]) = 0` guard becomes a Rust-side test that
    // simply omits the category filter when none was asked for.
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        r#"
        WITH RECURSIVE wanted AS (
            SELECT c.id, c.parent_id, c.enabled, c.id AS root_id, c.code AS root_code,
                   c.name AS root_name, c.names AS root_names, 0 AS depth
              FROM core.holiday_calendars c
             WHERE UPPER(c.code)"#,
    );
    qb.push_in(codes);
    qb.push(
        r#"
            UNION ALL
            SELECT p.id, p.parent_id, p.enabled, w.root_id, w.root_code,
                   w.root_name, w.root_names, w.depth + 1
              FROM core.holiday_calendars p
              JOIN wanted w ON p.id = w.parent_id
             WHERE w.depth < 8
        )
        SELECT h.id, h.calendar_id, h."key", h.name, h.names, h.category, h.kind, h.rule,
               h.observance, h.from_year, h.to_year, h.color, h.enabled,
               h.is_builtin, h.is_overridden, h.is_orphan,
               w.root_id, w.root_code, w.root_name, w.root_names
          FROM wanted w
          JOIN core.holidays h ON h.calendar_id = w.id
         WHERE h.enabled
           AND w.enabled
           AND (h.is_builtin IS NOT TRUE OR "#,
    );
    qb.push_bind(query.builtin_enabled);
    qb.push(")");
    if !categories.is_empty() {
        qb.push(" AND h.category");
        qb.push_in(categories);
    }
    qb.push(
        r#"
           -- A day the requested calendar explicitly does not observe.
           AND NOT EXISTS (SELECT 1 FROM core.holiday_exclusions e
                            WHERE e.calendar_id = w.root_id AND e."key" = h."key")
        "#,
    );

    let rows = qb.fetch_all_as::<FeedRow>(db).await.map_err(|e| {
        tracing::error!(error = %e, "holidays: flux");
        AppError::Database(e)
    })?;

    // The overlay, closest unit first: the first answer found for a target wins.
    let prefs = match query.org_unit_id {
        Some(unit) => unit_prefs(db, unit).await?,
        None => Vec::new(),
    };
    let pref_for = |calendar: Uuid, holiday: Uuid| -> Option<bool> {
        prefs
            .iter()
            .find(|(_, hol, _, _)| *hol == Some(holiday))
            .or_else(|| prefs.iter().find(|(cal, _, _, _)| *cal == Some(calendar)))
            .map(|(_, _, enabled, _)| *enabled)
    };

    let mut out = Vec::new();
    for row in rows {
        let root_id = row.root_id;
        let root_code = row.root_code;
        let root_name = row.root_name;
        let root_names = row.root_names;
        let holiday = row.holiday.into_holiday()?;
        if pref_for(root_id, holiday.id) == Some(false) {
            continue;
        }
        let calendar_name = model::localized_name(&root_names, &root_name, query.locale);

        let name = holiday.localized_name(query.locale);
        for expansion in rules::expand(
            &holiday.rule,
            holiday.observance,
            query.from,
            query.to,
            holiday.from_year,
            holiday.to_year,
        ) {
            out.push(Occurrence {
                date: expansion.date,
                name: name.clone(),
                key: holiday.key.clone(),
                category: holiday.category,
                calendar_code: root_code.clone(),
                calendar_name: calendar_name.clone(),
                color: holiday.color.clone(),
                observed_from: expansion.observed_from,
            });
        }
    }

    // Sorted by date then by name: two calendars can answer for the same day,
    // and a stable order is what keeps a module's rendering from flickering
    // between two refreshes.
    out.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}
