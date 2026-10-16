//! Per-module internal secrets.
//!
//! Historically the core handed the very same `server.internal_secret` to every
//! supervised module. Any module holding it could therefore speak for any other
//! module - and, through the proxy's internal impersonation path, for any user
//! including administrators. The trust boundary was "all modules at once".
//!
//! The core now derives a distinct secret per module:
//!
//! ```text
//! secret(module) = "kbms1." || module_id || "." || base64url(
//!     HMAC-SHA256(key = master_secret, msg = "kubuno-internal-secret:v1:" || module_id)
//! )
//! ```
//!
//! Why HMAC-SHA256 rather than a plain hash or HKDF:
//!
//! * A plain `SHA-256(master || module_id)` is a secret-prefix MAC and is
//!   vulnerable to length extension: a module knowing its own secret could
//!   compute valid secrets for other ids derived from its own. HMAC is not.
//! * HKDF would work too, but its extract step only matters when the input
//!   keying material is non-uniform. Here the master secret is a random value of
//!   at least 32 bytes (enforced by `ServerSettings::validate_internal_secret`),
//!   so HKDF-Expand - which *is* HMAC - is all that is needed. One HMAC call is
//!   the same construction with fewer moving parts.
//!
//! The derivation is deterministic, so nothing has to be stored: the core
//! recomputes a module's secret whenever it spawns it or calls it, and verifies
//! a presented secret by recomputing the expected tag.
//!
//! The value is **self-identifying**: the module id travels in clear inside the
//! secret, which lets the core answer "who is calling?" in constant time without
//! a lookup table and without the ordering problem of a module that must
//! authenticate *before* it is registered. Revealing a module's own id to the
//! holder of that module's secret leaks nothing.
//!
//! Modules are unaware of any of this: they still read `KUBUNO_INTERNAL_SECRET`
//! and present it verbatim in `X-Internal-Secret`.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine as _};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Marker + version prefix of a derived secret. Bumping it rotates every derived
/// secret at once (modules are restarted by the supervisor with the new value).
const DERIVED_PREFIX: &str = "kbms1.";

/// Domain separation string for the derivation. Included in the HMAC message so
/// the tag can never collide with another use of the same master secret.
const DERIVATION_CONTEXT: &str = "kubuno-internal-secret:v1:";

/// Who presented a valid `X-Internal-Secret`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InternalCaller {
    /// The master secret was presented. That is the core itself, an operator
    /// tool, or a module started outside the core's supervision (development,
    /// where the module reads the master secret from its own config file).
    /// The caller is *not* identified.
    Master,
    /// The secret derived for this module id was presented: the caller is that
    /// module, and the core knows it.
    Module(String),
}

impl InternalCaller {
    /// The module id when the caller is identified, `None` for the master secret.
    pub fn module_id(&self) -> Option<&str> {
        match self {
            InternalCaller::Module(id) => Some(id),
            InternalCaller::Master => None,
        }
    }

    /// Short label safe to log. Never contains any secret material.
    pub fn label(&self) -> &str {
        match self {
            InternalCaller::Module(id) => id,
            InternalCaller::Master => "<master>",
        }
    }
}

/// Derive the internal secret of `module_id` from the master secret.
///
/// Deterministic: the same pair always yields the same value, so the core can
/// recompute it at every start without persisting anything.
pub fn derive_module_secret(master: &str, module_id: &str) -> String {
    let tag = derive_tag(master, module_id);
    format!("{DERIVED_PREFIX}{module_id}.{}", B64URL.encode(tag))
}

/// Authenticate a presented `X-Internal-Secret` value.
///
/// Returns the identified caller, or `None` when the value is not a secret this
/// core issued. `allow_master` maps to `server.reject_master_internal_secret`
/// (inverted): when false, only derived secrets are accepted.
///
/// Both comparisons run in constant time with respect to the secret contents.
pub fn authenticate(master: &str, presented: &str, allow_master: bool) -> Option<InternalCaller> {
    if let Some(rest) = presented.strip_prefix(DERIVED_PREFIX) {
        // "<module_id>.<base64url tag>" - the module id may not contain a dot,
        // so splitting on the last dot is unambiguous.
        let (module_id, tag_b64) = rest.rsplit_once('.')?;
        if module_id.is_empty() {
            return None;
        }
        let presented_tag = B64URL.decode(tag_b64).ok()?;
        // `verify_slice` is a constant-time comparison of the two tags.
        let mut mac = new_mac(master)?;
        mac.update(DERIVATION_CONTEXT.as_bytes());
        mac.update(module_id.as_bytes());
        return mac
            .verify_slice(&presented_tag)
            .ok()
            .map(|()| InternalCaller::Module(module_id.to_owned()));
    }

    if allow_master && constant_time_eq(presented, master) {
        return Some(InternalCaller::Master);
    }
    None
}

