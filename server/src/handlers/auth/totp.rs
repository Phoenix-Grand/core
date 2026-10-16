//! Second factor verification (`POST /auth/totp`).
//!
//! Accepts either the time-based code or one of the account's single-use backup
//! codes. The backup code is a full substitute at this step and nowhere else: it
//! completes the sign-in exactly like a TOTP code would, and is then burnt.

use crate::{
    audit::{login_context, redact::target, AuditEntry},
    auth::{backup_codes, client_ip::ClientIp, jwt::JwtService, totp as totp_auth},
    errors::AppError,
    models::session::NativeTokenResponse,
    state::AppState,
};
use axum::{extract::State, http::HeaderMap, response::Response, Json};
use kubuno_db::params;
use serde::Deserialize;

use super::tokens::issue_full_tokens;

#[derive(Deserialize, utoipa::ToSchema)]
pub struct TotpVerifyDto {
    /// Time-based code. Optional when `backup_code` is supplied.
    #[serde(default)]
    pub code:         Option<String>,
    /// Single-use backup code, used **instead of** the time-based one.
    #[serde(default)]
    pub backup_code:  Option<String>,
    pub totp_session: String,
    /// Idem qu'au login : 'native'/'desktop' reçoivent le refresh en JSON.
    pub client_type:  Option<String>,
    /// Multi-compte : emplacement demandé (repassé depuis le login).
    #[serde(default)]
    pub slot:         Option<u8>,
}

/// How the second factor was cleared, for the audit trail.
#[derive(Clone, Copy)]
enum Cleared {
    Totp,
    /// Carries the number of codes still available afterwards.
    BackupCode(i64),
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/totp",
    tag = "auth",
    request_body = TotpVerifyDto,
    responses(
        (status = 200, description = "2FA validée, session émise", body = NativeTokenResponse),
        (status = 401, description = "Session TOTP invalide"),
        (status = 422, description = "Code incorrect")
    )
)]
pub async fn totp_verify(
    State(state): State<AppState>,
    client_ip: ClientIp,
    headers: HeaderMap,
    Json(dto): Json<TotpVerifyDto>,
) -> Result<Response, AppError> {
    let claims = JwtService::validate_totp_session(&state.settings.auth.jwt_secret, &dto.totp_session)
        .map_err(|_| AppError::Unauthorized)?;

    let user = state
        .db
        .fetch_optional_as::<crate::models::user::User>(
            "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
            params![claims.sub],
        )
        .await?
        .ok_or(AppError::Unauthorized)?;

    let encrypted = user
        .totp_secret
        .as_deref()
        .ok_or_else(|| AppError::Validation("2FA non configurée".into()))?;

    // A submission is routed by shape, not by which field the client filled in:
    // people paste their backup code into the field the dialog happens to focus,
    // and being locked out over that would defeat the purpose of having one.
    let submitted_backup = dto
        .backup_code
        .as_deref()
        .or(dto.code.as_deref())
        .filter(|s| backup_codes::looks_like_code(s))
        .map(|s| s.to_string());

    let cleared: Option<Cleared> = if let Some(candidate) = submitted_backup {
        backup_codes::consume(&state.db, user.id, &candidate, client_ip.0)
            .await?
            .map(Cleared::BackupCode)
    } else {
        let code = dto
            .code
            .as_deref()
            .ok_or_else(|| AppError::Validation("Code requis".into()))?;
        let valid = totp_auth::verify_code(
            &state.settings.auth.jwt_secret, encrypted, code, &user.email,
        )
        .map_err(AppError::Internal)?;
        valid.then_some(Cleared::Totp)
    };

    let Some(cleared) = cleared else {
        if user.role == "admin" {
            let ctx = login_context(&headers, client_ip, &user);
            ctx.record(
                &state.db,
                AuditEntry::new("core.auth.login_failed")
                    .module("core")
                    .target(target::USER, user.id, user.username.clone())
                    .denied("bad_totp_code"),
            )
            .await;
        }
        // Same message either way: telling the caller *which* factor was wrong
        // would confirm whether the account still has unused backup codes.
        return Err(AppError::Validation("Code incorrect".into()));
    };

    // Second factor cleared: this is where an administrator's sign-in actually
    // completes, so this is where it is recorded.
    if user.role == "admin" {
        let ctx = login_context(&headers, client_ip, &user);
        ctx.record(
            &state.db,
            AuditEntry::new("core.auth.login")
                .module("core")
                .target(target::USER, user.id, user.username.clone())
                .detail(match cleared {
                    Cleared::Totp => "2FA".to_string(),
                    Cleared::BackupCode(remaining) => {
                        format!("2FA (code de secours, {remaining} restant(s))")
                    }
                }),
        )
        .await;
    }

    // Consuming a backup code is audited for *every* account, not just
    // administrators: it is a rare, deliberate act, so it cannot be used to flood
    // the trail, and it is exactly what an operator looks for after a phone is
    // lost - or stolen. The code itself never appears, in any form.
    if let Cleared::BackupCode(remaining) = cleared {
        let ctx = login_context(&headers, client_ip, &user);
        ctx.record(
            &state.db,
            AuditEntry::new("core.auth.backup_code.used")
                .module("core")
                .target(target::USER, user.id, user.username.clone())
                .detail(format!("{remaining} code(s) de secours restant(s)")),
        )
        .await;
        tracing::warn!(
            user_id = %user.id,
            remaining,
            "Connexion par code de secours"
        );
    }

    // A backup code is not a second factor of the same strength as an authenticator:
    // it is a one-shot recovery credential, and the session list must be able to
    // tell them apart after a stolen phone.
    let strength = match cleared {
        Cleared::Totp => crate::devices::AuthStrength::PasswordTotp,
        Cleared::BackupCode(_) => crate::devices::AuthStrength::BackupCode,
    };

    issue_full_tokens(
        &state,
        &headers,
        client_ip,
        user,
        None,
        None,
        dto.client_type.as_deref(),
        strength,
        dto.slot,
    )
    .await
}
