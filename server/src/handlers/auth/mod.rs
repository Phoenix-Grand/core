//! Authentication handlers, split by responsibility.
//!
//! Every handler and DTO is re-exported at this level, so the router and the
//! OpenAPI declarations keep referring to `crate::handlers::auth::<name>`.
//!
//! - [`login`]          - sign in / sign out (`/auth/login`, `/auth/logout`)
//! - [`accounts`]       - Google-style multi-account (`/auth/accounts`, `/auth/switch`)
//! - [`register`]       - public sign up (`/auth/register`)
//! - [`tokens`]         - refresh token issuance + shared cookie helpers
//! - [`refresh`]        - rotation, reuse detection, rotation grace (`/auth/refresh`)
//! - [`tickets`]        - signed download / stream tickets (`/auth/tickets`)
//! - [`totp`]           - second factor verification (`/auth/totp`), TOTP or backup code
//! - [`reauth`]         - step-up before a sensitive action (`/auth/reauth`)
//! - [`password_reset`] - forgotten / reset password
//! - [`oauth`]          - generic OIDC providers (Keycloak, GitLab, Authentik, …)
//! - [`oauth_users`]    - SSO user lookup, linking and creation

mod accounts;
mod captcha;
mod login;
mod oauth;
mod oauth_users;
mod password_reset;
mod reauth;
mod refresh;
mod register;
mod tickets;
mod tokens;
mod totp;

pub use accounts::*;
pub use captcha::*;
pub use login::*;
pub use oauth::*;
pub use password_reset::*;
pub use reauth::*;
pub use refresh::*;
pub use register::*;
pub use tickets::*;
pub use tokens::*;
pub use totp::*;
