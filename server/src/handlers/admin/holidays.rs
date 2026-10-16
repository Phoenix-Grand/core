//! The console side of the holiday referential.
//!
//! ## Three verbs, and what each one really means
//!
//! * **disable** a day or a calendar - the ordinary answer. Nothing is lost, the
//!   next dataset upgrade still corrects the row, and turning it back on returns
//!   exactly what was there. This is why `enabled` never raises
//!   `is_overridden`.
//! * **edit** a day - the row stops following the shipped dataset
//!   (`is_overridden`), and says so in the console. That is a promise, not a
//!   side effect: somebody who fixed a wrong date must not have it re-broken by
//!   an upgrade.
//! * **delete** a day - allowed only for what this instance created. Deleting a
//!   shipped row would achieve nothing: the seeder recreates it on the next
//!   version, because a missing key is indistinguishable from a new one. The
//!   route says so instead of doing it and letting the row come back.
//!
//! ## Per-unit adjustments are an overlay, never a copy
//!
//! A unit stores its *difference* - this calendar off here, that day on there.
//! Correcting the instance referential therefore reaches every unit that had not
//! overridden the row, which is the whole point of an inheritance model and the
//! reason nothing here duplicates a day into a unit.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use kubuno_db::{new_id, params, DbPool};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{redact::target, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    authz::{keys, AdminCtx},
    errors::AppError,
    holidays::{
        model::{Category, Observance, Rule},
        rules, seed, store,
    },
    settings::intl,
    state::AppState,
};

/// The year a preview defaults to.
///
/// The instance's clock, not the reader's: a console is read by an administrator
/// checking a referential, and "this year" has to mean the same thing for all of
/// them.
fn current_year() -> i32 {
    use chrono::Datelike as _;
    chrono::Utc::now().date_naive().year()
}

// ── Reading ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ListParams {
    search: Option<String>,
    countries_only: Option<bool>,
    locale: Option<String>,
}

/// The language the console is being read in.
///
/// Sent by the browser rather than resolved from the account: an instance
/// installed in English still has administrators reading a French console, and
/// the names of two hundred countries are exactly what they need in their own
/// language. Falls back to the instance locale when the caller says nothing.
async fn console_locale(db: &DbPool, asked: Option<&str>) -> &'static str {
    match asked.and_then(intl::normalise_locale) {
        Some(locale) => locale,
        None => intl::instance_locale(db).await,
    }
}

/// `GET /admin/holidays/calendars`
pub async fn list_calendars(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Query(params): Query<ListParams>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_READ)?;
    let locale = console_locale(&state.db, params.locale.as_deref()).await;
    let calendars = store::list_calendars(
        &state.db,
        params.search.as_deref(),
        params.countries_only.unwrap_or(false),
        false,
        locale,
    )
    .await?;
    Ok(Json(json!({ "calendars": calendars })))
}

#[derive(Debug, Deserialize)]
pub struct DetailParams {
    /// The year the preview column is computed for. Defaults to the current one.
    year: Option<i32>,
    locale: Option<String>,
}

/// `GET /admin/holidays/calendars/:id` - the calendar, its own days, the ones it
/// inherits, and the dates each produces in one year.
///
/// The preview is computed **server-side** although the console could do it in
/// JavaScript: the expander is the definition of what a rule means, and a second
/// implementation in another language is a second answer waiting to disagree
/// with the first.
pub async fn calendar_detail(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Query(params): Query<DetailParams>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_READ)?;
    let locale = console_locale(&state.db, params.locale.as_deref()).await;
    let calendar = store::calendar(&state.db, id).await?;
    let year = params.year.unwrap_or_else(current_year);
    let days = store::holidays_of(&state.db, id, true).await?;
    let exclusions = store::exclusions(&state.db, id).await?;

    let holidays: Vec<Value> = days
        .into_iter()
        .map(|(holiday, inherited)| {
            let dates: Vec<Value> = rules::preview(&holiday.rule, holiday.observance, year)
                .into_iter()
                .map(|e| json!({ "date": e.date, "observed_from": e.observed_from }))
                .collect();
            let display_name = holiday.localized_name(locale);
            let mut value = serde_json::to_value(&holiday).unwrap_or_else(|_| json!({}));
            if let Some(object) = value.as_object_mut() {
                object.insert("inherited".into(), json!(inherited));
                object.insert("display_name".into(), json!(display_name));
                object.insert("dates".into(), json!(dates));
                object.insert("excluded".into(), json!(exclusions.contains(&holiday.key)));
            }
            value
        })
        .collect();

    let parent = match calendar.parent_id {
        Some(parent_id) => store::calendar(&state.db, parent_id)
            .await
            .ok()
            .map(|p| json!({ "id": p.id, "code": p.code, "name": p.localized_name(locale) })),
        None => None,
    };

    Ok(Json(json!({
        "calendar": calendar,
        "display_name": calendar.localized_name(locale),
        "parent": parent,
        "year": year,
        "holidays": holidays,
        "exclusions": exclusions,
    })))
}

