//! Persistence of re-authentication grants: revocation and the grace window.
//!
//! A grant row is written when a challenge is passed. It is what makes the
//! stateless token revocable, and what carries the grace window - the reason a
//! working session is not interrogated at every gesture.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use kubuno_db::{params, DbPool};
use std::net::IpAddr;
use uuid::Uuid;

use super::claims::ReauthMethod;
use crate::errors::AppError;

/// Durations governing step-up, read from `core.settings`.
#[derive(Debug, Clone, Copy)]
pub struct ReauthPolicy {
    /// Lifetime of the token handed to the client.
    pub token_ttl_s: i64,
    /// How long afterwards sensitive calls pass without a token.
    pub grace_s: i64,
}

impl Default for ReauthPolicy {
    fn default() -> Self {
        // Five minutes to replay the request, fifteen minutes of quiet afterwards:
        // long enough to finish a train of related administrative gestures, short
        // enough that an unattended browser is not a standing authorisation.
        Self { token_ttl_s: 300, grace_s: 900 }
    }
}

fn as_i64(v: &serde_json::Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// Reads the policy, falling back to [`ReauthPolicy::default`] key by key.
pub async fn policy(db: &DbPool) -> ReauthPolicy {
    let mut out = ReauthPolicy::default();

    let rows = db
        .fetch_all_as::<(String, serde_json::Value)>(
            "SELECT \"key\", value FROM core.settings
          WHERE \"key\" IN ('security.reauth_token_ttl_s', 'security.reauth_grace_s')",
            params![],
        )
        .await
        .unwrap_or_default();

    for (key, value) in rows {
        let Some(n) = as_i64(&value) else { continue };
        match key.as_str() {
            // Clamped rather than trusted: a value of zero would make every proof
            // stale before the client could replay, and an hour-long "fresh proof"
            // is not a fresh proof.
            "security.reauth_token_ttl_s" => out.token_ttl_s = n.clamp(30, 900),
            "security.reauth_grace_s" => out.grace_s = n.clamp(0, 3_600),
            _ => {}
        }
    }
    out
}

/// Records a passed challenge. Returns the grant's `jti`, which the token embeds.
pub async fn grant(
    db: &DbPool,
    user_id: Uuid,
    method: ReauthMethod,
    ip: Option<IpAddr>,
    policy: ReauthPolicy,
) -> Result<Uuid, AppError> {
    let jti = Uuid::new_v4();
    let now = Utc::now();
    let expires_at = now + ChronoDuration::seconds(policy.token_ttl_s);
    // The grace window always covers at least the token's own lifetime; a proof
    // that outlives the window it opens would be a confusing contradiction.
    let grace_until = now + ChronoDuration::seconds(policy.grace_s.max(policy.token_ttl_s));
    let ip_text = ip.map(|a| a.to_string());

    // The `$6::inet` cast is dropped: `ip_address` is bound as text (the
    // consolidated migration stores it in a portable text column, not PostgreSQL
    // `INET`).
    db.execute(
        "INSERT INTO core.reauth_grants (user_id, jti, method, expires_at, grace_until, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6)",
        params![
            user_id,
            jti,
            method.as_str(),
            expires_at,
            grace_until,
            ip_text.as_deref(),
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, user_id = %user_id, "reauth: recording the grant");
        AppError::Database(e)
    })?;

    // Opportunistic housekeeping, cheap and bounded: keeps the table from growing
    // without needing a scheduled job of its own. The one-day cutoff is computed
    // in Rust instead of `NOW() - INTERVAL '1 day'`.
    let day_ago = now - ChronoDuration::days(1);
    let _ = db
        .execute(
            "DELETE FROM core.reauth_grants WHERE user_id = $1 AND grace_until < $2",
            params![user_id, day_ago],
        )
        .await;

    Ok(jti)
}

/// True while the grant behind `jti` is still honoured (exists, not expired).
pub async fn is_live(db: &DbPool, jti: Uuid, user_id: Uuid) -> Result<bool, AppError> {
    let now = Utc::now();
    let found: Option<Uuid> = db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM core.reauth_grants
          WHERE jti = $1 AND user_id = $2 AND expires_at > $3",
            params![jti, user_id, now],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "reauth: verifying the grant");
            AppError::Database(e)
        })?;
    Ok(found.is_some())
}

/// End of the account's current grace window, if any is open.
pub async fn grace_until(db: &DbPool, user_id: Uuid) -> Result<Option<DateTime<Utc>>, AppError> {
    let now = Utc::now();
    let until: Option<DateTime<Utc>> = db
        .fetch_scalar::<Option<DateTime<Utc>>>(
            "SELECT MAX(grace_until) FROM core.reauth_grants
          WHERE user_id = $1 AND grace_until > $2",
            params![user_id, now],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "reauth: reading the grace window");
            AppError::Database(e)
        })?;
    Ok(until)
}

/// Drops every grant of an account.
///
/// Called when the session ends or the password changes: a step-up proof must not
/// survive the credential it was layered on top of.
pub async fn revoke_all(db: &DbPool, user_id: Uuid) {
    if let Err(e) = db
        .execute(
            "DELETE FROM core.reauth_grants WHERE user_id = $1",
            params![user_id],
        )
        .await
    {
        tracing::error!(error = %e, user_id = %user_id, "reauth: revoking the grants");
    }
}
