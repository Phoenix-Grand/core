//! `POST /internal/storage/usage` - a module declares what it holds.
//!
//! ## The one security property of this file
//!
//! **The declaring module is never read from the request body.** It is derived
//! from the `X-Internal-Secret` the caller presented, which the core issues
//! per module (see [`crate::auth::internal_secret`]). A module holding its own
//! secret can compute no other module's secret, so `photos` cannot declare - or
//! erase - `drive`'s share of the storage breakdown.
//!
//! The body *may* carry `module_id`, for one reason only: a module started
//! outside the core's supervision (development) presents the master secret and
//! is not identified, so it has to name itself. When the caller **is**
//! identified and the body disagrees, the request is refused rather than
//! silently corrected - a mismatch is either a bug or an attempt, and both
//! deserve a log line. This is the same discipline `ensure_caller_is` applies to
//! module registration.
//!
//! ## Why a route rather than an event
//!
//! Argued in full in [`crate::storage::usage`]. In one line: an event is a
//! fire-and-forget delta on a lossy channel whose envelope names its own sender,
//! and a storage breakdown needs an acknowledged declaration of state whose
//! sender is authenticated.

use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::middleware::InternalRequest,
    errors::AppError,
    state::AppState,
    storage::usage::{self, Scope, UsageEntry},
};

#[derive(Debug, Deserialize)]
pub struct DeclareUsageDto {
    /// Only honoured when the caller could not be identified from its secret.
    /// Never trusted over the authenticated identity.
    #[serde(default)]
    pub module_id: Option<String>,

    /// `true` when the list is everything the module holds. A full declaration
    /// retires the rows it does not mention, which is what repairs a breakdown
    /// after a lost message and the only way a module's share returns to zero.
    #[serde(default)]
    pub full: bool,

    /// The module's current total per account. An empty list with `full: true`
    /// is a legitimate statement: "I hold nothing for anybody".
    #[serde(default)]
    pub usage: Vec<UsageEntry>,
}

/// Decides, and justifies, which module a declaration is written under.
fn declaring_module(
    internal: &InternalRequest,
    claimed: Option<&str>,
) -> Result<String, AppError> {
    match (internal.module_id(), claimed) {
        // Identified caller naming somebody else: refused, loudly. This is the
        // impersonation attempt the per-module secret exists to make impossible,
        // and it is worth a log line on the rare occasion it is merely a bug.
        (Some(caller), Some(claimed)) if caller != claimed => {
            tracing::warn!(
                caller = %caller,
                claimed = %claimed,
                "Déclaration de stockage refusée : le module authentifié n'est pas celui déclaré"
            );
            Err(AppError::Forbidden)
        }
        // Identified caller: its own name wins, whether or not it repeated it.
        (Some(caller), _) => Ok(caller.to_owned()),
        // Unidentified caller (master secret) naming a module: accepted, because
        // that is how a module runs outside the core's supervision.
        (None, Some(claimed)) => Ok(claimed.to_owned()),
        // Unidentified caller naming nobody: there is no identity to fall back
        // on, and guessing one would attribute bytes at random.
        (None, None) => Err(AppError::Validation(
            "module_id is required: the caller was not identified by its internal secret".into(),
        )),
    }
}

pub async fn declare(
    State(state): State<AppState>,
    internal: InternalRequest,
    Json(dto): Json<DeclareUsageDto>,
) -> Result<Json<Value>, AppError> {
    let module_id = declaring_module(&internal, dto.module_id.as_deref())?;

    let scope = if dto.full { Scope::Full } else { Scope::Partial };
    let outcome = usage::declare(&state.db, &module_id, &dto.usage, scope).await?;

    Ok(Json(json!(outcome)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::internal_secret::InternalCaller;

    fn as_module(id: &str) -> InternalRequest {
        InternalRequest(InternalCaller::Module(id.into()))
    }
    fn as_master() -> InternalRequest {
        InternalRequest(InternalCaller::Master)
    }

    #[test]
    fn an_identified_module_declares_under_its_own_name() {
        let m = declaring_module(&as_module("drive"), None).expect("accepté");
        assert_eq!(m, "drive");
    }

    #[test]
    fn repeating_its_own_name_is_harmless() {
        let m = declaring_module(&as_module("drive"), Some("drive")).expect("accepté");
        assert_eq!(m, "drive");
    }

    /// The property the whole channel rests on: one module cannot write, or
    /// erase, another module's share.
    #[test]
    fn a_module_cannot_declare_for_another_module() {
        let err = declaring_module(&as_module("photos"), Some("drive"))
            .expect_err("l'usurpation doit être refusée");
        assert!(matches!(err, AppError::Forbidden));
    }

    #[test]
    fn the_body_never_overrides_the_authenticated_identity() {
        // Even naming the core's own namespace gets the caller's real name.
        let err = declaring_module(&as_module("photos"), Some("core"))
            .expect_err("l'usurpation doit être refusée");
        assert!(matches!(err, AppError::Forbidden));
    }

    /// The end-to-end property, from the bytes on the wire to the decision.
    ///
    /// The unit tests above start from an already-identified caller. This one
    /// starts where a real request does - a `X-Internal-Secret` header value -
    /// and walks the whole path: derive the secret the core would hand to
    /// `photos`, authenticate it exactly as the extractor does, then try to
    /// declare `drive`'s usage with it. There is no arrangement of the body that
    /// makes that succeed, and `photos` cannot produce `drive`'s secret because
    /// deriving one requires the master key.
    #[test]
    fn a_module_holding_its_own_secret_cannot_declare_for_another() {
        const MASTER: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        // What the core actually hands to the photos module at spawn time.
        let photos_secret = crate::auth::internal_secret::derive_module_secret(MASTER, "photos");

        // What the extractor does with the header it presents.
        let caller = crate::auth::internal_secret::authenticate(MASTER, &photos_secret, true)
            .expect("son propre secret est valide");
        assert_eq!(caller.module_id(), Some("photos"));
        let request = InternalRequest(caller);

        // Naming another module is refused…
        assert!(matches!(
            declaring_module(&request, Some("drive")),
            Err(AppError::Forbidden)
        ));
        // …and saying nothing does not silently let it through either: the
        // declaration lands under `photos`, which is the only name it can write.
        assert_eq!(
            declaring_module(&request, None).expect("son propre nom est accepté"),
            "photos"
        );

        // And the secret it holds is not the one that would identify it as drive.
        assert_ne!(
            photos_secret,
            crate::auth::internal_secret::derive_module_secret(MASTER, "drive")
        );
    }

    #[test]
    fn an_unidentified_caller_must_name_itself() {
        assert!(declaring_module(&as_master(), Some("drive")).is_ok());
        assert!(matches!(
            declaring_module(&as_master(), None),
            Err(AppError::Validation(_))
        ));
    }
}
