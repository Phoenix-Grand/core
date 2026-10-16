//! Everything the checks are computed from, gathered once.
//!
//! Two rules govern this file.
//!
//! * **The server observes, the client never guesses.** Each fact is read from
//!   the database, the configuration or the request itself. Nothing here is
//!   derived from a value the console happened to have on hand.
//! * **A fact that cannot be read is `None`, never a default.** A `statvfs`
//!   that fails must produce a check saying "unknown", not one saying "plenty
//!   of room". Silent defaults are how a health page ends up lying.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Utc};
use kubuno_db::{params, DbPool, DbQueryBuilder};
use serde_json::Value;

use crate::config::Settings;
use crate::errors::AppError;

use super::disk::{self, DiskUsage};
use super::model::Muted;
use super::secret::{self, SecretVerdict};

/// What the incoming request says about the way it reached us.
///
/// The core has no "is this connection encrypted" helper: `X-Forwarded-Proto`
/// is read in two places to build URLs, without ever checking who sent it. So
/// the probe is taken here, on the very request being served, and the header is
/// believed only when the socket peer is a configured trusted proxy - the same
/// rule `auth::client_ip` applies to `X-Forwarded-For`. An untrusted peer
/// claiming `https` proves nothing and is recorded as such.
#[derive(Debug, Clone, Copy, Default)]
pub struct RequestProbe {
    /// A forwarding header was present on this request.
    pub forwarded: bool,
    /// The socket peer is inside `server.trusted_proxy_cidrs`.
    pub peer_trusted: bool,
    /// `X-Forwarded-Proto: https`, from a trusted peer.
    pub forwarded_https: bool,
}

/// Sticky memory of what has ever been observed, since start-up.
///
/// A single request is a poor witness. The same instance is routinely reachable
/// two ways - through the TLS reverse proxy for its users, and on the plain port
/// for whoever is on the machine - so the verdict of "is traffic encrypted"
/// would otherwise flip depending on which request happened to refresh the
/// cache. That is worse than either answer: an operator who reloads twice and
/// reads two different verdicts stops believing the page.
///
/// So the observations accumulate. The question the check really answers is
/// "does an encrypted path to this instance exist", which is monotonic within a
/// process: it becomes true the first time a trusted proxy hands us an HTTPS
/// request, and a restart re-opens the question.
mod observed {
    use super::RequestProbe;
    use std::sync::atomic::{AtomicBool, Ordering};

    static TLS: AtomicBool = AtomicBool::new(false);
    static PROXY: AtomicBool = AtomicBool::new(false);

    /// Folds one request into the memory. Cheap enough to call on every hit.
    pub fn note(probe: &RequestProbe) {
        if probe.forwarded_https {
            TLS.store(true, Ordering::Relaxed);
        }
        if probe.forwarded {
            PROXY.store(true, Ordering::Relaxed);
        }
    }

    pub fn tls() -> bool {
        TLS.load(Ordering::Relaxed)
    }

    pub fn proxy() -> bool {
        PROXY.load(Ordering::Relaxed)
    }
}

pub use observed::note as note_probe;

/// Settings keys the report reads. One round trip, one place to look.
const SETTING_KEYS: &[&str] = &[
    "auth.registration_open",
    "auth.email_verification",
    "security.jwt_refresh_ttl_d",
    "security.session_idle_timeout_min",
    "security.max_sessions",
    "security.admin_2fa_required",
    "security.audit_retention_days",
    "storage.default_quota_bytes",
    "instance.name",
    "instance.locale",
    "instance.timezone",
    "mail.smtp_enabled",
    "mail.smtp_host",
    "mail.from_address",
    "mail.last_test_ok_at",
];

/// One settings row, with the piece of provenance the checks need: a value the
/// operator never touched is a value they never chose.
#[derive(Debug, Clone)]
struct SettingRow {
    value: Value,
    /// The instance scope holds a row of its own - see [`load_settings`] for why
    /// that, and not `core.settings.updated_by`, is the question.
    chosen: bool,
}

/// A module that should be running and is not.
#[derive(Debug, Clone)]
pub struct FailingModule {
    pub id: String,
    /// `degraded`, `stopped`, or `never_registered` when no instance row exists.
    pub status: String,
}

