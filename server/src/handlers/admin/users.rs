use crate::{
    audit::{redact::target, snap, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    authz::{
        guards::{
            apply_legacy_role_change, ensure_can_act_on_user, ensure_superadmin_remains,
            user_org_unit,
        },
        keys, AdminCtx,
    },
    errors::AppError,
    models::user::User,
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use kubuno_db::dialect::SqlType;
use kubuno_db::{params, Backend, DbPool, DbRow, DbValue};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

/// Map a raw row (a `RETURNING`, a reselect, or a `SELECT * ... FOR UPDATE`) into
/// the full `User`. Used inside audited transactions, where `DbTx` cannot decode
/// structs directly, and in the per-id bulk loops that replace `= ANY(...)`.
fn user_from_row(row: &DbRow) -> Result<User, sqlx::Error> {
    Ok(User {
        id:                   row.try_get("id")?,
        email:                row.try_get("email")?,
        username:             row.try_get("username")?,
        password_hash:        row.try_get("password_hash")?,
        display_name:         row.try_get("display_name")?,
        first_name:           row.try_get("first_name")?,
        last_name:            row.try_get("last_name")?,
        avatar_url:           row.try_get("avatar_url")?,
        role:                 row.try_get("role")?,
        quota_bytes:          row.try_get("quota_bytes")?,
        used_bytes:           row.try_get("used_bytes")?,
        is_active:            row.try_get("is_active")?,
        email_verified:       row.try_get("email_verified")?,
        oauth_provider:       row.try_get("oauth_provider")?,
        oauth_id:             row.try_get("oauth_id")?,
        preferences:          row.try_get("preferences")?,
        org_unit_id:          row.try_get("org_unit_id")?,
        name_pronunciation:   row.try_get("name_pronunciation")?,
        pronouns:             row.try_get("pronouns")?,
        work_location:        row.try_get("work_location")?,
        introduction:         row.try_get("introduction")?,
        gender:               row.try_get("gender")?,
        birthday:             row.try_get("birthday")?,
        created_at:           row.try_get("created_at")?,
        updated_at:           row.try_get("updated_at")?,
        last_login_at:        row.try_get("last_login_at")?,
        password_changed_at:  row.try_get("password_changed_at")?,
        totp_enabled:         row.try_get("totp_enabled")?,
        must_change_password: row.try_get("must_change_password")?,
        admin_2fa_grace_until: row.try_get("admin_2fa_grace_until")?,
        totp_secret:          row.try_get("totp_secret")?,
        totp_pending_secret:  row.try_get("totp_pending_secret")?,
        ldap_directory_id:    row.try_get("ldap_directory_id")?,
        ldap_dn:              row.try_get("ldap_dn")?,
        ldap_uid:             row.try_get("ldap_uid")?,
        ldap_synced_at:       row.try_get("ldap_synced_at")?,
    })
}

/// Label shown in the trail for a user target: readable without a join, and
/// still meaningful once the account is gone.
fn user_label(user: &User) -> String {
    match user.display_name.as_deref() {
        Some(name) if !name.is_empty() => format!("{name} <{}>", user.email),
        _ => format!("{} <{}>", user.username, user.email),
    }
}

#[derive(Deserialize)]
pub struct ListUsersQuery {
    pub limit:  Option<i64>,
    pub offset: Option<i64>,
    pub search: Option<String>,
    pub role:   Option<String>,
    /// Confine the listing to one organisational unit.
    pub org_unit_id: Option<Uuid>,
    /// Confine the listing to SEVERAL units at once, comma-separated.
    ///
    /// The console lets an operator hold two branches at the same time - looking
    /// at "Sales" and "Marketing" together - and every downstream operation (the
    /// count, the bulk bar, the export) must describe that same union, not one
    /// unit of it. Merged with `org_unit_id`, which stays for the single-unit
    /// callers that predate this.
    ///
    /// A comma-separated string rather than a repeated parameter: `Query` maps a
    /// flat pair list, so `?u=a&u=b` would silently keep only the last one.
    pub org_unit_ids: Option<String>,
    /// Column to order by, from a fixed list (`sort_clause`); anything else falls
    /// back to the default. `dir` is `asc` or `desc`.
    pub sort: Option<String>,
    pub dir:  Option<String>,
    /// Export only: the columns to write, comma-separated, from `EXPORT_COLUMNS`.
    /// Empty or absent writes them all. Ignored by the listing.
    pub columns: Option<String>,
    /// With `org_unit_id`: include the accounts of the whole subtree, not just
    /// the ones sitting directly in that unit. Looking at "Support" and being
    /// told it holds nobody, while its three sub-units hold everyone, is the
    /// answer an operator reads as a bug.
    pub include_descendants: Option<bool>,
    /// Also return the number of accounts per unit (`org_unit_counts`).
    ///
    /// Opt-in rather than always: the unit manager is the only caller that needs
    /// the aggregate, and the accounts list is fetched on every keystroke of its
    /// search box.
    pub counts: Option<bool>,
}

/// Builds the shared listing predicate (search, role, scope, unit filter) as an
/// SQL fragment plus its ordered binds, numbered from `$1`.
///
/// One builder for the listing, its count and the export, so they describe the
/// *same* set: a total computed on a wider predicate reports pages the listing
/// cannot show, and the operator reads it as accounts being hidden from them.
///
/// `scope_units = None` means "no restriction" (instance scope or superuser); an
/// **empty** slice means "nothing" (`IN (NULL)` matches no row), the right answer
/// for a caller who does not hold `core.users.read` at all. The array `= ANY(...)`
/// membership tests of the old PostgreSQL statement become portable `IN (...)`
/// lists; only the descendants expansion keeps a PostgreSQL set-returning
/// function (`core.org_unit_descendants`) - see the report.
fn build_user_filter(
    backend: Backend,
    search: Option<&str>,
    role: Option<&str>,
    scope_units: Option<&[Uuid]>,
    units: Option<&[Uuid]>,
    descendants: bool,
) -> (String, Vec<DbValue>) {
    let mut binds: Vec<DbValue> = Vec::new();
    let mut clauses: Vec<String> = vec!["TRUE".to_string()];

    if let Some(s) = search {
        let like = format!("%{s}%");
        let n = binds.len() + 1;
        binds.push(like.clone().into());
        binds.push(like.clone().into());
        binds.push(like.into());
        clauses.push(format!(
            "({} OR {} OR {})",
            backend.ilike("email", n),
            backend.ilike("username", n + 1),
            backend.ilike("display_name", n + 2),
        ));
    }

    if let Some(r) = role {
        let n = binds.len() + 1;
        binds.push(r.to_string().into());
        clauses.push(format!("role = ${n}"));
    }

    if let Some(scope) = scope_units {
        let start = binds.len() + 1;
        for u in scope {
            binds.push((*u).into());
        }
        clauses.push(format!(
            "(org_unit_id IS NOT NULL AND org_unit_id IN ({}))",
            backend.in_list(start, scope.len()),
        ));
    }

    if let Some(us) = units {
        let start = binds.len() + 1;
        for u in us {
            binds.push((*u).into());
        }
        let direct = format!("org_unit_id IN ({})", backend.in_list(start, us.len()));
        if descendants {
            let dstart = binds.len() + 1;
            for u in us {
                binds.push((*u).into());
            }
            // Portable multi-root subtree walk (see `database::compat`) instead
            // of the PostgreSQL `VALUES ... , core.org_unit_descendants(sel.id)`
            // lateral join. The walk already includes each root at depth 0, so
            // `direct` is kept only for readability of the filter.
            let subtree = crate::database::compat::org_unit_descendants_many(dstart, us.len());
            clauses.push(format!(
                "({direct} OR org_unit_id IN (SELECT d.id FROM {subtree} d))"
            ));
        } else {
            clauses.push(direct);
        }
    }

    (clauses.join(" AND "), binds)
}

/// Ordering, chosen from a CLOSED list.
///
/// The fragment is interpolated into the statement, so it must never carry
/// caller text: an unknown name falls back to the default instead of being
/// passed through. `id` breaks ties - without it two rows that compare equal can
/// swap between pages and an account is seen twice, or not at all.
/// `NULLS LAST` in both directions: "never signed in" is an absence, and it
/// belongs at the end whichever way the column is read.
fn sort_clause(sort: Option<&str>, dir: Option<&str>) -> String {
    let Some(sort) = sort else {
        return "ORDER BY created_at DESC, id ASC".into();
    };
    let column = match sort {
        "name"       => "lower(coalesce(nullif(display_name, ''), username))",
        "email"      => "lower(email)",
        "role"       => "role",
        "status"     => "is_active",
        "quota"      => "used_bytes",
        "last_login" => "last_login_at",
        "created"    => "created_at",
        "unit"       => "(SELECT lower(o.name) FROM core.org_units o WHERE o.id = org_unit_id)",
        _            => return "ORDER BY created_at DESC, id ASC".into(),
    };
    let direction = if dir == Some("desc") { "DESC" } else { "ASC" };
    // `NULLS LAST` is PostgreSQL-only; `({column} IS NULL)` first sends absences
    // to the end on the three engines, whichever way the column is read.
    format!("ORDER BY ({column} IS NULL), {column} {direction}, id ASC")
}

/// The units the caller asked to look at, single and multi-select merged.
fn requested_units(q: &ListUsersQuery) -> Option<Vec<Uuid>> {
    let mut units: Vec<Uuid> = q.org_unit_id.into_iter().collect();
    if let Some(raw) = q.org_unit_ids.as_deref() {
        // A malformed id is dropped rather than failing the listing: it can only
        // widen the perimeter, never leak past `scope_units` (the predicate that
        // actually confines a delegated administrator).
        units.extend(raw.split(',').filter_map(|s| Uuid::parse_str(s.trim()).ok()));
    }
    units.sort_unstable();
    units.dedup();
    (!units.is_empty()).then_some(units)
}

/// `GET /admin/users` - **confined to the caller's organisational subtree**.
///
/// Before delegation existed this listing filtered nothing at all, which was
/// harmless when the only administrator was an instance administrator. It stops
/// being harmless the moment a role can be scoped: without the subtree filter a
/// delegated administrator enumerates the whole directory - every address, every
/// name - which is most of the value of the directory to an attacker.
///
/// `scope_units = NULL` means "no restriction" (instance scope or superuser); an
/// **empty** array means "nothing", which is the right answer for a caller who
/// does not hold `core.users.read` at all.
pub async fn list_users(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Query(q): Query<ListUsersQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::USERS_READ)?;

    let limit  = q.limit.unwrap_or(50).clamp(0, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let scope_units = ctx.subtree_filter(keys::USERS_READ);
    let units = requested_units(&q);
    let descendants = q.include_descendants.unwrap_or(false);
    let order = sort_clause(q.sort.as_deref(), q.dir.as_deref());
    let backend = state.db.backend();

    // `order` comes from `sort_clause`, a closed allow-list that falls back to
    // the default for any name it does not know - no caller text reaches the
    // statement. Search, role, units and paging all travel as bind parameters.
    let (where_sql, mut binds) = build_user_filter(
        backend,
        q.search.as_deref(),
        q.role.as_deref(),
        scope_units.as_deref(),
        units.as_deref(),
        descendants,
    );
    let limit_n = binds.len() + 1;
    binds.push(limit.into());
    let offset_n = binds.len() + 1;
    binds.push(offset.into());
    let list_sql =
        format!("SELECT * FROM core.users WHERE {where_sql} {order} LIMIT ${limit_n} OFFSET ${offset_n}");
    let users = state
        .db
        .fetch_all_as::<User>(&list_sql, binds)
        .await
        .map_err(|e| { tracing::error!(error = %e, "list_users"); AppError::Database(e) })?;

    // The total must obey the same perimeter - and the same filters - or the
    // pagination tells the caller how many accounts they are not allowed to see,
    // and offers pages that come back empty.
    let (count_where, count_binds) = build_user_filter(
        backend,
        q.search.as_deref(),
        q.role.as_deref(),
        scope_units.as_deref(),
        units.as_deref(),
        descendants,
    );
    let count_sql = format!(
        "SELECT {} FROM core.users WHERE {count_where}",
        backend.count_bigint("*")
    );
    let total: i64 = state
        .db
        .fetch_scalar::<i64>(&count_sql, count_binds)
        .await
        .map_err(|e| { tracing::error!(error = %e, "list_users: total"); AppError::Database(e) })?;

    let mut body = json!({ "users": users, "total": total, "limit": limit, "offset": offset });

    // Accounts per unit - the "own" count only; a subtree total is a sum over a
    // tree the caller already holds, and computing it here would be one
    // recursive query per unit for an answer the console can add up itself.
    // Deliberately NOT narrowed by the search/role/unit filters: this describes
    // the directory, not the current page.
    if q.counts.unwrap_or(false) {
        let mut counts_binds: Vec<DbValue> = Vec::new();
        let mut counts_sql = format!(
            "SELECT org_unit_id, {} FROM core.users WHERE org_unit_id IS NOT NULL",
            backend.count_bigint("*")
        );
        if let Some(scope) = scope_units.as_deref() {
            counts_sql.push_str(&format!(
                " AND org_unit_id IN ({})",
                backend.in_list(1, scope.len())
            ));
            for u in scope {
                counts_binds.push((*u).into());
            }
        }
        counts_sql.push_str(" GROUP BY org_unit_id");

        let counts: Vec<(Uuid, i64)> = state
            .db
            .fetch_all_as::<(Uuid, i64)>(&counts_sql, counts_binds)
            .await
            .map_err(|e| { tracing::error!(error = %e, "list_users: org_unit_counts"); AppError::Database(e) })?;

        body["org_unit_counts"] = json!(counts
            .into_iter()
            .map(|(id, count)| json!({ "org_unit_id": id, "count": count }))
            .collect::<Vec<_>>());
    }

    Ok(Json(body))
}

/// Ceiling on one export. Past this the answer is a refusal, not a truncated
/// file: a spreadsheet that silently stops at row N is read as the whole
/// directory, and acted on as if it were.
const EXPORT_MAX: i64 = 50_000;

/// The columns an export may carry: `(id, header)`.
///
/// A CLOSED list, and deliberately NARROWER than the administration sheet.
/// `gender` and `birthday` are personal data that the directory never
/// discloses and that the audit trail deliberately does not carry (see
/// `models::user::User`); a sheet shows them to one administrator who opened one
/// account, whereas a spreadsheet copies them onto every machine the file is
/// forwarded to. They are not exportable, and adding them here would quietly
/// undo that decision. Password material is absent for the same reason, one
/// degree stronger.
const EXPORT_COLUMNS: &[(&str, &str)] = &[
    ("email",          "email"),
    ("username",       "nom_utilisateur"),
    ("display_name",   "nom_affiche"),
    ("first_name",     "prenom"),
    ("last_name",      "nom"),
    ("role",           "role"),
    ("status",         "statut"),
    ("email_verified", "email_verifie"),
    ("org_unit",       "unite_organisationnelle"),
    ("quota_bytes",    "quota_octets"),
    ("used_bytes",     "utilise_octets"),
    ("totp_enabled",   "double_authentification"),
    ("created_at",     "date_creation"),
    ("last_login_at",  "derniere_connexion"),
    ("id",             "identifiant"),
];

/// `GET /admin/users/export` - the listing, exactly as filtered, as a CSV file.
///
/// It takes the SAME parameters as `list_users` - search, role, units, subtree,
/// ordering - because the file has to be the list the operator is looking at. An
/// export computed on a different perimeter is the one mistake this endpoint can
/// make that nobody notices until the file has been sent on.
///
/// The export is itself audited: reading out the whole directory is an act worth
/// recording, the same way the audit trail records its own export.
pub async fn export_users(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    audit: AdminAudit,
    Query(q): Query<ListUsersQuery>,
) -> Result<axum::response::Response, AppError> {
    use axum::response::IntoResponse;

    ctx.require(keys::USERS_READ)?;

    let scope_units = ctx.subtree_filter(keys::USERS_READ);
    let units = requested_units(&q);
    let descendants = q.include_descendants.unwrap_or(false);
    let order = sort_clause(q.sort.as_deref(), q.dir.as_deref());
    let backend = state.db.backend();

    // One more than the ceiling, so "too many" is distinguishable from "exactly
    // the ceiling" without a second COUNT. Same predicate as the listing.
    let (where_sql, mut binds) = build_user_filter(
        backend,
        q.search.as_deref(),
        q.role.as_deref(),
        scope_units.as_deref(),
        units.as_deref(),
        descendants,
    );
    let limit_n = binds.len() + 1;
    binds.push((EXPORT_MAX + 1).into());
    let export_sql = format!("SELECT * FROM core.users WHERE {where_sql} {order} LIMIT ${limit_n}");
    let users = state
        .db
        .fetch_all_as::<User>(&export_sql, binds)
        .await
        .map_err(|e| { tracing::error!(error = %e, "export_users"); AppError::Database(e) })?;

    if users.len() as i64 > EXPORT_MAX {
        return Err(AppError::Validation(format!(
            "Too many accounts for one export (maximum {EXPORT_MAX}). Narrow the search or unit"
        )));
    }

    // Unit names in one query: the alternative is a join on a listing that
    // already carries its own perimeter, or one lookup per row.
    let unit_names: std::collections::HashMap<Uuid, String> = state
        .db
        .fetch_all_as::<(Uuid, String)>("SELECT id, name FROM core.org_units", params![])
        .await
        .map_err(|e| { tracing::error!(error = %e, "export_users: unités"); AppError::Database(e) })?
        .into_iter()
        .collect();

    // Requested columns, in the CLOSED list's own order so the file's shape does
    // not depend on the order the console happened to send them in.
    let asked: Option<Vec<&str>> = q.columns.as_deref().map(|c| c.split(',').map(str::trim).collect());
    let chosen: Vec<&(&str, &str)> = EXPORT_COLUMNS
        .iter()
        .filter(|(id, _)| asked.as_ref().is_none_or(|a| a.contains(id)))
        .collect();
    let chosen = if chosen.is_empty() { EXPORT_COLUMNS.iter().collect() } else { chosen };

    let cell = |user: &User, id: &str| -> String {
        match id {
            "email"          => user.email.clone(),
            "username"       => user.username.clone(),
            "display_name"   => user.display_name.clone().unwrap_or_default(),
            "first_name"     => user.first_name.clone().unwrap_or_default(),
            "last_name"      => user.last_name.clone().unwrap_or_default(),
            "role"           => user.role.clone(),
            "status"         => if user.is_active { "actif" } else { "inactif" }.into(),
            "email_verified" => if user.email_verified { "oui" } else { "non" }.into(),
            "org_unit"       => user.org_unit_id.and_then(|u| unit_names.get(&u).cloned()).unwrap_or_default(),
            "quota_bytes"    => user.quota_bytes.to_string(),
            "used_bytes"     => user.used_bytes.to_string(),
            "totp_enabled"   => if user.totp_enabled { "oui" } else { "non" }.into(),
            "created_at"     => user.created_at.to_rfc3339(),
            "last_login_at"  => user.last_login_at.map(|d| d.to_rfc3339()).unwrap_or_default(),
            "id"             => user.id.to_string(),
            _                => String::new(),
        }
    };

    // A UTF-8 BOM: without it a spreadsheet opened on Windows reads the accents
    // of a French directory as mojibake, and the operator blames the export.
    let mut csv = String::from("\u{feff}");
    csv.push_str(
        &chosen.iter().map(|(_, h)| (*h).to_string()).collect::<Vec<_>>().join(","),
    );
    csv.push('\n');
    for user in &users {
        let line = chosen
            .iter()
            .map(|(id, _)| crate::audit::query::csv_field(&cell(user, id)))
            .collect::<Vec<_>>()
            .join(",");
        csv.push_str(&line);
        csv.push('\n');
    }

    audit
        .record(
            &state.db,
            AuditEntry::new("core.users.export")
                .module("core")
                .target_kind("users", "Annuaire des comptes")
                .after(json!({
                    "count":        users.len(),
                    "search":       q.search,
                    "role":         q.role,
                    "org_units":    units,
                    "descendants":  descendants,
                    "columns":      chosen.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
                }))
                .detail(format!("{} compte(s) exporté(s) en CSV", users.len())),
        )
        .await;

    let filename = format!(
        "kubuno-utilisateurs-{}.csv",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );

    Ok((
        StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        csv,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct CreateUserAdminDto {
    pub email:        String,
    pub username:     String,
    pub password:     String,
    pub role:         Option<String>,
    pub display_name: Option<String>,
    pub quota_bytes:  Option<i64>,
    /// Unit the account is created in. A delegated administrator must name one
    /// inside their own subtree - an account created outside the tree would be
    /// invisible to every scoped listing, including their own.
    pub org_unit_id:  Option<Uuid>,
}

pub async fn create_user(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Json(dto): Json<CreateUserAdminDto>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    ctx.require_for_unit(keys::USERS_CREATE, dto.org_unit_id)?;

    // Creating an administrator is granting super-administration; it goes
    // through the assignment path below, and only a superuser may take it.
    if dto.role.as_deref() == Some("admin") {
        ctx.require_superuser("création d'un administrateur")?;
    }

    let exists: bool = state
        .db
        .fetch_scalar::<bool>(
            "SELECT EXISTS(SELECT 1 FROM core.users WHERE email = $1 OR username = $2)",
            params![&dto.email, &dto.username],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "create_user: unicité"); AppError::Database(e) })?;

    if exists {
        return Err(AppError::Conflict("Email or username already in use".into()));
    }

    // No unit named means the root, resolved here rather than left to the
    // PostgreSQL-only trigger: MySQL/MariaDB and SQLite refuse a NULL unit.
    let org_unit_id =
        crate::database::seed::unit_for_new_account(&state.db, dto.org_unit_id).await;

    // The password policy of the unit the account is being created in
    // (migration `000115`). An administrator is not exempt from the policy they
    // set: an account handed out below the instance's own minimum would be a
    // permanent exception nobody would ever notice again.
    let policy = crate::settings::password_policy::PasswordPolicy::for_new_account(
        &state.db,
        org_unit_id,
    )
    .await?;
    policy.check(&dto.password)?;

    let hash = crate::crypto::password::hash_password(&dto.password)
        .map_err(AppError::Internal)?;

    let role = dto.role.as_deref().unwrap_or("user");
    // No explicit quota means "apply the policy", and the policy is resolved for
    // the unit the account lands in - not the instance value. An administrator
    // who gave Marketing 50 GiB expects an account created there to get 50 GiB.
    let quota = match dto.quota_bytes {
        Some(explicit) => explicit,
        None => crate::models::user::default_quota_for(&state.db, org_unit_id).await,
    };

    // Audited transaction: the account and its trail entry commit together, so
    // no user can appear without a record of who created it.
    let mut tx = audit.begin(&state.db).await?;

    // The key is generated in Rust rather than by the database: MySQL and SQLite
    // have no `RETURNING`, so a process-side id is the only portable way to know
    // the row's identity for the reselect and the audit target.
    let user_id = kubuno_db::new_id();
    let now = chrono::Utc::now();
    let raw = kubuno_db::returning::insert_returning_row(
        &mut tx,
        r#"INSERT INTO core.users (id, email, username, password_hash, display_name, role, quota_bytes,
                                   org_unit_id, password_changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"#,
        params![
            user_id,
            &dto.email,
            &dto.username,
            &hash,
            dto.display_name.as_deref(),
            role,
            quota,
            org_unit_id,
            now
        ],
        "*",
        &kubuno_db::returning::reselect_by_id("core.users", "*"),
        params![user_id],
    )
    .await
    .map_err(|e| { tracing::error!(error = %e, "create_user: insertion"); AppError::Database(e) })?;
    let user = user_from_row(&raw).map_err(AppError::Database)?;

    // The password the account was handed enters the history straight away:
    // otherwise "no reuse" would let its owner change it once and set it back to
    // the one an administrator typed - the single password most likely to have
    // been written down or sent over a chat.
    crate::settings::password_policy::remember(&mut tx, user.id, &hash, policy.history_depth)
        .await?;

    // `role = 'admin'` on the legacy surface means "instance super-administrator";
    // materialise the assignment so the account is visible to the whole
    // delegation model - and to the "never remove the last one" guard.
    if role == "admin" {
        apply_legacy_role_change(&mut tx, user.id, "admin", ctx.user_id).await?;
    }

    tx.commit(
        AuditEntry::new("core.users.create")
            .target(target::USER, user.id, user_label(&user))
            // `after` only: the password hash is not part of the whitelist, so
            // the entry says a user was created without saying with what.
            .after(snap(target::USER, &user))
            .reversible(),
    )
    .await?;

    // `UserCreated` used to be published by public registration only, so an
    // account created by an administrator - the majority of them on a managed
    // instance - was invisible to every module that provisions on account
    // creation, and to the rule engine. Published after the commit, and logged:
    // `publish` alone reaches live subscribers but leaves nothing in
    // `core.event_log`, which is what a retrospective replay reads.
    state
        .events
        .publish_and_log(
            crate::events::AppEvent::UserCreated {
                user_id: user.id,
                email:   user.email.clone(),
            },
            &state.db,
        )
        .await;

    Ok((StatusCode::CREATED, Json(json!({ "user": user }))))
}

pub async fn get_user(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = state
        .db
        .fetch_optional_as::<User>("SELECT * FROM core.users WHERE id = $1", params![id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "get_user"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("User {id}")))?;

    // Read the row first, then check the perimeter against the unit it is
    // actually in: the alternative is a scoped WHERE clause that reports
    // "introuvable" and quietly turns every out-of-scope id into a probe for
    // whether the account exists.
    ctx.require_for_unit(keys::USERS_READ, user.org_unit_id)?;

    Ok(Json(json!({ "user": user })))
}

#[derive(Debug, Default, Deserialize)]
pub struct UpdateUserAdminDto {
    pub role:        Option<String>,
    pub quota_bytes: Option<i64>,
    pub is_active:   Option<bool>,
    pub display_name: Option<String>,
    pub org_unit_id: Option<Uuid>,

    // ── Profile fields of migration `000114` ────────────────────────────────
    //
    // Present here because the refusal a person reads when a switch is off says
    // the field "est géré par votre administrateur". If no administrative path
    // could write it, that sentence would be false and the switch would mean
    // "nobody may change this", which is not what the card offers.
    //
    // Same three-state shape as `PATCH /me`: absent leaves alone, `null` erases,
    // a value sets. Same bounds too - the DTO is normalised through
    // [`crate::models::user::UpdateUserDto::tidy_profile`] rather than
    // re-validated by hand, so the two paths cannot drift apart.
    #[serde(default, deserialize_with = "crate::models::user::double_option")]
    pub first_name:         Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::models::user::double_option")]
    pub last_name:          Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::models::user::double_option")]
    pub name_pronunciation: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::models::user::double_option")]
    pub pronouns:           Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::models::user::double_option")]
    pub work_location:      Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::models::user::double_option")]
    pub introduction:       Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::models::user::double_option")]
    pub gender:             Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::models::user::double_option")]
    pub birthday:           Option<Option<chrono::NaiveDate>>,
}

impl UpdateUserAdminDto {
    /// Borrows the profile half into the shape `tidy_profile` knows, normalises
    /// it, and takes the cleaned values back. One set of rules, one set of
    /// messages, whoever is writing.
    fn tidy_profile(&mut self, today: chrono::NaiveDate) -> Result<(), AppError> {
        let mut shared = crate::models::user::UpdateUserDto {
            first_name:         self.first_name.take(),
            last_name:          self.last_name.take(),
            name_pronunciation: self.name_pronunciation.take(),
            pronouns:           self.pronouns.take(),
            work_location:      self.work_location.take(),
            introduction:       self.introduction.take(),
            gender:             self.gender.take(),
            birthday:           self.birthday.take(),
            ..Default::default()
        };
        let outcome = shared.tidy_profile(today);

        self.first_name         = shared.first_name;
        self.last_name          = shared.last_name;
        self.name_pronunciation = shared.name_pronunciation;
        self.pronouns           = shared.pronouns;
        self.work_location      = shared.work_location;
        self.introduction       = shared.introduction;
        self.gender             = shared.gender;
        self.birthday           = shared.birthday;

        outcome.map_err(AppError::Validation)
    }

    /// Names of the profile fields this request carries. Used for the audit
    /// entry's `detail`, because the trail's whitelist (`audit::redact`)
    /// deliberately does not list these columns: without the sentence, a
    /// profile-only edit would appear in the trail as an entry with an empty
    /// diff and nobody could tell what had moved. **Names only, never values.**
    fn profile_fields_present(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.first_name.is_some() { names.push("first_name"); }
        if self.last_name.is_some() { names.push("last_name"); }
        if self.name_pronunciation.is_some() { names.push("name_pronunciation"); }
        if self.pronouns.is_some() { names.push("pronouns"); }
        if self.work_location.is_some() { names.push("work_location"); }
        if self.introduction.is_some() { names.push("introduction"); }
        if self.gender.is_some() { names.push("gender"); }
        if self.birthday.is_some() { names.push("birthday"); }
        names
    }
}

/// Which of `core.users.{update,role,quota,activation}` best describes an edit.
///
/// Role, quota and activation changes get their own action names: they are the
/// three that carry privilege or capacity, and an operator filtering the trail
/// wants them without having to read every diff.
fn user_update_action(dto: &UpdateUserAdminDto) -> &'static str {
    if dto.role.is_some() {
        "core.users.role"
    } else if dto.is_active.is_some() {
        "core.users.activation"
    } else if dto.quota_bytes.is_some() {
        "core.users.quota"
    } else {
        "core.users.update"
    }
}

pub async fn update_user(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Path(id): Path<Uuid>,
    Json(mut dto): Json<UpdateUserAdminDto>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Promoting or demoting through this legacy field is granting or revoking
    // instance super-administration: superuser only, and it must go through the
    // assignment table so the model - and guard 4 - see it.
    if dto.role.is_some() {
        ctx.require_superuser("changement de rôle système")?;
    }

    // Before the transaction opens: a request carrying an impossible birthday
    // must cost neither a lock on the row nor an audit transaction.
    dto.tidy_profile(chrono::Utc::now().date_naive())?;
    let profile_touched = dto.profile_fields_present();

    let mut tx = audit.begin(&state.db).await?;

    // Read the previous state inside the transaction: the `before` snapshot is
    // then the exact row the UPDATE is about to overwrite, not one a concurrent
    // request may have changed in between.
    let for_update = tx.backend().for_update();
    let previous = tx
        .fetch_optional_row(
            &format!("SELECT * FROM core.users WHERE id = $1{for_update}"),
            params![id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "update_user: lecture"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("User {id}")))?;
    let previous = user_from_row(&previous).map_err(AppError::Database)?;

    // Perimeter: the unit the account is in today, and - when the edit moves it -
    // the unit it is going to. Checking only the first would let a delegated
    // administrator push accounts out of their own subtree.
    ctx.require_for_unit(keys::USERS_UPDATE, previous.org_unit_id)?;
    if let Some(new_unit) = dto.org_unit_id {
        if Some(new_unit) != previous.org_unit_id {
            ctx.require_for_unit(keys::USERS_UPDATE, Some(new_unit))?;
        }
    }
    if dto.is_active.is_some() {
        ctx.require_for_unit(keys::USER_SUSPENSION, previous.org_unit_id)?;
    }
    // Guard 3: never act on an account holding a role the caller does not hold.
    ensure_can_act_on_user(&state.db, &ctx, id).await?;

    // `is_active` feeds two placeholders ($3 for the COALESCE, $6 for the
    // `deleted_at` reset); the engine-agnostic layer numbers placeholders
    // strictly and never reuses one, so it is bound twice. `id` moves to the last
    // placeholder ($23) so every `$n` appears once, in increasing order.
    let raw = kubuno_db::returning::update_returning_row(
        &mut tx,
        r#"UPDATE core.users
           SET role        = COALESCE($1, role),
               quota_bytes = COALESCE($2, quota_bytes),
               is_active   = COALESCE($3, is_active),
               display_name = COALESCE($4, display_name),
               org_unit_id = COALESCE($5, org_unit_id),
               -- Reactivating an account cancels its pending destruction. The
               -- alternative - leaving the stamp - would let the purge job
               -- delete a live account weeks later because somebody had once
               -- deleted it and changed their mind.
               deleted_at  = CASE WHEN $6 IS TRUE THEN NULL ELSE deleted_at END,
               -- Three-state, exactly as on `PATCH /me`: the boolean says the
               -- request carried the field, so an explicit null erases it.
               first_name         = CASE WHEN $7  THEN $8  ELSE first_name END,
               last_name          = CASE WHEN $9  THEN $10 ELSE last_name END,
               name_pronunciation = CASE WHEN $11 THEN $12 ELSE name_pronunciation END,
               pronouns           = CASE WHEN $13 THEN $14 ELSE pronouns END,
               work_location      = CASE WHEN $15 THEN $16 ELSE work_location END,
               introduction       = CASE WHEN $17 THEN $18 ELSE introduction END,
               gender             = CASE WHEN $19 THEN $20 ELSE gender END,
               birthday           = CASE WHEN $21 THEN $22 ELSE birthday END
           WHERE id = $23"#,
        params![
            dto.role.as_deref(),
            dto.quota_bytes,
            dto.is_active,
            dto.display_name.as_deref(),
            dto.org_unit_id,
            dto.is_active,
            dto.first_name.is_some(),
            dto.first_name.clone().flatten(),
            dto.last_name.is_some(),
            dto.last_name.clone().flatten(),
            dto.name_pronunciation.is_some(),
            dto.name_pronunciation.clone().flatten(),
            dto.pronouns.is_some(),
            dto.pronouns.clone().flatten(),
            dto.work_location.is_some(),
            dto.work_location.clone().flatten(),
            dto.introduction.is_some(),
            dto.introduction.clone().flatten(),
            dto.gender.is_some(),
            dto.gender.clone().flatten(),
            dto.birthday.is_some(),
            dto.birthday.flatten(),
            id
        ],
        "*",
        &kubuno_db::returning::reselect_by_id("core.users", "*"),
        params![id],
    )
    .await
    .map_err(|e| { tracing::error!(error = %e, "update_user: écriture"); AppError::Database(e) })?
    .ok_or_else(|| AppError::NotFound(format!("User {id}")))?;
    let user = user_from_row(&raw).map_err(AppError::Database)?;

    // Keep the two representations of "is an administrator" in step, then check
    // the post-state: a demotion, or a deactivation, must never empty the
    // instance of super-administrators.
    if let Some(new_role) = dto.role.as_deref() {
        apply_legacy_role_change(&mut tx, id, new_role, ctx.user_id).await?;
    }
    if dto.role.is_some() || dto.is_active == Some(false) {
        ensure_superadmin_remains(&mut tx).await?;
    }

    let mut entry = AuditEntry::new(user_update_action(&dto))
        .target(target::USER, user.id, user_label(&user))
        .before(snap(target::USER, &previous))
        .after(snap(target::USER, &user))
        .reversible();

    // The personal columns are absent from the snapshot whitelist on purpose -
    // a gender must not be readable in a trail every administrator can export.
    // The sentence restores what the diff cannot say, without saying what was
    // written.
    if !profile_touched.is_empty() {
        entry = entry.detail(format!("champs de profil modifiés : {}", profile_touched.join(", ")));
    }

    tx.commit(entry).await?;

    Ok(Json(json!({ "user": user })))
}

#[derive(Deserialize)]
pub struct BulkOrgUnitDto {
    pub user_ids:    Vec<Uuid>,
    pub org_unit_id: Uuid,
}

/// Largest move accepted in one call. High enough for "select the page, move
/// it", low enough that the transaction below cannot hold a lock on the whole
/// directory while an operator's browser is thinking about it.
const BULK_MAX: usize = 500;

/// `POST /admin/users/bulk/org-unit` - move several accounts into one unit.
///
/// One transaction and **one** audit entry, rather than N calls to
/// `PATCH /admin/users/:id`. The difference is not performance: a bulk move that
/// fails halfway leaves the directory in a state nobody asked for, and a trail
/// that records it as forty unrelated edits does not let anyone answer "who
/// reorganised Support, and when". The entry says "N accounts moved to X" and
/// carries the list in its diff.
pub async fn bulk_set_org_unit(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Json(dto): Json<BulkOrgUnitDto>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Deduplicate before anything else: the same id twice would make the
    // "everything was found" check below fail on a request that is merely
    // redundant.
    let mut ids = dto.user_ids.clone();
    ids.sort_unstable();
    ids.dedup();

    if ids.is_empty() {
        return Err(AppError::Validation("No accounts selected".into()));
    }
    if ids.len() > BULK_MAX {
        return Err(AppError::Validation(format!(
            "Too many accounts at once (maximum {BULK_MAX})"
        )));
    }

    // The destination first: an operator who may not administer the target unit
    // must not be able to push accounts into it, even accounts they do own.
    ctx.require_for_unit(keys::USERS_UPDATE, Some(dto.org_unit_id))?;

    let mut tx = audit.begin(&state.db).await?;

    let unit_name: String = tx
        .fetch_optional_scalar::<String>(
            "SELECT name FROM core.org_units WHERE id = $1",
            params![dto.org_unit_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "bulk_set_org_unit: unité"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("Unit {}", dto.org_unit_id)))?;

    // Locked one row at a time, in the sorted id order, so two concurrent bulk
    // moves take the rows in the same order and queue instead of deadlocking.
    // The old single `WHERE id = ANY(...) ORDER BY id FOR UPDATE` had no portable
    // form (arrays exist only on PostgreSQL), so the loop reproduces its lock
    // ordering.
    let mut previous: Vec<User> = Vec::with_capacity(ids.len());
    let sql = format!("SELECT * FROM core.users WHERE id = $1{}", tx.backend().for_update());
    for uid in &ids {
        if let Some(row) = tx
            .fetch_optional_row(&sql, params![*uid])
            .await
            .map_err(|e| { tracing::error!(error = %e, "bulk_set_org_unit: lecture"); AppError::Database(e) })?
        {
            previous.push(user_from_row(&row).map_err(AppError::Database)?);
        }
    }

    if previous.len() != ids.len() {
        return Err(AppError::NotFound(format!(
            "{} account(s) not found",
            ids.len() - previous.len()
        )));
    }

    // Every source unit, and every target account, checked before a single row
    // is written: a partial move is exactly what the transaction is here to
    // prevent, so the refusal has to come first.
    for user in &previous {
        ctx.require_for_unit(keys::USERS_UPDATE, user.org_unit_id)?;
        ensure_can_act_on_user(&state.db, &ctx, user.id).await?;
    }

    let moving: Vec<Uuid> = previous
        .iter()
        .filter(|u| u.org_unit_id != Some(dto.org_unit_id))
        .map(|u| u.id)
        .collect();

    // Nothing to do - but say so rather than writing an entry claiming a move.
    if moving.is_empty() {
        return Ok(Json(json!({ "moved": 0, "org_unit_id": dto.org_unit_id })));
    }

    let backend = tx.backend();
    let mut binds: Vec<DbValue> = vec![dto.org_unit_id.into()];
    let move_sql = format!(
        "UPDATE core.users SET org_unit_id = $1 WHERE id IN ({})",
        backend.in_list(2, moving.len())
    );
    for uid in &moving {
        binds.push((*uid).into());
    }
    let moved = tx
        .execute(&move_sql, binds)
        .await
        .map_err(|e| { tracing::error!(error = %e, "bulk_set_org_unit: écriture"); AppError::Database(e) })?;

    // The diff names the accounts and where each came from: the entry has to be
    // enough on its own to put the directory back the way it was.
    let before = previous
        .iter()
        .filter(|u| moving.contains(&u.id))
        .map(|u| json!({
            "id": u.id,
            "label": user_label(u),
            "org_unit_id": u.org_unit_id,
        }))
        .collect::<Vec<_>>();

    tx.commit(
        AuditEntry::new("core.users.org_unit")
            .target(target::ORG_UNIT, dto.org_unit_id, unit_name.clone())
            .before(json!({ "users": before }))
            .after(json!({ "org_unit_id": dto.org_unit_id, "moved": moved }))
            .detail(format!("{moved} compte(s) déplacé(s) vers « {unit_name} »"))
            .reversible(),
    )
    .await?;

    // An account's unit decides which delegated administrator reaches it, and the
    // resolved context is cached for a few seconds per subject. Drop it, or a
    // move can be followed by a window where the OLD perimeter still applies.
    crate::authz::cache::invalidate_all();

    Ok(Json(json!({ "moved": moved, "org_unit_id": dto.org_unit_id })))
}

/// The selection, cleaned up: deduplicated, non-empty, under the ceiling.
///
/// Deduplication comes first because the callers below check that every id was
/// found; the same id twice would fail a request that is merely redundant.
fn bulk_ids(raw: &[Uuid]) -> Result<Vec<Uuid>, AppError> {
    let mut ids = raw.to_vec();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Err(AppError::Validation("No accounts selected".into()));
    }
    if ids.len() > BULK_MAX {
        return Err(AppError::Validation(format!(
            "Too many accounts at once (maximum {BULK_MAX})"
        )));
    }
    Ok(ids)
}

/// The selected accounts, locked in id order so two concurrent bulk operations
/// queue instead of deadlocking, with every guard applied BEFORE a single row is
/// written - a partial run is exactly what the transaction is here to prevent.
///
/// The old `WHERE id = ANY(...) ORDER BY id FOR UPDATE` had no portable form, so
/// each row is locked in turn, in the sorted id order, reproducing its lock
/// ordering.
async fn bulk_load_and_authorise(
    db: &DbPool,
    tx: &mut crate::audit::AuditTx,
    ctx: &AdminCtx,
    ids: &[Uuid],
    privilege: &str,
) -> Result<Vec<User>, AppError> {
    let mut users: Vec<User> = Vec::with_capacity(ids.len());
    let sql = format!("SELECT * FROM core.users WHERE id = $1{}", db.backend().for_update());
    for uid in ids {
        if let Some(row) = tx
            .fetch_optional_row(&sql, params![*uid])
            .await
            .map_err(|e| { tracing::error!(error = %e, "bulk: lecture"); AppError::Database(e) })?
        {
            users.push(user_from_row(&row).map_err(AppError::Database)?);
        }
    }

    if users.len() != ids.len() {
        return Err(AppError::NotFound(format!(
            "{} account(s) not found",
            ids.len() - users.len()
        )));
    }
    for user in &users {
        ctx.require_for_unit(privilege, user.org_unit_id)?;
        ensure_can_act_on_user(db, ctx, user.id).await?;
    }
    Ok(users)
}

#[derive(Deserialize)]
pub struct BulkActiveDto {
    pub user_ids:  Vec<Uuid>,
    pub is_active: bool,
}

/// `POST /admin/users/bulk/active` - suspend or restore several accounts.
///
/// One transaction and one recapitulative entry rather than N calls to
/// `PATCH /users/:id`, for the same reason as the bulk unit move: N calls half
/// succeed, and the trail then holds N entries that nobody reads as one act.
pub async fn bulk_set_active(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Json(dto): Json<BulkActiveDto>,
) -> Result<Json<serde_json::Value>, AppError> {
    let ids = bulk_ids(&dto.user_ids)?;
    let mut tx = audit.begin(&state.db).await?;
    let previous = bulk_load_and_authorise(&state.db, &mut tx, &ctx, &ids, keys::USERS_UPDATE).await?;

    let changing: Vec<Uuid> = previous
        .iter()
        .filter(|u| u.is_active != dto.is_active)
        .map(|u| u.id)
        .collect();

    // Nothing to do - say so rather than writing an entry claiming a change.
    if changing.is_empty() {
        return Ok(Json(json!({ "changed": 0, "is_active": dto.is_active })));
    }

    // Reactivating cancels a pending destruction, exactly as the single-account
    // update does: leaving the stamp would let the purge job delete a live
    // account weeks later because somebody had once deleted it and changed
    // their mind. `is_active` feeds two placeholders and is bound twice.
    let backend = tx.backend();
    let mut binds: Vec<DbValue> = vec![dto.is_active.into(), dto.is_active.into()];
    let sql = format!(
        "UPDATE core.users \
            SET is_active  = $1, \
                deleted_at = CASE WHEN $2 IS TRUE THEN NULL ELSE deleted_at END \
          WHERE id IN ({})",
        backend.in_list(3, changing.len())
    );
    for uid in &changing {
        binds.push((*uid).into());
    }
    let changed = tx
        .execute(&sql, binds)
        .await
        .map_err(|e| { tracing::error!(error = %e, "bulk_set_active: écriture"); AppError::Database(e) })?;

    // `core.superadmin_ids()` counts ACTIVE accounts only: suspending the last
    // super-administrator is caught here like any other removal.
    ensure_superadmin_remains(&mut tx).await?;

    let before = previous
        .iter()
        .filter(|u| changing.contains(&u.id))
        .map(|u| json!({ "id": u.id, "label": user_label(u), "is_active": u.is_active }))
        .collect::<Vec<_>>();

    let verb = if dto.is_active { "réactivé(s)" } else { "suspendu(s)" };
    tx.commit(
        AuditEntry::new("core.users.active")
            .target_kind("users", "Comptes sélectionnés")
            .before(json!({ "users": before }))
            .after(json!({ "is_active": dto.is_active, "changed": changed }))
            .detail(format!("{changed} compte(s) {verb}"))
            .reversible(),
    )
    .await?;

    // Whether an account is active decides what its sessions may still do, and
    // the resolved context is cached per subject for a few seconds.
    crate::authz::cache::invalidate_all();

    Ok(Json(json!({ "changed": changed, "is_active": dto.is_active })))
}

#[derive(Deserialize)]
pub struct BulkDeleteDto {
    pub user_ids: Vec<Uuid>,
}

/// `POST /admin/users/bulk/delete` - deactivate several accounts and arm their
/// purge, the bulk form of `DELETE /admin/users/:id`.
///
/// Deliberately the SOFT delete, never the purge: erasing is a second, separate
/// decision that requires the account's own address to be typed back, and there
/// is no honest way to ask for that confirmation about fifty accounts at once.
pub async fn bulk_delete_users(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Json(dto): Json<BulkDeleteDto>,
) -> Result<Json<serde_json::Value>, AppError> {
    let ids = bulk_ids(&dto.user_ids)?;
    let mut tx = audit.begin(&state.db).await?;
    let previous = bulk_load_and_authorise(&state.db, &mut tx, &ctx, &ids, keys::USERS_DELETE).await?;

    // Accounts already carrying the stamp are left alone: re-stamping `deleted_at`
    // would push their purge date back, quietly keeping data that was due to go.
    // Asked of the database rather than of `User`, which does not map the column;
    // one probe per id, in the already-sorted order.
    let mut deleting: Vec<Uuid> = Vec::new();
    for uid in &ids {
        if let Some(found) = tx
            .fetch_optional_scalar::<Uuid>(
                "SELECT id FROM core.users WHERE id = $1 AND deleted_at IS NULL",
                params![*uid],
            )
            .await
            .map_err(|e| { tracing::error!(error = %e, "bulk_delete_users: tri"); AppError::Database(e) })?
        {
            deleting.push(found);
        }
    }

    if deleting.is_empty() {
        return Ok(Json(json!({ "deleted": 0 })));
    }

    let backend = tx.backend();
    let now = chrono::Utc::now();
    let mut binds: Vec<DbValue> = vec![now.into()];
    let sql = format!(
        "UPDATE core.users SET is_active = FALSE, deleted_at = $1 WHERE id IN ({})",
        backend.in_list(2, deleting.len())
    );
    for uid in &deleting {
        binds.push((*uid).into());
    }
    let deleted = tx
        .execute(&sql, binds)
        .await
        .map_err(|e| { tracing::error!(error = %e, "bulk_delete_users: écriture"); AppError::Database(e) })?;

    ensure_superadmin_remains(&mut tx).await?;

    // The diff names every account: the entry has to be enough on its own to put
    // the directory back the way it was.
    let before = previous
        .iter()
        .filter(|u| deleting.contains(&u.id))
        .map(|u| json!({
            "id":          u.id,
            "label":       user_label(u),
            "is_active":   u.is_active,
            "org_unit_id": u.org_unit_id,
        }))
        .collect::<Vec<_>>();

    tx.commit(
        AuditEntry::new("core.users.delete")
            .target_kind("users", "Comptes sélectionnés")
            .before(json!({ "users": before }))
            .after(json!({ "deleted": deleted }))
            .detail(format!("{deleted} compte(s) supprimé(s)"))
            .reversible(),
    )
    .await?;

    for id in &deleting {
        state.events.publish(crate::events::AppEvent::UserDeleted { user_id: *id });
    }
    crate::authz::cache::invalidate_all();

    Ok(Json(json!({ "deleted": deleted })))
}

#[derive(Deserialize)]
pub struct BulkRequirePasswordChangeDto {
    pub user_ids: Vec<Uuid>,
}

/// `POST /admin/users/bulk/require-password-change` - arm the forced password
/// change on the selected accounts.
///
/// ## Why this IS the bulk "reset"
///
/// A password cannot be reset for many accounts the way it is for one. Setting
/// the same password on N accounts creates one shared secret, which is worse
/// than the situation it answers; generating N different ones puts N plaintext
/// passwords into a page, a scrollback and whatever screenshot follows, and
/// leaves the operator to distribute them by hand. Arming the change costs
/// nobody a secret, is reversible, and is the honest answer to "these accounts
/// may be compromised". Choosing a password, sending it, and revoking sessions
/// stay where they belong: on one account, from its own sheet.
///
/// Accounts with no local password are SKIPPED, not refused: their
/// authentication is governed by a directory or an identity provider, the change
/// screen would ask them for a current password they do not have, and failing
/// the whole batch over one such account would be useless to the operator. The
/// answer says how many were left out.
pub async fn bulk_require_password_change(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Json(dto): Json<BulkRequirePasswordChangeDto>,
) -> Result<Json<serde_json::Value>, AppError> {
    let ids = bulk_ids(&dto.user_ids)?;
    let mut tx = audit.begin(&state.db).await?;
    let previous = bulk_load_and_authorise(&state.db, &mut tx, &ctx, &ids, keys::USER_PASSWORD).await?;

    // `password_hash` is not mapped onto `User`, so its presence is asked of the
    // database - as is the flag, to avoid re-arming what is already armed. One
    // probe per id, in the already-sorted order.
    let mut rows: Vec<(Uuid, bool, bool)> = Vec::new();
    for uid in &ids {
        if let Some(row) = tx
            .fetch_optional_row(
                "SELECT id, (password_hash IS NOT NULL) AS has_password, must_change_password \
                   FROM core.users WHERE id = $1",
                params![*uid],
            )
            .await
            .map_err(|e| { tracing::error!(error = %e, "bulk_require_password_change: lecture"); AppError::Database(e) })?
        {
            let rid: Uuid = row.try_get("id").map_err(AppError::Database)?;
            let has_password: bool = row.try_get("has_password").map_err(AppError::Database)?;
            let already: bool = row.try_get("must_change_password").map_err(AppError::Database)?;
            rows.push((rid, has_password, already));
        }
    }

    let skipped = rows.iter().filter(|(_, has_password, _)| !has_password).count();
    let arming: Vec<Uuid> = rows
        .iter()
        .filter(|(_, has_password, already)| *has_password && !already)
        .map(|(id, _, _)| *id)
        .collect();

    if arming.is_empty() {
        return Ok(Json(json!({ "armed": 0, "skipped_no_password": skipped })));
    }

    let backend = tx.backend();
    let mut binds: Vec<DbValue> = Vec::new();
    let sql = format!(
        "UPDATE core.users SET must_change_password = TRUE WHERE id IN ({})",
        backend.in_list(1, arming.len())
    );
    for uid in &arming {
        binds.push((*uid).into());
    }
    let armed = tx
        .execute(&sql, binds)
        .await
        .map_err(|e| { tracing::error!(error = %e, "bulk_require_password_change: écriture"); AppError::Database(e) })?;

    let before = previous
        .iter()
        .filter(|u| arming.contains(&u.id))
        .map(|u| json!({ "id": u.id, "label": user_label(u) }))
        .collect::<Vec<_>>();

    tx.commit(
        AuditEntry::new("core.users.require_password_change")
            .target_kind("users", "Comptes sélectionnés")
            .before(json!({ "users": before, "must_change_password": false }))
            .after(json!({ "must_change_password": true, "armed": armed }))
            .detail(format!(
                "{armed} compte(s) devront changer de mot de passe\
                 {}",
                if skipped > 0 {
                    format!(" ({skipped} ignoré(s) : pas de mot de passe local)")
                } else {
                    String::new()
                }
            ))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "armed": armed, "skipped_no_password": skipped })))
}

