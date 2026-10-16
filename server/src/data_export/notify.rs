//! Telling every administrator that an export has started.
//!
//! ## Why this is a security control and not a courtesy
//!
//! An export is the one administrative act that concentrates everything the
//! instance holds about everyone into a single file. The realistic attack is not
//! somebody breaking the archive format - it is somebody arriving with a valid
//! administrator session (stolen cookie, borrowed laptop, a colleague's
//! unlocked screen) and pressing the button.
//!
//! Nothing about the request itself distinguishes that from a legitimate one, so
//! the defence cannot be a check. It has to be **visibility**: the instant an
//! export is requested, every administrator sees it, named, with the account
//! that asked. Combined with `data_export.hold_hours` - during which the archive
//! exists but cannot be downloaded - that turns a silent exfiltration into a
//! two-day window in which somebody else can cancel it.
//!
//! The two halves only work together. A hold nobody is told about protects
//! nothing (the attacker simply waits); an alert with no hold arrives after the
//! file is already gone.
//!
//! ## Why the alert centre, and not an email
//!
//! Because that is where this console puts facts an administrator must see:
//! `security.privilege_granted` - an event of exactly the same class - has lived
//! there since the centre existed. An alert is deduplicated, assignable,
//! commentable and closable, it survives an unread inbox, and it cannot be
//! filtered away by a rule in somebody's mail client. An instance whose SMTP
//! relay is unconfigured (the default) would silently send nothing at all, which
//! is the one outcome this control cannot afford.

use serde_json::json;
use kubuno_db::DbPool;
use uuid::Uuid;

use crate::alerts::{self, model::Severity, NewAlert};

/// Source shown on the alert.
pub const SRC_DATA_EXPORT: &str = "data_export";

/// An export of the instance's data has been requested.
pub const EXPORT_STARTED: &str = "security.data_export_started";

/// Raises the alert that tells every administrator an export has begun.
///
/// Best-effort by design, and that choice is deliberate rather than lazy:
/// refusing the export because the alert could not be written would let anybody
/// who can break the alert centre also block a legitimate portability request.
/// The audit entry is written on the caller's side, in the same transaction as
/// the request, and is the record that cannot be lost.
pub async fn announce(
    db: &DbPool,
    export_id: Uuid,
    actor_id: Uuid,
    actor_label: &str,
    scope: &str,
    accounts: usize,
    available_at: chrono::DateTime<chrono::Utc>,
) {
    // English, like every other string this catalogue ships: the console owns the
    // wording in thirteen languages, keyed on the alert kind, and falls back to
    // what the server said. Writing French here would make the fallback the odd
    // one out - see `alerts/labels.ts`.
    let scope_words = if scope == "instance" {
        "the whole instance".to_string()
    } else if accounts == 1 {
        "one account".to_string()
    } else {
        format!("{accounts} accounts")
    };

    let alert = NewAlert::new(
        EXPORT_STARTED,
        SRC_DATA_EXPORT,
        Severity::Warning,
        format!("Data export requested by {actor_label}"),
    )
    .summary(format!(
        "An archive covering {scope_words} is being produced. It cannot be downloaded \
         before {}. If this request is not legitimate, cancel it before that date from \
         the data-export page.",
        available_at.format("%Y-%m-%d %H:%M UTC")
    ))
    .subject(actor_id)
    // One alert per export, never merged with the previous one: two exports are
    // two decisions, and a counter that went from 3 to 4 is not something an
    // administrator notices at eight in the morning.
    .dedup(export_id)
    .payload(json!({
        "export_id":    export_id,
        "actor_id":     actor_id,
        "actor_label":  actor_label,
        "scope":        scope,
        "accounts":     accounts,
        "available_at": available_at,
    }));

    match alerts::raise(db, alert).await {
        Ok(_) => tracing::info!(
            export_id = %export_id,
            demandeur = %actor_label,
            comptes = accounts,
            "Export de données annoncé aux administrateurs"
        ),
        Err(e) => tracing::error!(
            error = %e,
            export_id = %export_id,
            "export: alerte de démarrage non levée - les administrateurs ne sont pas prévenus"
        ),
    }
}
