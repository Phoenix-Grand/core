//! The Kubuno mobile account / network base (M2).
//!
//! This is the layer the mobile apps' real behaviour stands on: how a phone signs in, keeps a session alive, and
//! talks to its Kubuno server. It is portable Rust with no platform API of its own - the shell injects the one
//! platform-specific piece, the OS secret store ([`SecretStore`]).
//!
//! - **Transport.** The typed Kubuno API client is the desktop's [`kubuno_desktop_api_client`], reused as-is: it does
//!   TLS with rustls (no OpenSSL), so it cross-compiles to Android and iOS. [`authed_client`] / [`unauth_client`]
//!   build one for a server.
//! - **Sign-in.** [`login`] (native client: the refresh token comes back in the body, not a cookie) and, for an
//!   account with a second factor, [`verify_totp`].
//! - **Session.** [`TokenOwner`] holds the account's own refresh token in the secret store - there is no broker, the
//!   phone is the owner - and is the [`TokenSource`] the API client refreshes access tokens from, with rotation and
//!   single-flight.
//!
//! - **Phone state.** A per-installation device key and the book of accounts signed in here ([`device_key`],
//!   [`accounts`]), next to the refresh tokens in the secret store.
//!
//! Typical flow: [`probe_server`] → [`login`] → ([`verify_totp`]) → [`Session::adopt`]; at a later launch
//! [`Session::restore_last`]. Network calls run on [`spawn`] (off the UI thread). Nothing here logs a token.

mod auth;
mod device;
mod http;
mod model;
mod platform;
mod secret;
mod session;
mod token_owner;

pub use auth::{login, verify_totp, LoginOptions, LoginOutcome, TotpPending};
pub use device::{accounts, device_key, forget_account, remember};
pub use http::{authed_client, unauth_client, user_agent};
pub use model::{Account, NativeTokens, User};
pub use platform::{platform_store, set_platform_store, spawn};
pub use secret::{refresh_key, MemorySecretStore, SecretError, SecretStore};
pub use session::{normalize_server, probe_server, Session, HEALTH, ME};
pub use token_owner::TokenOwner;

/// The transport, re-exported so callers (and the app) use the same types without depending on the desktop crate
/// directly.
pub use kubuno_desktop_api_client::{
    AccessToken, ApiClient, ApiError, ApiRequest, ApiResponse, AuthError, ErrorClass, Method, TokenSource,
};

/// The Kubuno native auth endpoints (paths under the server base URL).
pub const AUTH_LOGIN: &str = "/api/v1/auth/login";
pub const AUTH_REFRESH: &str = "/api/v1/auth/refresh";
pub const AUTH_TOTP: &str = "/api/v1/auth/totp";
pub const AUTH_LOGOUT: &str = "/api/v1/auth/logout";

/// What can go wrong in the account layer (sign-in, token ownership). Network / HTTP failures surface as the
/// transport's [`ApiError`]; an unreadable response as [`AccountError::Protocol`]; a keystore failure as
/// [`AccountError::Secret`].
#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error(transparent)]
    Secret(#[from] SecretError),
    #[error("protocol error: {0}")]
    Protocol(String),
    /// What was typed is not a server address.
    #[error("invalid server address")]
    InvalidServer,
    /// The address answers, but not as a Kubuno server (no `/health` document).
    #[error("not a Kubuno server")]
    NotKubuno,
}

impl AccountError {
    /// The session is over (the refresh token was rejected): the user must sign in again. Any other failure (network,
    /// server error) leaves the session intact.
    pub fn is_session_expired(&self) -> bool {
        matches!(self, AccountError::Api(e) if e.class() == ErrorClass::SessionExpired)
    }
}