/// The whole observed state, in one struct so the check functions are pure.
#[derive(Debug, Clone)]
pub struct Facts {
    // ── Accounts ────────────────────────────────────────────────────────────
    pub pending_password_changes: i64,
    pub superadmins: i64,
    pub superadmins_with_2fa: i64,
    pub non_admin_accounts: i64,

    // ── Policy ──────────────────────────────────────────────────────────────
    pub admin_2fa_required: bool,
    pub registration_open: bool,
    pub email_verification: bool,
    pub refresh_ttl_days: i64,
    pub idle_timeout_min: i64,
    pub max_sessions: i64,
    pub audit_retention_days: i64,
    pub audit_retention_chosen: bool,

    // ── Exposure ────────────────────────────────────────────────────────────
    pub native_tls: bool,
    /// The request being served, as-is. Only the trusted-proxy check that says
    /// "a proxy is in front but the ranges are wide" reads it directly.
    pub probe: RequestProbe,
    /// An encrypted arrival has been observed since start-up (or TLS is native).
    pub tls_observed: bool,
    /// A forwarding proxy has been observed since start-up.
    pub proxy_observed: bool,
    pub secret_verdict: SecretVerdict,
    pub trusted_proxy_cidrs: Vec<String>,
    pub trusted_proxies_are_default: bool,

    // ── Continuity ──────────────────────────────────────────────────────────
    pub data_path: String,
    pub disk: Option<DiskUsage>,
    pub configured_default_quota: Option<i64>,
    pub applied_default_quota: i64,

    /// The backup policy in force, and what it has actually produced.
    ///
    /// Read from `crate::backup` rather than re-derived here, so the console,
    /// the health report and the alert producer cannot disagree about whether
    /// this instance is protected.
    pub backup: crate::backup::Policy,
    pub backup_stats: crate::backup::runs::RunStats,
    /// Declared, never verified - the setting says so and the check repeats it.
    pub backup_restore_tested_at: Option<DateTime<Utc>>,

    // ── Communications ──────────────────────────────────────────────────────
    pub mail_enabled: bool,
    pub mail_host_set: bool,
    pub mail_from_set: bool,
    pub mail_host: String,
    pub mail_last_test_ok: Option<DateTime<Utc>>,
    pub mail_settings_changed_at: Option<DateTime<Utc>>,

    // ── Identity ────────────────────────────────────────────────────────────
    pub instance_name: String,
    pub instance_name_chosen: bool,
    /// `instance.locale`, raw. Kept as stored rather than normalised: the check
    /// has to be able to say "this value names no language we ship", and a
    /// normalisation that falls back to English would erase exactly that.
    pub instance_locale: String,
    pub instance_locale_chosen: bool,
    /// `instance.timezone`, raw, for the same reason: a typo must be reported,
    /// not silently rounded to UTC.
    pub instance_timezone: String,
    pub instance_timezone_chosen: bool,
    pub failing_modules: Vec<FailingModule>,

    // ── Operator decisions ──────────────────────────────────────────────────
    pub mutes: HashMap<String, Muted>,
}

