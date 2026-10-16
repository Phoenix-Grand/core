//! Refresh token rotation (`POST /auth/refresh`): reuse detection, idle timeout
//! and the rotation grace window for native clients.

use crate::{
    auth::jwt::JwtService,
    crypto::token,
    errors::AppError,
    models::session::NativeTokenResponse,
    state::AppState,
};
use axum::{
    extract::State,
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use kubuno_db::{params, Backend};
use serde_json::json;

use super::tokens::{refresh_cookie, RefreshRequest};

/// What a session already knows about its device, carried across a rotation.
#[derive(Debug, Default, Clone)]
pub(super) struct SessionInventory {
    pub(super) device_id: Option<uuid::Uuid>,
    country: Option<String>,
    auth_strength: Option<String>,
}

/// One row of the inventory carried across a rotation.
#[derive(sqlx::FromRow)]
struct InventoryRow {
    device_id: Option<uuid::Uuid>,
    country: Option<String>,
    auth_strength: Option<String>,
}

/// Reads it back. Best-effort: a rotation must never fail because the inventory
/// could not be consulted - the session is what keeps the user signed in, the
/// inventory is what tells an operator about it.
pub(super) async fn session_inventory(state: &AppState, session_id: uuid::Uuid) -> SessionInventory {
    let row = state
        .db
        .fetch_optional_as::<InventoryRow>(
            "SELECT device_id, country, auth_strength FROM core.refresh_tokens WHERE id = $1",
            params![session_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "refresh: reading the session's device");
            e
        })
        .ok()
        .flatten();

    match row {
        Some(r) => SessionInventory {
            device_id: r.device_id,
            country: r.country,
            auth_strength: r.auth_strength,
        },
        None => SessionInventory::default(),
    }
}

/// Is the device this session belongs to blocked?
///
/// The check lives on the refresh path because that is the only moment a
/// blocked machine comes back: an access token already issued keeps working
/// until it expires (fifteen minutes), and revoking the sessions at block time -
/// which the console does - closes that window from the other side.
pub(super) async fn device_is_blocked(state: &AppState, device_id: Option<uuid::Uuid>) -> bool {
    let Some(device_id) = device_id else {
        return false;
    };
    let approval: Option<String> = state
        .db
        .fetch_optional_scalar::<String>(
            "SELECT approval FROM core.devices WHERE id = $1",
            params![device_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, device_id = %device_id, "refresh: reading the device approval");
            e
        })
        .ok()
        .flatten();

    if approval.as_deref() != Some(crate::devices::Approval::Blocked.as_str()) {
        return false;
    }
    crate::devices::declared::block_denies_refresh(&state.db).await
}

