//! The feed every module reads: what days are special, between two dates, for
//! whoever is asking.
//!
//! ## Open to every signed-in account, on purpose
//!
//! A public holiday is public. `core.holidays.read` gates the administration
//! console - "who may see and edit the referential" - and has no business
//! gating the answer to "is the 14th of July a working day". A calendar that
//! showed holidays to administrators only would be a bug wearing a policy's
//! clothes, so the only guard here is authentication.
//!
//! ## The caller does not have to know where the reader lives
//!
//! With no `calendars` parameter the route resolves them itself
//! ([`crate::holidays::resolve`]) and *says how* it did: `source: "setting"`
//! when somebody posted the value, `"timezone"` when it was deduced. A module
//! renders "Jours fériés - France (d'après votre fuseau horaire)" from that and
//! offers a correction, instead of silently showing the wrong country.

use axum::{
    extract::{Query, State},
    Json,
};
use chrono::{Datelike, NaiveDate, Utc};
use kubuno_db::{params, DbPool, DbQueryBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    auth::middleware::AuthUser,
    errors::AppError,
    holidays::{
        model::Category,
        resolve,
        store::{self, FeedQuery},
    },
    settings::intl,
    state::AppState,
};

/// Longest range a single request may ask for.
///
/// Five years, and the reason is the expansion: every rule of every requested
/// calendar is walked year by year, so an unbounded range is an unbounded
/// response. Five covers every real caller - a year view, a planning horizon,
/// an export - and a module that wants a century asks twenty times, visibly.
const MAX_SPAN_DAYS: i64 = 366 * 5;

#[derive(Debug, Deserialize)]
pub struct FeedParams {
    /// Inclusive, `YYYY-MM-DD`. Defaults to the first day of the current year.
    from: Option<String>,
    /// Inclusive. Defaults to a year after `from`.
    to: Option<String>,
    /// Overrides the resolution: `FR`, `FR-6AE,BE`.
    calendars: Option<String>,
    /// `public,bank` - empty means every category.
    categories: Option<String>,
    /// Overrides the reader's language for the returned names.
    locale: Option<String>,
}

fn parse_date(raw: &str, field: &str) -> Result<NaiveDate, AppError> {
    raw.trim()
        .parse::<NaiveDate>()
        .map_err(|_| AppError::Validation(format!("Paramètre « {field} » : date attendue au format AAAA-MM-JJ")))
}

fn parse_categories(raw: Option<&str>) -> Result<Vec<Category>, AppError> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(Vec::new()),
        Some(list) => list
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(Category::parse)
            .collect(),
    }
}

/// The unit the reader belongs to - what the organisational overlay is applied
/// for. A reader outside the tree simply gets the instance's answer.
async fn org_unit_of(db: &DbPool, user_id: Uuid) -> Option<Uuid> {
    match db
        .fetch_optional_scalar::<Option<Uuid>>(
            "SELECT org_unit_id FROM core.users WHERE id = $1",
            params![user_id],
        )
        .await
    {
        Ok(unit) => unit.flatten(),
        Err(e) => {
            // Not fatal: without the unit the overlay is skipped and the
            // instance referential answers, which is the right degraded answer.
            tracing::error!(error = %e, "holidays: lecture de l'unité du lecteur");
            None
        }
    }
}

