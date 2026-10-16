//! Signing in a native client: `POST /auth/login`, and, when the account has a second factor, `POST /auth/totp`.
//!
//! A native sign-in sends `client_type: "native"`, which makes the server return the token pair in the JSON body
//! ([`NativeTokens`]) instead of setting an HttpOnly cookie — so the phone can keep the refresh token in its secret
//! store and refresh without a cookie jar. When the account has TOTP enabled the login answers `{requires_totp,
//! totp_session}` instead, and the code (or a backup code) is verified with [`verify_totp`].

use kubuno_desktop_api_client::ApiRequest;
use serde_json::json;

use crate::http::unauth_client;
use crate::model::NativeTokens;
use crate::{AccountError, AUTH_LOGIN, AUTH_TOTP};

/// What a sign-in needs: the server, the stable device key (sent as `X-Kubuno-Device-Key` and used to inventory the
/// device), a human device name, and the credentials.
#[derive(Clone, Debug)]
pub struct LoginOptions {
    pub server: String,
    pub device_key: String,
    pub device_name: String,
    /// Email or username.
    pub login: String,
    pub password: String,
}

/// The sign-in either completed with a token pair, or needs a second factor.
#[derive(Debug)]
pub enum LoginOutcome {
    /// Signed in: adopt these with [`crate::TokenOwner::adopt`].
    Tokens(NativeTokens),
    /// The account has TOTP: verify a code with [`verify_totp`] and this pending session.
    TotpRequired(TotpPending),
}

/// A sign-in paused on the second factor: carry it to [`verify_totp`].
#[derive(Clone, Debug)]
pub struct TotpPending {
    pub server: String,
    pub device_key: String,
    /// The short-lived session token the server issued to tie the password step to the TOTP step.
    pub totp_session: String,
}

/// Sign in with a password. Returns a token pair, or a pending TOTP session when the account has a second factor.
pub async fn login(opts: LoginOptions) -> Result<LoginOutcome, AccountError> {
    let api = unauth_client(&opts.server, &opts.device_key)?;
    let body = json!({
        "login": opts.login,
        "password": opts.password,
        // `client_type: "native"` makes the server return the refresh token in the body (no cookie).
        "client_type": "native",
        "device_name": opts.device_name,
        "device_type": "mobile",
    });
    let value = api.send(ApiRequest::post(AUTH_LOGIN).json(body).unauthenticated()).await?.json_value();
    if value.get("requires_totp").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        let totp_session =
            value.get("totp_session").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
        return Ok(LoginOutcome::TotpRequired(TotpPending {
            server: opts.server,
            device_key: opts.device_key,
            totp_session,
        }));
    }
    Ok(LoginOutcome::Tokens(tokens_from(value)?))
}

/// Finish a sign-in with the second factor: a time-based code or a single-use backup code (the server accepts either
/// here). Returns the token pair.
pub async fn verify_totp(pending: &TotpPending, code: &str) -> Result<NativeTokens, AccountError> {
    let api = unauth_client(&pending.server, &pending.device_key)?;
    let body = json!({
        "code": code,
        "totp_session": pending.totp_session,
        "client_type": "native",
    });
    let value = api.send(ApiRequest::post(AUTH_TOTP).json(body).unauthenticated()).await?.json_value();
    tokens_from(value)
}

/// Parse a `NativeTokenResponse` body, turning a shape mismatch into a clear error.
fn tokens_from(value: serde_json::Value) -> Result<NativeTokens, AccountError> {
    serde_json::from_value(value).map_err(|e| AccountError::Protocol(format!("sign-in response: {e}")))
}