pub async fn delete_user(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut tx = audit.begin(&state.db).await?;

    let sql = format!(
        "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE{}",
        tx.backend().for_update()
    );
    let previous = tx
        .fetch_optional_row(&sql, params![id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_user: lecture"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("User {id}")))?;
    let previous = user_from_row(&previous).map_err(AppError::Database)?;

    ctx.require_for_unit(keys::USERS_DELETE, previous.org_unit_id)?;
    ensure_can_act_on_user(&state.db, &ctx, id).await?;

    // `deleted_at` is what arms the automatic purge, and it is stamped *here* -
    // never by a suspension. The two produce the same `is_active = FALSE`, and a
    // purge keyed on that flag would destroy accounts somebody merely put on
    // hold. See `migrations/000109`.
    let now = chrono::Utc::now();
    let raw = kubuno_db::returning::update_returning_row(
        &mut tx,
        "UPDATE core.users SET is_active = FALSE, deleted_at = $1 WHERE id = $2",
        params![now, id],
        "*",
        &kubuno_db::returning::reselect_by_id("core.users", "*"),
        params![id],
    )
    .await
    .map_err(|e| { tracing::error!(error = %e, "delete_user: désactivation"); AppError::Database(e) })?
    .ok_or_else(|| AppError::NotFound(format!("User {id}")))?;
    let user = user_from_row(&raw).map_err(AppError::Database)?;

    // `core.superadmin_ids()` counts ACTIVE accounts only, so deactivating the
    // last super-administrator is caught here like any other removal.
    // Deliberately no `sync_role_cache` here: the assignment survives the
    // deactivation, so reactivating the account must restore its powers rather
    // than silently return an ex-administrator as an ordinary user.
    ensure_superadmin_remains(&mut tx).await?;

    tx.commit(
        AuditEntry::new("core.users.delete")
            .target(target::USER, id, user_label(&previous))
            .before(snap(target::USER, &previous))
            .after(snap(target::USER, &user))
            .reversible(),
    )
    .await?;

    state.events.publish(crate::events::AppEvent::UserDeleted { user_id: id });

    Ok(Json(json!({ "message": "User disabled" })))
}

/// Body of a purge: the account's own email address, typed back.
#[derive(Debug, Deserialize)]
pub struct PurgeUserDto {
    pub confirm_email: String,
}

/// `DELETE /admin/users/:id/purge` - erases the row, for good.
///
/// ## Why this is a second route and not a flag on the first
///
/// Deleting and erasing are different acts with different consequences, and a
/// boolean on one endpoint makes them one click apart. Here the sequence is
/// deliberate: an account must already be deactivated before it can be erased,
/// so destroying a live account takes two decisions taken at two moments.
///
/// ## Three refusals, in this order
///
/// 1. **A live account is never erased.** The caller has to deactivate first,
///    which is the reversible half of the operation and the one that gives the
///    organisation time to object.
/// 2. **The email is typed back.** Not a checkbox: a checkbox is ticked by the
///    hand that was already moving. Retyping `marie.dupont@…` is the moment
///    somebody reads the address and notices it is not the one they meant.
/// 3. **The ordinary guards still apply** - scope, self-protection, and the last
///    super-administrator. Erasing is not a way around a rule that blocks
///    deactivating.
///
/// The audit entry carries the complete snapshot *before* the delete, because
/// afterwards there is no row left to point at. It is explicitly **not**
/// `reversible()`: nothing here can be undone, and a trail that suggested
/// otherwise would be worse than one that says nothing.
pub async fn purge_user(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Path(id): Path<Uuid>,
    Json(dto): Json<PurgeUserDto>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut tx = audit.begin(&state.db).await?;

    let sql = format!("SELECT * FROM core.users WHERE id = $1{}", tx.backend().for_update());
    let victim = tx
        .fetch_optional_row(&sql, params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "purge_user: lecture");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound(format!("User {id}")))?;
    let victim = user_from_row(&victim).map_err(AppError::Database)?;

    ctx.require_for_unit(keys::USERS_DELETE, victim.org_unit_id)?;
    ensure_can_act_on_user(&state.db, &ctx, id).await?;

    if victim.is_active {
        return Err(tx
            .abort(
                &state.db,
                AuditEntry::new("core.users.purge")
                    .target(target::USER, id, user_label(&victim))
                    .denied("compte encore actif"),
                AppError::Validation(
                    "This account is still active. Disable it first; permanent deletion only applies to an account already taken out of service.".into(),
                ),
            )
            .await);
    }

    // Compared without regard to case: the column is `CITEXT`, so `Marie@…` and
    // `marie@…` are the same account, and refusing the first would be a riddle
    // rather than a safeguard.
    if !dto.confirm_email.trim().eq_ignore_ascii_case(&victim.email) {
        return Err(tx
            .abort(
                &state.db,
                AuditEntry::new("core.users.purge")
                    .target(target::USER, id, user_label(&victim))
                    .denied("adresse de confirmation incorrecte"),
                AppError::Validation(
                    "The entered address does not match the account's address. Copy it exactly to confirm permanent deletion.".into(),
                ),
            )
            .await);
    }

    let before = snap(target::USER, &victim);

    // Release the alerts this account had taken, *before* the delete.
    //
    // `core.alerts.assignee_id` is `ON DELETE SET NULL`, but the table also
    // carries `CHECK ((assignee_id IS NULL) = (assigned_at IS NULL))`: nulling
    // one half of the pair breaks the constraint and the whole delete fails.
    // The referential action and the check contradict each other, and nothing
    // caught it because until this route existed no account was ever hard
    // deleted. Clearing both columns is what the constraint means by "not
    // assigned" - the alert survives, unassigned, which is the right outcome:
    // it was raised by the instance, not by the person who happened to take it.
    let released = tx
        .execute(
            "UPDATE core.alerts SET assignee_id = NULL, assigned_at = NULL WHERE assignee_id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %id, "purge_user: libération des alertes");
            AppError::Database(e)
        })?;

    // Purge the account's own setting overrides (the `setting_values_purge_scope`
    // trigger's job on PostgreSQL; a no-op there).
    crate::settings::store::purge_setting_values_for_scope(&mut tx, "user", id)
        .await
        .map_err(|e| { tracing::error!(error = %e, user_id = %id, "purge_user: purge des réglages"); AppError::Database(e) })?;
    tx.execute("DELETE FROM core.users WHERE id = $1", params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %id, "purge_user: suppression");
            // A constraint that still refuses names the relation holding the
            // account back. A bare 500 here would send an operator to the logs
            // for something they can act on - and the point of this route is to
            // finish, or to say precisely what is in the way.
            match e.as_database_error().and_then(|d| d.constraint()) {
                Some(c) => AppError::Conflict(format!(
                    "Related data prevents this account from being erased (constraint '{c}'). Resolve it before permanently deleting the account."
                )),
                None => AppError::Database(e),
            }
        })?;

    // Runs after the delete, on purpose: the count must see the instance as it
    // will be, not as it was.
    ensure_superadmin_remains(&mut tx).await?;

    tx.commit(
        AuditEntry::new("core.users.purge")
            .target(target::USER, id, user_label(&victim))
            .before(before)
            .detail(format!("{released} alerte(s) libérée(s)")),
    )
    .await?;

    // Modules hold rows keyed on this account. They already handle the event for
    // a deactivation; an erasure is the same signal, sent once more so a module
    // that only reacts to this one still learns of it.
    state.events.publish(crate::events::AppEvent::UserDeleted { user_id: id });

    Ok(Json(json!({ "message": "Account permanently deleted" })))
}

