//! Step-up re-authentication: proving presence again before a sensitive action.
//!
//! ```text
//!   client                                            core
//!     │  POST /me/api-tokens  (access token only)      │
//!     │───────────────────────────────────────────────►│  Reauthenticated
//!     │◄─────────────────── 403 REAUTH_REQUIRED ───────│  extractor refuses,
//!     │                                                │  audits the challenge
//!     │  GET  /auth/reauth/challenge                   │
//!     │───────────────────────────────────────────────►│  which methods apply
//!     │◄──────── { methods: ["totp","backup_code"] } ──│
//!     │  POST /auth/reauth   { code }                  │
//!     │───────────────────────────────────────────────►│  verify + grant row
//!     │◄──────────── { reauth_token, expires_in } ─────│
//!     │  POST /me/api-tokens  + X-Reauth-Token         │
//!     │───────────────────────────────────────────────►│  passes; grace opens
//!     │◄──────────────────────────── 201 ──────────────│
//! ```
//!
//! The four pieces:
//!
//! - [`claims`] - the token. Signed with a *derived* key so it can never be used
//!   as an access token, nor an access token as a proof. It grants nothing on its
//!   own.
//! - [`store`] - the grant row: revocation and the grace window.
//! - [`catalog`] - which actions are sensitive, and how to hand that decision over
//!   to the delegated-privilege catalogue.
//! - [`guard`] - the extractor handlers take, and the distinguishable refusal.

pub mod catalog;
pub mod claims;
pub mod guard;
pub mod store;

pub use catalog::{is_sensitive, SensitiveAction, SENSITIVE_ACTIONS};
pub use claims::{ReauthClaims, ReauthMethod};
pub use guard::{HumanUser, Reauthenticated, REAUTH_HEADER};
pub use store::{policy, ReauthPolicy};
