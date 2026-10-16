//! Retention policy of the audit trail.
//!
//! Two rules, both non-negotiable:
//!
//!  * the window is configurable (`security.audit_retention_days`, default 400);
//!  * it can never go below [`MIN_RETENTION_DAYS`]. An administrator whose
//!    account has been taken over would otherwise set retention to zero, wait
//!    for the purge, and walk away with no trace. The floor is enforced here,
//!    in the settings handler, *and* by a `CHECK` constraint on
//!    `core.settings`, so the direct-SQL path is closed too.
//!
//! Changing the setting is itself audited - see the settings handler.

use crate::audit::model::{AuditContext, AuditEntry};
use crate::errors::AppError;
use kubuno_db::{params, DbPool};

/// Lowest retention an administrator may configure.
pub const MIN_RETENTION_DAYS: i64 = 90;

/// Value shipped by the migration: ~13 months, so a year-on-year comparison
/// always has both ends available.
pub const DEFAULT_RETENTION_DAYS: i64 = 400;

pub const RETENTION_SETTING_KEY: &str = "security.audit_retention_days";

/// Applies the floor to a requested value.
pub fn clamp_retention(requested: i64) -> i64 {
    requested.max(MIN_RETENTION_DAYS)
}

/// Validates a candidate value for the retention setting.
///
/// Refuses rather than silently clamping: an operator who typed 7 must be told
/// the floor exists, not left believing they got what they asked for.
pub fn validate_retention(value: &serde_json::Value) -> Result<i64, AppError> {
    let days = value.as_i64().ok_or_else(|| {
        AppError::Validation(format!("{RETENTION_SETTING_KEY} : un nombre de jours est attendu"))
    })?;
    if days < MIN_RETENTION_DAYS {
        return Err(AppError::Validation(format!(
            "{RETENTION_SETTING_KEY} : plancher de {MIN_RETENTION_DAYS} jours, non abaissable"
        )));
    }
    if days > 3650 {
        return Err(AppError::Validation(format!(
            "{RETENTION_SETTING_KEY} : plafond de 3650 jours (10 ans)"
        )));
    }
    Ok(days)
}

/// Reads the configured window, falling back to the default and applying the
/// floor defensively (a row edited straight in the database still cannot shrink
/// the effective window).
pub async fn configured_days(db: &DbPool) -> i64 {
    let raw: Option<serde_json::Value> = db
        .fetch_optional_scalar::<Option<serde_json::Value>>(
            "SELECT value FROM core.settings WHERE \"key\" = $1",
            params![RETENTION_SETTING_KEY],
        )
        .await
        .unwrap_or(None)
        .flatten();

    let days = raw.and_then(|v| v.as_i64()).unwrap_or(DEFAULT_RETENTION_DAYS);
    clamp_retention(days)
}

/// Deletes entries older than the configured window and records the purge in the
/// trail itself (a purge that leaves no trace is indistinguishable from
/// tampering).
///
/// **Not scheduled here.** The daily cadence is owned by the job runner: see
/// [`crate::jobs::builtin::PURGE_ADMIN_AUDIT`].
pub async fn purge_expired(db: &DbPool) -> Result<u64, AppError> {
    let days = configured_days(db).await;

    // The append-only guard is a `BEFORE UPDATE` trigger only - DELETE is
    // deliberately allowed for retention - so the purge is a plain, portable
    // `DELETE` with the cut-off computed in Rust, in place of the former
    // PostgreSQL stored function `core.purge_admin_audit` (`make_interval`).
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days);
    let deleted: u64 = db
        .execute(
            "DELETE FROM core.admin_audit WHERE occurred_at < $1",
            params![cutoff],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audit: purge de rétention impossible");
            AppError::Database(e)
        })?;

    if deleted > 0 {
        tracing::info!(deleted, retention_days = days, "audit: purge de rétention");
        let ctx = AuditContext::system("Purge de rétention (core)");
        ctx.record(
            db,
            AuditEntry::new("core.audit.purge")
                .module("core")
                .target_kind("audit", "Journal d'audit")
                .after(serde_json::json!({ "deleted": deleted, "retention_days": days }))
                .detail(format!("{deleted} entrée(s) au-delà de {days} jours")),
        )
        .await;
    }

    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floor_is_not_lowerable() {
        assert!(validate_retention(&json!(0)).is_err());
        assert!(validate_retention(&json!(1)).is_err());
        assert!(validate_retention(&json!(89)).is_err());
        assert!(validate_retention(&json!(-400)).is_err());
    }

    #[test]
    fn floor_itself_is_accepted() {
        assert_eq!(validate_retention(&json!(90)).ok(), Some(90));
    }

    #[test]
    fn ordinary_values_pass_through() {
        assert_eq!(validate_retention(&json!(400)).ok(), Some(400));
        assert_eq!(validate_retention(&json!(3650)).ok(), Some(3650));
    }

    #[test]
    fn absurd_values_are_refused() {
        assert!(validate_retention(&json!(3651)).is_err());
        assert!(validate_retention(&json!("400")).is_err());
        assert!(validate_retention(&json!(null)).is_err());
        assert!(validate_retention(&json!({ "days": 400 })).is_err());
    }

    #[test]
    fn clamp_never_returns_below_the_floor() {
        assert_eq!(clamp_retention(0), MIN_RETENTION_DAYS);
        assert_eq!(clamp_retention(-1), MIN_RETENTION_DAYS);
        assert_eq!(clamp_retention(89), MIN_RETENTION_DAYS);
        assert_eq!(clamp_retention(400), 400);
    }
}
