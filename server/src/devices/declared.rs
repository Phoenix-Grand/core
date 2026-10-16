//! Signals a native application **states** about itself - and the discipline
//! that keeps them from being read as facts.
//!
//! ## Why this is off by default
//!
//! A declaration is a sentence the client chose to send. A hostile or merely
//! buggy application can say "disk encrypted: yes" as easily as the truth. That
//! is not a reason to refuse the feature - an honest fleet of honest
//! applications makes an operator's life considerably easier - but it is a
//! reason to (a) require the operator to switch it on deliberately, and (b)
//! label every value it produces "declared by the device", never "verified".
//!
//! The label is not cosmetic. It is the difference between a self-hosted
//! platform an administrator can reason about and a compliance dashboard that
//! reports green because the endpoint said so.
//!
//! ## What is refused
//!
//! * Declarations at all, when the setting is off - a 403 that says why.
//! * A declaration about somebody else's device: the route only ever writes the
//!   device the caller's own session belongs to.
//! * `attested`. Nothing in the core produces it; the enum value exists so the
//!   day somebody implements hardware attestation there is a slot for it, and
//!   the route below refuses to be that slot.

use kubuno_db::{params, DbPool};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::model::{event_kind, Tri};
use crate::errors::AppError;

/// Reads a boolean setting, defaulting when the row is missing or malformed.
async fn bool_setting(db: &DbPool, key: &str, default: bool) -> bool {
    let value: Option<Value> = db
        .fetch_optional_scalar::<Value>(
            "SELECT value FROM core.settings WHERE \"key\" = $1",
            params![key],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, key = %key, "devices: reading a setting");
            e
        })
        .ok()
        .flatten();
    value
        .and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s == "true")))
        .unwrap_or(default)
}

/// Are declared signals accepted on this instance?
pub async fn enabled(db: &DbPool) -> bool {
    bool_setting(db, "devices.declared_signals_enabled", false).await
}

/// Does blocking a device actually refuse its refreshes?
pub async fn block_denies_refresh(db: &DbPool) -> bool {
    bool_setting(db, "devices.block_denies_refresh", true).await
}

/// Configured path of the offline country database (empty = disabled).
pub async fn country_db_path(db: &DbPool) -> String {
    let value: Option<Value> = db
        .fetch_optional_scalar::<Value>(
            "SELECT value FROM core.settings WHERE \"key\" = 'devices.country_db_path'",
            params![],
        )
        .await
        .ok()
        .flatten();
    value
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// What a native application may state about itself.
///
/// Every field is optional: an application that only knows its platform version
/// says that and nothing else, and the fields it omits stay unknown rather than
/// being reset to a value nobody claimed.
#[derive(Debug, Deserialize)]
pub struct DeclareDto {
    pub platform: Option<String>,
    pub platform_version: Option<String>,
    pub app_version: Option<String>,
    pub disk_encrypted: Option<bool>,
    pub screen_lock: Option<bool>,
}

fn trimmed(value: &Option<String>, max: usize) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(max).collect())
}

/// Records a declaration against the caller's own device.
///
/// `COALESCE` on every column: a field the application did not send keeps its
/// previous value instead of collapsing to unknown, which would make a partial
/// declaration destructive.
pub async fn apply(
    db: &DbPool,
    device_id: Uuid,
    user_id: Uuid,
    dto: &DeclareDto,
) -> Result<(), AppError> {
    // Placeholders must appear once each in ascending order (portable rewrite):
    // the SET assignments come first, the WHERE keys after. `declared_at` is
    // bound from Rust rather than the PostgreSQL-only `NOW()`.
    let affected = db
        .execute(
            r#"UPDATE core.devices
              SET declared_platform    = COALESCE($1, declared_platform),
                  declared_version     = COALESCE($2, declared_version),
                  declared_app_version = COALESCE($3, declared_app_version),
                  disk_encrypted       = COALESCE($4, disk_encrypted),
                  screen_lock          = COALESCE($5, screen_lock),
                  declared_at          = $6,
                  -- Never downgrades: a device that reached `attested` (nothing
                  -- produces that today) must not fall back to `declared`
                  -- because a routine declaration arrived.
                  signal_level         = CASE WHEN signal_level = 'attested'
                                              THEN signal_level ELSE 'declared' END
            WHERE id = $7 AND user_id = $8"#,
            params![
                trimmed(&dto.platform, 64),
                trimmed(&dto.platform_version, 64),
                trimmed(&dto.app_version, 64),
                dto.disk_encrypted,
                dto.screen_lock,
                chrono::Utc::now(),
                device_id,
                user_id
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, device_id = %device_id, "devices: recording a declaration");
            AppError::Database(e)
        })?;

    if affected == 0 {
        return Err(AppError::NotFound("Appareil introuvable".into()));
    }

    // The timeline records that a declaration arrived and what it claimed - the
    // wording says "déclaré" so a reader of the history cannot mistake it for a
    // measurement either.
    let detail = format!(
        "déclaré : chiffrement={} · verrouillage={}",
        Tri::from_option(dto.disk_encrypted).as_str(),
        Tri::from_option(dto.screen_lock).as_str()
    );
    super::correlate::record_event(
        db,
        device_id,
        event_kind::DECLARED,
        None,
        None,
        Some(user_id),
        None,
        Some(&detail),
    )
    .await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_declaration_that_says_nothing_stays_unknown() {
        let dto = DeclareDto {
            platform: None,
            platform_version: None,
            app_version: None,
            disk_encrypted: None,
            screen_lock: None,
        };
        // Exactly what the COALESCE above preserves, and what the console shows.
        assert_eq!(Tri::from_option(dto.disk_encrypted), Tri::Unknown);
        assert!(!Tri::from_option(dto.disk_encrypted).is_encrypted());
        assert_eq!(Tri::from_option(dto.screen_lock).as_str(), "unknown");
    }

    #[test]
    fn declared_strings_are_trimmed_and_bounded() {
        let long = "x".repeat(500);
        assert_eq!(trimmed(&Some("  Android  ".into()), 64).as_deref(), Some("Android"));
        assert_eq!(trimmed(&Some("   ".into()), 64), None);
        assert_eq!(trimmed(&Some(long), 64).map(|s| s.len()), Some(64));
    }
}