/// The eight referential counts the overview reports.
#[derive(sqlx::FromRow)]
struct OverviewCounts {
    calendars:          i64,
    countries:          i64,
    disabled_calendars: i64,
    holidays:           i64,
    overridden:         i64,
    custom:             i64,
    orphans:            i64,
    unit_prefs:         i64,
}

/// `GET /admin/holidays/overview` - what is loaded, and how much of it.
pub async fn overview(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_READ)?;

    // Each count decodes as `i64` on every engine (`count_bigint` applies the
    // per-dialect cast PostgreSQL used to spell `::bigint`).
    let cnt = state.db.backend().count_bigint("*");
    let sql = format!(
        "SELECT (SELECT {cnt} FROM core.holiday_calendars)                       AS calendars, \
                (SELECT {cnt} FROM core.holiday_calendars WHERE parent_id IS NULL) AS countries, \
                (SELECT {cnt} FROM core.holiday_calendars WHERE NOT enabled)     AS disabled_calendars, \
                (SELECT {cnt} FROM core.holidays)                               AS holidays, \
                (SELECT {cnt} FROM core.holidays WHERE is_overridden)           AS overridden, \
                (SELECT {cnt} FROM core.holidays WHERE NOT is_builtin)          AS custom, \
                (SELECT {cnt} FROM core.holidays WHERE is_orphan)               AS orphans, \
                (SELECT {cnt} FROM core.holiday_unit_prefs)                     AS unit_prefs"
    );
    let row = state
        .db
        .fetch_one_as::<OverviewCounts>(&sql, params![])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "holidays: referential status");
            AppError::Database(e)
        })?;

    // The whole stored JSON value as text - PostgreSQL's `value #>> '{}'`.
    let loaded_sql = format!(
        "SELECT {} FROM core.settings WHERE \"key\" = 'intl.holidays_dataset'",
        state.db.backend().json_text("value", &[]),
    );
    let loaded: Option<String> = state
        .db
        .fetch_optional_scalar::<Option<String>>(&loaded_sql, params![])
        .await
        .map_err(AppError::Database)?
        .flatten();

    Ok(Json(json!({
        "calendars":          row.calendars,
        "countries":          row.countries,
        "disabled_calendars": row.disabled_calendars,
        "holidays":           row.holidays,
        "overridden":         row.overridden,
        "custom":             row.custom,
        "orphans":            row.orphans,
        "unit_prefs":         row.unit_prefs,
        "dataset_loaded":     loaded,
        "dataset_shipped":    seed::shipped_version(),
    })))
}

// ── Writing a day ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct HolidayDto {
    name: String,
    #[serde(default)]
    names: Option<Value>,
    #[serde(default)]
    category: Option<String>,
    kind: String,
    rule: Value,
    #[serde(default)]
    observance: Option<String>,
    #[serde(default)]
    from_year: Option<i32>,
    #[serde(default)]
    to_year: Option<i32>,
    #[serde(default)]
    color: Option<String>,
}

/// The parsed, validated form of what the console posted.
struct ParsedHoliday {
    name: String,
    names: Value,
    category: Category,
    rule: Rule,
    observance: Observance,
    color: Option<String>,
}

