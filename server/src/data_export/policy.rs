//! The policy: seven settings, and the two dates they produce.
//!
//! Read through [`crate::settings::instance_value`], so the scope chain of
//! migration `000060` applies and a missing row falls back to the declared
//! factory default rather than taking a background job down.
//!
//! Values are **clamped, never trusted** - same discipline as
//! [`crate::backup::policy`]. A retention of zero would delete the archive the
//! moment it became available; a hold of a year would make the feature
//! unusable. Both are refused at the API and clamped again here, because the
//! job must stay correct against a row written by something other than the
//! console.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use kubuno_db::DbPool;

pub const KEY_DESTINATION: &str = "data_export.destination";
pub const KEY_HOLD_HOURS: &str = "data_export.hold_hours";
pub const KEY_RETENTION_DAYS: &str = "data_export.retention_days";
pub const KEY_MAX_FILE_MB: &str = "data_export.max_file_mb";
pub const KEY_MODULE_TIMEOUT_S: &str = "data_export.module_timeout_s";
pub const KEY_REQUIRE_2FA: &str = "data_export.require_2fa";
pub const KEY_MIN_ADMIN_AGE_DAYS: &str = "data_export.min_admin_age_days";

/// Whether an account may export its **own** data (migration `000122`).
///
/// The only key of this feature declared `overridable`: it is resolved through
/// the scope chain, so an organisational unit, a group or a single account may
/// differ from the instance. See [`self_service_enabled`].
pub const KEY_SELF_SERVICE: &str = "data_export.self_service";
pub const KEY_SELF_HOLD_HOURS: &str = "data_export.self_hold_hours";
pub const KEY_SELF_MAX_DOWNLOADS: &str = "data_export.self_max_downloads";

/// Every key this feature owns.
pub const ALL_KEYS: &[&str] = &[
    KEY_DESTINATION,
    KEY_HOLD_HOURS,
    KEY_RETENTION_DAYS,
    KEY_MAX_FILE_MB,
    KEY_MODULE_TIMEOUT_S,
    KEY_REQUIRE_2FA,
    KEY_MIN_ADMIN_AGE_DAYS,
    KEY_SELF_SERVICE,
    KEY_SELF_HOLD_HOURS,
    KEY_SELF_MAX_DOWNLOADS,
];

/// Settings category, so the console can group them.
pub const CATEGORY: &str = "data_export";

/// Default destination: `<data>/exports` (`/var/lib/kubuno/exports` on Linux).
fn default_destination() -> String {
    crate::config::paths::current().exports_dir().to_string_lossy().into_owned()
}
const DEFAULT_HOLD_HOURS: i64 = 48;
const DEFAULT_RETENTION_DAYS: i64 = 7;
const DEFAULT_MAX_FILE_MB: i64 = 2_048;
const DEFAULT_MODULE_TIMEOUT_S: i64 = 600;
const DEFAULT_MIN_ADMIN_AGE_DAYS: i64 = 30;

/// Bounds. The upper end of the hold is two weeks: past that an operator works
/// around the feature instead of using it, and a control people route around is
/// not a control.
const HOLD_HOURS_MAX: i64 = 336;
const RETENTION_DAYS_MIN: i64 = 1;
const RETENTION_DAYS_MAX: i64 = 90;
const MAX_FILE_MB_MIN: i64 = 1;
const MAX_FILE_MB_MAX: i64 = 65_536;
const MODULE_TIMEOUT_MIN: i64 = 5;
const MODULE_TIMEOUT_MAX: i64 = 3_600;
const MIN_ADMIN_AGE_MAX: i64 = 3_650;

/// Self-service bounds. The hold is capped well below the administrator's two
/// weeks: past a couple of days, a portability request stops being answered and
/// starts being obstructed.
const SELF_HOLD_HOURS_MAX: i64 = 72;
const SELF_MAX_DOWNLOADS_MIN: i64 = 1;
const SELF_MAX_DOWNLOADS_MAX: i64 = 100;
const DEFAULT_SELF_HOLD_HOURS: i64 = 0;
const DEFAULT_SELF_MAX_DOWNLOADS: i64 = 5;

