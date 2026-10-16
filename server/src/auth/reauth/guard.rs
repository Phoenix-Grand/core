//! The extractor a sensitive handler takes instead of [`AuthUser`].
//!
//! It authenticates exactly like `AuthUser` and then adds one condition: the
//! caller must have proved presence recently - either by presenting a re-auth
//! token in `X-Reauth-Token`, or by being inside the grace window opened by an
//! earlier proof.
//!
//! Refusals are **distinguishable**, which is the whole reason the mechanism
//! exists. A plain `Forbidden` tells a client nothing it can act on; here the
//! client receives `REAUTH_REQUIRED` and knows to open the dialog and replay.

use axum::{extract::FromRequestParts, http::request::Parts};
use uuid::Uuid;

use super::{claims, store};
use crate::{
    audit::{context_from, AuditEntry},
    auth::middleware::{AuthSource, AuthUser},
    errors::AppError,
    models::user::User,
    state::AppState,
};

/// Header carrying the proof. Never logged, never echoed back.
pub const REAUTH_HEADER: &str = "x-reauth-token";

/// An authenticated caller that is a **person**, not a program.
///
/// Used by the challenge routes themselves. Letting a personal API token mint a
/// re-auth proof would hand every sensitive action to whoever holds the token -
/// the exact outcome step-up exists to prevent - so the refusal is enforced at
/// the door rather than checked again in each handler.
pub struct HumanUser(pub User);

#[axum::async_trait]
impl FromRequestParts<AppState> for HumanUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let AuthUser(user) = AuthUser::from_request_parts(parts, state).await?;
        let origin = parts.extensions.get::<AuthSource>().map(|s| s.origin);
        if matches!(origin, Some(crate::audit::ActorOrigin::ApiToken)) {
            record(state, parts, &user, "api_token_cannot_reauth").await;
            return Err(AppError::ReauthImpossible);
        }
        Ok(Self(user))
    }
}

/// An authenticated user who has proved presence recently.
pub struct Reauthenticated {
    pub user: User,
    /// How the proof was obtained; `None` when it came from the grace window.
    pub method: Option<claims::ReauthMethod>,
}

impl Reauthenticated {
    pub fn user(&self) -> &User {
        &self.user
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for Reauthenticated {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let AuthUser(user) = AuthUser::from_request_parts(parts, state).await?;

        // A personal API token can never satisfy the challenge, and this is a
        // property rather than a gap: step-up asks a *human* to prove presence,
        // and a program holding a long-lived credential has no second factor and
        // nobody at the keyboard. Answering REAUTH_REQUIRED here would send an
        // unattended script into a retry loop it can never win, so the refusal is
        // final and says so.
        let origin = parts.extensions.get::<AuthSource>().map(|s| s.origin);
        if matches!(origin, Some(crate::audit::ActorOrigin::ApiToken)) {
            record(state, parts, &user, "api_token_cannot_reauth").await;
            return Err(AppError::ReauthImpossible);
        }

        if let Some(method) = presented_proof(state, parts, user.id).await? {
            return Ok(Self { user, method: Some(method) });
        }

        if store::grace_until(&state.db, user.id).await?.is_some() {
            return Ok(Self { user, method: None });
        }

        record(state, parts, &user, "reauth_required").await;
        Err(AppError::ReauthRequired)
    }
}

/// Validates the `X-Reauth-Token` header, if present.
///
/// Three independent conditions, all required: the signature must verify under
/// the re-auth key, the token must belong to the *calling* account (a proof
/// obtained by one operator is not transferable), and its grant must still be
/// live in the database (revocation).
async fn presented_proof(
    state: &AppState,
    parts: &Parts,
    user_id: Uuid,
) -> Result<Option<claims::ReauthMethod>, AppError> {
    let Some(raw) = parts
        .headers
        .get(REAUTH_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    else {
        return Ok(None);
    };

    let Ok(c) = claims::validate(&state.settings.auth.jwt_secret, raw) else {
        return Ok(None);
    };
    if c.sub != user_id {
        return Ok(None);
    }
    if !store::is_live(&state.db, c.jti, user_id).await? {
        return Ok(None);
    }
    Ok(Some(c.method))
}

/// Records the refusal. A sensitive action attempted without a fresh proof is a
/// signal in its own right - the same reasoning that puts refused administrative
/// calls in the trail.
async fn record(state: &AppState, parts: &Parts, user: &User, reason: &str) {
    let ctx = context_from(parts, user);
    ctx.record(
        &state.db,
        AuditEntry::new("core.auth.reauth.challenged")
            .module("core")
            .target(
                crate::audit::redact::target::ROUTE,
                parts.uri.path(),
                format!("{} {}", parts.method, parts.uri.path()),
            )
            .denied(reason),
    )
    .await;
}
