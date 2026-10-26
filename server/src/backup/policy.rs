//! The policy: five settings, and the arithmetic that turns them into a date.
//!
//! Everything is read through [`crate::settings::instance_value`], so the scope
//! chain of migration `000060` applies and a missing row falls back to the
//! declared factory default rather than taking the scheduler down.
//!
//! Values are **clamped, never trusted**. A retention of `0` would delete the
//! backup it has just written; an hour of `47` would schedule the next run in
//! the year after next. Both are refused at the API, and clamped again here -
//! the scheduler must stay correct against a row written by something other than
//! the console.

use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};
use serde::Serialize;
use serde_json::Value;
use kubuno_db::DbPool;

pub const KEY_ENABLED: &str = "backup.enabled";
pub const KEY_FREQUENCY: &str = "backup.frequency";
pub const KEY_HOUR_UTC: &str = "backup.hour_utc";
pub const KEY_RETENTION: &str = "backup.retention_count";
pub const KEY_DESTINATION: &str = "backup.destination";
pub const KEY_LAST_RESTORE_TEST: &str = "backup.last_restore_test_at";

/// Every key this feature owns - used by the generic settings route to refuse a
/// write it should not perform, the way the mail relay does.
pub const ALL_KEYS: &[&str] = &[
    KEY_ENABLED,
    KEY_FREQUENCY,
    KEY_HOUR_UTC,
    KEY_RETENTION,
    KEY_DESTINATION,
    KEY_LAST_RESTORE_TEST,
];

/// Settings category, so the console can group them.
pub const CATEGORY: &str = "backup";

/// Default destination: the platform backup directory (`/var/backups/kubuno` on Linux).
fn default_destination() -> String {
    crate::config::paths::current().backup_dir.to_string_lossy().into_owned()
}
const DEFAULT_HOUR_UTC: i64 = 3;
const DEFAULT_RETENTION: i64 = 7;

/// Bounds on the retention. One is the minimum that is still a policy; ninety is
/// far past what any self-hosted instance keeps on the same volume it backs up.
const RETENTION_MIN: i64 = 1;
const RETENTION_MAX: i64 = 90;

/// How often the scheduler wakes up while the policy is switched off. Short
/// enough that enabling it does not mean waiting a day, long enough to be free.
pub const DISABLED_RECHECK: std::time::Duration = std::time::Duration::from_secs(3_600);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Frequency {
    Daily,
    /// Sunday, at the configured hour. Stated in the setting's description
    /// rather than made into a sixth knob nobody would ever move.
    Weekly,
}

impl Frequency {
    pub const fn as_str(self) -> &'static str {
        match self {
            Frequency::Daily => "daily",
            Frequency::Weekly => "weekly",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "daily" => Some(Frequency::Daily),
            "weekly" => Some(Frequency::Weekly),
            _ => None,
        }
    }

    /// How stale a successful backup may get before the instance is, in
    /// practice, unprotected. One cycle of grace on top of the cadence: a single
    /// missed night is a retry, three days of silence is a broken policy.
    pub const fn stale_after_days(self) -> i64 {
        match self {
            Frequency::Daily => 2,
            Frequency::Weekly => 8,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Policy {
    pub enabled: bool,
    pub frequency: Frequency,
    /// 0–23, in UTC. The core has no instance timezone; saying "UTC" on the
    /// label is the honest form, and inventing a local hour would be a guess.
    pub hour_utc: i64,
    pub retention_count: i64,
    pub destination: String,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            enabled: false,
            frequency: Frequency::Daily,
            hour_utc: DEFAULT_HOUR_UTC,
            retention_count: DEFAULT_RETENTION,
            destination: default_destination(),
        }
    }
}

