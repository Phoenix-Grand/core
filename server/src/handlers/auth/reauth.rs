//! Step-up re-authentication endpoints.
//!
//! - `GET  /auth/reauth/challenge` - which proofs this account can offer.
//! - `POST /auth/reauth`           - offer one, receive a short-lived proof.
//!
//! Both refuse a personal API token outright ([`HumanUser`]): a program holding a
//! long-lived credential has no second factor and nobody at the keyboard, so it
//! can never meet the challenge. That is a property of the design, not a gap.

use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    audit::{login_context, redact::target, AuditEntry},
    auth::{
        backup_codes,
        client_ip::ClientIp,
        reauth::{claims, guard::HumanUser, store},
        totp as totp_auth,
    },
    crypto::password,
    errors::AppError,
    state::AppState,
};

/// What the client needs to render the dialog.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ReauthChallenge {
    /// Accepted proofs, in the order the dialog should offer them.
    pub methods: Vec<String>,
    /// Lifetime of the proof once obtained.
    pub token_ttl_seconds: i64,
    /// How long afterwards sensitive actions pass unchallenged.
    pub grace_seconds: i64,
    /// End of an already-open grace window, when there is one - the client can
    /// then skip the dialog entirely.
    pub grace_active_until: Option<chrono::DateTime<chrono::Utc>>,
    /// Unused backup codes left, so the dialog can warn before offering that path.
    pub backup_codes_remaining: i64,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ReauthDto {
    #[serde(default)]
    pub password: Option<String>,
    /// Time-based code.
    #[serde(default)]
    pub code: Option<String>,
    /// Single-use backup code.
    #[serde(default)]
    pub backup_code: Option<String>,
}

/// Audit entry aimed at the account performing the challenge.
fn entry(action: &str, user: &crate::models::user::User) -> AuditEntry {
    AuditEntry::new(action)
        .module("core")
        .target(target::USER, user.id, user.username.clone())
}

/// Records a failed challenge and returns the (deliberately vague) error.
///
/// The caller is already authenticated, so there is nothing to enumerate - but a
/// message naming the factor that failed is the kind of detail that ends up in a
/// screenshot pasted into a support thread.
async fn deny(
    state: &AppState,
    ctx: &crate::audit::AuditContext,
    user: &crate::models::user::User,
    reason: &str,
) -> AppError {
    ctx.record(
        &state.db,
        entry("core.auth.reauth.failed", user).denied(reason),
    )
    .await;
    AppError::Validation("Preuve invalide".into())
}

#[utoipa::path(
    get,
    path = "/api/v1/auth/reauth/challenge",
    tag = "auth",
    responses((status = 200, description = "Preuves acceptées", body = ReauthChallenge))
)]
pub async fn reauth_challenge(
    State(state): State<AppState>,
    HumanUser(user): HumanUser,
) -> Result<Json<ReauthChallenge>, AppError> {
    let policy = store::policy(&state.db).await;

    // When a second factor is configured, the password alone is NOT accepted: a
    // stolen password is exactly the scenario the second factor answers, and a
    // step-up that a password satisfies would quietly downgrade the account's
    // protection at the moment it matters most.
    let methods: Vec<String> = if user.totp_enabled {
        vec!["totp".into(), "backup_code".into()]
    } else if user.password_hash.is_some() {
        vec!["password".into()]
    } else {
        // SSO-only account with no second factor: there is no local secret to
        // re-prove. Reported honestly rather than offering a dialog that cannot
        // succeed.
        Vec::new()
    };

    let remaining = if user.totp_enabled {
        backup_codes::status(&state.db, user.id).await?.remaining
    } else {
        0
    };

    Ok(Json(ReauthChallenge {
        methods,
        token_ttl_seconds: policy.token_ttl_s,
        grace_seconds: policy.grace_s,
        grace_active_until: store::grace_until(&state.db, user.id).await?,
        backup_codes_remaining: remaining,
    }))
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/reauth",
    tag = "auth",
    request_body = ReauthDto,
    responses(
        (status = 200, description = "Preuve fraîche émise"),
        (status = 403, description = "Un jeton d'API ne peut pas satisfaire un défi"),
        (status = 422, description = "Preuve invalide")
    )
)]
pub async fn reauth(
    State(state): State<AppState>,
    client_ip: ClientIp,
    headers: HeaderMap,
    HumanUser(user): HumanUser,
    Json(dto): Json<ReauthDto>,
) -> Result<Json<serde_json::Value>, AppError> {
    let ctx = login_context(&headers, client_ip, &user);

    let method = if user.totp_enabled {
        let submitted = dto
            .backup_code
            .as_deref()
            .or(dto.code.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AppError::Validation("Code de double authentification requis".into())
            })?;

        if backup_codes::looks_like_code(submitted) {
            match backup_codes::consume(&state.db, user.id, submitted, client_ip.0).await? {
                Some(remaining) => {
                    tracing::warn!(user_id = %user.id, remaining, "Réauthentification par code de secours");
                    ctx.record(
                        &state.db,
                        entry("core.auth.backup_code.used", &user).detail(format!(
                            "réauthentification - {remaining} code(s) de secours restant(s)"
                        )),
                    )
                    .await;
                    claims::ReauthMethod::BackupCode
                }
                None => return Err(deny(&state, &ctx, &user, "bad_backup_code").await),
            }
        } else {
            let encrypted = user.totp_secret.as_deref().ok_or_else(|| {
                AppError::Internal(anyhow::anyhow!("Secret TOTP absent malgré totp_enabled=true"))
            })?;
            let valid = totp_auth::verify_code(
                &state.settings.auth.jwt_secret,
                encrypted,
                submitted,
                &user.email,
            )
            .map_err(AppError::Internal)?;
            if !valid {
                return Err(deny(&state, &ctx, &user, "bad_totp_code").await);
            }
            claims::ReauthMethod::Totp
        }
    } else {
        let submitted = dto
            .password
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::Validation("Mot de passe requis".into()))?;
        let hash = user
            .password_hash
            .as_deref()
            .ok_or_else(|| AppError::Validation("Ce compte n'a pas de mot de passe local".into()))?;
        let ok = password::verify_password(submitted, hash).map_err(AppError::Internal)?;
        if !ok {
            return Err(deny(&state, &ctx, &user, "bad_password").await);
        }
        claims::ReauthMethod::Password
    };

    let policy = store::policy(&state.db).await;
    let jti = store::grant(&state.db, user.id, method, client_ip.0, policy).await?;
    let token = claims::issue(
        &state.settings.auth.jwt_secret,
        user.id,
        jti,
        method,
        policy.token_ttl_s,
    )?;

    ctx.record(
        &state.db,
        entry("core.auth.reauth.granted", &user).detail(method.as_str()),
    )
    .await;

    // The token is a credential: it goes in the body once, is never logged, and
    // is never written to the audit trail.
    Ok(Json(json!({
        "reauth_token":  token,
        "expires_in":    policy.token_ttl_s,
        "grace_seconds": policy.grace_s,
        "method":        method.as_str(),
    })))
}
