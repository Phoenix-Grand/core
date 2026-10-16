//! Device and session inventory.
//!
//! ## The line this feature does not cross
//!
//! Kubuno will never ship fleet management, and nothing in this module can
//! erase, lock or inspect a personal machine. There is no agent to install and
//! no route that would talk to one. What it does is answer the question a
//! self-hosted operator - and every one of their users - actually needs
//! answered: *which machines currently hold a credential for this account, and
//! what do we honestly know about them?*
//!
//! ## Three levels of trust, two of them shipped
//!
//! ```text
//!   observed   what the request reveals: address, country, user agent,
//!              client kind, timestamps, authentication strength.  VERIFIABLE.
//!   declared   what a native application states: disk encryption, screen
//!              lock, platform version.  Shown as "declared by the device",
//!              never as "verified".  Off by default (`crate::devices::declared`).
//!   attested   hardware/OS attestation.  OUT OF SCOPE - the enum value exists
//!              so a future implementation needs no migration, and nothing in
//!              the core produces it.
//! ```
//!
//! The honesty of the middle label is a product argument, not a caveat. An
//! administrator who cannot tell a measurement from a claim will eventually
//! trust the claim.
//!
//! ## Layout
//!
//! ```text
//!   user_agent  normalisation of a User-Agent into device/platform/browser
//!   geoip       OPTIONAL local country database - no outgoing request, ever
//!   correlate   which device a request belongs to; the SECRET correlation id
//!   store       reads and writes, one shape for the operator and the user
//!   declared    the opt-in declaration route's logic and its settings
//!   model       value types, chiefly `Tri` - "unknown" never satisfies "yes"
//! ```
//!
//! ## Two invariants worth stating once
//!
//! 1. **The correlation identifier is a secret.** It is hashed before it
//!    touches the database, it appears in no JSON, in no log, and in no error.
//!    The API speaks in `core.devices.id`, a public UUID that grants nothing.
//! 2. **Unknown is not false.** Encryption and screen lock are tri-states
//!    ([`Tri`]); the only way to ask the positive question is
//!    [`Tri::is_satisfied`], which answers `false` for unknown.

pub mod correlate;
pub mod declared;
pub mod geoip;
pub mod model;
pub mod store;
pub mod user_agent;

pub use model::{
    event_kind, Approval, AuthStrength, DeviceEventRow, DeviceRow, SessionRow, SignalLevel, Tri,
};
pub use user_agent::{normalise, Normalised};

use kubuno_db::DbPool;

/// Startup wiring: loads the optional country database, then attaches every
/// pre-existing session to a device.
///
/// Both steps are best-effort and neither can keep the server from booting: an
/// inventory that failed to backfill is an inventory that is merely incomplete
/// until the next sign-in, which is strictly better than an instance that
/// refuses to start over a reporting feature.
pub async fn bootstrap(db: &DbPool) {
    // Configured path wins; an empty value disables the lookup entirely.
    let path = declared::country_db_path(db).await;
    geoip::init(&path);

    match correlate::backfill(db).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(sessions = n, "Inventaire des appareils : sessions rattachées"),
        Err(e) => tracing::error!(error = %e, "Inventaire des appareils : rattachement initial impossible"),
    }
}
