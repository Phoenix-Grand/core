//! The mobile token owner: the phone holds its own refresh token (there is no broker, unlike the multi-account
//! desktop shell), so this is both the thing that owns the refresh token and the [`TokenSource`] the API client pulls
//! access tokens from.
//!
//! It keeps a 15-minute access JWT in memory and the long-lived refresh token in the OS secret store. When the access
//! token is missing or about to expire it refreshes: `POST /auth/refresh {refresh_token}` returns a **rotated** pair
//! (the old refresh token is now spent), so the new one is written to the secret store **before** it is used. A
//! `tokio::Mutex` serialises refreshes, which is the single-flight the server's reuse detection needs: two concurrent
//! requests never both refresh the same token. A rejected refresh (401/403) is a genuinely expired session; a network
//! error, 429 or 5xx is transient and must never be reported as a lost session.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use kubuno_desktop_api_client::{AccessToken, ApiError, ApiRequest, AuthError, TokenSource};
use tokio::sync::Mutex;

use crate::http::unauth_client;
use crate::model::{Account, NativeTokens};
use crate::secret::{refresh_key, SecretStore};
use crate::{AccountError, AUTH_REFRESH};

/// Refresh once the access token has this many seconds or fewer left (or is missing / opaque).
const REFRESH_SKEW_S: i64 = 60;

/// The mutable part, behind the refresh lock.
struct State {
    /// The current access token, if one has been obtained and is cached.
    access: Option<AccessToken>,
    /// The current (un-spent) refresh token.
    refresh: String,
}

/// Owns an account's tokens and hands out access tokens. Build it from a fresh sign-in with [`TokenOwner::adopt`], or
/// restore it on launch with [`TokenOwner::restore`]. Wrap it in an `Arc` and pass it to
/// [`crate::authed_client`] as the token source.
pub struct TokenOwner {
    server: String,
    device_key: String,
    secret_key: String,
    store: Arc<dyn SecretStore>,
    /// An unauthenticated client of the server, used only to call the refresh endpoint.
    refresh_api: kubuno_desktop_api_client::ApiClient,
    state: Mutex<State>,
}

impl TokenOwner {
    /// Take ownership of the tokens a sign-in returned: write the refresh token to the secret store and keep the
    /// access token in memory.
    pub fn adopt(account: &Account, store: Arc<dyn SecretStore>, tokens: NativeTokens) -> Result<Self, AccountError> {
        let secret_key = refresh_key(&account.server, &account.user_id);
        store.store(&secret_key, &tokens.refresh_token)?;
        Ok(Self {
            refresh_api: unauth_client(&account.server, &account.device_key)?,
            server: account.server.clone(),
            device_key: account.device_key.clone(),
            secret_key,
            store,
            state: Mutex::new(State { access: Some(AccessToken::new(tokens.access_token)), refresh: tokens.refresh_token }),
        })
    }

    /// Restore an owner on launch from the refresh token kept in the secret store. `Ok(None)` if there is no stored
    /// token for this account (never signed in here, or signed out). The access token is fetched lazily on first use.
    pub fn restore(account: &Account, store: Arc<dyn SecretStore>) -> Result<Option<Self>, AccountError> {
        let secret_key = refresh_key(&account.server, &account.user_id);
        let Some(refresh) = store.load(&secret_key)? else { return Ok(None) };
        Ok(Some(Self {
            refresh_api: unauth_client(&account.server, &account.device_key)?,
            server: account.server.clone(),
            device_key: account.device_key.clone(),
            secret_key,
            store,
            state: Mutex::new(State { access: None, refresh }),
        }))
    }

    /// The server this owner authenticates against.
    pub fn server(&self) -> &str {
        &self.server
    }

    /// The device key sent on every request for this account.
    pub fn device_key(&self) -> &str {
        &self.device_key
    }

    /// Forget the account on this device: drop the refresh token from the secret store. The server session is left
    /// to expire (or is closed separately with `POST /auth/logout`).
    pub fn forget(&self) -> Result<(), AccountError> {
        self.store.delete(&self.secret_key)?;
        Ok(())
    }

    /// Refresh the tokens (the caller holds the lock). Writes the rotated refresh token to the secret store **before**
    /// it is used, so a crash never leaves us with a spent token and no record of its successor.
    async fn refresh_locked(&self, state: &mut State) -> Result<AccessToken, AuthError> {
        let req = ApiRequest::post(AUTH_REFRESH)
            .json(serde_json::json!({ "refresh_token": state.refresh }))
            .unauthenticated();
        let resp = self.refresh_api.send(req).await.map_err(refresh_error)?;
        let tokens: NativeTokens =
            resp.json().map_err(|e| AuthError::Transient(format!("refresh response: {e}")))?;

        // Persist the rotated refresh token first. If the store write fails we keep serving this process from memory
        // (the token is valid) but log it: on next launch the restore would otherwise use the spent token.
        if let Err(e) = self.store.store(&self.secret_key, &tokens.refresh_token) {
            tracing::error!("could not persist the rotated refresh token: {e}");
        }
        let access = AccessToken::new(tokens.access_token);
        state.refresh = tokens.refresh_token;
        state.access = Some(access.clone());
        Ok(access)
    }

