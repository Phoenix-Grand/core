//! Public sign up (`POST /auth/register`).

use crate::{
    crypto::password, errors::AppError, models::user::CreateUserDto, state::AppState,
};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use kubuno_db::{params, Backend};
use serde_json::{json, Value};
use validator::Validate;

/// A single `id` column, wrapped so `DbPool` can fetch a list of them.
#[derive(sqlx::FromRow)]
struct GroupIdRow {
    id: uuid::Uuid,
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/register",
    tag = "auth",
    request_body = CreateUserDto,
    responses(
        (status = 201, description = "Account created"),
        (status = 403, description = "Inscription fermée"),
        (status = 409, description = "Email ou nom d'utilisateur déjà pris")
    )
)]
pub async fn register(
    State(state): State<AppState>,
    Json(dto): Json<CreateUserDto>,
) -> Result<impl IntoResponse, AppError> {
    dto.validate()
        .map_err(|e| AppError::Validation(e.to_string()))?;

    // Check whether registration is open.
    let open: bool = state
        .db
        .fetch_optional_scalar::<Value>(
            "SELECT value FROM core.settings WHERE \"key\" = 'auth.registration_open'",
            params![],
        )
        .await?
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    if !open {
        return Err(AppError::Forbidden);
    }

    // The one policy the domain registry governs. Off by default, so an instance
    // that never declared a domain behaves exactly as it always has.
    //
    // Checked against **verified** domains only: a registry entry nobody has
    // proven would let whoever typed it decide who may open an account here.
    // The refusal names the accepted domains - an address at the wrong domain is
    // a mistake, not an attack, and hiding the list would only make it a
    // guessing game. Nothing about existing accounts is disclosed by it.
    let restricted: bool = crate::settings::instance_value(&state.db, "auth.registration_domains_only")
        .await
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if restricted {
        let domain = dto.email.rsplit('@').next().unwrap_or_default().to_ascii_lowercase();
        if !crate::domains::store::is_verified(&state.db, &domain).await {
            let accepted = crate::domains::store::verified_names(&state.db).await;
            return Err(AppError::Validation(if accepted.is_empty() {
                "Registration is restricted to addresses on this instance's domains.".into()
            } else {
                format!(
                    "Registration is restricted to addresses on: {}.",
                    accepted.join(", ")
                )
            }));
        }
    }

    // Check email + username uniqueness (same message to avoid enumeration).
    let exists: bool = state
        .db
        .fetch_scalar::<bool>(
            "SELECT EXISTS(SELECT 1 FROM core.users WHERE email = $1 OR username = $2)",
            params![&dto.email, &dto.username],
        )
        .await?;

    if exists {
        return Err(AppError::Conflict("Email or username already in use".into()));
    }

    // A public sign-up names no unit, so it lands at the root of the tree - not
    // outside it. An account outside the tree is invisible to every DELEGATED
    // administrator (`handlers/admin/users.rs` filters by subtree) and resolves
    // its settings as `default → instance`, SKIPPING every unit-level value,
    // locked ones included. Migration 000107 makes that state unrepresentable;
    // naming the unit here is what makes the intention readable at the call site.
    let root_unit = crate::database::seed::root_org_unit(&state.db).await;

    // The configured default, not the column default - and resolved FROM THE
    // UNIT the account is being created in, so a per-unit (or locked) quota set
    // on the root applies to the people who sign up into it. Until this was
    // read, raising `storage.default_quota_bytes` changed nothing for the
    // accounts it was raised for.
    let quota = crate::models::user::default_quota_for(&state.db, root_unit).await;

    // The password policy of the unit the account is about to land in - the
    // most specific scope that can be known before the row exists. Resolved and
    // applied BEFORE hashing: a refused password must not cost an argon2id, and
    // a public route is the one an attacker can call at will.
    //
    // The refusal states the rule, never how close the attempt came. It is not
    // an enumeration oracle either: the policy of the root unit is the same for
    // everybody who signs up, whatever address they typed.
    let policy =
        crate::settings::password_policy::PasswordPolicy::for_new_account(&state.db, root_unit)
            .await?;
    policy.check(&dto.password)?;

    let hash = password::hash_password(&dto.password)
        .map_err(AppError::Internal)?;

    // The id and `password_changed_at` timestamp are generated in Rust: no
    // engine-specific `DEFAULT`/`RETURNING`, and the row is reselected below.
    let user_id = kubuno_db::new_id();
    let now = chrono::Utc::now();
    state
        .db
        .execute(
            r#"INSERT INTO core.users
               (id, email, username, password_hash, display_name, quota_bytes, org_unit_id,
                password_changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
            params![
                user_id,
                &dto.email,
                &dto.username,
                &hash,
                dto.display_name.as_deref(),
                quota,
                root_unit,
                now,
            ],
        )
        .await?;

    let user = state
        .db
        .fetch_one_as::<crate::models::user::User>(
            "SELECT * FROM core.users WHERE id = $1",
            params![user_id],
        )
        .await?;

    // The first password enters the history like every later one. Without it,
    // "no reuse" would let somebody change their password once and immediately
    // change it back to the one they signed up with.
    let mut tx = state.db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "register: transaction for the password history");
        AppError::Database(e)
    })?;
    crate::settings::password_policy::remember(&mut tx, user.id, &hash, policy.history_depth)
        .await?;
    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "register: committing the password history");
        AppError::Database(e)
    })?;

    // Add the user to the default groups.
    let default_groups: Vec<uuid::Uuid> = state
        .db
        .fetch_all_as::<GroupIdRow>(
            "SELECT id FROM core.user_groups WHERE is_default = TRUE",
            params![],
        )
        .await
        .map(|rows| rows.into_iter().map(|r| r.id).collect())
        .unwrap_or_default();

    // `ON CONFLICT DO NOTHING` with no target list has no portable target, so it
    // is spliced as (prefix, suffix): MySQL uses `INSERT IGNORE`, the others a
    // trailing `ON CONFLICT DO NOTHING`.
    let (ignore, on_conflict) = match state.db.backend() {
        Backend::MySql => ("IGNORE ", ""),
        _ => ("", " ON CONFLICT DO NOTHING"),
    };
    let insert_member = format!(
        "INSERT {ignore}INTO core.user_group_members (group_id, user_id) VALUES ($1, $2){on_conflict}"
    );
    for group_id in default_groups {
        let _ = state
            .db
            .execute(&insert_member, params![group_id, user.id])
            .await;
    }

    state.events.publish(crate::events::AppEvent::UserCreated {
        user_id: user.id,
        email: user.email.clone(),
    });

    Ok((StatusCode::CREATED, Json(json!({ "user": user }))))
}
