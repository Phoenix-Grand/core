//! Building the typed Kubuno API client for a server. The transport is the desktop's `kubuno-desktop-api-client`
//! (rustls, no OpenSSL - it cross-compiles to Android and iOS); here we only choose the user agent and wire the
//! device key and, for authenticated clients, the token owner.

use std::sync::Arc;

use kubuno_desktop_api_client::{ApiClient, ApiError, TokenSource};

/// The user agent the mobile apps send.
pub fn user_agent() -> String {
    format!("KubunoMobile/{}", env!("CARGO_PKG_VERSION"))
}

/// An unauthenticated client of `server`, for the sign-in endpoints (login / TOTP / the first refresh), carrying the
/// device key but no token source.
pub fn unauth_client(server: &str, device_key: &str) -> Result<ApiClient, ApiError> {
    ApiClient::builder(server).user_agent(user_agent()).device_key(device_key).build()
}

/// An authenticated client of `server`: the same transport, plus `tokens` as its token source (the mobile
/// [`crate::TokenOwner`]), so every request carries a fresh access token and retries once on 401.
pub fn authed_client(
    server: &str,
    device_key: &str,
    tokens: Arc<dyn TokenSource>,
) -> Result<ApiClient, ApiError> {
    ApiClient::builder(server).user_agent(user_agent()).device_key(device_key).tokens(tokens).build()
}
