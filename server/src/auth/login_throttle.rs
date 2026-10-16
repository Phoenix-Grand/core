//! Per-account sign-in throttle: exponential backoff against credential
//! stuffing and brute force, persisted in `core.login_throttle`.
//!
//! # Why this exists
//!
//! [`crate::auth::rate_limit`] limits attempts per IP, in process memory. That
//! is useful against a burst from one address but useless against the shape of a
//! real attack: credential stuffing is *distributed* (a few tries from each of
//! thousands of addresses), and the in-memory counter is reset on restart and
//! not shared between instances. What was missing is a ceiling **per account**,
//! persistent and shared - the only thing that resists a targeted guess. This
//! module is that ceiling.
//!
//! # Behaviour
//!
//! Modelled on OWASP (Credential Stuffing / Authentication cheat sheets), NIST
//! SP 800-63B §5.2.2 and the ANSSI/CNIL password recommendations:
//!
//! * a temporising **exponential backoff**, never a hard permanent lock - a
//!   permanent lock would hand an attacker a denial of service on any account
//!   whose e-mail they know;
//! * the delay starts after [`SOFT_THRESHOLD`] failures and doubles each further
//!   failure (`> 1 min` after 5 failures, per ANSSI), capped at [`MAX_DELAY`];
//! * a daily cap of [`WINDOW_CAP`] attempts over a 24 h window (ANSSI) and an
//!   absolute ceiling of [`HARD_CAP`] consecutive failures (NIST);
//! * **reset on success** (NIST SHOULD): the row is deleted;
//! * a password reset re-opens the account regardless (the reset flow does not
//!   go through here), so temporising is never a dead end.
//!
//! The caller never tells the client that an account is locked (that would be an
//! enumeration oracle): [`is_locked`] returning `true` maps to the same generic
//! "invalid credentials" answer, and the sign-in handler runs the argon2 verify
//! either way so the response timing does not change.

use chrono::{DateTime, Duration, Utc};
use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

/// Consecutive failures before any delay is imposed.
const SOFT_THRESHOLD: i32 = 5;
/// First delay applied at `SOFT_THRESHOLD` failures, in seconds. Doubles after.
const BASE_DELAY_SECS: i64 = 60;
/// Ceiling on a single delay, in seconds (15 min).
const MAX_DELAY_SECS: i64 = 15 * 60;
/// Length of the sliding window for the daily cap, in hours.
const WINDOW_HOURS: i64 = 24;
/// Maximum attempts within the 24 h window before the delay is forced to the
/// maximum (ANSSI: ≤ 25 attempts / 24 h).
const WINDOW_CAP: i32 = 25;
/// Absolute ceiling on consecutive failures (NIST SP 800-63B: ≤ 100).
const HARD_CAP: i32 = 100;

/// The delay to impose after `failed_attempts` consecutive failures, or `None`
/// while still under [`SOFT_THRESHOLD`].
fn lock_delay(failed_attempts: i32) -> Option<Duration> {
    if failed_attempts < SOFT_THRESHOLD {
        return None;
    }
    // 60s, 120s, 240s, … capped at 15 min. `exp` stays small; guard the shift.
    let exp = (failed_attempts - SOFT_THRESHOLD).min(20) as u32;
    let secs = BASE_DELAY_SECS
        .saturating_mul(2i64.saturating_pow(exp))
        .min(MAX_DELAY_SECS);
    Some(Duration::seconds(secs))
}

/// Whether this account is currently within an active backoff delay.
///
/// Fails **open** (returns `false`) on a database error: a transient DB problem
/// must not lock every account out. The recording side is best-effort for the
/// same reason.
pub async fn is_locked(db: &DbPool, user_id: Uuid) -> bool {
    match db
        .fetch_optional_scalar::<Option<DateTime<Utc>>>(
            "SELECT locked_until FROM core.login_throttle WHERE user_id = $1",
            params![user_id],
        )
        .await
    {
        Ok(Some(Some(locked_until))) => locked_until > Utc::now(),
        Ok(_) => false,
        Err(e) => {
            tracing::error!(error = %e, "login_throttle: reading the state failed");
            false
        }
    }
}