#[derive(Debug, Clone, Serialize)]
pub struct Policy {
    pub destination: String,
    /// Hours between "the archive is finished" and "the archive can be
    /// downloaded". Zero disables the protection, and the console says so in as
    /// many words rather than hiding the option.
    pub hold_hours: i64,
    /// Days the archive stays on disk once available. Counted from
    /// `available_at`, never from the request: an export that took two days to
    /// produce must not arrive with one day left.
    pub retention_days: i64,
    pub max_file_mb: i64,
    pub module_timeout_s: i64,
    pub require_2fa: bool,
    pub min_admin_age_days: i64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            destination: default_destination(),
            hold_hours: DEFAULT_HOLD_HOURS,
            retention_days: DEFAULT_RETENTION_DAYS,
            max_file_mb: DEFAULT_MAX_FILE_MB,
            module_timeout_s: DEFAULT_MODULE_TIMEOUT_S,
            require_2fa: true,
            min_admin_age_days: DEFAULT_MIN_ADMIN_AGE_DAYS,
        }
    }
}

impl Policy {
    /// Largest single file admitted into an archive, in bytes.
    pub fn max_file_bytes(&self) -> u64 {
        (self.max_file_mb.max(MAX_FILE_MB_MIN) as u64).saturating_mul(1024 * 1024)
    }

    pub fn module_timeout(&self) -> Duration {
        Duration::from_secs(self.module_timeout_s.max(MODULE_TIMEOUT_MIN) as u64)
    }

    /// The two dates of a run about to be created, computed once and stored.
    ///
    /// Deliberately **not** recomputed afterwards: shortening the hold must not
    /// pull forward the release of an export already under way, and lengthening
    /// it must not push back one an operator is waiting for. A deadline that
    /// moves under a setting is a deadline nobody can rely on, in either
    /// direction.
    pub fn window_from(&self, now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
        let available = now + chrono::Duration::hours(self.hold_hours.clamp(0, HOLD_HOURS_MAX));
        let expires = available
            + chrono::Duration::days(
                self.retention_days
                    .clamp(RETENTION_DAYS_MIN, RETENTION_DAYS_MAX),
            );
        (available, expires)
    }
}

/// Reads the policy in force at instance level. Never fails, for the same reason
/// [`crate::backup::policy::load`] never fails.
pub async fn load(db: &DbPool) -> Policy {
    let d = Policy::default();

    let destination = crate::settings::instance_value(db, KEY_DESTINATION)
        .await
        .as_ref()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_destination);

    let hold_hours = crate::settings::instance_value(db, KEY_HOLD_HOURS)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.hold_hours)
        .clamp(0, HOLD_HOURS_MAX);

    let retention_days = crate::settings::instance_value(db, KEY_RETENTION_DAYS)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.retention_days)
        .clamp(RETENTION_DAYS_MIN, RETENTION_DAYS_MAX);

    let max_file_mb = crate::settings::instance_value(db, KEY_MAX_FILE_MB)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.max_file_mb)
        .clamp(MAX_FILE_MB_MIN, MAX_FILE_MB_MAX);

    let module_timeout_s = crate::settings::instance_value(db, KEY_MODULE_TIMEOUT_S)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.module_timeout_s)
        .clamp(MODULE_TIMEOUT_MIN, MODULE_TIMEOUT_MAX);

    let require_2fa = crate::settings::instance_value(db, KEY_REQUIRE_2FA)
        .await
        .as_ref()
        .and_then(Value::as_bool)
        .unwrap_or(d.require_2fa);

    let min_admin_age_days = crate::settings::instance_value(db, KEY_MIN_ADMIN_AGE_DAYS)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.min_admin_age_days)
        .clamp(0, MIN_ADMIN_AGE_MAX);

    Policy {
        destination,
        hold_hours,
        retention_days,
        max_file_mb,
        module_timeout_s,
        require_2fa,
        min_admin_age_days,
    }
}

// ── Self-service ─────────────────────────────────────────────────────────────

/// What governs an account exporting its **own** data.
///
/// A separate struct rather than three more fields on [`Policy`], because the
/// two answer different questions and share only the disk they write to. The
/// values they do share - the retention and the per-file ceiling - are read from
/// the **same** keys on purpose: "how long an archive of this instance lives" has
/// one answer, and giving the self-service path its own copy would let the two
/// drift until an operator who shortened the retention discovers half the
/// archives ignored it.
#[derive(Debug, Clone, Serialize)]
pub struct SelfPolicy {
    /// Hours between "the archive is finished" and "it can be downloaded".
    /// **Zero by default**, unlike the administrator's 48 h - see
    /// [`KEY_SELF_HOLD_HOURS`] for the reasoning, which is that the hold defends
    /// against exfiltrating *everybody's* data from a stolen session, and a
    /// stolen session can already read this one account's data in the interface.
    pub hold_hours: i64,
    pub retention_days: i64,
    /// How many times one archive may be fetched before a new one is needed.
    pub max_downloads: i64,
    /// The largest per-file ceiling a requester may ask for. They may lower it,
    /// never raise it: it is the instance's protection against a single object
    /// making an archive unusable, not a preference.
    pub max_file_mb: i64,
}

