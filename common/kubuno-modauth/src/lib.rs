//! Signed service-identity token for the core → module trust boundary.
//!
//! # The problem this closes
//!
//! Every module runs as its own process listening on loopback. The core is a
//! reverse proxy in front of them: it authenticates the caller, then forwards
//! the request to the target module with the caller's identity attached. Until
//! now that identity travelled as plain `X-Kubuno-User-Id` / `-Role` / `-Email`
//! headers which the module read and trusted unconditionally. Any process able
//! to reach the module's loopback port could therefore forge those headers and
//! impersonate any user, administrators included - a lateral-movement primitive
//! that a single compromised module (or the two modules exempt from the seccomp
//! `execve` ban) turns into a full takeover.
//!
//! # The fix
//!
//! The core already derives a distinct internal secret **per module**
//! (`kubuno_core::auth::internal_secret`). This crate binds the forwarded
//! identity to that secret: the core [`sign`]s a short-lived, audience-bound
//! token with the target module's secret, and the module [`verify`]s it with
//! its own copy. A forged header no longer carries a valid signature; a token
//! minted for one module does not validate at another (different secret **and**
//! different `aud`); and its 30-second lifetime bounds replay on the loopback
//! path.
//!
//! # Token format
//!
//! ```text
//!   v1.<base64url(payload)>.<base64url(HMAC_SHA256(secret, "v1." + base64url(payload)))>
//!   payload = {"sub","role","email","aud","iat","exp"}   (compact JSON)
//! ```
//!
//! The signature covers the **exact canonical bytes** that travel on the wire
//! (`"v1." + base64url(payload)`), never a re-serialised payload - this removes
//! any encoding ambiguity between signer and verifier. The verifier accepts
//! **only** HMAC-SHA256: no algorithm field is read from the message, which is
//! precisely the class of bug (`alg=none`, algorithm confusion) that makes naive
//! JWT verification unsafe. See RFC 8725 (JWT BCP) for the rationale we sidestep
//! by not using JWT at all here.
//!
//! Design confirmed against ANSSI-PG-083 (HMAC-SHA-256 is a "règle" mechanism),
//! RFC 2104 (HMAC) and RFC 8725.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

/// HTTP header the token travels in.
pub const TOKEN_HEADER: &str = "x-kubuno-auth";

/// Version prefix of the wire format. Bump only on a breaking format change; the
/// verifier rejects anything that does not start with the version it knows.
const VERSION: &str = "v1";

/// Default lifetime of a minted token. The proxy → module hop is sub-millisecond
/// on loopback, so a short window is the first line of replay defence. Kept as a
/// constant rather than a parameter so every call site agrees.
pub const DEFAULT_TTL_SECS: u64 = 30;

/// Tolerance for clock disagreement. The core and the module share a host and
/// therefore a clock, so this is only a guard against a token minted a hair in
/// the "future" relative to the reader; kept small on purpose.
pub const MAX_CLOCK_SKEW_SECS: u64 = 5;

/// The verified caller a module gets back from [`verify`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleUser {
    pub id: Uuid,
    pub role: String,
    pub email: String,
}

/// Signed claims. Compact field names keep the header small.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Claims {
    /// Subject: the user id.
    sub: Uuid,
    /// The role the module should see (already scope-derived by the core).
    role: String,
    email: String,
    /// Audience: the target module id. A token only validates at its `aud`.
    aud: String,
    /// Issued-at, Unix seconds.
    iat: u64,
    /// Expiry, Unix seconds.
    exp: u64,
}

/// Why a token was rejected. Deliberately coarse: a module maps any of these to
/// a single 401 and never echoes the reason, so this is not an oracle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    /// Not three dot-separated parts, wrong version, or undecodable base64/JSON.
    Malformed,
    /// The HMAC did not match - forged, tampered, or wrong module secret.
    BadSignature,
    /// `exp` is in the past.
    Expired,
    /// `iat` is further in the future than [`MAX_CLOCK_SKEW_SECS`].
    NotYetValid,
    /// The token's `aud` is not this module.
    WrongAudience,
}