/// Is the shipped referential served at all (`intl.holidays_enabled`)?
async fn builtin_enabled(db: &DbPool) -> bool {
    crate::settings::instance_value(db, "intl.holidays_enabled")
        .await
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// `GET /api/v1/holidays`
pub async fn feed(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(params): Query<FeedParams>,
) -> Result<Json<Value>, AppError> {
    let today = Utc::now().date_naive();
    let from = match params.from.as_deref() {
        Some(raw) => parse_date(raw, "from")?,
        None => NaiveDate::from_ymd_opt(today.year(), 1, 1)
            .ok_or_else(|| AppError::Validation("Année hors de portée".into()))?,
    };
    let to = match params.to.as_deref() {
        Some(raw) => parse_date(raw, "to")?,
        None => NaiveDate::from_ymd_opt(from.year() + 1, 1, 1)
            .map(|d| d.pred_opt().unwrap_or(d))
            .ok_or_else(|| AppError::Validation("Année hors de portée".into()))?,
    };
    if to < from {
        return Err(AppError::Validation(
            "La date de fin précède la date de début".into(),
        ));
    }
    if (to - from).num_days() > MAX_SPAN_DAYS {
        return Err(AppError::Validation(
            "Plage trop large : cinq ans au maximum par requête".into(),
        ));
    }

    let categories = parse_categories(params.categories.as_deref())?;
    let locale = match params.locale.as_deref().and_then(intl::normalise_locale) {
        Some(locale) => locale.to_string(),
        None => intl::locale_for(&state.db, Some(user.id)).await.to_string(),
    };

    // An explicit list is an override, and it is reported as such: a module that
    // asked for Belgium must not be told the answer came from the reader's
    // setting.
    let (codes, source, timezone) = match params.calendars.as_deref() {
        Some(raw) if !raw.trim().is_empty() => {
            let applicable = resolve::for_user(&state.db, Some(user.id)).await;
            (resolve::parse_codes(raw), "explicit".to_string(), applicable.timezone)
        }
        _ => {
            let applicable = resolve::for_user(&state.db, Some(user.id)).await;
            (
                applicable.codes,
                serde_json::to_value(applicable.source)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| "unknown".into()),
                applicable.timezone,
            )
        }
    };

    let org_unit_id = org_unit_of(&state.db, user.id).await;
    let occurrences = store::feed(
        &state.db,
        FeedQuery {
            codes: &codes,
            from,
            to,
            categories: &categories,
            locale: &locale,
            org_unit_id,
            builtin_enabled: builtin_enabled(&state.db).await,
        },
    )
    .await?;

    Ok(Json(json!({
        "from": from,
        "to": to,
        "locale": locale,
        "calendars": codes,
        "source": source,
        "timezone": timezone,
        "holidays": occurrences,
    })))
}

#[derive(Debug, Deserialize)]
pub struct LocaleParams {
    locale: Option<String>,
}

/// `GET /api/v1/holidays/applicable` - what applies to the caller, and how the
/// instance knows.
///
/// Its own route rather than a field of the feed: a settings screen needs the
/// answer before it has a date range to ask about, and a module that only wants
/// to label a toggle should not have to fetch a year of dates to do it.
pub async fn applicable(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(params): Query<LocaleParams>,
) -> Result<Json<Value>, AppError> {
    let applicable = resolve::for_user(&state.db, Some(user.id)).await;
    // The caller's language wins over the resolved one: a browser showing a
    // French interface knows what language its reader chose, and the account's
    // stored locale may simply never have been set.
    let locale = match params.locale.as_deref().and_then(intl::normalise_locale) {
        Some(locale) => locale,
        None => intl::locale_for(&state.db, Some(user.id)).await,
    };

    // The names, so a module can label the toggle without a second request.
    let mut qb = DbQueryBuilder::new(
        state.db.backend(),
        "SELECT code, name, names FROM core.holiday_calendars WHERE UPPER(code)",
    );
    qb.push_in(applicable.codes.clone());
    qb.push(" AND enabled");
    let named: Vec<(String, String, Value)> = qb
        .fetch_all_as::<(String, String, Value)>(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "holidays: names of applicable calendars");
            AppError::Database(e)
        })?;

    let calendars: Vec<Value> = named
        .into_iter()
        .map(|(code, name, names)| {
            let localized = names
                .get(locale)
                .or_else(|| names.get("en"))
                .and_then(Value::as_str)
                .unwrap_or(&name)
                .to_string();
            json!({ "code": code, "name": localized })
        })
        .collect();

    Ok(Json(json!({
        "codes": applicable.codes,
        "source": applicable.source,
        "timezone": applicable.timezone,
        "calendars": calendars,
    })))
}

#[derive(Debug, Deserialize)]
pub struct CalendarListParams {
    search: Option<String>,
    /// Countries only - what a picker offers first.
    countries_only: Option<bool>,
}

/// `GET /api/v1/holidays/calendars` - the territories on offer, for a picker.
///
/// Only the enabled ones: an instance that turned a country off has said it does
/// not want it proposed, and a picker still offering it would make that decision
/// look broken rather than applied.
pub async fn calendars(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(params): Query<CalendarListParams>,
) -> Result<Json<Value>, AppError> {
    let locale = intl::locale_for(&state.db, Some(user.id)).await;
    let summaries = store::list_calendars(
        &state.db,
        params.search.as_deref(),
        params.countries_only.unwrap_or(false),
        true,
        locale,
    )
    .await?;

    let calendars: Vec<Value> = summaries
        .into_iter()
        .map(|s| {
            json!({
                "code": s.calendar.code,
                "name": s.display_name,
                "country_code": s.calendar.country_code,
                "subdivision": s.calendar.subdivision,
                "parent_id": s.calendar.parent_id,
                "id": s.calendar.id,
            })
        })
        .collect();

    Ok(Json(json!({ "calendars": calendars })))
}