impl Policy {
    /// The next moment a scheduled run is due, strictly after `from`.
    ///
    /// Deliberately *strictly* after: a handler that finishes at 03:00:04 and
    /// asks for "the next 03:00" must not be handed the one it has just run, or
    /// the queue would spin for the rest of the hour.
    pub fn next_run_after(&self, from: DateTime<Utc>) -> DateTime<Utc> {
        let hour = self.hour_utc.clamp(0, 23) as u32;

        // Today at the configured hour, as the anchor. `single()` can only be
        // `None` for a timezone with a gap at that instant; UTC has none, and the
        // fallback keeps the function total rather than panicking on a case that
        // cannot happen.
        let today = match Utc
            .with_ymd_and_hms(from.year(), from.month(), from.day(), hour, 0, 0)
            .single()
        {
            Some(t) => t,
            None => return from + Duration::hours(1),
        };

        match self.frequency {
            Frequency::Daily => {
                if today > from {
                    today
                } else {
                    today + Duration::days(1)
                }
            }
            Frequency::Weekly => {
                // Days from today to the next Sunday, 0 when today *is* Sunday.
                let ahead = (7 - today.weekday().num_days_from_sunday()) % 7;
                let candidate = today + Duration::days(i64::from(ahead));
                if candidate > from {
                    candidate
                } else {
                    candidate + Duration::days(7)
                }
            }
        }
    }

    /// How long the scheduler should sleep before the next attempt.
    ///
    /// Never zero and never negative: the job queue treats a `run_after` in the
    /// past as "runnable now", and a handler that re-arms itself for the past is
    /// a busy loop with a database behind it.
    pub fn delay_until_next(&self, from: DateTime<Utc>) -> std::time::Duration {
        let next = self.next_run_after(from);
        (next - from)
            .to_std()
            .unwrap_or(std::time::Duration::from_secs(60))
            .max(std::time::Duration::from_secs(60))
    }

    pub fn stale_after_days(&self) -> i64 {
        self.frequency.stale_after_days()
    }
}

/// Reads the policy in force at instance level.
///
/// Never fails: a background worker that cannot start because one settings row
/// is missing is a worse outcome than one that starts with the declared
/// defaults, and every fallback here is the value the migration seeded.
pub async fn load(db: &DbPool) -> Policy {
    let d = Policy::default();

    let enabled = crate::settings::instance_value(db, KEY_ENABLED)
        .await
        .as_ref()
        .and_then(Value::as_bool)
        .unwrap_or(d.enabled);

    let frequency = crate::settings::instance_value(db, KEY_FREQUENCY)
        .await
        .as_ref()
        .and_then(Value::as_str)
        .and_then(Frequency::parse)
        .unwrap_or(d.frequency);

    let hour_utc = crate::settings::instance_value(db, KEY_HOUR_UTC)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.hour_utc)
        .clamp(0, 23);

    let retention_count = crate::settings::instance_value(db, KEY_RETENTION)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.retention_count)
        .clamp(RETENTION_MIN, RETENTION_MAX);

    let destination = crate::settings::instance_value(db, KEY_DESTINATION)
        .await
        .as_ref()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_destination);

    Policy {
        enabled,
        frequency,
        hour_utc,
        retention_count,
        destination,
    }
}

/// When an administrator last declared having restored a backup successfully.
///
/// Declarative by construction - see the setting's own description. Read here so
/// the health check and the console cannot disagree about the date.
pub async fn last_restore_test(db: &DbPool) -> Option<DateTime<Utc>> {
    crate::settings::instance_value(db, KEY_LAST_RESTORE_TEST)
        .await
        .as_ref()
        .and_then(Value::as_str)
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|dt| dt.with_timezone(&Utc))
}