fn parse_holiday(dto: &HolidayDto) -> Result<ParsedHoliday, AppError> {
    let name = dto.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Le nom de la journée est vide".into()));
    }
    if name.chars().count() > 200 {
        return Err(AppError::Validation("Nom trop long (200 caractères)".into()));
    }
    if let (Some(from), Some(to)) = (dto.from_year, dto.to_year) {
        if to < from {
            return Err(AppError::Validation(
                "L'année de fin précède l'année de début".into(),
            ));
        }
    }
    let color = match dto.color.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        None => None,
        Some(c) => {
            if !c.starts_with('#') || !(4..=9).contains(&c.len()) || !c[1..].chars().all(|ch| ch.is_ascii_hexdigit()) {
                return Err(AppError::Validation("Couleur invalide (attendu #rrggbb)".into()));
            }
            Some(c.to_string())
        }
    };
    // The names map is `{locale: name}` and nothing else: a nested object here
    // would travel intact to every module rendering the feed.
    let names = match dto.names.clone() {
        None => json!({}),
        Some(Value::Object(map)) => {
            if map.values().any(|v| !v.is_string()) {
                return Err(AppError::Validation(
                    "Les traductions doivent être des chaînes".into(),
                ));
            }
            Value::Object(map)
        }
        Some(_) => return Err(AppError::Validation("Traductions invalides".into())),
    };

    Ok(ParsedHoliday {
        name: name.to_string(),
        names,
        category: Category::parse(dto.category.as_deref().unwrap_or("public"))?,
        rule: Rule::from_parts(&dto.kind, &dto.rule)?,
        observance: Observance::parse(dto.observance.as_deref().unwrap_or("none"))?,
        color,
    })
}

/// A stable, unique key for a day this instance creates.
///
/// Prefixed rather than derived from the name alone: a locally-created
/// "Christmas Day" must never collide with the shipped `christmas-day`, or the
/// next re-seed would take the local row for a shipped one and rewrite it.
async fn custom_key(db: &DbPool, calendar_id: Uuid, name: &str) -> Result<String, AppError> {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let base = format!("local-{}", if slug.is_empty() { "jour".into() } else { slug });
    let base: String = base.chars().take(70).collect();

    for suffix in 0..50 {
        let candidate = if suffix == 0 { base.clone() } else { format!("{base}-{suffix}") };
        let taken: bool = db
            .fetch_scalar::<bool>(
                "SELECT EXISTS(SELECT 1 FROM core.holidays WHERE calendar_id = $1 AND \"key\" = $2)",
                params![calendar_id, &candidate],
            )
            .await
            .map_err(AppError::Database)?;
        if !taken {
            return Ok(candidate);
        }
    }
    Err(AppError::Conflict(
        "Trop de journées portant ce nom sur ce calendrier".into(),
    ))
}

/// `POST /admin/holidays/calendars/:id/holidays`
pub async fn create_holiday(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(calendar_id): Path<Uuid>,
    Json(dto): Json<HolidayDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;
    let parsed = parse_holiday(&dto)?;
    let calendar = store::calendar(&state.db, calendar_id).await?;
    let key = custom_key(&state.db, calendar_id, &parsed.name).await?;

    let mut tx = audit.begin(&state.db).await?;
    // The primary key is generated in Rust (no `RETURNING`, which MySQL lacks).
    let id = new_id();
    tx.execute(
        r#"INSERT INTO core.holidays
               (id, calendar_id, "key", name, names, category, kind, rule, observance,
                from_year, to_year, color, is_builtin, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, FALSE, $13)"#,
        params![
            id,
            calendar_id,
            &key,
            &parsed.name,
            parsed.names.clone(),
            parsed.category.as_str(),
            parsed.rule.kind(),
            parsed.rule.params(),
            parsed.observance.as_str(),
            dto.from_year,
            dto.to_year,
            parsed.color.clone(),
            audit.admin.id,
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "holidays: creating a day");
        AppError::Database(e)
    })?;

    tx.commit(
        AuditEntry::new("core.holidays.create")
            .target(target::HOLIDAY, id, parsed.name.clone())
            .after(json!({
                "id": id, "key": key, "name": parsed.name, "calendar": calendar.code,
                "category": parsed.category.as_str(), "kind": parsed.rule.kind(),
                "rule": parsed.rule.params(), "observance": parsed.observance.as_str(),
            }))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "id": id, "key": key })))
}

