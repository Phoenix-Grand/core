//! Resolving a raw token into the grant it carries.
//!
//! The one function that turns `kubuno_…` into an authorisation input. Every
//! refusal lives here rather than being re-derived by each caller - the middleware,
//! the module proxy and the MCP endpoint all resolve through this path, which is
//! why closing a hole here closes it everywhere.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use kubuno_db::{params, DbPool};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::policy;
use crate::errors::AppError;

/// Prefix that makes a token recognisable in a log or a paste.
pub const TOKEN_PREFIX: &str = "kubuno_";

/// What a presented token authorises.
///
/// Carries the token's **row identifier** and its scopes. Never the token, never
/// its hash - those stop at the query below and travel no further, so no
/// downstream consumer can leak what it does not have.
#[derive(Debug, Clone)]
pub struct TokenGrant {
    pub token_id: Uuid,
    pub user_id: Uuid,
    /// Privilege keys. Empty **only** for a legacy token.
    pub scopes: Vec<String>,
    /// Issued before scopes existed.
    pub is_legacy: bool,
    /// End of the migration grace window; `Some` only when `is_legacy`.
    pub grace_until: Option<DateTime<Utc>>,
}

impl TokenGrant {
    /// True when the token explicitly carries `key`.
    ///
    /// A legacy token carries no scope list at all: during its grace window it
    /// runs on its owner's privileges, so "does it carry this key" is answered by
    /// the owner's context, not here.
    pub fn has_scope(&self, key: &str) -> bool {
        self.scopes.iter().any(|s| s == key)
    }

    /// True when the token may exercise `key` at all - scope list for a scoped
    /// token, "ask the owner" for a legacy one.
    pub fn may_carry(&self, key: &str) -> bool {
        self.is_legacy || self.has_scope(key)
    }
}

/// What the resolution query returns. `scopes` is read as JSON so it decodes on
/// every engine (`#[sqlx(json)]` requires the column to be JSON - the consolidated
/// migration replaces the PostgreSQL `TEXT[]` with a JSON column).
#[derive(sqlx::FromRow)]
struct TokenRow {
    id: Uuid,
    user_id: Uuid,
    expires_at: Option<DateTime<Utc>>,
    #[sqlx(json)]
    scopes: Vec<String>,
    is_legacy: bool,
    legacy_since: Option<DateTime<Utc>>,
    is_active: bool,
}

/// Resolves a raw token, or explains why it is refused.
///
/// The refusals, and why each one is here rather than at a call site:
///
/// * **unknown, revoked or expired** → `Unauthorized`, indistinguishable from
///   each other on purpose;
/// * **owner deactivated** → `Unauthorized`. Suspending an account used to leave
///   its tokens working, which made suspension a half-measure: the session was
///   cut and the API key was not;
/// * **legacy past its grace window** → [`AppError::ApiTokenLegacyExpired`], a
///   *distinguishable* code, because the holder can act on it (reissue a scoped
///   token) and a bare 401 would send them looking for a network fault.
pub async fn resolve_grant(db: &DbPool, raw_token: &str) -> Result<TokenGrant, AppError> {
    if !raw_token.starts_with(TOKEN_PREFIX) {
        return Err(AppError::Unauthorized);
    }
    let hash = hex::encode(Sha256::digest(raw_token.as_bytes()));

    // The owner's `is_active` is joined in rather than checked afterwards: two
    // statements is two chances to forget the second one.
    let row: Option<TokenRow> = db
        .fetch_optional_as::<TokenRow>(
            r#"SELECT t.id, t.user_id, t.expires_at, t.scopes, t.is_legacy,
                  t.legacy_since, u.is_active
             FROM core.api_tokens t
             JOIN core.users u ON u.id = t.user_id
            WHERE t.token_hash = $1 AND t.revoked_at IS NULL"#,
            params![&hash],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Resolving an API token");
            AppError::Database(e)
        })?;

    let Some(TokenRow {
        id: token_id,
        user_id,
        expires_at,
        scopes,
        is_legacy,
        legacy_since,
        is_active: owner_active,
    }) = row
    else {
        return Err(AppError::Unauthorized);
    };

    if !owner_active {
        // Worth a line: a suspended account whose key is still being replayed is
        // either a forgotten integration or someone who has not noticed yet.
        tracing::warn!(
            token_id = %token_id,
            user_id = %user_id,
            "Jeton d'API refusé : le compte propriétaire est désactivé"
        );
        return Err(AppError::Unauthorized);
    }

    if let Some(exp) = expires_at {
        if exp < Utc::now() {
            return Err(AppError::Unauthorized);
        }
    }

    let mut grace_until = None;
    if is_legacy {
        let since = legacy_since.unwrap_or_else(Utc::now);
        let deadline = policy::grace_deadline(since, policy::legacy_grace_days(db).await);
        if Utc::now() > deadline {
            tracing::warn!(
                token_id = %token_id,
                user_id = %user_id,
                grace_until = %deadline,
                "Jeton d'API hérité refusé : la fenêtre de grâce est close, réémission requise"
            );
            return Err(AppError::ApiTokenLegacyExpired);
        }
        // Every use of a legacy token is a line in the log: this is a credential
        // running on a policy that has been withdrawn, and the operator needs to
        // find it before the deadline rather than after.
        tracing::warn!(
            token_id = %token_id,
            user_id = %user_id,
            grace_until = %deadline,
            "Jeton d'API hérité utilisé : privilèges du propriétaire hors portées sensibles, \
             écritures d'administration refusées. Réémettez un jeton à portées explicites."
        );
        grace_until = Some(deadline);
    }

    // Best-effort: a failure here must not deny an otherwise valid call.
    let now = Utc::now();
    if let Err(e) = db
        .execute(
            "UPDATE core.api_tokens SET last_used_at = $1 WHERE id = $2",
            params![now, token_id],
        )
        .await
    {
        tracing::error!(error = %e, token_id = %token_id, "Updating last_used_at");
    }

    Ok(TokenGrant { token_id, user_id, scopes, is_legacy, grace_until })
}