impl core::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let s = match self {
            Self::Malformed => "malformed token",
            Self::BadSignature => "bad signature",
            Self::Expired => "expired",
            Self::NotYetValid => "not yet valid",
            Self::WrongAudience => "wrong audience",
        };
        f.write_str(s)
    }
}

impl std::error::Error for VerifyError {}

/// Current Unix time in seconds. Panics only if the system clock predates the
/// Unix epoch, which cannot happen on a running server.
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Mint a token for `user`, bound to module `aud`, signed with that module's
/// `secret`, valid for [`DEFAULT_TTL_SECS`].
pub fn sign(secret: &[u8], user: &ModuleUser, aud: &str) -> String {
    sign_at(secret, user, aud, now_unix(), DEFAULT_TTL_SECS)
}

/// [`sign`] with an explicit issue time and lifetime. Exposed for tests and for
/// callers that need a non-default TTL.
pub fn sign_at(secret: &[u8], user: &ModuleUser, aud: &str, iat: u64, ttl_secs: u64) -> String {
    let claims = Claims {
        sub: user.id,
        role: user.role.clone(),
        email: user.email.clone(),
        aud: aud.to_owned(),
        iat,
        exp: iat.saturating_add(ttl_secs),
    };
    // `Claims` serialises infallibly (only owned String/Uuid/u64), but stay
    // total rather than unwrap: an empty payload can never validate.
    let payload_json = serde_json::to_vec(&claims).unwrap_or_default();
    let payload_b64 = B64URL.encode(payload_json);
    let signing_input = format!("{VERSION}.{payload_b64}");
    let sig = mac(secret, signing_input.as_bytes());
    format!("{signing_input}.{}", B64URL.encode(sig))
}

/// Verify a token minted by the core for **this** module.
///
/// `secret` is the module's own internal secret; `expected_aud` its module id.
/// Returns the caller on success. Every failure mode collapses to a
/// [`VerifyError`] the caller should treat as a flat 401.
pub fn verify(secret: &[u8], token: &str, expected_aud: &str) -> Result<ModuleUser, VerifyError> {
    verify_at(secret, token, expected_aud, now_unix())
}

/// [`verify`] with an explicit "now", for tests.
pub fn verify_at(
    secret: &[u8],
    token: &str,
    expected_aud: &str,
    now: u64,
) -> Result<ModuleUser, VerifyError> {
    // Split into exactly three parts: version, payload, signature.
    let mut parts = token.splitn(3, '.');
    let version = parts.next().ok_or(VerifyError::Malformed)?;
    let payload_b64 = parts.next().ok_or(VerifyError::Malformed)?;
    let sig_b64 = parts.next().ok_or(VerifyError::Malformed)?;
    if parts.next().is_some() || version != VERSION {
        return Err(VerifyError::Malformed);
    }

    // Recompute the MAC over the exact wire bytes and compare in constant time.
    // The verifier fixes the algorithm here - it never reads one from the token,
    // which is the whole reason JWT's `alg` pitfalls do not apply.
    let signing_input = format!("{VERSION}.{payload_b64}");
    let presented_sig = B64URL.decode(sig_b64).map_err(|_| VerifyError::Malformed)?;
    // `verify_slice` is a constant-time comparison; a length mismatch is a
    // failure, not a panic.
    let mut verifier = new_mac(secret);
    verifier.update(signing_input.as_bytes());
    verifier
        .verify_slice(&presented_sig)
        .map_err(|_| VerifyError::BadSignature)?;

    // Only after the signature holds do we trust the payload's contents.
    let payload_json = B64URL.decode(payload_b64).map_err(|_| VerifyError::Malformed)?;
    let claims: Claims = serde_json::from_slice(&payload_json).map_err(|_| VerifyError::Malformed)?;

    if claims.aud != expected_aud {
        return Err(VerifyError::WrongAudience);
    }
    if now.saturating_add(MAX_CLOCK_SKEW_SECS) < claims.iat {
        return Err(VerifyError::NotYetValid);
    }
    if claims.exp < now {
        return Err(VerifyError::Expired);
    }

    Ok(ModuleUser {
        id: claims.sub,
        role: claims.role,
        email: claims.email,
    })
}