/// `PATCH /admin/holidays/days/:id`
///
/// Editing a shipped day detaches it from the dataset. Enabling or disabling one
/// does **not**: those two are answers about this organisation, not corrections
/// of the source, and a day switched off must keep receiving upstream fixes for
/// the day it is switched back on.
pub async fn update_holiday(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<HolidayDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;
    let parsed = parse_holiday(&dto)?;

    let mut tx = audit.begin(&state.db).await?;
    let for_update = tx.backend().for_update();
    let before = tx
        .fetch_optional_row(
            &format!(
                "SELECT name, category, kind, rule, observance, from_year, to_year, color, is_builtin \
                   FROM core.holidays WHERE id = $1{}",
                for_update
            ),
            params![id],
        )
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound("Journée introuvable".into()))?;

    let before_json = json!({
        "name": before.try_get::<String>("name")?,
        "category": before.try_get::<String>("category")?,
        "kind": before.try_get::<String>("kind")?,
        "rule": before.try_get::<Value>("rule")?,
        "observance": before.try_get::<String>("observance")?,
    });

    tx.execute(
        r#"UPDATE core.holidays
              SET name = $2, names = $3, category = $4, kind = $5, rule = $6,
                  observance = $7, from_year = $8, to_year = $9, color = $10,
                  -- Shipped rows detach here, and only here.
                  is_overridden = CASE WHEN is_builtin THEN TRUE ELSE is_overridden END
            WHERE id = $1"#,
        params![
            id,
            &parsed.name,
            parsed.names.clone(),
            parsed.category.as_str(),
            parsed.rule.kind(),
            parsed.rule.params(),
            parsed.observance.as_str(),
            dto.from_year,
            dto.to_year,
            parsed.color.clone(),
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "holidays: modifying a day");
        AppError::Database(e)
    })?;

    tx.commit(
        AuditEntry::new("core.holidays.update")
            .target(target::HOLIDAY, id, parsed.name.clone())
            .before(before_json)
            .after(json!({
                "name": parsed.name, "category": parsed.category.as_str(),
                "kind": parsed.rule.kind(), "rule": parsed.rule.params(),
                "observance": parsed.observance.as_str(),
            })),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct EnabledDto {
    enabled: bool,
}

/// `PATCH /admin/holidays/days/:id/enabled`
pub async fn set_holiday_enabled(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<EnabledDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;

    let mut tx = audit.begin(&state.db).await?;
    // No portable `RETURNING`: apply the change, then read the name back by id
    // (a missing row updates nothing and re-selects to `None` → 404).
    tx.execute(
        "UPDATE core.holidays SET enabled = $2 WHERE id = $1",
        params![id, dto.enabled],
    )
    .await
    .map_err(AppError::Database)?;
    let row = tx
        .fetch_optional_row("SELECT name FROM core.holidays WHERE id = $1", params![id])
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound("Journée introuvable".into()))?;
    let name: String = row.try_get("name")?;

    tx.commit(
        AuditEntry::new("core.holidays.update")
            .target(target::HOLIDAY, id, name)
            .after(json!({ "enabled": dto.enabled }))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "ok": true, "enabled": dto.enabled })))
}

