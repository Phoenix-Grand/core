//! The per-identifier failure counter that arms the sign-in CAPTCHA.
//!
//! # Why this is separate from [`crate::auth::login_throttle`]
//!
//! The throttle (account lockout) is keyed by user id - it must be, since it
//! protects a specific account and resets on that account's success. Keying the
//! CAPTCHA gate the same way turned it into an enumeration oracle: an unknown
//! login never accrued failures there (no row is created for a stranger, on
//! purpose), so a CAPTCHA appeared only for accounts that exist. This module
//! keys the count on the SUBMITTED IDENTIFIER instead (hashed), so the gate arms
//! identically whether or not the identifier names a real account - the CAPTCHA
//! is demanded the same either way, and existence stays hidden.
//!
//! The raw identifier is never stored: only its SHA-256. Rows are swept once
//! stale, so counting failures for made-up identifiers cannot grow the table
//! without bound (the per-IP sign-in rate limit bounds the inflow too).

use crate::settings::SettingScope;
use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool};
use sha2::{Digest, Sha256};

/// Failures older than this since their last touch are swept, and a run this old
/// no longer counts.
const STALE_HOURS: i64 = 24;

/// SHA-256 (hex) of the identifier as typed, trimmed and lower-cased so that
/// `Alice@Example.com ` and `alice@example.com` share a counter. The raw value
/// never reaches the table.
pub fn hash_identifier(login: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(login.trim().to_lowercase().as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Failures past which sign-in requires a CAPTCHA
/// (`security.login_captcha_after_failures`). Resolved at the INSTANCE scope, not
/// the account's: an unknown identifier has no unit to resolve from, and reading
/// it per-account would make the threshold - and thus the gate - depend on
/// whether the account exists, which is the very oracle this avoids. `0` (the
/// default) disables the gate. Fails open (0) on any error.
pub async fn threshold(db: &DbPool) -> i32 {
    match crate::settings::chain::resolve_for(
        db,
        "security.login_captcha_after_failures",
        &SettingScope::INSTANCE,
    )
    .await
    {
        Ok(r) => r
            .value
            .as_ref()
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0)
            .clamp(0, 50) as i32,
        Err(e) => {
            tracing::error!(error = %e, "captcha_gate: seuil illisible");
            0
        }
    }
}

/// Consecutive failures recorded for this identifier hash within the live
/// window, or 0 when there is no fresh row. Fails **open** (0) on a DB error: a
/// hiccup must not start demanding a CAPTCHA of everyone.
pub async fn attempt_count(db: &DbPool, id_hash: &str) -> i32 {
    // The staleness cutoff is computed in Rust and bound, replacing the
    // PostgreSQL `NOW() - (… || ' hours')::interval` arithmetic.
    let cutoff = chrono::Utc::now() - chrono::Duration::hours(STALE_HOURS);
    match db
        .fetch_optional_scalar::<i32>(
            "SELECT failed_count FROM core.login_captcha_gate \
         WHERE identifier_hash = $1 AND updated_at > $2",
            params![id_hash, cutoff],
        )
        .await
    {
        Ok(Some(n)) => n,
        Ok(None) => 0,
        Err(e) => {
            tracing::error!(error = %e, "captcha_gate: could not read the counter");
            0
        }
    }
}

/// Record a failed sign-in for this identifier hash. Best-effort: errors are
/// logged and swallowed (the credential check has already decided the outcome;
/// this only shapes future attempts). Sweeps stale rows first so made-up
/// identifiers cannot pile up.
pub async fn record_failure(db: &DbPool, id_hash: &str) {
    // Cutoff and timestamp computed in Rust; the same cutoff drives the sweep and
    // the "is this run stale" test so the two agree exactly.
    let now = chrono::Utc::now();
    let cutoff = now - chrono::Duration::hours(STALE_HOURS);

    if let Err(e) = db
        .execute(
            "DELETE FROM core.login_captcha_gate WHERE updated_at < $1",
            params![cutoff],
        )
        .await
    {
        tracing::warn!(error = %e, "captcha_gate: could not purge the stale counters");
    }

    // A run that has gone stale restarts from one; otherwise increment. In the
    // upsert's update branch a bare column name refers to the stored row on all
    // three engines, so the CASE reads the current `updated_at`/`failed_count`.
    let backend = db.backend();
    let sql = format!(
        "INSERT INTO core.login_captcha_gate (identifier_hash, failed_count, window_started_at, updated_at) \
         VALUES ($1, 1, $2, $3){}",
        backend.upsert(
            "core.login_captcha_gate",
            &["identifier_hash"],
            &[
                Assign::Expr {
                    col: "failed_count",
                    expr: "CASE WHEN updated_at < $4 THEN 1 ELSE failed_count + 1 END",
                },
                Assign::Expr {
                    col: "window_started_at",
                    expr: "CASE WHEN updated_at < $5 THEN $6 ELSE window_started_at END",
                },
                Assign::Expr {
                    col: "updated_at",
                    expr: "$7",
                },
            ],
        )
    );
    if let Err(e) = db
        .execute(
            &sql,
            params![id_hash, now, now, cutoff, cutoff, now, now],
        )
        .await
    {
        tracing::error!(error = %e, "captcha_gate: could not record the failure");
    }
}

/// Clear the counter after a successful sign-in for this identifier. Best-effort.
pub async fn record_success(db: &DbPool, id_hash: &str) {
    if let Err(e) = db
        .execute(
            "DELETE FROM core.login_captcha_gate WHERE identifier_hash = $1",
            params![id_hash],
        )
        .await
    {
        tracing::error!(error = %e, "captcha_gate: could not reset after success");
    }
}
