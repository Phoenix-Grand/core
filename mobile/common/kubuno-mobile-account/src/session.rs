//! A signed-in session - the account, its token owner and an authenticated API client - and the server checks that
//! come before a sign-in.

use std::sync::Arc;

use kubuno_desktop_api_client::{ApiClient, ApiRequest};
use serde_json::json;

use crate::device::{accounts, forget_account, remember};
use crate::http::{authed_client, unauth_client};
use crate::model::{Account, NativeTokens, User};
use crate::secret::SecretStore;
use crate::token_owner::TokenOwner;
use crate::{AccountError, AUTH_LOGOUT};

/// The current user's profile (`{"user": …}`).
pub const ME: &str = "/api/v1/me";
/// The core's liveness probe (`{"status":"ok", "version": …}`), at the server root.
pub const HEALTH: &str = "/health";

/// An account signed in on this phone, ready to call its server.
#[derive(Clone)]
pub struct Session {
    pub account: Account,
    pub owner: Arc<TokenOwner>,
    /// The authenticated client: every request carries a fresh access token and retries once on 401.
    pub api: ApiClient,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session").field("account", &self.account).finish_non_exhaustive()
    }
}

impl Session {
    /// Open the session a sign-in produced: keep the refresh token in the secret store and remember the account as the
    /// most recent one.
    pub fn adopt(
        store: Arc<dyn SecretStore>,
        server: &str,
        device_key: &str,
        tokens: NativeTokens,
    ) -> Result<Self, AccountError> {
        let account = Account {
            server: server.to_string(),
            user_id: tokens.user.id.clone(),
            label: tokens.user.label(),
            device_key: device_key.to_string(),
        };
        let owner = Arc::new(TokenOwner::adopt(&account, store.clone(), tokens)?);
        remember(store.as_ref(), &account)?;
        let api = authed_client(&account.server, &account.device_key, owner.clone())?;
        Ok(Self { account, owner, api })
    }

    /// Reopen, at launch, the most recent account that still has a refresh token here. `Ok(None)` when there is none
    /// (first launch, or signed out). Offline-safe: nothing is sent until the first request.
    pub fn restore_last(store: Arc<dyn SecretStore>) -> Result<Option<Self>, AccountError> {
        for account in accounts(store.as_ref())? {
            if let Some(owner) = TokenOwner::restore(&account, store.clone())? {
                let owner = Arc::new(owner);
                let api = authed_client(&account.server, &account.device_key, owner.clone())?;
                return Ok(Some(Self { account, owner, api }));
            }
        }
        Ok(None)
    }

    /// The signed-in user, from the server (`GET /api/v1/me`). Also proves the session works end to end.
    pub async fn me(&self) -> Result<User, AccountError> {
        let value = self.api.send(ApiRequest::get(ME)).await?.json_value();
        let user = value.get("user").cloned().unwrap_or(value);
        serde_json::from_value(user).map_err(|e| AccountError::Protocol(format!("profile: {e}")))
    }

    /// Sign out: close the session on the server (best effort - a phone offline still signs out locally), then forget
    /// the refresh token and the account here.
    pub async fn sign_out(&self, store: Arc<dyn SecretStore>) -> Result<(), AccountError> {
        let refresh = self.owner.current_refresh().await;
        if let Ok(api) = unauth_client(&self.account.server, &self.account.device_key) {
            let req = ApiRequest::post(AUTH_LOGOUT).json(json!({ "refresh_token": refresh })).unauthenticated();
            if let Err(e) = api.send(req).await {
                tracing::warn!("server sign-out failed (signing out locally anyway): {e}");
            }
        }
        self.owner.forget()?;
        forget_account(store.as_ref(), &self.account.server, &self.account.user_id)?;
        Ok(())
    }
}

/// Turn what the user typed into a server base URL: trimmed, `https://` added when no scheme is given, no trailing
/// slash. Rejects an empty or malformed address.
pub fn normalize_server(input: &str) -> Result<String, AccountError> {
    let s = input.trim();
    if s.is_empty() || s.contains(char::is_whitespace) {
        return Err(AccountError::InvalidServer);
    }
    let (scheme, rest) = s.split_once("://").unwrap_or(("https", s));
    let rest = rest.trim_end_matches('/');
    if !(scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http"))
        || rest.is_empty()
        || rest.starts_with('/')
    {
        return Err(AccountError::InvalidServer);
    }
    Ok(format!("{}://{rest}", scheme.to_ascii_lowercase()))
}

/// Check that `server` is a Kubuno server before asking for credentials: `GET /health` must answer `{"status":"ok"}`.
/// Returns the server's version.
pub async fn probe_server(server: &str, device_key: &str) -> Result<String, AccountError> {
    let api = unauth_client(server, device_key)?;
    let value = api.send(ApiRequest::get(HEALTH).unauthenticated()).await.map_err(|e| match e.status() {
        // Any HTTP answer other than the health document: something answers, but it is not a Kubuno core.
        Some(_) => AccountError::NotKubuno,
        None => AccountError::Api(e),
    })?;
    let value = value.json_value();
    if value.get("status").and_then(serde_json::Value::as_str) != Some("ok") {
        return Err(AccountError::NotKubuno);
    }
    Ok(value.get("version").and_then(serde_json::Value::as_str).unwrap_or_default().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_addresses_are_normalised() {
        assert_eq!(normalize_server(" dev.kubuno.com/ ").unwrap(), "https://dev.kubuno.com");
        assert_eq!(normalize_server("http://10.0.2.2:8787").unwrap(), "http://10.0.2.2:8787");
        assert!(normalize_server("").is_err());
        assert!(normalize_server("https://").is_err());
        assert!(normalize_server("a b").is_err());
    }
}