/// `DELETE /admin/holidays/days/:id`
///
/// Refuses a shipped day, and says why: the seeder would recreate it on the next
/// dataset version, so a deletion that looked like it worked would quietly come
/// undone. Disabling is the answer, and it is permanent.
pub async fn delete_holiday(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;

    let mut tx = audit.begin(&state.db).await?;
    let for_update = tx.backend().for_update();
    let row = tx
        .fetch_optional_row(
            &format!(
                "SELECT name, is_builtin FROM core.holidays WHERE id = $1{}",
                for_update
            ),
            params![id],
        )
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound("Journée introuvable".into()))?;

    let name: String = row.try_get("name")?;
    if row.try_get::<bool>("is_builtin")? {
        return Err(AppError::Validation(
            "Cette journée provient du référentiel livré : désactivez-la plutôt que de la supprimer \
             (une suppression serait rétablie au prochain chargement du référentiel)."
                .into(),
        ));
    }

    tx.execute("DELETE FROM core.holidays WHERE id = $1", params![id])
        .await
        .map_err(AppError::Database)?;

    tx.commit(
        AuditEntry::new("core.holidays.delete")
            .target(target::HOLIDAY, id, name.clone())
            .before(json!({ "id": id, "name": name })),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

/// `POST /admin/holidays/days/:id/reset` - back to what the dataset ships.
pub async fn reset_holiday(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;

    let row = state
        .db
        .fetch_optional_row(
            "SELECT h.\"key\", h.name, h.is_builtin, c.code AS calendar_code \
               FROM core.holidays h JOIN core.holiday_calendars c ON c.id = h.calendar_id \
              WHERE h.id = $1",
            params![id],
        )
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound("Journée introuvable".into()))?;

    if !row.try_get::<bool>("is_builtin")? {
        return Err(AppError::Validation(
            "Cette journée a été créée ici : il n'y a pas de version d'origine à rétablir.".into(),
        ));
    }

    let before_name: String = row.try_get("name")?;
    let calendar_code: String = row.try_get("calendar_code")?;
    let key: String = row.try_get("key")?;
    let shipped = seed::shipped_holiday(&calendar_code, &key).ok_or_else(|| {
        AppError::Validation(
            "Le référentiel livré ne contient plus cette journée : elle ne peut pas être rétablie.".into(),
        )
    })?;

    let mut tx = audit.begin(&state.db).await?;
    tx.execute(
        r#"UPDATE core.holidays
              SET name = $2, names = $3, category = $4, kind = $5, rule = $6, observance = $7,
                  from_year = $8, to_year = $9, color = NULL,
                  is_overridden = FALSE
            WHERE id = $1"#,
        params![
            id,
            &shipped.name,
            shipped.names.clone(),
            &shipped.category,
            &shipped.kind,
            shipped.rule.clone(),
            &shipped.observance,
            shipped.from_year,
            shipped.to_year,
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "holidays: restoring a day");
        AppError::Database(e)
    })?;

    tx.commit(
        AuditEntry::new("core.holidays.update")
            .target(target::HOLIDAY, id, shipped.name.clone())
            .before(json!({ "name": before_name, "is_overridden": true }))
            .after(json!({ "name": shipped.name, "is_overridden": false })),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

// ── Calendars ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CalendarDto {
    name: String,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    country_code: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
}

/// `POST /admin/holidays/calendars` - a list this organisation keeps for itself
/// (closure days, a site's own calendar).
pub async fn create_calendar(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<CalendarDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;
    let name = dto.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Le nom du calendrier est vide".into()));
    }

    let code = match dto.code.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(code) => code.to_uppercase(),
        None => {
            let slug: String = name
                .to_uppercase()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect();
            let slug = slug.trim_matches('-').replace("--", "-");
            format!("LOCAL-{}", slug.chars().take(50).collect::<String>())
        }
    };
    if !code.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || "._-".contains(c)) {
        return Err(AppError::Validation(
            "Identifiant invalide : lettres majuscules, chiffres, point, tiret ou souligné".into(),
        ));
    }

    let country = match dto.country_code.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        None => None,
        Some(c) if c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()) => Some(c.to_uppercase()),
        Some(_) => return Err(AppError::Validation("Code pays invalide (ISO 3166-1 alpha-2)".into())),
    };

    let mut tx = audit.begin(&state.db).await?;
    // The primary key is generated in Rust (no `RETURNING`, which MySQL lacks).
    let id = new_id();
    tx.execute(
        r#"INSERT INTO core.holiday_calendars (id, code, country_code, name, is_builtin, enabled, created_by)
           VALUES ($1, $2, $3, $4, FALSE, $5, $6)"#,
        params![
            id,
            &code,
            country.clone(),
            name,
            dto.enabled.unwrap_or(true),
            audit.admin.id,
        ],
    )
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db) = &e {
            if db.constraint().is_some() {
                return AppError::Conflict(format!("Un calendrier « {code} » existe déjà."));
            }
        }
        tracing::error!(error = %e, "holidays: creating a calendar");
        AppError::Database(e)
    })?;

    tx.commit(
        AuditEntry::new("core.holiday_calendars.create")
            .target(target::HOLIDAY_CALENDAR, id, name.to_string())
            .after(json!({ "id": id, "code": code, "name": name, "country_code": country }))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "id": id, "code": code })))
}

