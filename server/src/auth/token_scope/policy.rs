//! What a token may be granted, and how long it may live.

use chrono::{DateTime, Duration, Utc};
use kubuno_db::{params, DbPool, DbQueryBuilder};
use serde::Serialize;

use crate::authz::model::parse_key;
use crate::errors::AppError;

/// Privilege that lets a token be presented to the modules as an administrator.
/// Without it, a token-authenticated proxy call carries `X-Kubuno-User-Role:
/// user` whatever the owner's role - see [`crate::modules::proxy`].
pub const MODULE_ADMIN: &str = "core.module_admin.execute";

/// Privilege required to reach `/mcp`, the one route that authenticates by API
/// token and nothing else.
pub const MCP_EXECUTE: &str = "core.mcp.execute";

/// Namespaces that may never appear in a token's scopes, whatever the catalogue
/// says.
///
/// `security.*` is the naming the step-up catalogue uses for the actions that
/// demand a fresh proof of presence - disabling the second factor, reprinting
/// the backup codes that bypass it. Those routes are already closed to a bearer
/// (they take [`Reauthenticated`](crate::auth::reauth::Reauthenticated), which
/// answers `REAUTH_NOT_AVAILABLE` to an API token), but the refusal here is what
/// keeps them closed if such a key is ever promoted into `core.privileges`: the
/// default for anything resembling a second-factor reset is "no", not "whatever
/// the catalogue's flag happens to say on the day".
pub const FORBIDDEN_SCOPE_NAMESPACES: &[&str] = &["security"];

/// Verbs that change something. A `core.*` scope carrying one of these may not
/// live forever.
const WRITE_VERBS: &[&str] = &["create", "update", "delete", "manage", "execute"];

/// Default cap when `security.api_token_max_ttl_days` is missing or unreadable.
const DEFAULT_MAX_TTL_DAYS: i64 = 365;

/// Default window when `security.api_token_legacy_grace_days` is missing.
const DEFAULT_LEGACY_GRACE_DAYS: i64 = 90;

/// One scope the caller may put on a token, as offered to the interface.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct GrantableScope {
    pub key: String,
    pub namespace: String,
    pub domain: String,
    pub verb: String,
    pub label: String,
    pub description: Option<String>,
    /// True when picking this scope makes an expiry date mandatory.
    pub requires_expiry: bool,
}

/// True when `key` may never be granted to a token on the strength of its name
/// alone (the catalogue flag is checked separately, against the database).
pub fn forbids_scope(key: &str) -> bool {
    FORBIDDEN_SCOPE_NAMESPACES
        .iter()
        .any(|ns| key.starts_with(ns) && key[ns.len()..].starts_with('.'))
}

/// True when holding `key` obliges the token to carry an expiry date.
///
/// Deliberately narrow: a read-only scope, or a scope in a module's own
/// namespace, may be perpetual. What may not is a credential that can *change*
/// the instance and never dies.
pub fn requires_expiry(key: &str) -> bool {
    match parse_key(key) {
        Ok(parsed) => {
            parsed.namespace == crate::authz::model::CORE_NAMESPACE
                && WRITE_VERBS.contains(&parsed.verb)
        }
        // An unparseable key never reaches this far (validation rejects it
        // first); treating it as "needs an expiry" is the conservative answer.
        Err(_) => true,
    }
}

/// Reads the instance ceiling on a token's lifetime, in days.
pub async fn max_ttl_days(db: &DbPool) -> i64 {
    read_i64(db, "security.api_token_max_ttl_days")
        .await
        .filter(|d| *d > 0)
        .unwrap_or(DEFAULT_MAX_TTL_DAYS)
}

/// Reads the grace window granted to tokens issued before scopes existed.
pub async fn legacy_grace_days(db: &DbPool) -> i64 {
    read_i64(db, "security.api_token_legacy_grace_days")
        .await
        .filter(|d| *d >= 0)
        .unwrap_or(DEFAULT_LEGACY_GRACE_DAYS)
}

/// Deadline of a legacy token, from the moment it was marked.
pub fn grace_deadline(legacy_since: DateTime<Utc>, grace_days: i64) -> DateTime<Utc> {
    legacy_since + Duration::days(grace_days)
}

async fn read_i64(db: &DbPool, key: &str) -> Option<i64> {
    let value: Option<serde_json::Value> = db
        .fetch_optional_scalar::<serde_json::Value>(
            "SELECT value FROM core.settings WHERE \"key\" = $1",
            params![key],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, setting = %key, "Reading the token-policy setting");
            e
        })
        .ok()
        .flatten();
    value.and_then(|v| v.as_i64())
}