impl Default for SelfPolicy {
    fn default() -> Self {
        Self {
            hold_hours: DEFAULT_SELF_HOLD_HOURS,
            retention_days: DEFAULT_RETENTION_DAYS,
            max_downloads: DEFAULT_SELF_MAX_DOWNLOADS,
            max_file_mb: DEFAULT_MAX_FILE_MB,
        }
    }
}

impl SelfPolicy {
    /// The two dates of a personal request, computed once and stored - same rule
    /// as [`Policy::window_from`], and the same reason.
    pub fn window_from(&self, now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
        let available = now + chrono::Duration::hours(self.hold_hours.clamp(0, SELF_HOLD_HOURS_MAX));
        let expires = available
            + chrono::Duration::days(
                self.retention_days
                    .clamp(RETENTION_DAYS_MIN, RETENTION_DAYS_MAX),
            );
        (available, expires)
    }

    /// The per-file ceiling actually applied to a request, given what was asked.
    ///
    /// `None` (nothing asked) and an over-large value both land on the instance
    /// ceiling: a requester may only ever tighten it.
    pub fn resolve_max_file_mb(&self, requested: Option<i64>) -> i64 {
        let ceiling = self.max_file_mb.clamp(MAX_FILE_MB_MIN, MAX_FILE_MB_MAX);
        match requested {
            Some(v) => v.clamp(MAX_FILE_MB_MIN, ceiling),
            None => ceiling,
        }
    }
}

/// Reads the self-service policy. Never fails, like [`load`].
pub async fn load_self(db: &DbPool) -> SelfPolicy {
    let d = SelfPolicy::default();

    let hold_hours = crate::settings::instance_value(db, KEY_SELF_HOLD_HOURS)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.hold_hours)
        .clamp(0, SELF_HOLD_HOURS_MAX);

    let retention_days = crate::settings::instance_value(db, KEY_RETENTION_DAYS)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.retention_days)
        .clamp(RETENTION_DAYS_MIN, RETENTION_DAYS_MAX);

    let max_downloads = crate::settings::instance_value(db, KEY_SELF_MAX_DOWNLOADS)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.max_downloads)
        .clamp(SELF_MAX_DOWNLOADS_MIN, SELF_MAX_DOWNLOADS_MAX);

    let max_file_mb = crate::settings::instance_value(db, KEY_MAX_FILE_MB)
        .await
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(d.max_file_mb)
        .clamp(MAX_FILE_MB_MIN, MAX_FILE_MB_MAX);

    SelfPolicy {
        hold_hours,
        retention_days,
        max_downloads,
        max_file_mb,
    }
}

/// May **this** account export its own data?
///
/// Resolved through the scope chain of migration `000060` as seen from the
/// account itself, which is what gives the setting the granularity the feature
/// is specified with: the value may be written at the instance, on an
/// organisational unit, on a group or on one account, and the most specific one
/// - or the most general **lock** - wins. Nothing here knows about units; it
/// asks the chain, exactly as the password policy does.
///
/// A read failure falls back to the declared factory default (enabled) rather
/// than to a refusal, for the same reason [`load`] cannot fail: the alternative
/// is a feature that disappears from somebody's account page during a database
/// hiccup, and the archive at the end of this path contains nothing the caller
/// cannot already read in the interface.
pub async fn self_service_enabled(db: &DbPool, user_id: uuid::Uuid) -> bool {
    let scope = crate::settings::SettingScope::user(user_id);
    match crate::settings::chain::resolve_for(db, KEY_SELF_SERVICE, &scope).await {
        Ok(resolution) => resolution
            .value
            .as_ref()
            .and_then(Value::as_bool)
            .unwrap_or(true),
        Err(e) => {
            tracing::error!(error = %e, user_id = %user_id,
                "export: résolution du libre-service impossible - valeur d'usine retenue");
            true
        }
    }
}