/// Refuses a destination that is not a plausible directory to write into.
///
/// Three rules, each protecting against a different accident: an absolute path
/// (a relative one resolves against the server's working directory, which is not
/// something an operator can reason about), no `..` component (a policy is not a
/// path traversal), and a bounded length (the value ends up in a column).
pub fn validate_destination(raw: &str) -> Result<String, crate::errors::AppError> {
    use crate::errors::AppError;

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "The destination directory is required".into(),
        ));
    }
    if trimmed.len() > 512 {
        return Err(AppError::Validation(
            "Destination directory: maximum 512 characters".into(),
        ));
    }
    let path = std::path::Path::new(trimmed);
    if !path.is_absolute() {
        return Err(AppError::Validation(
            "The destination directory must be an absolute path".into(),
        ));
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::Validation(
            "The destination directory cannot contain '..'".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// True when `key` belongs to this feature.
pub fn owns_setting(key: &str) -> bool {
    ALL_KEYS.contains(&key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Timelike, Weekday};

    fn at(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, mi, 0)
            .single()
            .expect("date de test valide")
    }

    fn daily(hour: i64) -> Policy {
        Policy {
            enabled: true,
            frequency: Frequency::Daily,
            hour_utc: hour,
            ..Policy::default()
        }
    }

    #[test]
    fn a_daily_policy_picks_today_then_tomorrow() {
        let p = daily(3);
        // Before the hour: today.
        assert_eq!(p.next_run_after(at(2026, 8, 4, 1, 0)), at(2026, 8, 4, 3, 0));
        // After it: tomorrow.
        assert_eq!(p.next_run_after(at(2026, 8, 4, 5, 0)), at(2026, 8, 5, 3, 0));
    }

    /// The bug this guards against: a run that finishes four seconds past the
    /// hour re-arms itself for the hour it has just executed, and the queue
    /// spins until the clock moves on.
    #[test]
    fn the_next_run_is_strictly_in_the_future() {
        let p = daily(3);
        let exactly = at(2026, 8, 4, 3, 0);
        assert_eq!(p.next_run_after(exactly), at(2026, 8, 5, 3, 0));
        assert!(p.delay_until_next(exactly) >= std::time::Duration::from_secs(60));
    }

    #[test]
    fn a_weekly_policy_lands_on_sunday() {
        let p = Policy {
            enabled: true,
            frequency: Frequency::Weekly,
            hour_utc: 4,
            ..Policy::default()
        };
        // 2026-08-04 is a Tuesday; the next Sunday is the 9th.
        let next = p.next_run_after(at(2026, 8, 4, 12, 0));
        assert_eq!(next, at(2026, 8, 9, 4, 0));
        assert_eq!(next.weekday(), Weekday::Sun);

        // Sunday morning, before the hour: today. After it: next Sunday.
        assert_eq!(p.next_run_after(at(2026, 8, 9, 1, 0)), at(2026, 8, 9, 4, 0));
        assert_eq!(p.next_run_after(at(2026, 8, 9, 6, 0)), at(2026, 8, 16, 4, 0));
    }

    #[test]
    fn an_absurd_hour_never_schedules_out_of_range() {
        let p = daily(99);
        let next = p.next_run_after(at(2026, 8, 4, 12, 0));
        assert_eq!(next.hour(), 23);
        assert!(next > at(2026, 8, 4, 12, 0));
    }

    #[test]
    fn destinations_must_be_absolute_and_sane() {
        assert!(validate_destination(&abs("/var/backups/kubuno")).is_ok());
        assert_eq!(
            validate_destination(&format!("  {}  ", abs("/srv/sauvegardes")))
                .ok()
                .as_deref(),
            Some(abs("/srv/sauvegardes").as_str())
        );
        assert!(validate_destination("").is_err());
        assert!(validate_destination("sauvegardes").is_err());
        assert!(validate_destination(&abs("/var/../etc")).is_err());
        assert!(validate_destination(&abs(&"/x".repeat(400))).is_err());
    }

    /// An absolute path in the host's own flavour: a leading `/` is only absolute
    /// on Unix, whereas Windows needs a drive (`C:\var\backups`).
    fn abs(unix_style: &str) -> String {
        if cfg!(windows) {
            format!("C:{}", unix_style.replace('/', "\\"))
        } else {
            unix_style.to_string()
        }
    }

    #[test]
    fn staleness_follows_the_cadence() {
        assert_eq!(Frequency::Daily.stale_after_days(), 2);
        assert_eq!(Frequency::Weekly.stale_after_days(), 8);
    }
}