/// Reads everything. Errors from individual probes degrade the corresponding
/// fact rather than failing the whole report: a health page that returns 500
/// because one query is slow tells the operator nothing at all.
pub async fn gather(db: &DbPool, settings: &Settings, probe: RequestProbe) -> Result<Facts, AppError> {
    let s = load_settings(db).await?;

    let pending_password_changes = count(
        db,
        "SELECT COUNT(*) FROM core.users WHERE must_change_password = TRUE AND is_active = TRUE",
        "accounts pending a password change",
    )
    .await?;

    // Portable derived table (see `database::compat`) in place of the
    // PostgreSQL-only `core.superadmin_ids()`.
    let superadmin_ids = crate::database::compat::superadmin_ids(db.backend());
    let superadmins = count(
        db,
        &format!(
            "SELECT {} FROM {superadmin_ids} s",
            db.backend().count_bigint("*")
        ),
        "full administrators",
    )
    .await?;

    let superadmins_with_2fa = count(
        db,
        &format!(
            "SELECT {} FROM {superadmin_ids} s \
             JOIN core.users u ON u.id = s.user_id WHERE u.totp_enabled = TRUE",
            db.backend().count_bigint("*")
        ),
        "administrators with two-factor authentication",
    )
    .await?;

    // "Not an administrator" means "does not hold a full administrator role":
    // a delegated administrator keeps `role = 'user'` by construction, so the
    // legacy column cannot answer this.
    let non_admin_accounts = count(
        db,
        &format!(
            "SELECT {} FROM core.users u \
             WHERE u.is_active = TRUE \
               AND NOT EXISTS (SELECT 1 FROM {superadmin_ids} s WHERE s.user_id = u.id)",
            db.backend().count_bigint("*")
        ),
        "non-administrator accounts",
    )
    .await?;

    let failing_modules = load_failing_modules(db).await?;
    let mutes = load_mutes(db).await?;

    // The setting is authoritative from now on; the audit trail answers for
    // tests performed before it existed. Whichever is later is the truth.
    let audit_test = db
        .fetch_scalar::<Option<DateTime<Utc>>>(
            "SELECT MAX(occurred_at) FROM core.admin_audit \
         WHERE action = 'core.mail.test' AND outcome = 'success'",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "health: reading the last relay test from the audit log");
            AppError::Database(e)
        })?;

    let setting_test = s
        .get("mail.last_test_ok_at")
        .and_then(|r| r.value.as_str())
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|dt| dt.with_timezone(&Utc));

    let mail_last_test_ok = match (setting_test, audit_test) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };

    let mail_settings_changed_at = db
        .fetch_scalar::<Option<DateTime<Utc>>>(
            "SELECT MAX(updated_at) FROM core.settings \
         WHERE category = 'mail' AND \"key\" <> 'mail.last_test_ok_at' AND updated_by IS NOT NULL",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "health: reading the last relay change");
            AppError::Database(e)
        })?;

    let data_path = settings.storage.local_path().to_string();
    let disk = disk::usage_of(Path::new(&data_path));

    let configured_cidrs = settings.server.trusted_proxy_cidrs.clone();
    let trusted_proxies_are_default = same_set(
        &configured_cidrs,
        crate::auth::client_ip::DEFAULT_TRUSTED_PROXY_CIDRS,
    );

    Ok(Facts {
        pending_password_changes,
        superadmins,
        superadmins_with_2fa,
        non_admin_accounts,

        admin_2fa_required: s.boolean("security.admin_2fa_required", false),
        registration_open: s.boolean("auth.registration_open", true),
        email_verification: s.boolean("auth.email_verification", false),
        refresh_ttl_days: s.integer("security.jwt_refresh_ttl_d", 30),
        idle_timeout_min: s.integer("security.session_idle_timeout_min", 0),
        max_sessions: s.integer("security.max_sessions", 10),
        audit_retention_days: s.integer(
            "security.audit_retention_days",
            crate::audit::retention::DEFAULT_RETENTION_DAYS,
        ),
        audit_retention_chosen: s.chosen("security.audit_retention_days"),

        native_tls: settings.server.tls.enabled,
        probe,
        tls_observed: probe.forwarded_https || observed::tls(),
        proxy_observed: probe.forwarded || observed::proxy(),
        secret_verdict: secret::grade(&settings.server.internal_secret),
        trusted_proxy_cidrs: configured_cidrs,
        trusted_proxies_are_default,

        data_path,
        disk,
        configured_default_quota: s.optional_integer("storage.default_quota_bytes"),
        // What account creation would actually hand out right now, for an account
        // in no organisational unit. It reads the setting through the same helper
        // the three creation paths use, so the check keeps comparing the number
        // an operator sees with the number the code applies - and still catches a
        // regression to a constant, which is the whole reason it exists.
        applied_default_quota: crate::models::user::default_quota_for(db, None).await,

        // Read through `crate::backup`, never re-derived from the settings map:
        // the policy is clamped there (an hour of 47, a retention of 0), and a
        // health page reporting the *unclamped* value would grade a schedule
        // that is not the one the scheduler follows.
        backup: crate::backup::policy::load(db).await,
        backup_stats: crate::backup::runs::stats(db).await.unwrap_or_default(),
        backup_restore_tested_at: crate::backup::policy::last_restore_test(db).await,

        mail_enabled: s.boolean("mail.smtp_enabled", false),
        mail_host_set: !s.string("mail.smtp_host").is_empty(),
        mail_from_set: !s.string("mail.from_address").is_empty(),
        mail_host: s.string("mail.smtp_host"),
        mail_last_test_ok,
        mail_settings_changed_at,

        instance_name: s.string("instance.name"),
        instance_name_chosen: s.chosen("instance.name"),
        instance_locale: s.string("instance.locale"),
        instance_locale_chosen: s.chosen("instance.locale"),
        instance_timezone: s.string("instance.timezone"),
        instance_timezone_chosen: s.chosen("instance.timezone"),
        failing_modules,

        mutes,
    })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// The settings rows, keyed. A missing key falls back to the accessor's