#[derive(Debug, Deserialize)]
pub struct CalendarPatchDto {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
}

/// `PATCH /admin/holidays/calendars/:id`
pub async fn update_calendar(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<CalendarPatchDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;
    let name = match dto.name.as_deref().map(str::trim) {
        Some("") => return Err(AppError::Validation("Le nom du calendrier est vide".into())),
        other => other.map(str::to_string),
    };

    let mut tx = audit.begin(&state.db).await?;
    // Renaming detaches the wording from the dataset; switching the calendar off
    // does not. The `is_overridden` flip therefore rides on whether a new name
    // was supplied - decided in Rust, so the statement needs no NULL-typed cast.
    let override_clause = if name.is_some() {
        ", is_overridden = CASE WHEN is_builtin THEN TRUE ELSE is_overridden END"
    } else {
        ""
    };
    let sql = format!(
        "UPDATE core.holiday_calendars \
            SET name = COALESCE($2, name), enabled = COALESCE($3, enabled){override_clause} \
          WHERE id = $1"
    );
    tx.execute(&sql, params![id, name.as_deref(), dto.enabled])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "holidays: modifying a calendar");
            AppError::Database(e)
        })?;

    // No portable `RETURNING`: read the resulting name/enabled back by id.
    let row = tx
        .fetch_optional_row(
            "SELECT name, enabled FROM core.holiday_calendars WHERE id = $1",
            params![id],
        )
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound("Calendrier introuvable".into()))?;

    let final_name: String = row.try_get("name")?;
    let final_enabled: bool = row.try_get("enabled")?;
    tx.commit(
        AuditEntry::new("core.holiday_calendars.update")
            .target(target::HOLIDAY_CALENDAR, id, final_name.clone())
            .after(json!({ "name": final_name, "enabled": final_enabled })),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

/// `DELETE /admin/holidays/calendars/:id` - only what this instance created.
pub async fn delete_calendar(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;

    let mut tx = audit.begin(&state.db).await?;
    let for_update = tx.backend().for_update();
    let row = tx
        .fetch_optional_row(
            &format!(
                "SELECT name, code, is_builtin FROM core.holiday_calendars WHERE id = $1{}",
                for_update
            ),
            params![id],
        )
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound("Calendrier introuvable".into()))?;

    if row.try_get::<bool>("is_builtin")? {
        return Err(AppError::Validation(
            "Ce calendrier fait partie du référentiel livré : désactivez-le plutôt que de le supprimer.".into(),
        ));
    }
    let name: String = row.try_get("name")?;
    let code: String = row.try_get("code")?;

    tx.execute("DELETE FROM core.holiday_calendars WHERE id = $1", params![id])
        .await
        .map_err(AppError::Database)?;

    tx.commit(
        AuditEntry::new("core.holiday_calendars.delete")
            .target(target::HOLIDAY_CALENDAR, id, name.clone())
            .before(json!({ "id": id, "name": name, "code": code })),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct ExclusionsDto {
    /// Keys of the parent's days this calendar does not observe. The whole set,
    /// not a delta: a partial write is how two administrators editing the same
    /// region silently undo each other.
    keys: Vec<String>,
}

/// `PUT /admin/holidays/calendars/:id/exclusions`
pub async fn set_exclusions(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<ExclusionsDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;
    let calendar = store::calendar(&state.db, id).await?;
    if calendar.parent_id.is_none() {
        return Err(AppError::Validation(
            "Seul un calendrier régional peut retirer une journée : il n'hérite de rien ici.".into(),
        ));
    }

    let mut tx = audit.begin(&state.db).await?;
    tx.execute(
        "DELETE FROM core.holiday_exclusions WHERE calendar_id = $1",
        params![id],
    )
    .await
    .map_err(AppError::Database)?;
    let conflict = tx.backend().on_conflict_do_nothing(&["calendar_id", "key"]);
    let insert_sql =
        format!("INSERT INTO core.holiday_exclusions (calendar_id, \"key\") VALUES ($1, $2){conflict}");
    for key in &dto.keys {
        tx.execute(&insert_sql, params![id, key])
            .await
            .map_err(AppError::Database)?;
    }

    tx.commit(
        AuditEntry::new("core.holiday_calendars.update")
            .target(target::HOLIDAY_CALENDAR, id, calendar.name.clone())
            .after(json!({ "exclusions": dto.keys })),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

// ── The organisational-unit overlay ──────────────────────────────────────────

/// One row of a unit's holiday overlay.
#[derive(sqlx::FromRow)]
struct UnitOverlayRow {
    id:                    Uuid,
    calendar_id:           Option<Uuid>,
    holiday_id:            Option<Uuid>,
    enabled:               bool,
    calendar_code:         Option<String>,
    calendar_name:         Option<String>,
    holiday_name:          Option<String>,
    holiday_calendar_code: Option<String>,
}

/// `GET /admin/holidays/units/:unit_id`
pub async fn unit_overlay(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(unit_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_READ)?;

    let rows = state
        .db
        .fetch_all_as::<UnitOverlayRow>(
            r#"SELECT p.id, p.calendar_id, p.holiday_id, p.enabled, p.org_unit_id,
                      u.name AS unit_name,
                      c.code AS calendar_code, c.name AS calendar_name,
                      h.name AS holiday_name, hc.code AS holiday_calendar_code
                 FROM core.holiday_unit_prefs p
                 JOIN core.org_units u ON u.id = p.org_unit_id
                 LEFT JOIN core.holiday_calendars c ON c.id = p.calendar_id
                 LEFT JOIN core.holidays h ON h.id = p.holiday_id
                 LEFT JOIN core.holiday_calendars hc ON hc.id = h.calendar_id
                WHERE p.org_unit_id = $1
                ORDER BY (c.name IS NULL), c.name, h.name"#,
            params![unit_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "holidays: reading the unit overlay");
            AppError::Database(e)
        })?;

    let prefs: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id":           row.id,
                "calendar_id":  row.calendar_id,
                "holiday_id":   row.holiday_id,
                "enabled":      row.enabled,
                "calendar_code": row.calendar_code,
                "calendar_name": row.calendar_name,
                "holiday_name":  row.holiday_name,
                "holiday_calendar_code": row.holiday_calendar_code,
            })
        })
        .collect();

    Ok(Json(json!({ "prefs": prefs })))
}