/// One zero-filled daily series over the last `days` days, up to today in UTC.
///
/// The portable replacement for the old `generate_series` + `to_char` +
/// `::date`/`::bigint` query: the `days` day buckets are generated in Rust, the
/// rows falling in the window are read once and folded into their UTC calendar
/// day, and every day with no row stays at zero. `table` and `date_col` are
/// `&'static str` written in source (no request data spliced); the only bound
/// value is the window's lower bound.
///
/// Public so the portability test can exercise it directly on each engine; the
/// only caller in production is [`admin_stats`].
pub async fn daily_series(
    db: &DbPool,
    table: &'static str,
    date_col: &'static str,
    days: i64,
) -> Result<Vec<(String, i64)>, AppError> {
    use std::collections::HashMap;

    let today = chrono::Utc::now().date_naive();
    let start = today - chrono::Duration::days((days - 1).max(0));
    let start_ts = start.and_hms_opt(0, 0, 0).unwrap_or_default().and_utc();

    let sql = format!("SELECT t.{date_col} FROM {table} t WHERE t.{date_col} >= $1");
    let rows: Vec<(chrono::DateTime<chrono::Utc>,)> = db
        .fetch_all_as::<(chrono::DateTime<chrono::Utc>,)>(&sql, params![start_ts])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, table, "admin_stats: daily series");
            AppError::Database(e)
        })?;

    let mut counts: HashMap<chrono::NaiveDate, i64> = HashMap::new();
    for (ts,) in rows {
        *counts.entry(ts.date_naive()).or_default() += 1;
    }

    let mut out = Vec::with_capacity(days.max(0) as usize);
    let mut cur = start;
    while cur <= today {
        out.push((cur.format("%Y-%m-%d").to_string(), counts.get(&cur).copied().unwrap_or(0)));
        cur += chrono::Duration::days(1);
    }
    Ok(out)
}

