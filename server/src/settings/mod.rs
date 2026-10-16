//! Scoped settings: one value per (key, scope), inherited down the
//! organisational tree.
//!
//! ## The model in one paragraph
//!
//! `core.settings` is the **schema** - key, value type, enum domain, owning
//! module, factory default, label, public visibility. `core.setting_values`
//! holds the values, indexed by (key, scope type, scope id), across four scopes:
//! instance, organisational unit, group, user. Resolution runs from the most
//! specific to the most general:
//!
//! ```text
//!   user ?? group ?? closest org unit ?? … ?? root unit ?? instance ?? factory
//! ```
//!
//! ## An inherited value is never materialised
//!
//! A scope that inherits has **no row**. "Revert to the inherited value" is a
//! `DELETE` ([`store::clear_value`]), and that is exactly what makes the setting
//! follow its parent again: writing the inherited value into the child would
//! freeze it, and the link would break silently the day the parent moved. Every
//! function here is built around that invariant - [`chain::Resolution`] reports
//! `inherited_value` by *recomputing* the chain without the child's row, never
//! by reading a stored copy.
//!
//! ## Locking
//!
//! A locked level short-circuits every level below it, and [`store`] refuses any
//! write underneath ([`crate::errors::AppError::SettingLocked`]). The lock is
//! the addition over the model this feature imitates, and it is what makes a
//! policy enforceable instead of merely suggested.
//!
//! ## Compatibility with the pre-`000060` readers
//!
//! About twenty call sites - the mailer, the health report, the job runner, the
//! anti-DDoS limiter, the auth layer, `handlers/themes.rs` - read
//! `core.settings.value` with hand-written SQL. That column is **kept** as a
//! mirror of the instance scope, maintained in both directions by the triggers
//! shipped with migration `000060`: a legacy `UPDATE core.settings SET value`
//! still lands in the scoped table, and a scoped write at instance level still
//! updates the mirror. Nothing inherited is ever mirrored - the instance level
//! is a stored level, not an inherited one.
//!
//! New code should use [`instance_value`] (a single accessor, no SQL at the call
//! site) or [`chain::resolve_for`] when a scope is involved. The callers that
//! genuinely resolve *per user* - `handlers/modules.rs` - have been migrated to
//! the resolver; the rest read instance-level configuration where a scope has no
//! meaning (SMTP relay, JWT lifetimes, job concurrency), and moving them would
//! add a chain walk to answer a question that has one answer.

pub mod chain;
/// The directory policy (migration `000110`), resolved through the chain above
/// rather than read off `core.settings` - see the module's own preamble.
pub mod directory;
pub mod intl;
/// The password policy (migration `000115`), resolved through the chain: what a
/// local password must satisfy, how long it stays valid, and whether the
/// forgotten-password link may be issued - per organisational unit.
pub mod password_policy;
pub mod schema;
pub mod scope;
pub mod store;

pub use chain::{ChainLevel, Origin, Resolution};
pub use schema::SettingSchema;
pub use scope::{ScopeKind, SettingScope, INSTANCE_SCOPE_ID};
pub use store::{clear_value, set_lock, set_value, WriteOutcome};

use kubuno_db::{params, DbPool};
use serde_json::Value;

/// The instance-level value of `key`, factory default included.
///
/// The single accessor new code should use for instance-scoped configuration.
/// Returns `None` for an undeclared key rather than an error: every caller here
/// has a hard-coded fallback anyway, and a missing setting must not take a
/// background worker down.
pub async fn instance_value(db: &DbPool, key: &str) -> Option<Value> {
    match db
        .fetch_optional_scalar::<Value>(
            "SELECT COALESCE( \
                 (SELECT v.value FROM core.setting_values v \
                   WHERE v.\"key\" = s.\"key\" AND v.scope_type = 'instance'), \
                 s.default_value) \
             FROM core.settings s WHERE s.\"key\" = $1",
            params![key],
        )
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, key = %key, "settings: lecture de la valeur d'instance impossible");
            None
        }
    }
}
