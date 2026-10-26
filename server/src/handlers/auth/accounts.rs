//! Google-style multi-account: the browser's cookie jar holds one refresh
//! token per signed-in account (`kb_account_<slot>`, see
//! [`super::tokens`]), the `refresh_token` cookie designating the ACTIVE one.
//!
//! `GET /auth/accounts` enumerates the jar - the panel's account list - and
//! `POST /auth/switch` re-points the active cookie at another slot. Switching
//! never touches any other account's session: each slot is an independent
//! `core.refresh_tokens` row, so revoking, expiring or idle-closing one leaves
//! the rest signed in, exactly like Google's `authuser` model.

use crate::{
    auth::jwt::JwtService,
    crypto::token,
    errors::AppError,
    models::session::LoginResponse,
    state::AppState,
};
use axum::{
    extract::State,
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use kubuno_db::dialect::SqlType;
use kubuno_db::params;
use serde::Deserialize;
use serde_json::{json, Value};

use super::refresh::{device_is_blocked, session_inventory};
use super::tokens::{read_slot_cookie, refresh_cookie, MAX_ACCOUNT_SLOTS};

/// One slot as the panel sees it. `connected: false` = the cookie is still
/// there but its session died server-side (revoked, expired, idle-closed):
/// the row shows « Déconnecté » with a re-connect button, like Google.
fn account_entry(slot: u8, active: bool, connected: bool, row: &AccountRow) -> Value {
    json!({
        "slot": slot,
        "active": active,
        "connected": connected,
        "user": {
            "id": row.user_id,
            "email": row.email,
            "username": row.username,
            "display_name": row.display_name,
            "avatar_url": row.avatar_url,
        },
    })
}

#[derive(sqlx::FromRow)]
struct AccountRow {
    user_id: uuid::Uuid,
    email: String,
    username: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
    live: bool,
    user_active: bool,
}

async fn slot_row(state: &AppState, raw: &str) -> Result<Option<AccountRow>, AppError> {
    let hash = token::hash_token(raw);
    let backend = state.db.backend();
    let sql = format!(
        r#"SELECT u.id AS user_id, {email} AS email, u.username, u.display_name, u.avatar_url,
                  (rt.revoked_at IS NULL AND rt.expires_at > $1) AS live,
                  u.is_active AS user_active
           FROM core.refresh_tokens rt
           JOIN core.users u ON u.id = rt.user_id
           WHERE rt.token_hash = $2"#,
        email = backend.cast("u.email", SqlType::Text),
    );
    state
        .db
        .fetch_optional_as::<AccountRow>(&sql, params![Utc::now(), &hash])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "accounts: reading a slot");
            AppError::Database(e)
        })
}

/// GET /auth/accounts - the signed-in accounts of THIS browser.
///
/// Unauthenticated on purpose: it reads nothing but the caller's own cookies,
/// exactly like the sign-in page's account chooser. A caller with no account
/// cookies gets an empty list.
pub async fn list_accounts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    let active_raw = refresh_cookie(&headers);
    let mut accounts = Vec::new();
    for slot in 0..MAX_ACCOUNT_SLOTS {
        let Some(raw) = read_slot_cookie(&headers, slot) else { continue };
        let Some(row) = slot_row(&state, &raw).await? else { continue };
        // A deactivated account disappears from the chooser entirely.
        if !row.user_active {
            continue;
        }
        let active = Some(raw.as_str()) == active_raw.as_deref();
        let connected = row.live;
        accounts.push(account_entry(slot, active, connected, &row));
    }
    Ok(Json(json!({ "accounts": accounts })))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct SwitchDto {
    pub slot: u8,
}

/// POST /auth/switch - make the account parked in `slot` the active session.
///
/// Validated exactly like a web refresh (live token, active user, device not
/// blocked, idle window): a parked account that no longer qualifies answers
/// 401, which the panel renders as « Déconnecté ».
pub async fn switch_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(dto): Json<SwitchDto>,
) -> Result<Response, AppError> {
    if dto.slot >= MAX_ACCOUNT_SLOTS {
        return Err(AppError::Validation("Invalid account slot".into()));
    }
    let raw = read_slot_cookie(&headers, dto.slot).ok_or(AppError::Unauthorized)?;
    let hash = token::hash_token(&raw);

    #[derive(sqlx::FromRow)]
    struct SlotSession {
        id: uuid::Uuid,
        user_id: uuid::Uuid,
        expires_at: chrono::DateTime<Utc>,
        last_used_at: chrono::DateTime<Utc>,
        live: bool,
    }
    let rt = state
        .db
        .fetch_optional_as::<SlotSession>(
            r#"SELECT id, user_id, expires_at, last_used_at, (revoked_at IS NULL) AS live
               FROM core.refresh_tokens WHERE token_hash = $1"#,
            params![&hash],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "switch: reading the slot session");
            AppError::Database(e)
        })?;
    let Some(SlotSession { id: session_id, user_id, expires_at, last_used_at, live }) = rt else {
        return Err(AppError::Unauthorized);
    };
    if !live || expires_at <= Utc::now() {
        return Err(AppError::Unauthorized);
    }

    let user = state
        .db
        .fetch_optional_as::<crate::models::user::User>(
            "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
            params![user_id],
        )
        .await?
        .ok_or(AppError::Unauthorized)?;

    let inventory = session_inventory(&state, session_id).await;
    if device_is_blocked(&state, inventory.device_id).await {
        return Err(AppError::Unauthorized);
    }

    let ttls = crate::config::runtime::security_ttls(&state.db, &state.settings).await;
    if let Some(idle) = ttls.idle_timeout {
        let idle_chrono =
            chrono::Duration::from_std(idle).unwrap_or_else(|_| chrono::Duration::days(3650));
        if Utc::now() - last_used_at > idle_chrono {
            state
                .db
                .execute(
                    "UPDATE core.refresh_tokens SET revoked_at = $1, revoke_reason = 'idle_timeout'
                     WHERE id = $2 AND revoked_at IS NULL",
                    params![Utc::now(), session_id],
                )
                .await?;
            return Err(AppError::Unauthorized);
        }
    }

    state
        .db
        .execute(
            "UPDATE core.refresh_tokens SET last_used_at = $1 WHERE id = $2",
            params![Utc::now(), session_id],
        )
        .await?;

    let jwt = JwtService::new(state.settings.auth.jwt_secret.clone(), ttls.access_ttl);
    let access_token = jwt.generate_access_token_for_session(&user, Some(session_id))?;

    // The active-session cookie now carries the slot's token. Max-Age follows
    // the session's real remaining lifetime, not a fresh TTL.
    let secure = if state.settings.server.secure_cookies { "; Secure" } else { "" };
    let remaining = (expires_at - Utc::now()).num_seconds().max(0);
    let cookie = format!(
        "refresh_token={raw}; HttpOnly{secure}; Path=/api/v1/auth; SameSite=Strict; Max-Age={remaining}",
    );

    tracing::info!(user_id = %user.id, slot = dto.slot, "Bascule de compte");
    let legacy = crate::auth::tickets::legacy_cookie(&state, &access_token, ttls.access_ttl.as_secs());
    let mut response = (
        [(header::SET_COOKIE, cookie)],
        Json(LoginResponse { access_token, user, slot: Some(dto.slot) }),
    )
        .into_response();
    // Deprecated compatibility cookie (HttpOnly), see `crate::auth::tickets`.
    if let Some(value) = legacy.and_then(|c| header::HeaderValue::from_str(&c).ok()) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    Ok(response)
}