/// Validates a requested scope list against the catalogue **and** against what
/// the creator holds right now.
///
/// Four independent conditions, in the order a reader would ask them:
///
/// 1. the list is not empty - there is no "all" default, and never was one to
///    fall back to;
/// 2. every key exists in `core.privileges` and is flagged grantable;
/// 3. no key sits in a forbidden namespace;
/// 4. the creator holds every key **at this instant** - a token is a delegation,
///    and one cannot delegate what one does not have.
pub async fn validate_requested(
    db: &DbPool,
    requested: &[String],
    creator: &crate::authz::AdminContext,
) -> Result<Vec<String>, AppError> {
    let mut scopes: Vec<String> = requested
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    scopes.sort();
    scopes.dedup();

    if scopes.is_empty() {
        return Err(AppError::Validation(
            "A token must have at least one scope; there is no default 'all' value."
                .into(),
        ));
    }

    for key in &scopes {
        // The forbidden namespaces come first, *before* the grammar check: those
        // keys are named in the step-up catalogue, which uses verbs of its own
        // ("disable", "regenerate") that the privilege grammar does not accept.
        // Checking the shape first would answer "clé invalide" to someone asking
        // for a second-factor reset, which is true but tells them nothing about
        // why it will never be granted.
        if forbids_scope(key) {
            return Err(AppError::Validation(format!(
                "Scope '{key}' requires interactive reauthentication (second-factor reset) and cannot be assigned to a token."
            )));
        }
        parse_key(key)?;
    }

    // One round-trip for the whole list, returning the rows that are actually
    // grantable; whatever is missing from the answer is refused below.
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        "SELECT \"key\", is_token_grantable FROM core.privileges WHERE \"key\"",
    );
    qb.push_in(scopes.iter().cloned());
    let rows: Vec<(String, bool)> = qb.fetch_all_as(db).await.map_err(|e| {
        tracing::error!(error = %e, "Validating requested scopes: reading the catalogue");
        AppError::Database(e)
    })?;

    for key in &scopes {
        match rows.iter().find(|(k, _)| k == key) {
            None => {
                return Err(AppError::Validation(format!(
                    "Unknown scope '{key}': it does not exist in the privilege catalog."
                )));
            }
            Some((_, false)) => {
                return Err(AppError::Validation(format!(
                    "Scope '{key}' is reserved for interactive operations (role management, module installation, theme approval, second-factor reset) and cannot be assigned to a token."
                )));
            }
            Some((_, true)) => {}
        }

        if !creator.has(key) {
            tracing::warn!(
                user_id = %creator.user_id,
                scope = %key,
                "Création de jeton refusée : le créateur ne détient pas la portée demandée"
            );
            return Err(AppError::Forbidden);
        }
    }

    Ok(scopes)
}

/// Turns the requested lifetime into an expiry date, applying the two rules that
/// keep a scoped token from becoming the thing it replaced.
///
/// * a `core.*` write scope forbids "no expiry" - that combination *is* the
///   defect being fixed;
/// * whatever is asked for is clamped to the instance ceiling.
pub async fn resolve_expiry(
    db: &DbPool,
    scopes: &[String],
    expires_in_days: Option<u32>,
) -> Result<Option<DateTime<Utc>>, AppError> {
    let cap = max_ttl_days(db).await;
    let mandatory: Vec<&String> = scopes.iter().filter(|k| requires_expiry(k)).collect();

    let Some(days) = expires_in_days else {
        if let Some(key) = mandatory.first() {
            return Err(AppError::Validation(format!(
                "Scope '{key}' modifies the instance, so this token must expire within at most {cap} days."
            )));
        }
        return Ok(None);
    };

    if days == 0 {
        return Err(AppError::Validation(
            "The expiration must be at least one day away.".into(),
        ));
    }
    let days = i64::from(days).min(cap);
    Ok(Some(Utc::now() + Duration::days(days)))
}

/// Lists the scopes `creator` may put on a token: grantable, not forbidden, and
/// actually held.
pub async fn grantable_for(
    db: &DbPool,
    creator: &crate::authz::AdminContext,
) -> Result<Vec<GrantableScope>, AppError> {
    let rows: Vec<(String, String, String, String, String, Option<String>)> = db
        .fetch_all_as::<(String, String, String, String, String, Option<String>)>(
            "SELECT \"key\", namespace, domain, verb, label, description
           FROM core.privileges
          WHERE is_token_grantable AND NOT is_orphan
          ORDER BY namespace, domain, verb",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Reading the grantable scopes");
            AppError::Database(e)
        })?;

    Ok(rows
        .into_iter()
        .filter(|(key, ..)| !forbids_scope(key) && creator.has(key))
        .map(|(key, namespace, domain, verb, label, description)| GrantableScope {
            requires_expiry: requires_expiry(&key),
            key,
            namespace,
            domain,
            verb,
            label,
            description,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_second_factor_namespace_is_refused_by_name() {
        assert!(forbids_scope("security.two_factor.disable"));
        assert!(forbids_scope("security.backup_codes.regenerate"));
        // A namespace that merely starts with the same letters is not it.
        assert!(!forbids_scope("securityx.things.read"));
        assert!(!forbids_scope("core.users.read"));
    }

    #[test]
    fn only_a_core_write_scope_forces_an_expiry() {
        assert!(requires_expiry("core.users.update"));
        assert!(requires_expiry("core.settings.manage"));
        assert!(requires_expiry("core.user_password.execute"));
        // Reads may be perpetual…
        assert!(!requires_expiry("core.users.read"));
        assert!(!requires_expiry("core.audit.read"));
        // …and so may a module's own namespace.
        assert!(!requires_expiry("drive.files.update"));
    }

    #[test]
    fn a_malformed_key_is_treated_as_needing_an_expiry() {
        // Conservative default: validation refuses it long before this matters,
        // but the fallback must not be the permissive one.
        assert!(requires_expiry("nonsense"));
    }

    #[test]
    fn the_grace_deadline_counts_from_the_marking() {
        let since = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .expect("date de test")
            .with_timezone(&Utc);
        assert_eq!(
            grace_deadline(since, 90),
            DateTime::parse_from_rfc3339("2026-04-01T00:00:00Z")
                .expect("date de test")
                .with_timezone(&Utc)
        );
    }
}