/// Refuses a destination that is not a plausible directory to write into.
///
/// Same three rules as the backup destination, and the same reasoning: an
/// absolute path (a relative one resolves against the server's working
/// directory, which nobody can reason about), no `..` component, a bounded
/// length. Deliberately duplicated rather than shared: the day one of the two
/// features needs a fourth rule, it must be able to grow it alone.
pub fn validate_destination(raw: &str) -> Result<String, crate::errors::AppError> {
    use crate::errors::AppError;

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "Le répertoire des archives est obligatoire".into(),
        ));
    }
    if trimmed.len() > 512 {
        return Err(AppError::Validation(
            "Répertoire des archives : 512 caractères maximum".into(),
        ));
    }
    let path = std::path::Path::new(trimmed);
    if !path.is_absolute() {
        return Err(AppError::Validation(
            "Le répertoire des archives doit être un chemin absolu".into(),
        ));
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::Validation(
            "Le répertoire des archives ne peut pas contenir « .. »".into(),
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
    use chrono::TimeZone;

    fn at(y: i32, m: u32, d: u32, h: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, 0, 0)
            .single()
            .expect("date de test valide")
    }

    #[test]
    fn the_window_is_hold_then_retention() {
        let p = Policy::default();
        let (available, expires) = p.window_from(at(2026, 8, 14, 10));
        assert_eq!(available, at(2026, 8, 16, 10), "48 h de délai de sécurité");
        assert_eq!(expires, at(2026, 8, 23, 10), "puis 7 jours de disponibilité");
    }

    /// The constraint `expires_at > available_at` is enforced in SQL; this makes
    /// sure the arithmetic can never propose a row that would violate it, even
    /// with an absurd policy.
    #[test]
    fn the_window_is_always_ordered() {
        for hold in [-100, 0, 1, 48, 10_000] {
            for retention in [-5, 0, 1, 90, 10_000] {
                let p = Policy {
                    hold_hours: hold,
                    retention_days: retention,
                    ..Policy::default()
                };
                let (a, e) = p.window_from(at(2026, 8, 14, 10));
                assert!(e > a, "hold={hold} retention={retention}");
            }
        }
    }

    #[test]
    fn a_zero_hold_makes_the_archive_available_at_once() {
        let p = Policy {
            hold_hours: 0,
            ..Policy::default()
        };
        let now = at(2026, 8, 14, 10);
        assert_eq!(p.window_from(now).0, now);
    }

    #[test]
    fn destinations_must_be_absolute_and_sane() {
        assert!(validate_destination(&abs("/var/lib/kubuno/exports")).is_ok());
        assert_eq!(
            validate_destination(&format!("  {}  ", abs("/srv/exports")))
                .ok()
                .as_deref(),
            Some(abs("/srv/exports").as_str())
        );
        assert!(validate_destination("").is_err());
        assert!(validate_destination("exports").is_err());
        assert!(validate_destination(&abs("/var/../etc")).is_err());
    }

    /// An absolute path in the host's own flavour: a leading `/` is only absolute
    /// on Unix, whereas Windows needs a drive (`C:\var\lib`).
    fn abs(unix_style: &str) -> String {
        if cfg!(windows) {
            format!("C:{}", unix_style.replace('/', "\\"))
        } else {
            unix_style.to_string()
        }
    }

    /// The self-service default is the opposite trade-off of the administrative
    /// one, and the test states it so that flipping it back requires editing a
    /// sentence rather than a constant.
    #[test]
    fn the_self_service_archive_is_available_at_once_by_default() {
        let p = SelfPolicy::default();
        assert_eq!(p.hold_hours, 0, "pas de délai de sécurité en libre-service");
        let now = at(2026, 8, 14, 10);
        let (available, expires) = p.window_from(now);
        assert_eq!(available, now);
        assert_eq!(expires, at(2026, 8, 21, 10), "puis 7 jours de disponibilité");
    }

    #[test]
    fn an_administrable_self_service_hold_still_orders_the_window() {
        for hold in [-10, 0, 1, 48, 100_000] {
            let p = SelfPolicy {
                hold_hours: hold,
                ..SelfPolicy::default()
            };
            let (a, e) = p.window_from(at(2026, 8, 14, 10));
            assert!(e > a, "hold={hold}");
        }
    }

    /// A requester may tighten the per-file ceiling and never widen it.
    #[test]
    fn the_requested_ceiling_can_only_go_down() {
        let p = SelfPolicy {
            max_file_mb: 100,
            ..SelfPolicy::default()
        };
        assert_eq!(p.resolve_max_file_mb(None), 100);
        assert_eq!(p.resolve_max_file_mb(Some(25)), 25);
        assert_eq!(p.resolve_max_file_mb(Some(5_000)), 100, "plafond d'instance");
        assert_eq!(p.resolve_max_file_mb(Some(0)), 1);
        assert_eq!(p.resolve_max_file_mb(Some(-3)), 1);
    }

    #[test]
    fn the_file_ceiling_is_expressed_in_bytes() {
        let p = Policy {
            max_file_mb: 2,
            ..Policy::default()
        };
        assert_eq!(p.max_file_bytes(), 2 * 1024 * 1024);
    }
}