/// HMAC-SHA256 of `data` under `secret`. HMAC accepts a key of any length, so
/// this never fails for a real secret.
fn mac(secret: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = new_mac(secret);
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

fn new_mac(secret: &[u8]) -> HmacSha256 {
    // `new_from_slice` only errors on key-length constraints HMAC does not have.
    HmacSha256::new_from_slice(secret).unwrap_or_else(|_| {
        // Unreachable for HMAC; keep total without propagating a never-error.
        HmacSha256::new_from_slice(&[0u8; 32]).expect("HMAC accepts any key length")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";

    fn user() -> ModuleUser {
        ModuleUser {
            id: Uuid::parse_str("11111111-1111-1111-1111-111111111111").expect("uuid"),
            role: "admin".into(),
            email: "a@b.c".into(),
        }
    }

    #[test]
    fn round_trip() {
        let t = sign_at(SECRET, &user(), "drive", 1_000, 30);
        let got = verify_at(SECRET, &t, "drive", 1_005).expect("valid");
        assert_eq!(got, user());
    }

    #[test]
    fn rejects_wrong_secret() {
        let t = sign_at(SECRET, &user(), "drive", 1_000, 30);
        let err = verify_at(b"another-secret-32-bytes-long!!!!", &t, "drive", 1_005);
        assert_eq!(err, Err(VerifyError::BadSignature));
    }

    #[test]
    fn rejects_tampered_payload() {
        let t = sign_at(SECRET, &user(), "drive", 1_000, 30);
        // Flip the role by re-encoding a forged payload but keeping the old sig.
        let mut parts: Vec<&str> = t.split('.').collect();
        let forged = B64URL.encode(br#"{"sub":"11111111-1111-1111-1111-111111111111","role":"admin","email":"a@b.c","aud":"drive","iat":1000,"exp":99999999999}"#);
        parts[1] = &forged;
        let forged_token = parts.join(".");
        assert_eq!(
            verify_at(SECRET, &forged_token, "drive", 1_005),
            Err(VerifyError::BadSignature)
        );
    }

    #[test]
    fn rejects_wrong_audience() {
        let t = sign_at(SECRET, &user(), "drive", 1_000, 30);
        assert_eq!(
            verify_at(SECRET, &t, "mail", 1_005),
            Err(VerifyError::WrongAudience)
        );
    }

    #[test]
    fn rejects_expired() {
        let t = sign_at(SECRET, &user(), "drive", 1_000, 30);
        assert_eq!(
            verify_at(SECRET, &t, "drive", 1_031),
            Err(VerifyError::Expired)
        );
    }

    #[test]
    fn rejects_future_iat() {
        let t = sign_at(SECRET, &user(), "drive", 10_000, 30);
        // "now" is well before iat, beyond the skew.
        assert_eq!(
            verify_at(SECRET, &t, "drive", 1_000),
            Err(VerifyError::NotYetValid)
        );
    }

    #[test]
    fn accepts_within_skew() {
        let t = sign_at(SECRET, &user(), "drive", 1_000, 30);
        // now is 3s before iat - inside MAX_CLOCK_SKEW_SECS.
        assert!(verify_at(SECRET, &t, "drive", 997).is_ok());
    }

    #[test]
    fn rejects_malformed() {
        for bad in ["", "v1", "v1.abc", "v2.abc.def", "v1.@@@.def", "a.b.c.d"] {
            assert_eq!(
                verify_at(SECRET, bad, "drive", 1_005),
                Err(VerifyError::Malformed),
                "token {bad:?} should be malformed"
            );
        }
    }
}