    /// Whether `access` is usable for a while longer (its `exp` is more than the skew away). An opaque token has no
    /// `exp`, so it is always refreshed.
    fn is_fresh(access: &AccessToken) -> bool {
        match access.jwt_expiry() {
            Some(exp) => exp - now_s() > REFRESH_SKEW_S,
            None => false,
        }
    }
}

#[async_trait]
impl TokenSource for TokenOwner {
    async fn access_token(&self) -> Result<AccessToken, AuthError> {
        let mut state = self.state.lock().await;
        if let Some(access) = &state.access {
            if Self::is_fresh(access) {
                return Ok(access.clone());
            }
        }
        self.refresh_locked(&mut state).await
    }

    async fn after_unauthorized(&self, failed: &AccessToken) -> Result<AccessToken, AuthError> {
        let mut state = self.state.lock().await;
        // Another request may have refreshed while we waited for the lock: if the cached token is no longer the one
        // that was rejected, use it instead of refreshing again.
        if let Some(access) = &state.access {
            if access != failed {
                return Ok(access.clone());
            }
        }
        self.refresh_locked(&mut state).await
    }
}

/// Map a failed refresh call to an [`AuthError`]: a 401/403 means the refresh token was rejected (expired session);
/// anything else (network, 429, 5xx) is transient and must not end the session.
fn refresh_error(e: ApiError) -> AuthError {
    match e.status() {
        Some(401) | Some(403) => AuthError::SessionExpired,
        _ => AuthError::Transient(e.to_string()),
    }
}

/// Seconds since the Unix epoch (local clock), for comparing against a JWT `exp`.
fn now_s() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::MemorySecretStore;

    fn account() -> Account {
        Account {
            server: "https://dev.kubuno.com".into(),
            user_id: "u-1".into(),
            label: "Test".into(),
            device_key: "dev-key".into(),
        }
    }

    // A JWT whose `exp` is `exp` seconds since the epoch (unsigned; the client reads the claim without verifying).
    fn jwt_with_exp(exp: i64) -> String {
        // header {"alg":"none"} . payload {"exp":<exp>} . (no signature)
        let b64 = |b: &[u8]| {
            // minimal base64url without padding
            const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut o = String::new();
            for c in b.chunks(3) {
                let b0 = c[0] as u32;
                let b1 = *c.get(1).unwrap_or(&0) as u32;
                let b2 = *c.get(2).unwrap_or(&0) as u32;
                let n = (b0 << 16) | (b1 << 8) | b2;
                o.push(A[(n >> 18 & 63) as usize] as char);
                o.push(A[(n >> 12 & 63) as usize] as char);
                if c.len() > 1 {
                    o.push(A[(n >> 6 & 63) as usize] as char);
                }
                if c.len() > 2 {
                    o.push(A[(n & 63) as usize] as char);
                }
            }
            o
        };
        format!("{}.{}.sig", b64(br#"{"alg":"none"}"#), b64(format!(r#"{{"exp":{exp}}}"#).as_bytes()))
    }

    #[test]
    fn adopt_persists_the_refresh_token_and_keeps_the_access_token() {
        let store = Arc::new(MemorySecretStore::new());
        let tokens = NativeTokens {
            access_token: jwt_with_exp(now_s() + 900),
            refresh_token: "refresh-1".into(),
            refresh_expires_at: None,
            user: crate::model::User { id: "u-1".into(), email: None, display_name: None, username: None },
        };
        let owner = TokenOwner::adopt(&account(), store.clone(), tokens).expect("adopt");
        assert_eq!(store.load(&refresh_key("https://dev.kubuno.com", "u-1")).unwrap().as_deref(), Some("refresh-1"));
        // A fresh (long-lived) access token is served from memory without touching the network.
        let got = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(owner.access_token())
            .expect("access");
        assert!(got.jwt_expiry().expect("exp") >= now_s() + 800);
    }

    #[test]
    fn restore_reads_the_stored_token_or_reports_none() {
        let store = Arc::new(MemorySecretStore::new());
        assert!(TokenOwner::restore(&account(), store.clone()).unwrap().is_none());
        store.store(&refresh_key("https://dev.kubuno.com", "u-1"), "refresh-x").unwrap();
        let owner = TokenOwner::restore(&account(), store.clone()).unwrap().expect("restored");
        owner.forget().unwrap();
        assert!(TokenOwner::restore(&account(), store).unwrap().is_none());
    }

    #[test]
    fn a_soon_to_expire_or_opaque_token_is_not_considered_fresh() {
        assert!(!TokenOwner::is_fresh(&AccessToken::new("opaque")));
        assert!(!TokenOwner::is_fresh(&AccessToken::new(jwt_with_exp(now_s() + 10))));
        assert!(TokenOwner::is_fresh(&AccessToken::new(jwt_with_exp(now_s() + 900))));
    }
}