/// How often one legacy token may add a row to the audit trail.
///
/// Every use is logged (see above); the *trail* is throttled. An integration
/// polling ten times a second would otherwise write close to a million rows a
/// day, which does not make the deprecation more visible - it makes the trail
/// unreadable and grows a table an operator then has to prune. One row a minute
/// per token keeps the signal, the timeline and the volume all usable.
const AUDIT_THROTTLE: Duration = Duration::from_secs(60);

fn last_audited() -> &'static Mutex<HashMap<Uuid, Instant>> {
    static STORE: OnceLock<Mutex<HashMap<Uuid, Instant>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// True when this use of `token_id` should be written to the trail.
fn should_audit(token_id: Uuid) -> bool {
    let Ok(mut guard) = last_audited().lock() else {
        // A poisoned lock must not silence the trail.
        return true;
    };
    // An instance does not accumulate legacy tokens; the map is bounded by their
    // number, and cleared wholesale if that assumption ever breaks.
    if guard.len() > 1024 {
        guard.clear();
    }
    match guard.get(&token_id) {
        Some(at) if at.elapsed() < AUDIT_THROTTLE => false,
        _ => {
            guard.insert(token_id, Instant::now());
            true
        }
    }
}

/// Writes the "a legacy token was used" entry, throttled per token.
///
/// The entry names the token by **id** and by the name its owner gave it; the
/// token itself and its hash never appear.
pub async fn audit_legacy_use(
    db: &DbPool,
    ctx: &crate::audit::AuditContext,
    grant: &TokenGrant,
    route: &str,
) {
    if !grant.is_legacy || !should_audit(grant.token_id) {
        return;
    }
    let detail = match grant.grace_until {
        Some(until) => format!(
            "Jeton hérité (sans portées) utilisé sur {route} - fin de grâce le {}",
            until.format("%Y-%m-%d")
        ),
        None => format!("Jeton hérité (sans portées) utilisé sur {route}"),
    };
    ctx.record(
        db,
        crate::audit::AuditEntry::new("core.api_tokens.legacy_used")
            .module("core")
            .target(
                crate::audit::redact::target::API_TOKEN,
                grant.token_id,
                format!("jeton {}", grant.token_id),
            )
            .detail(detail),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy() -> TokenGrant {
        TokenGrant {
            token_id: Uuid::nil(),
            user_id: Uuid::nil(),
            scopes: Vec::new(),
            is_legacy: true,
            grace_until: Some(Utc::now()),
        }
    }

    fn scoped(keys: &[&str]) -> TokenGrant {
        TokenGrant {
            token_id: Uuid::nil(),
            user_id: Uuid::nil(),
            scopes: keys.iter().map(|s| s.to_string()).collect(),
            is_legacy: false,
            grace_until: None,
        }
    }

    #[test]
    fn a_scoped_token_carries_only_what_it_lists() {
        let g = scoped(&["core.users.read"]);
        assert!(g.has_scope("core.users.read"));
        assert!(!g.has_scope("core.users.update"));
        assert!(g.may_carry("core.users.read"));
        assert!(!g.may_carry("core.users.update"));
    }

    #[test]
    fn a_legacy_token_defers_to_its_owner() {
        let g = legacy();
        // It lists nothing…
        assert!(!g.has_scope("core.users.read"));
        // …but during the grace window the answer comes from the owner.
        assert!(g.may_carry("core.users.read"));
    }

    #[test]
    fn the_audit_throttle_lets_the_first_use_through_and_holds_the_next() {
        let id = Uuid::new_v4();
        assert!(should_audit(id), "le premier usage doit être tracé");
        assert!(!should_audit(id), "l'usage suivant est absorbé par le seuil");
        // A different token is not affected by its neighbour's throttle.
        assert!(should_audit(Uuid::new_v4()));
    }
}