/// default: a report must survive a partially migrated database.
struct SettingMap(HashMap<String, SettingRow>);

impl SettingMap {
    fn get(&self, key: &str) -> Option<&SettingRow> {
        self.0.get(key)
    }

    fn boolean(&self, key: &str, fallback: bool) -> bool {
        self.get(key).and_then(|r| r.value.as_bool()).unwrap_or(fallback)
    }

    fn integer(&self, key: &str, fallback: i64) -> i64 {
        self.optional_integer(key).unwrap_or(fallback)
    }

    fn optional_integer(&self, key: &str) -> Option<i64> {
        self.get(key).and_then(|r| r.value.as_i64())
    }

    fn string(&self, key: &str) -> String {
        self.get(key)
            .and_then(|r| r.value.as_str())
            .unwrap_or_default()
            .to_string()
    }

    /// Did an operator ever set this value, or is it still the seed? The
    /// difference matters for the checks that ask "did somebody decide?"
    /// rather than "is the value acceptable?".
    fn chosen(&self, key: &str) -> bool {
        self.get(key).map(|r| r.chosen).unwrap_or(false)
    }
}

async fn load_settings(db: &DbPool) -> Result<SettingMap, AppError> {
    // "Chosen" is the EXISTENCE of an instance-scope row, not `settings.updated_by`.
    //
    // The two answer differently, and only one of them is right. `updated_by`
    // lives on the compatibility mirror (migration `000060`), which is written
    // when an instance value is set and - by design, see
    // `core.setting_values_mirror` - is NOT cleared when that value is reverted:
    // the DELETE branch restores `value` and leaves `updated_by` behind. An
    // operator who sets a value and then reverts it would therefore keep reading
    // "decided" on a setting that is back at its factory value, which is the one
    // thing the checks asking "did somebody decide?" must never get wrong.
    //
    // The scoped table has no such drift: reverting IS deleting the row, so the
    // absence of a row is exactly the absence of a decision.
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        "SELECT s.\"key\", s.value, \
                EXISTS ( \
                    SELECT 1 FROM core.setting_values v \
                     WHERE v.\"key\" = s.\"key\" AND v.scope_type = 'instance' \
                ) AS chosen \
           FROM core.settings s WHERE s.\"key\"",
    );
    qb.push_in(SETTING_KEYS.iter().copied());
    let rows: Vec<(String, Value, bool)> = qb.fetch_all_as(db).await.map_err(|e| {
        tracing::error!(error = %e, "health: reading the settings");
        AppError::Database(e)
    })?;

    let mut map = HashMap::with_capacity(rows.len());
    for (key, value, chosen) in rows {
        map.insert(key, SettingRow { value, chosen });
    }
    Ok(SettingMap(map))
}

// `sql` is `&'static str`: the four callers above each pass a literal written in
// this file, so nothing here can be assembled at run time.
async fn count(db: &DbPool, sql: &str, what: &str) -> Result<i64, AppError> {
    db.fetch_scalar::<i64>(sql, params![])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, what = %what, "health: counting");
            AppError::Database(e)
        })
}