/// Record a failed sign-in for `user_id` and apply the backoff. Best-effort:
/// errors are logged and swallowed so a throttle-store hiccup never turns into a
/// failed sign-in for a legitimate user (the argon2 check has already decided the
/// outcome; this only shapes future attempts).
///
/// Returns `true` when this failure pushed the account into (or deeper into)
/// backoff - the caller uses it as an audit signal.
pub async fn record_failure(db: &DbPool, user_id: Uuid) -> bool {
    let now = Utc::now();
    let window = Duration::hours(WINDOW_HOURS);

    let existing = db
        .fetch_optional_as::<(i32, Option<DateTime<Utc>>, i32, i16)>(
            "SELECT failed_attempts, window_started_at, window_count, lockout_count \
           FROM core.login_throttle WHERE user_id = $1",
            params![user_id],
        )
        .await;

    let (prev_failed, window_started_at, window_count, prev_lockouts) = match existing {
        Ok(Some(row)) => row,
        Ok(None) => (0, None, 0, 0),
        Err(e) => {
            tracing::error!(error = %e, "login_throttle: could not read before recording failure");
            return false;
        }
    };

    // Reset the 24 h window if it has elapsed (or never started).
    let (window_start, window_n) = match window_started_at {
        Some(start) if now - start <= window => (start, window_count),
        _ => (now, 0),
    };

    let failed = prev_failed + 1;
    let window_n = window_n + 1;

    let mut delay = lock_delay(failed);
    // Daily cap or absolute ceiling: force the maximum delay.
    if window_n >= WINDOW_CAP || failed >= HARD_CAP {
        delay = Some(Duration::seconds(MAX_DELAY_SECS));
    }
    let locked_until = delay.map(|d| now + d);
    let lockouts = prev_lockouts + if locked_until.is_some() { 1 } else { 0 };

    // `updated_at` is bound (`$8`) rather than written as `NOW()`, so the upsert's
    // update branch reuses the incoming value on every engine.
    let backend = db.backend();
    let sql = format!(
        "INSERT INTO core.login_throttle \
            (user_id, failed_attempts, window_started_at, window_count, \
             last_attempt_at, locked_until, lockout_count, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8){}",
        backend.upsert(
            "core.login_throttle",
            &["user_id"],
            &[
                Assign::Incoming("failed_attempts"),
                Assign::Incoming("window_started_at"),
                Assign::Incoming("window_count"),
                Assign::Incoming("last_attempt_at"),
                Assign::Incoming("locked_until"),
                Assign::Incoming("lockout_count"),
                Assign::Incoming("updated_at"),
            ],
        )
    );
    let res = db
        .execute(
            &sql,
            params![
                user_id,
                failed,
                window_start,
                window_n,
                now,
                locked_until,
                lockouts,
                now,
            ],
        )
        .await;

    if let Err(e) = res {
        tracing::error!(error = %e, "login_throttle: could not record the failure");
        return false;
    }
    locked_until.is_some()
}

/// Clear the throttle for `user_id` after a successful sign-in (NIST: disregard
/// previous failures once authentication succeeds). Best-effort.
pub async fn record_success(db: &DbPool, user_id: Uuid) {
    if let Err(e) = db
        .execute(
            "DELETE FROM core.login_throttle WHERE user_id = $1",
            params![user_id],
        )
        .await
    {
        tracing::error!(error = %e, "login_throttle: could not reset after success");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_delay_below_threshold() {
        for n in 0..SOFT_THRESHOLD {
            assert!(lock_delay(n).is_none(), "n={n} should not lock");
        }
    }

    #[test]
    fn delay_doubles_then_caps() {
        assert_eq!(lock_delay(5), Some(Duration::seconds(60)));
        assert_eq!(lock_delay(6), Some(Duration::seconds(120)));
        assert_eq!(lock_delay(7), Some(Duration::seconds(240)));
        assert_eq!(lock_delay(8), Some(Duration::seconds(480)));
        // 960s would exceed the 15 min cap → clamped.
        assert_eq!(lock_delay(9), Some(Duration::seconds(MAX_DELAY_SECS)));
        assert_eq!(lock_delay(50), Some(Duration::seconds(MAX_DELAY_SECS)));
    }
}