/// Rotation grace: heals a native client that lost the successor token (killed
/// between the server rotation and its own persistence). Eligible only when the
/// successor has NEVER been used - it then gets superseded by a fresh token in
/// the same family. Returns None when the presentation must be treated as reuse.
async fn try_rotation_grace(
    state: &AppState,
    rt: &crate::models::session::RefreshToken,
) -> Result<Option<Response>, AppError> {
    let rotated_to: Option<uuid::Uuid> = state
        .db
        .fetch_scalar::<Option<uuid::Uuid>>(
            "SELECT rotated_to FROM core.refresh_tokens WHERE id = $1",
            params![rt.id],
        )
        .await?;
    let Some(succ_id) = rotated_to else { return Ok(None) };

    // Successor must be alive and virgin (last_used_at untouched since creation):
    // if it ever served, the old-token presentation is genuine reuse.
    let succ: Option<chrono::DateTime<Utc>> = state
        .db
        .fetch_optional_scalar::<chrono::DateTime<Utc>>(
            "SELECT expires_at FROM core.refresh_tokens
             WHERE id = $1 AND revoked_at IS NULL AND last_used_at = created_at",
            params![succ_id],
        )
        .await?;
    if succ.is_none() {
        return Ok(None);
    }

    let user = state
        .db
        .fetch_optional_as::<crate::models::user::User>(
            "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
            params![rt.user_id],
        )
        .await?
        .ok_or(AppError::Unauthorized)?;

    let ttls = crate::config::runtime::security_ttls(&state.db, &state.settings).await;
    let (new_raw, new_hash) = JwtService::generate_refresh_token();
    let new_expires = Utc::now() + ttls.refresh_ttl;
    let family = rt.family_id.unwrap_or(rt.id);

    let inventory = session_inventory(state, rt.id).await;

    // NOTE (migration consolidation): the `::inet` cast is PostgreSQL-only and is
    // spliced in only there, where `ip_address` is an INET column.
    let inet_cast = if state.db.backend() == Backend::Postgres { "::inet" } else { "" };
    let mut tx = state.db.begin().await?;
    tx.execute(
        "UPDATE core.refresh_tokens SET revoked_at = $1, revoke_reason = 'rotation_grace_superseded' WHERE id = $2",
        params![Utc::now(), succ_id],
    )
    .await?;
    // The id is minted in Rust instead of relying on RETURNING (unsupported on
    // MySQL). Rotation issues a NEW row for the SAME device: losing the inventory
    // link here would empty the inventory of every native client after its first
    // refresh.
    let new_id = kubuno_db::new_id();
    tx.execute(
        &format!(
            r#"INSERT INTO core.refresh_tokens
               (id, user_id, token_hash, device_name, device_type, ip_address, user_agent,
                expires_at, family_id, client_type, device_id, country, auth_strength)
               VALUES ($1, $2, $3, $4, $5, $6{inet_cast}, $7, $8, $9, $10, $11, $12, $13)"#
        ),
        params![
            new_id,
            rt.user_id,
            &new_hash,
            rt.device_name.as_deref(),
            rt.device_type.as_deref(),
            rt.ip_address.as_deref(),
            rt.user_agent.as_deref(),
            new_expires,
            family,
            rt.client_type.as_deref().unwrap_or("native"),
            inventory.device_id,
            inventory.country.as_deref(),
            inventory.auth_strength.as_deref()
        ],
    )
    .await?;
    // Repoint (revoked_at unchanged → the grace window stays anchored at the
    // ORIGINAL rotation, a crash-loop cannot extend it indefinitely).
    tx.execute(
        "UPDATE core.refresh_tokens SET rotated_to = $1 WHERE id = $2",
        params![new_id, rt.id],
    )
    .await?;
    tx.commit().await?;

    tracing::info!(user_id = %rt.user_id, family_id = %family, "Rotation grace served (virgin successor replaced)");

    let jwt = JwtService::new(state.settings.auth.jwt_secret.clone(), ttls.access_ttl);
    let access_token = jwt.generate_access_token_for_session(&user, Some(family))?;
    Ok(Some(
        Json(NativeTokenResponse {
            access_token,
            refresh_token: new_raw,
            refresh_expires_at: new_expires,
            user,
        })
        .into_response(),
    ))
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/refresh",
    tag = "auth",
    request_body(content = RefreshRequest, description = "Optionnel - clients natifs. Le web envoie le refresh via cookie."),
    responses(
        (status = 200, description = "Nouveau couple (natif, avec rotation) ou nouvel access_token (web)", body = NativeTokenResponse),
        (status = 401, description = "Refresh invalide, expiré ou réutilisé")
    )
)]
pub async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, AppError> {
    // Refresh source: JSON body (native) first, otherwise cookie (web).
    let body_token: Option<String> = if body.is_empty() {
        None
    } else {
        serde_json::from_slice::<RefreshRequest>(&body)
            .ok()
            .map(|r| r.refresh_token)
    };
    let is_native = body_token.is_some();
    let refresh_raw = body_token
        .or_else(|| refresh_cookie(&headers))
        .ok_or(AppError::Unauthorized)?;

    let refresh_hash = token::hash_token(&refresh_raw);

    // We fetch the token WITHOUT filtering on revoked_at, to detect the reuse of
    // an already-rotated token (a sign of theft).
    //
    // NOTE (migration consolidation): PostgreSQL's `host(...)::text` extracts the
    // textual address from the INET column; on the other engines `ip_address` is
    // already text, so the bare column is selected.
    let backend = state.db.backend();
    let ip_expr = if backend == Backend::Postgres {
        "host(ip_address)::text"
    } else {
        "ip_address"
    };
    let rt = state
        .db
        .fetch_optional_as::<crate::models::session::RefreshToken>(
            &format!(
                r#"SELECT id, user_id, token_hash, device_name, device_type,
                      {ip_expr} as ip_address, user_agent,
                      expires_at, created_at, last_used_at, revoked_at, revoke_reason,
                      family_id, client_type
               FROM core.refresh_tokens
               WHERE token_hash = $1"#
            ),
            params![&refresh_hash],
        )
        .await?
        .ok_or(AppError::Unauthorized)?;

    // Reuse detection: an already-rotated token presented again ⇒ we revoke the
    // whole device family (the thief AND the legitimate user must sign in again).
    //
    // ROTATION GRACE: a native client killed/crashed BETWEEN the server rotation
    // and its persistence of the new token replays the old one on restart - this
    // is not theft. If the successor has NEVER served, `try_rotation_grace`
    // replaces it with a fresh token instead of revoking the family; an already
    // used successor returns None → we fall back to the revocation below.
    //
    // WINDOW: a VIRGIN successor alone proves the crash case (a thief who
    // intercepted the rotation would present the successor, not the old token),
    // so the window is wide (24 h) - a dev loop that kills/restarts the app well
    // beyond 60 s stays clean. It remains anchored on the ORIGINAL `revoked_at`
    // (grace does not move it), so a crash-loop cannot extend it indefinitely;
    // and the "successor already used" case keeps the immediate revocation (via
    // the None from `try_rotation_grace`).
    if let Some(revoked_at) = rt.revoked_at {
        if rt.revoke_reason.as_deref() == Some("rotated") {
            const ROTATION_GRACE_SECS: i64 = 24 * 60 * 60;
            let in_grace = is_native
                && Utc::now() - revoked_at <= chrono::Duration::seconds(ROTATION_GRACE_SECS);
            if in_grace {
                if let Some(healed) = try_rotation_grace(&state, &rt).await? {
                    return Ok(healed);
                }
            }
            let family = rt.family_id.unwrap_or(rt.id);
            state
                .db
                .execute(
                    "UPDATE core.refresh_tokens SET revoked_at = $1, revoke_reason = 'reuse_detected'
                     WHERE family_id = $2 AND revoked_at IS NULL",
                    params![Utc::now(), family],
                )
                .await?;
            tracing::warn!(user_id = %rt.user_id, family_id = %family, "Refresh token reuse detected - family revoked");
        }
        return Err(AppError::Unauthorized);
    }

    if rt.expires_at <= Utc::now() {
        return Err(AppError::Unauthorized);
    }

    let user = state
        .db
        .fetch_optional_as::<crate::models::user::User>(
            "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
            params![rt.user_id],
        )
        .await?
        .ok_or(AppError::Unauthorized)?;

    // Blocked device: the session no longer renews and closes.
    let inventory = session_inventory(&state, rt.id).await;
    if device_is_blocked(&state, inventory.device_id).await {
        state
            .db
            .execute(
                "UPDATE core.refresh_tokens SET revoked_at = $1, revoke_reason = 'device_blocked'
                 WHERE id = $2 AND revoked_at IS NULL",
                params![Utc::now(), rt.id],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "refresh: closing a blocked-device session");
                AppError::Database(e)
            })?;
        tracing::warn!(user_id = %rt.user_id, "Renewal refused: device blocked");
        return Err(AppError::Unauthorized);
    }

    let ttls = crate::config::runtime::security_ttls(&state.db, &state.settings).await;

    // INACTIVITY sign-out: if the refresh token has not served for longer than
    // `idle_timeout`, we revoke it → the user must sign in again.
    if let Some(idle) = ttls.idle_timeout {
        let idle_chrono = chrono::Duration::from_std(idle).unwrap_or_else(|_| chrono::Duration::days(3650));
        if Utc::now() - rt.last_used_at > idle_chrono {
            state
                .db
                .execute(
                    "UPDATE core.refresh_tokens SET revoked_at = $1, revoke_reason = 'idle_timeout' WHERE id = $2",
                    params![Utc::now(), rt.id],
                )
                .await?;
            return Err(AppError::Unauthorized);
        }
    }

    let jwt = JwtService::new(state.settings.auth.jwt_secret.clone(), ttls.access_ttl);
    let access_token = jwt.generate_access_token_for_session(&user, Some(rt.family_id.unwrap_or(rt.id)))?;

    // Native client: ROTATION. We revoke the old refresh and issue a new one in
    // the same family, transmitted in JSON.
    if is_native {
        let (new_raw, new_hash) = JwtService::generate_refresh_token();
        let new_expires = Utc::now() + ttls.refresh_ttl;
        let family = rt.family_id.unwrap_or(rt.id);

        // NOTE (migration consolidation): the `::inet` cast is PostgreSQL-only.
        let inet_cast = if backend == Backend::Postgres { "::inet" } else { "" };
        let mut tx = state.db.begin().await?;
        // The id is minted in Rust in place of RETURNING. Same device, new row:
        // the inventory link is carried across the rotation, otherwise every
        // native client would vanish from it on its first refresh.
        let new_id = kubuno_db::new_id();
        tx.execute(
            &format!(
                r#"INSERT INTO core.refresh_tokens
                   (id, user_id, token_hash, device_name, device_type, ip_address, user_agent,
                    expires_at, family_id, client_type, device_id, country, auth_strength)
                   VALUES ($1, $2, $3, $4, $5, $6{inet_cast}, $7, $8, $9, $10, $11, $12, $13)"#
            ),
            params![
                new_id,
                rt.user_id,
                &new_hash,
                rt.device_name.as_deref(),
                rt.device_type.as_deref(),
                rt.ip_address.as_deref(),
                rt.user_agent.as_deref(),
                new_expires,
                family,
                rt.client_type.as_deref().unwrap_or("native"),
                inventory.device_id,
                inventory.country.as_deref(),
                inventory.auth_strength.as_deref()
            ],
        )
        .await?;
        // rotated_to feeds the rotation grace (crash between rotation and persistence).
        tx.execute(
            "UPDATE core.refresh_tokens SET revoked_at = $1, revoke_reason = 'rotated', rotated_to = $2 WHERE id = $3",
            params![Utc::now(), new_id, rt.id],
        )
        .await?;
        tx.commit().await?;

        return Ok(Json(NativeTokenResponse {
            access_token,
            refresh_token: new_raw,
            refresh_expires_at: new_expires,
            user,
        })
        .into_response());
    }

    // Web: no rotation, we just update activity and return a new access token
    // (the refresh stays in the cookie).
    state
        .db
        .execute(
            "UPDATE core.refresh_tokens SET last_used_at = $1 WHERE id = $2",
            params![Utc::now(), rt.id],
        )
        .await?;

    // "Last seen" must mean last seen, not last signed in: a browser open for a
    // fortnight would otherwise look abandoned in the inventory.
    if let Some(device_id) = inventory.device_id {
        if let Err(e) = state
            .db
            .execute(
                "UPDATE core.devices SET last_seen_at = $1 WHERE id = $2",
                params![Utc::now(), device_id],
            )
            .await
        {
            tracing::error!(error = %e, device_id = %device_id, "refresh: updating device activity");
        }
    }

    let mut response = Json(json!({ "access_token": access_token })).into_response();
    // Deprecated compatibility cookie (HttpOnly), see `crate::auth::tickets`.
    if let Some(c) =
        crate::auth::tickets::legacy_cookie(&state, &access_token, ttls.access_ttl.as_secs())
    {
        if let Ok(v) = header::HeaderValue::from_str(&c) {
            response.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    Ok(response)
}