pub async fn admin_stats(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<serde_json::Value>, AppError> {
    // Instance-wide aggregates: not scopable, so a delegated administrator does
    // not get a count of the accounts they cannot list.
    ctx.require(keys::STATS_READ)?;

    let backend = state.db.backend();
    let now = chrono::Utc::now();

    let users_total: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!("SELECT {} FROM core.users", backend.count_bigint("*")),
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: users_total"); AppError::Database(e) })?;

    let users_active: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!("SELECT {} FROM core.users WHERE is_active = TRUE", backend.count_bigint("*")),
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: users_active"); AppError::Database(e) })?;

    let storage_used: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!("SELECT {} FROM core.users", backend.sum_bigint("used_bytes")),
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: storage_used"); AppError::Database(e) })?;

    let modules_active: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.module_instances WHERE status = 'healthy'",
                backend.count_bigint("*")
            ),
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: modules_active"); AppError::Database(e) })?;

    // ── Session statistics ──────────────────────────────────────────────────
    let sessions_active: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.refresh_tokens WHERE revoked_at IS NULL AND expires_at > $1",
                backend.count_bigint("*")
            ),
            params![now],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: sessions_active"); AppError::Database(e) })?;

    // Distinct users holding at least one active session (= currently signed in).
    let users_online: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.refresh_tokens WHERE revoked_at IS NULL AND expires_at > $1",
                backend.cast("COUNT(DISTINCT user_id)", SqlType::BigInt)
            ),
            params![now],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: users_online"); AppError::Database(e) })?;

    // Sessions used in the last 24 hours.
    let sessions_24h: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.refresh_tokens WHERE revoked_at IS NULL AND last_used_at > $1",
                backend.count_bigint("*")
            ),
            params![now - chrono::Duration::hours(24)],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: sessions_24h"); AppError::Database(e) })?;

    // ── Enriched aggregates (cards + charts) ────────────────────────────────────
    let storage_quota_total: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!("SELECT {} FROM core.users", backend.sum_bigint("quota_bytes")),
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: storage_quota_total"); AppError::Database(e) })?;

    let new_users_7d: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!("SELECT {} FROM core.users WHERE created_at > $1", backend.count_bigint("*")),
            params![now - chrono::Duration::days(7)],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: new_users_7d"); AppError::Database(e) })?;

    let new_users_30d: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!("SELECT {} FROM core.users WHERE created_at > $1", backend.count_bigint("*")),
            params![now - chrono::Duration::days(30)],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: new_users_30d"); AppError::Database(e) })?;

    // Distributions (key, count).
    let users_by_role: Vec<(String, i64)> = state
        .db
        .fetch_all_as::<(String, i64)>(
            &format!(
                "SELECT role, {} FROM core.users GROUP BY role ORDER BY 2 DESC",
                backend.count_bigint("*")
            ),
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: users_by_role"); AppError::Database(e) })?;

    let sessions_by_device: Vec<(String, i64)> = state
        .db
        .fetch_all_as::<(String, i64)>(
            &format!(
                "SELECT COALESCE(NULLIF(device_type, ''), 'unknown'), {} FROM core.refresh_tokens \
                 WHERE revoked_at IS NULL AND expires_at > $1 GROUP BY 1 ORDER BY 2 DESC",
                backend.count_bigint("*")
            ),
            params![now],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: sessions_by_device"); AppError::Database(e) })?;

    let modules_by_status: Vec<(String, i64)> = state
        .db
        .fetch_all_as::<(String, i64)>(
            &format!(
                "SELECT status, {} FROM core.module_instances GROUP BY status ORDER BY 2 DESC",
                backend.count_bigint("*")
            ),
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: modules_by_status"); AppError::Database(e) })?;

    // Top users by storage.
    let top_storage: Vec<(String, i64, i64)> = state
        .db
        .fetch_all_as::<(String, i64, i64)>(
            "SELECT COALESCE(NULLIF(display_name, ''), username), used_bytes, quota_bytes \
             FROM core.users ORDER BY used_bytes DESC LIMIT 6",
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "admin_stats: top_storage"); AppError::Database(e) })?;

    // Daily series, zero-filled. The date buckets are generated in Rust (like
    // `admin::period` does) instead of through PostgreSQL's `generate_series` +
    // `to_char` + `::date`/`::bigint`, none of which MySQL and SQLite share:
    // `daily_series` reads the raw timestamps in its window and folds each into
    // its UTC calendar day, leaving every empty day at zero.
    let signups_daily = daily_series(&state.db, "core.users", "created_at", 14).await?;
    let logins_daily = daily_series(&state.db, "core.refresh_tokens", "created_at", 14).await?;
    // event_log may be empty / absent depending on the instance.
    let events_daily = daily_series(&state.db, "core.event_log", "created_at", 7)
        .await
        .unwrap_or_default();

    let kv = |rows: Vec<(String, i64)>| -> Vec<serde_json::Value> {
        rows.into_iter().map(|(k, v)| json!({ "key": k, "count": v })).collect()
    };
    let series = |rows: Vec<(String, i64)>| -> Vec<serde_json::Value> {
        rows.into_iter().map(|(d, v)| json!({ "date": d, "count": v })).collect()
    };

    Ok(Json(json!({
        "users_total":         users_total,
        "users_active":        users_active,
        "storage_used":        storage_used,
        "storage_quota_total": storage_quota_total,
        "modules_active":      modules_active,
        "sessions_active":     sessions_active,
        "users_online":        users_online,
        "sessions_24h":        sessions_24h,
        "new_users_7d":        new_users_7d,
        "new_users_30d":       new_users_30d,
        "users_by_role":       kv(users_by_role),
        "sessions_by_device":  kv(sessions_by_device),
        "modules_by_status":   kv(modules_by_status),
        "signups_daily":       series(signups_daily),
        "logins_daily":        series(logins_daily),
        "events_daily":        series(events_daily),
        "top_storage": top_storage.into_iter()
            .map(|(name, used, quota)| json!({ "name": name, "used": used, "quota": quota }))
            .collect::<Vec<_>>(),
    })))
}