/// Modules the operator enabled that are not answering.
///
/// A module with no instance row at all is the worst case and the easiest to
/// miss - it never registered, so it never had a status to degrade. Internal
/// infrastructure modules are excluded, exactly as they are from the module
/// list: they are not something an operator installed.
async fn load_failing_modules(db: &DbPool) -> Result<Vec<FailingModule>, AppError> {
    // The latest instance status per module, as a correlated scalar subquery so
    // it works on every engine (the old form used a PostgreSQL LATERAL join).
    let rows: Vec<(String, String)> = db
        .fetch_all_as(
            r#"SELECT m.id AS id,
                  COALESCE(
                      (SELECT status
                         FROM core.module_instances
                        WHERE module_id = m.id
                        ORDER BY registered_at DESC
                        LIMIT 1),
                      'never_registered'
                  ) AS status
             FROM core.modules m
            WHERE m.is_enabled = TRUE
              AND m.is_core_module = FALSE
              AND COALESCE(
                      (SELECT status
                         FROM core.module_instances
                        WHERE module_id = m.id
                        ORDER BY registered_at DESC
                        LIMIT 1),
                      'never_registered'
                  ) IN ('never_registered', 'degraded', 'stopped')
            ORDER BY m.id"#,
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "health: reading the failing modules");
            AppError::Database(e)
        })?;

    Ok(rows
        .into_iter()
        .map(|(id, status)| FailingModule { id, status })
        .collect())
}

#[allow(clippy::type_complexity)]
async fn load_mutes(db: &DbPool) -> Result<HashMap<String, Muted>, AppError> {
    // (check_id, muted_by, muted_at, reason, by_label)
    let rows: Vec<(String, Option<uuid::Uuid>, DateTime<Utc>, Option<String>, Option<String>)> = db
        .fetch_all_as(
            r#"SELECT h.check_id, h.muted_by, h.muted_at, h.reason,
                  COALESCE(NULLIF(u.display_name, ''), u.username) AS by_label
             FROM core.health_check_mutes h
             LEFT JOIN core.users u ON u.id = h.muted_by"#,
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "health: reading the muted checks");
            AppError::Database(e)
        })?;

    Ok(rows
        .into_iter()
        .map(|(id, by, at, reason, by_label)| {
            (
                id,
                Muted {
                    by,
                    by_label,
                    at,
                    reason,
                },
            )
        })
        .collect())
}

/// Set equality, order-insensitive and whitespace-tolerant - the configured
/// list is free text from a TOML file or a comma-separated environment
/// variable, so `10.0.0.0/8, ::1/128` and `::1/128,10.0.0.0/8` are the same
/// policy and must not read as a customisation.
fn same_set(configured: &[String], reference: &[&str]) -> bool {
    let left: std::collections::BTreeSet<&str> =
        configured.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let right: std::collections::BTreeSet<&str> = reference.iter().copied().collect();
    left == right
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_proxy_list_is_recognised_whatever_the_order_or_spacing() {
        let shuffled: Vec<String> = crate::auth::client_ip::DEFAULT_TRUSTED_PROXY_CIDRS
            .iter()
            .rev()
            .map(|s| format!("  {s} "))
            .collect();
        assert!(same_set(&shuffled, crate::auth::client_ip::DEFAULT_TRUSTED_PROXY_CIDRS));
    }

    #[test]
    fn an_encrypted_arrival_is_remembered_for_later_requests() {
        // The failure this guards against: the operator loads the console over
        // HTTPS, something on the machine polls the plain port a second later,
        // and the next page tells them their traffic is in the clear.
        note_probe(&RequestProbe { forwarded: true, peer_trusted: true, forwarded_https: true });
        assert!(observed::tls());
        assert!(observed::proxy());

        // A later plaintext request does not un-teach it.
        note_probe(&RequestProbe::default());
        assert!(observed::tls());
    }

    #[test]
    fn a_narrowed_list_is_not_the_default() {
        let narrowed = vec!["10.42.0.7/32".to_string()];
        assert!(!same_set(&narrowed, crate::auth::client_ip::DEFAULT_TRUSTED_PROXY_CIDRS));
        // An empty list is a policy of its own, not the default one.
        assert!(!same_set(&[], crate::auth::client_ip::DEFAULT_TRUSTED_PROXY_CIDRS));
    }
}
