//! Backup codes for the second factor (`/me/2fa/backup-codes`).
//!
//! - `GET`  - how many are left. A counter, never a code.
//! - `POST` - print a fresh sheet, invalidating the previous one. Sensitive: it
//!   is guarded by [`Reauthenticated`], because reprinting the codes that bypass
//!   the second factor is exactly as powerful as removing the second factor.
//!
//! The plaintext codes exist in a response body **once**, when they are created
//! (here and at `/me/2fa/enable`). There is no route that returns them again, and
//! adding one would defeat the point of hashing them.

use axum::{extract::State, http::HeaderMap, Json};
use serde_json::json;

use crate::{
    audit::{login_context, redact::target, AuditEntry},
    auth::{backup_codes, client_ip::ClientIp, middleware::AuthUser, reauth::Reauthenticated},
    errors::AppError,
    state::AppState,
};

#[utoipa::path(
    get,
    path = "/api/v1/me/2fa/backup-codes",
    tag = "auth",
    responses((status = 200, description = "Compteurs des codes de secours"))
)]
pub async fn get_status(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<backup_codes::BackupCodeStatus>, AppError> {
    Ok(Json(backup_codes::status(&state.db, user.id).await?))
}

#[utoipa::path(
    post,
    path = "/api/v1/me/2fa/backup-codes",
    tag = "auth",
    responses(
        (status = 200, description = "Nouveau lot de codes - affiché une seule fois"),
        (status = 403, description = "Réauthentification requise (REAUTH_REQUIRED)")
    )
)]
pub async fn regenerate(
    State(state): State<AppState>,
    client_ip: ClientIp,
    headers: HeaderMap,
    proof: Reauthenticated,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = proof.user().clone();

    if !user.totp_enabled {
        return Err(AppError::Validation(
            "Activez d'abord la double authentification".into(),
        ));
    }

    let codes = backup_codes::replace_all(&state.db, user.id).await?;

    // Audited for every account: regenerating is how an attacker who briefly held
    // a session would give themselves durable access, and the previous sheet
    // becoming worthless is something the legitimate owner must be able to see.
    // The entry records the count and the method that satisfied the challenge -
    // never a code, in clear or hashed.
    let ctx = login_context(&headers, client_ip, &user);
    ctx.record(
        &state.db,
        AuditEntry::new("core.auth.backup_codes.regenerate")
            .module("core")
            .target(target::USER, user.id, user.username.clone())
            .detail(match proof.method {
                Some(m) => format!("{} codes émis (preuve : {})", codes.len(), m.as_str()),
                None => format!("{} codes émis (fenêtre de grâce)", codes.len()),
            }),
    )
    .await;

    let status = backup_codes::status(&state.db, user.id).await?;

    Ok(Json(json!({
        "codes":  codes,
        "status": status,
    })))
}