/// GET /admin/users/:id/sessions - liste les sessions actives d'un utilisateur.
pub async fn list_user_sessions(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(user_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    // The unit-resolving guard reads committed state on the pool now.
    let unit = user_org_unit(&state.db, user_id).await?;
    ctx.require_for_unit(keys::SESSIONS_READ, unit)?;

    // `host(ip_address)::text` is PostgreSQL-only; the dialect layer selects the
    // plain text column on the other engines.
    let sessions_sql = format!(
        r#"SELECT id, user_id, token_hash, device_name, device_type,
                  {ip} as ip_address, user_agent,
                  expires_at, created_at, last_used_at, revoked_at, revoke_reason,
                  family_id, client_type
           FROM core.refresh_tokens
           WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
           ORDER BY last_used_at DESC"#,
        ip = state.db.backend().inet_text("ip_address"),
    );
    let sessions = state
        .db
        .fetch_all_as::<crate::models::session::RefreshToken>(
            &sessions_sql,
            params![user_id, chrono::Utc::now()],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "list_user_sessions"); AppError::Database(e) })?;

    Ok(Json(json!({ "sessions": sessions })))
}

/// DELETE /admin/users/:id/sessions/:sid - révoque une session précise.
pub async fn revoke_user_session(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Path((user_id, session_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut tx = audit.begin(&state.db).await?;

    let unit = user_org_unit(&state.db, user_id).await?;
    ctx.require_for_unit(keys::SESSIONS_DELETE, unit)?;
    ensure_can_act_on_user(&state.db, &ctx, user_id).await?;

    // `token_hash` is not selected: it is not on the session whitelist and has
    // no business travelling anywhere near the trail.
    let session_sql = format!(
        r#"SELECT device_name, device_type, {ip} AS ip_address
           FROM core.refresh_tokens
           WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL{for_update}"#,
        ip = state.db.backend().inet_text("ip_address"),
        for_update = state.db.backend().for_update(),
    );
    let session = tx
        .fetch_optional_row(
            &session_sql,
            params![session_id, user_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "revoke_user_session: lecture"); AppError::Database(e) })?;

    let Some(session) = session else {
        return Err(AppError::NotFound("Session not found".into()));
    };
    let device_name: Option<String> = session.try_get("device_name").map_err(AppError::Database)?;
    let device_type: Option<String> = session.try_get("device_type").map_err(AppError::Database)?;
    let ip: Option<String> = session.try_get("ip_address").map_err(AppError::Database)?;

    tx.execute(
        "UPDATE core.refresh_tokens
         SET revoked_at = $1, revoke_reason = 'admin'
         WHERE id = $2 AND user_id = $3",
        params![chrono::Utc::now(), session_id, user_id],
    )
    .await
    .map_err(|e| { tracing::error!(error = %e, "revoke_user_session"); AppError::Database(e) })?;

    let label = device_name.clone().unwrap_or_else(|| "Session".into());
    tx.commit(
        AuditEntry::new("core.sessions.revoke")
            .target(target::SESSION, session_id, label)
            .before(crate::audit::redact::snapshot(
                target::SESSION,
                &json!({
                    "id": session_id, "user_id": user_id,
                    "device_name": device_name, "device_type": device_type,
                    "ip_address": ip,
                }),
            ))
            .after(crate::audit::redact::snapshot(
                target::SESSION,
                &json!({ "id": session_id, "user_id": user_id, "revoke_reason": "admin" }),
            )),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

/// DELETE /admin/users/:id/sessions - révoque TOUTES les sessions d'un utilisateur.
pub async fn revoke_all_user_sessions(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Path(user_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut tx = audit.begin(&state.db).await?;

    let unit = user_org_unit(&state.db, user_id).await?;
    ctx.require_for_unit(keys::SESSIONS_DELETE, unit)?;
    ensure_can_act_on_user(&state.db, &ctx, user_id).await?;

    let target_user = tx
        .fetch_optional_row("SELECT username, email FROM core.users WHERE id = $1", params![user_id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "revoke_all_user_sessions: cible"); AppError::Database(e) })?;
    let target_user = match target_user {
        Some(row) => {
            let username: String = row.try_get("username").map_err(AppError::Database)?;
            let email: String = row.try_get("email").map_err(AppError::Database)?;
            Some((username, email))
        }
        None => None,
    };

    let affected = tx
        .execute(
            "UPDATE core.refresh_tokens
             SET revoked_at = $1, revoke_reason = 'admin'
             WHERE user_id = $2 AND revoked_at IS NULL",
            params![chrono::Utc::now(), user_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "revoke_all_user_sessions"); AppError::Database(e) })?;

    let label = target_user
        .map(|(username, email)| format!("{username} <{email}>"))
        .unwrap_or_else(|| user_id.to_string());

    tx.commit(
        AuditEntry::new("core.sessions.revoke_all")
            .target(target::USER, user_id, label)
            .after(json!({ "revoked": affected }))
            .detail(format!("{affected} session(s) révoquée(s)")),
    )
    .await?;

    Ok(Json(json!({ "ok": true, "revoked": affected })))
}
