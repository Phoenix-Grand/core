//! Scoping personal API tokens: what a bearer may do, and for how long.
//!
//! ## The defect this closes
//!
//! [`AuthUser`](crate::auth::middleware::AuthUser) accepts a signed session *or*
//! a personal API token and yields the same `User` either way. Before this
//! module, `core.api_tokens` carried no notion of scope, `expires_at` was
//! nullable, and resolution never looked at the owner's second factor. A token
//! minted by an administrator was therefore a complete, permanent administration
//! key that bypassed step-up authentication - the last of the five findings of
//! the security audit, and the only one still open.
//!
//! ## The shape of the fix
//!
//! ```text
//!   raw token ──► grant::resolve ──► TokenGrant { scopes, is_legacy, grace }
//!                       │                          │
//!                       │                          ├─ AuthSource (request ext)
//!                       │                          │
//!                       └─ refuses: unknown, revoked, expired,
//!                          owner disabled, grace window closed
//!
//!   AdminContext(owner's privileges, resolved fresh)
//!                       │
//!                       └─ narrow::apply(ctx, grant) ──► effective privilege
//!                                                        = INTERSECTION
//! ```
//!
//! Four properties hold, and each one is a test:
//!
//! 1. **A token never grants more than its owner.** The effective privilege is
//!    the intersection of the token's scopes with what the owner holds.
//! 2. **Re-evaluated at every use.** The owner's context is resolved per request
//!    (through a five-second cache); the intersection is applied *after* that
//!    read, never stored. Withdraw a privilege from the owner and the token loses
//!    it on the next call.
//! 3. **Scopes are explicit and mandatory.** An empty list is refused by the
//!    database `CHECK` as well as by [`policy::validate_requested`], and the
//!    creator may only pick scopes they themselves hold at that instant.
//! 4. **Some scopes are never grantable.** Granting power, installing modules,
//!    approving themes and resetting a second factor require a person; see
//!    [`policy`].
//!
//! ## Origin, not a second notion of it
//!
//! Step-up re-authentication ([`crate::auth::reauth`]) already needed to tell a
//! human from a program and reads
//! [`ActorOrigin`](crate::audit::ActorOrigin) out of
//! [`AuthSource`](crate::auth::middleware::AuthSource). This module extends that
//! same record with the grant instead of introducing a parallel one: there is
//! exactly one answer in the request to "how did this caller authenticate".

pub mod grant;
pub mod narrow;
pub mod policy;

pub use grant::{resolve_grant, TokenGrant};
pub use narrow::apply as narrow;
pub use policy::{
    forbids_scope, requires_expiry, GrantableScope, FORBIDDEN_SCOPE_NAMESPACES,
    MCP_EXECUTE, MODULE_ADMIN,
};

use axum::http::Method;

/// True for HTTP methods that change something.
pub fn is_write_method(method: &Method) -> bool {
    !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

/// The one refusal that gets **no grace at all**.
///
/// A legacy token keeps its owner's privileges while the migration window is
/// open - everywhere except here. An unscoped credential performing an
/// administrative write is the defect itself, not a compatibility concern: it is
/// what turned "an API key" into "a permanent root key", and letting it survive
/// its own remediation for ninety days would make the remediation decorative.
///
/// Reads under `/admin/*` stay open so an existing integration that merely
/// *watches* the instance keeps working until the deadline.
pub fn deny_legacy_admin_write(
    grant: Option<&TokenGrant>,
    method: &Method,
) -> Result<(), crate::errors::AppError> {
    let Some(grant) = grant else { return Ok(()) };
    if grant.is_legacy && is_write_method(method) {
        tracing::warn!(
            token_id = %grant.token_id,
            user_id = %grant.user_id,
            method = %method,
            "Écriture d'administration refusée : jeton hérité, sans portées. \
             Réémettez un jeton à portées explicites."
        );
        return Err(crate::errors::AppError::ApiTokenLegacyAdminWrite);
    }
    Ok(())
}

/// Role to present to a module for a token-authenticated call.
///
/// The proxy used to forward the owner's `role` verbatim, so a token belonging to
/// an administrator arrived at every module as an administrator - the header the
/// modules gate their own administration on. A scoped token is therefore an
/// ordinary user unless it explicitly carries [`MODULE_ADMIN`], and even then only
/// if its owner really is one: the token cannot manufacture a role its owner does
/// not have.
///
/// A legacy token keeps the owner's role during the grace window; the immediate,
/// ungraced cut is on administrative writes in the core (see
/// [`deny_legacy_admin_write`]).
pub fn module_role_for(grant: &TokenGrant, owner_role: &str) -> String {
    if grant.is_legacy {
        return owner_role.to_string();
    }
    if owner_role == "admin" && grant.has_scope(MODULE_ADMIN) {
        return owner_role.to_string();
    }
    "user".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn g(scopes: &[&str], is_legacy: bool) -> TokenGrant {
        TokenGrant {
            token_id: Uuid::nil(),
            user_id: Uuid::nil(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            is_legacy,
            grace_until: None,
        }
    }

    #[test]
    fn a_legacy_token_may_read_the_admin_surface_but_never_write_to_it() {
        let legacy = g(&[], true);
        assert!(deny_legacy_admin_write(Some(&legacy), &Method::GET).is_ok());
        assert!(deny_legacy_admin_write(Some(&legacy), &Method::POST).is_err());
        assert!(deny_legacy_admin_write(Some(&legacy), &Method::PATCH).is_err());
        assert!(deny_legacy_admin_write(Some(&legacy), &Method::DELETE).is_err());
    }

    #[test]
    fn a_scoped_token_and_a_session_are_not_concerned() {
        assert!(deny_legacy_admin_write(Some(&g(&["core.users.update"], false)), &Method::POST).is_ok());
        assert!(deny_legacy_admin_write(None, &Method::DELETE).is_ok());
    }

    #[test]
    fn a_token_is_presented_to_modules_as_an_ordinary_user_by_default() {
        assert_eq!(module_role_for(&g(&["core.users.read"], false), "admin"), "user");
        assert_eq!(module_role_for(&g(&["core.users.read"], false), "user"), "user");
    }

    #[test]
    fn the_admin_role_travels_only_when_explicitly_scoped_and_actually_held() {
        assert_eq!(module_role_for(&g(&[MODULE_ADMIN], false), "admin"), "admin");
        // The scope cannot manufacture a role the owner does not have.
        assert_eq!(module_role_for(&g(&[MODULE_ADMIN], false), "user"), "user");
    }

    #[test]
    fn a_legacy_token_keeps_the_owner_role_during_grace() {
        assert_eq!(module_role_for(&g(&[], true), "admin"), "admin");
    }
}