#[derive(Debug, Deserialize)]
pub struct UnitPrefDto {
    #[serde(default)]
    calendar_id: Option<Uuid>,
    #[serde(default)]
    holiday_id: Option<Uuid>,
    /// `null` clears the adjustment - the unit goes back to inheriting, which is
    /// a *deletion* and never a stored copy of what it was inheriting.
    #[serde(default)]
    enabled: Option<bool>,
}

/// `PUT /admin/holidays/units/:unit_id`
pub async fn set_unit_pref(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(unit_id): Path<Uuid>,
    Json(dto): Json<UnitPrefDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;
    if dto.calendar_id.is_some() == dto.holiday_id.is_some() {
        return Err(AppError::Validation(
            "Indiquez soit un calendrier, soit une journée.".into(),
        ));
    }

    let mut tx = audit.begin(&state.db).await?;
    match dto.enabled {
        None => {
            // NOTE (multi-engine): `IS NOT DISTINCT FROM` is a null-safe equality
            // PostgreSQL supports directly; MySQL spells it `<=>` and SQLite `IS`.
            // Kept PostgreSQL-shaped for now - flagged for the dialect layer.
            tx.execute(
                "DELETE FROM core.holiday_unit_prefs \
                  WHERE org_unit_id = $1 \
                    AND calendar_id IS NOT DISTINCT FROM $2 \
                    AND holiday_id  IS NOT DISTINCT FROM $3",
                params![unit_id, dto.calendar_id, dto.holiday_id],
            )
            .await
            .map_err(AppError::Database)?;
        }
        Some(enabled) => {
            // The primary key is generated in Rust (no reliance on a DB default).
            let id = new_id();
            // Two partial unique indexes, so the conflict target depends on
            // which of the two is set.
            //
            // NOTE (multi-engine): the `ON CONFLICT (...) WHERE ...` inference
            // predicate is PostgreSQL-only (a partial unique index cannot be
            // named through `Backend::upsert`, which emits no predicate). Kept
            // PostgreSQL-shaped for now - flagged for the dialect layer.
            let statement = if dto.calendar_id.is_some() {
                r#"INSERT INTO core.holiday_unit_prefs (id, org_unit_id, calendar_id, holiday_id, enabled, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6)
                   ON CONFLICT (org_unit_id, calendar_id) WHERE calendar_id IS NOT NULL
                   DO UPDATE SET enabled = EXCLUDED.enabled"#
            } else {
                r#"INSERT INTO core.holiday_unit_prefs (id, org_unit_id, calendar_id, holiday_id, enabled, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6)
                   ON CONFLICT (org_unit_id, holiday_id) WHERE holiday_id IS NOT NULL
                   DO UPDATE SET enabled = EXCLUDED.enabled"#
            };
            tx.execute(
                statement,
                params![
                    id,
                    unit_id,
                    dto.calendar_id,
                    dto.holiday_id,
                    enabled,
                    audit.admin.id,
                ],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "holidays: writing the unit overlay");
                AppError::Database(e)
            })?;
        }
    }

    tx.commit(
        AuditEntry::new("core.holidays.update")
            .target(target::ORG_UNIT, unit_id, "unité organisationnelle".to_string())
            .after(json!({
                "calendar_id": dto.calendar_id, "holiday_id": dto.holiday_id, "enabled": dto.enabled,
            }))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

// ── Tools ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PreviewDto {
    kind: String,
    rule: Value,
    #[serde(default)]
    observance: Option<String>,
    #[serde(default)]
    years: Option<Vec<i32>>,
}