/// Constant-time string equality.
///
/// Both operands are hashed first so the comparison runs over two fixed-size
/// digests: the timing then depends neither on the contents nor on the lengths
/// of the secrets.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let da = Sha256::digest(a.as_bytes());
    let db = Sha256::digest(b.as_bytes());
    da.ct_eq(&db).into()
}

fn derive_tag(master: &str, module_id: &str) -> Vec<u8> {
    match new_mac(master) {
        Some(mut mac) => {
            mac.update(DERIVATION_CONTEXT.as_bytes());
            mac.update(module_id.as_bytes());
            mac.finalize().into_bytes().to_vec()
        }
        // Unreachable: HMAC accepts keys of any length. Returning an empty tag
        // keeps this function total without an unwrap; it can never validate.
        None => Vec::new(),
    }
}

fn new_mac(master: &str) -> Option<Hmac<Sha256>> {
    Hmac::<Sha256>::new_from_slice(master.as_bytes()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn derivation_is_deterministic() {
        assert_eq!(
            derive_module_secret(MASTER, "drive"),
            derive_module_secret(MASTER, "drive")
        );
    }

    #[test]
    fn derivation_differs_per_module() {
        assert_ne!(
            derive_module_secret(MASTER, "drive"),
            derive_module_secret(MASTER, "office")
        );
    }

    #[test]
    fn derivation_differs_per_master() {
        let other = format!("{MASTER}x");
        assert_ne!(
            derive_module_secret(MASTER, "drive"),
            derive_module_secret(&other, "drive")
        );
    }

    #[test]
    fn derived_secret_never_contains_the_master() {
        let s = derive_module_secret(MASTER, "drive");
        assert!(!s.contains(MASTER));
        assert!(s.starts_with("kbms1.drive."));
    }

    #[test]
    fn derived_secret_identifies_its_module() {
        let s = derive_module_secret(MASTER, "calendar");
        assert_eq!(
            authenticate(MASTER, &s, true),
            Some(InternalCaller::Module("calendar".into()))
        );
    }

    #[test]
    fn module_ids_with_dashes_and_digits_round_trip() {
        for id in ["p2pnas", "media-watch", "code2", "a"] {
            let s = derive_module_secret(MASTER, id);
            assert_eq!(
                authenticate(MASTER, &s, true).and_then(|c| c.module_id().map(str::to_owned)),
                Some(id.to_owned()),
                "id {id}"
            );
        }
    }

    #[test]
    fn a_secret_relabelled_as_another_module_is_rejected() {
        // Take module A's tag and present it under module B's name.
        let a = derive_module_secret(MASTER, "notes");
        let tag = a.rsplit_once('.').map(|(_, t)| t).unwrap_or_default();
        let forged = format!("kbms1.drive.{tag}");
        assert_eq!(authenticate(MASTER, &forged, true), None);
    }

    #[test]
    fn master_is_accepted_when_allowed_and_is_not_identified() {
        assert_eq!(
            authenticate(MASTER, MASTER, true),
            Some(InternalCaller::Master)
        );
        assert_eq!(authenticate(MASTER, MASTER, true).and_then(|c| c.module_id().map(str::to_owned)), None);
    }

    #[test]
    fn master_is_rejected_in_strict_mode_but_derived_still_works() {
        assert_eq!(authenticate(MASTER, MASTER, false), None);
        let s = derive_module_secret(MASTER, "mail");
        assert_eq!(
            authenticate(MASTER, &s, false),
            Some(InternalCaller::Module("mail".into()))
        );
    }

    #[test]
    fn garbage_is_rejected() {
        for bad in ["", "kbms1.", "kbms1.drive", "kbms1.drive.", "kbms1..abc", "wrong-secret", "kbms1.drive.!!!!"] {
            assert_eq!(authenticate(MASTER, bad, true), None, "input {bad:?}");
        }
    }

    #[test]
    fn a_derived_secret_from_another_master_is_rejected() {
        let s = derive_module_secret("another-master-secret-that-is-long-enough-32", "drive");
        assert_eq!(authenticate(MASTER, &s, true), None);
    }

    #[test]
    fn hmac_matches_rfc4231_test_case_2() {
        // RFC 4231 §4.3: key = "Jefe", data = "what do ya want for nothing?"
        let mut mac = Hmac::<Sha256>::new_from_slice(b"Jefe").expect("hmac key");
        mac.update(b"what do ya want for nothing?");
        let out = mac.finalize().into_bytes();
        assert_eq!(
            hex(&out),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}