/// `POST /admin/holidays/preview` - the dates a rule being written produces.
///
/// The editor calls this on every change: it is what turns "Easter plus 39" from
/// a form into a date somebody can recognise, before saving anything.
pub async fn preview(
    _admin: AdminUser,
    ctx: AdminCtx,
    Json(dto): Json<PreviewDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_READ)?;
    let rule = Rule::from_parts(&dto.kind, &dto.rule)?;
    let observance = Observance::parse(dto.observance.as_deref().unwrap_or("none"))?;

    let current = current_year();
    let years = match dto.years {
        Some(years) if !years.is_empty() => years.into_iter().take(10).collect::<Vec<_>>(),
        _ => (current..current + 3).collect(),
    };

    let dates: Vec<Value> = years
        .into_iter()
        .flat_map(|year| {
            rules::preview(&rule, observance, year)
                .into_iter()
                .map(move |e| json!({ "year": year, "date": e.date, "observed_from": e.observed_from }))
        })
        .collect();

    Ok(Json(json!({ "dates": dates })))
}

/// `POST /admin/holidays/reload` - re-apply the shipped dataset now.
///
/// Forced: it rewrites every row that is not overridden, which is how an
/// administrator brings back days they deleted before understanding that
/// disabling was the answer.
pub async fn reload(
    State(state): State<AppState>,
    _admin: AdminUser,
    audit: AdminAudit,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::HOLIDAYS_MANAGE)?;
    let report = seed::load(&state.db, true).await?;

    audit
        .record(
            &state.db,
            AuditEntry::new("core.holidays.reload")
                .after(json!(report)),
        )
        .await;

    Ok(Json(json!({ "report": report })))
}
