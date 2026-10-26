//! The licence this software carries, and the support contract an instance may
//! have bought for it. Two different things, and the whole point of this module
//! is that they never become one.
//!
//! ## The software is not sold
//!
//! Kubuno is AGPL-3.0-or-later. Every instance already holds every right the
//! licence grants - run it, study it, modify it, redistribute it - and no code
//! here, now or later, may condition a feature on anything in this module. A
//! "licence check" in a free-software product is a contradiction: the licence is
//! granted by the copyright holder to everybody, unconditionally, and there is
//! nothing to enforce at runtime.
//!
//! What *can* be sold is **support**: somebody contractually obliged to answer.
//! That is a fact about a commercial relationship between an operator and a
//! publisher, and it is the only thing this module models.
//!
//! ## Why a signed key, and why nothing is ever fetched
//!
//! An instance is self-hosted and may have no route to the internet at all. A
//! contract that had to be confirmed by calling a server would therefore be a
//! contract that stops existing when the network does - and it would make the
//! product phone home, which it does not do and must not start doing.
//!
//! So the proof travels **with** the operator: the publisher signs the contract
//! details offline, the operator pastes the result, and the instance checks the
//! signature against a public key compiled into it. No socket is opened, and the
//! check works identically on an air-gapped machine.
//!
//! ## The honest state of this today
//!
//! The trusted-key list ([`trusted_signing_keys`]) is **empty**, because the
//! publisher has not minted a support signing key yet. The verifier below is
//! complete and will start validating the day a key is added to that list -
//! including for contracts registered before it existed, since the pasted key is
//! kept.
//!
//! Until then every registered contract is stored as **declarative**: the claims
//! are read out of the key and shown, labelled as unverified, and the console
//! says so in as many words. Refusing to store anything until the key exists
//! would be worse - the information would live in somebody's spreadsheet, where
//! nobody administering the instance can see it.

pub mod store;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine as _};
use chrono::{DateTime, TimeZone, Utc};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};

use crate::errors::AppError;

/// The licence this build is distributed under. A constant rather than a
/// setting: it is a fact about the source, not a choice an operator makes, and a
/// page that let somebody *edit* the licence of a copyleft work would be
/// misleading at best.
pub const LICENCE_SPDX: &str = "AGPL-3.0-or-later";
/// Canonical text of the licence. Also shipped verbatim as `LICENSE` at the root
/// of every Kubuno repository - the link is a convenience, not the source.
pub const LICENCE_URL: &str = "https://www.gnu.org/licenses/agpl-3.0.html";
/// Where the source of the core actually lives. Taken from the repository this
/// crate is built from, not invented: the AGPL obliges an operator running a
/// modified instance over a network to offer that instance's source, and a
/// wrong address here would make that obligation impossible to honour.
pub const SOURCE_URL: &str = "https://github.com/kubuno/core";
/// Where community support happens - the issue tracker of the same repository.
pub const ISSUES_URL: &str = "https://github.com/kubuno/core/issues";
/// The organisation that hosts every component of the platform, one repository
/// per component.
pub const ORGANISATION_URL: &str = "https://github.com/kubuno";

/// One public key the publisher signs support contracts with.
pub struct SigningKey {
    /// Matches the `kid` header of a key it signed. Rotation is additive: a
    /// retired key stays listed so contracts signed with it keep verifying until
    /// they expire on their own.
    pub id: &'static str,
    /// The raw 32-byte Ed25519 public key, base64url without padding.
    pub public_key_b64url: &'static str,
}

/// The keys this build trusts.
///
/// **Empty on purpose.** See the module preamble: the publisher has no support
/// signing key yet, so nothing can be verified and every contract is stored as
/// declarative. Adding an entry here - and nothing else - turns verification on,
/// retroactively, for keys already registered.
///
/// Ed25519 is the only algorithm accepted ([`Algorithm::EdDSA`]): one curve, one
/// signature size, no parameter an attacker gets to choose.
const TRUSTED_SIGNING_KEYS: &[SigningKey] = &[];

/// The trusted keys, behind an accessor.
///
/// Call sites go through this rather than touching the constant, so that "can
/// this build check a signature?" stays a question asked at run time - which is
/// what it becomes the moment the list stops being empty.
pub fn trusted_signing_keys() -> &'static [SigningKey] {
    TRUSTED_SIGNING_KEYS
}

/// Whether a support signature can be checked at all by this build.
///
/// `false` today, and the console says so in as many words rather than letting
/// an operator read a declarative contract as a proven one.
pub fn verification_available() -> bool {
    !trusted_signing_keys().is_empty()
}

/// What the publisher asserts about a contract.
///
/// The names follow the registered JWT claims where one fits (`sub`, `iss`,
/// `iat`, `exp`) so the key is an ordinary JWT that ordinary tooling can mint,
/// and use private names for the rest.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SupportClaims {
    /// Who the contract is with, as the publisher wrote it.
    pub sub: String,
    /// When it ends. Required: a support contract without an end date is not a
    /// contract, and the console has to be able to say "expires in 12 days".
    pub exp: i64,
    #[serde(default)]
    pub iss: Option<String>,
    #[serde(default)]
    pub iat: Option<i64>,
    /// The offer's name, e.g. "Standard".
    #[serde(default)]
    pub plan: Option<String>,
    /// What the contract covers, in the publisher's words.
    #[serde(default)]
    pub perimeter: Option<String>,
    /// Where to reach support - an e-mail address or an `https://` URL.
    #[serde(default)]
    pub contact: Option<String>,
    /// The instance this contract was issued for, if the publisher bound it to
    /// one. When present it is checked against this instance's identifier, so a
    /// key cannot be pasted into an installation it was not sold to.
    #[serde(default)]
    pub instance: Option<String>,
}

/// What the signature check concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trust {
    /// A trusted public key validated the signature; the claims are the
    /// publisher's, not the operator's.
    Verified { key_id: String },
    /// The key is well formed and its claims are readable, but no trusted public
    /// key could confirm them - either none is compiled in yet, or the `kid` is
    /// not one this build knows. The claims are treated as **declarative** and
    /// the console labels them so.
    Declarative,
}

/// A support key that parsed, plus the verdict on its signature.
#[derive(Debug, Clone)]
pub struct SupportKey {
    pub claims: SupportClaims,
    pub trust: Trust,
}

impl SupportKey {
    pub fn is_verified(&self) -> bool {
        matches!(self.trust, Trust::Verified { .. })
    }

    pub fn key_id(&self) -> Option<&str> {
        match &self.trust {
            Trust::Verified { key_id } => Some(key_id.as_str()),
            Trust::Declarative => None,
        }
    }

    pub fn expires_at(&self) -> Option<DateTime<Utc>> {
        Utc.timestamp_opt(self.claims.exp, 0).single()
    }

    pub fn issued_at(&self) -> Option<DateTime<Utc>> {
        self.claims
            .iat
            .and_then(|iat| Utc.timestamp_opt(iat, 0).single())
    }
}

/// Reads a pasted support key: signature first, claims second.
///
/// Never fails because the signature could not be *confirmed* - that is
/// [`Trust::Declarative`], a state the product supports. It fails only when the
/// string is not a support key at all: malformed, signed with an algorithm this
/// build refuses, or missing the claims a contract is made of.
///
/// `instance_id` is this installation's identifier. A key that names an instance
/// is refused here when it names a different one - pasting somebody else's
/// contract must not silently succeed.
pub fn read_key(raw: &str, instance_id: &str) -> Result<SupportKey, AppError> {
    let token = raw.trim();
    if token.is_empty() {
        return Err(AppError::Validation(
            "Paste the support key supplied by the publisher.".into(),
        ));
    }
    // A generous ceiling, well above any plausible key: it bounds the work done
    // on unauthenticated-looking input before anything is parsed.
    if token.len() > 8192 {
        return Err(AppError::Validation(
            "This support key is too long.".into(),
        ));
    }

    let header = decode_header(token).map_err(|_| {
        AppError::Validation(
            "This support key is unreadable. Check that it was pasted in full without spaces or line breaks."
                .into(),
        )
    })?;
    if header.alg != Algorithm::EdDSA {
        return Err(AppError::Validation(
            "This key was not signed using the expected algorithm (Ed25519).".into(),
        ));
    }

    // The `kid` decides WHICH key may verify. A key whose `kid` is unknown is
    // never verified against another one: trying every listed key in turn would
    // make rotation meaningless and would hide a publisher-side mistake.
    let trusted = header
        .kid
        .as_deref()
        .and_then(|kid| trusted_signing_keys().iter().find(|k| k.id == kid));

    let key = match trusted {
        Some(signing) => verify(token, signing)?,
        None => SupportKey {
            claims: read_claims_unverified(token)?,
            trust: Trust::Declarative,
        },
    };

    validate_claims(&key.claims, instance_id)?;
    Ok(key)
}

/// Checks the signature and the expiry against one trusted public key.
fn verify(token: &str, signing: &SigningKey) -> Result<SupportKey, AppError> {
    let public_key = B64URL.decode(signing.public_key_b64url).map_err(|e| {
        // A malformed constant is a build-time mistake, not an operator's: it is
        // logged so it is diagnosable, and reported as an internal failure
        // rather than as "your key is invalid", which would send an operator
        // hunting for a problem they do not have.
        tracing::error!(error = %e, key_id = %signing.id, "support: clé publique de confiance illisible");
        AppError::Validation(
            "Cannot verify: the embedded public key is unusable. Report this to the publisher."
                .into(),
        )
    })?;

    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.validate_exp = true;
    validation.validate_aud = false;
    validation.required_spec_claims = ["exp", "sub"].iter().map(|s| s.to_string()).collect();

    let data = decode::<SupportClaims>(
        token,
        &DecodingKey::from_ed_der(&public_key),
        &validation,
    )
    .map_err(|e| {
        // The reason is deliberately not echoed back: it distinguishes "bad
        // signature" from "expired", and neither is worth leaking to whoever is
        // pasting strings. The operator gets one message; the trail gets the
        // detail.
        tracing::warn!(error = %e, key_id = %signing.id, "support: clé refusée");
        AppError::Validation(
            "This support key is invalid: the signature is incorrect or the contract has expired."
                .into(),
        )
    })?;

    Ok(SupportKey {
        claims: data.claims,
        trust: Trust::Verified {
            key_id: signing.id.to_string(),
        },
    })
}

/// Reads the claims of a well-formed key **without** checking anything.
///
/// Only reached when no trusted public key can speak for the token. The result
/// is stored and displayed as declarative, never as a verified fact - the caller
/// is what enforces that, by attaching [`Trust::Declarative`] to it.
fn read_claims_unverified(token: &str) -> Result<SupportClaims, AppError> {
    let unreadable = || {
        AppError::Validation(
            "This support key is unreadable: its content could not be decoded.".into(),
        )
    };

    let mut parts = token.split('.');
    let payload = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(_), Some(payload), Some(_), None) => payload,
        _ => return Err(unreadable()),
    };

    let decoded = B64URL.decode(payload).map_err(|_| unreadable())?;
    serde_json::from_slice::<SupportClaims>(&decoded).map_err(|_| {
        AppError::Validation(
            "This support key does not describe a contract: the holder ('sub') or expiry ('exp') is missing."
                .into(),
        )
    })
}

/// The rules that hold whether or not a signature could be checked.
///
/// Run on the verified path too: `jsonwebtoken` validates the expiry and the
/// presence of the claims, and nothing else - the shape of what the publisher
/// wrote is this function's business.
fn validate_claims(claims: &SupportClaims, instance_id: &str) -> Result<(), AppError> {
    let subject = claims.sub.trim();
    if subject.is_empty() || subject.chars().count() > 255 {
        return Err(AppError::Validation(
            "The contract holder ('sub') is empty or too long.".into(),
        ));
    }

    let expires_at = Utc.timestamp_opt(claims.exp, 0).single().ok_or_else(|| {
        AppError::Validation("The contract expiry ('exp') is not a date.".into())
    })?;
    // Checked here as well as by `jsonwebtoken`, because the declarative path
    // never goes through it. Registering a contract that is already over would
    // put a permanently red panel on the page and help nobody.
    if expires_at <= Utc::now() {
        return Err(AppError::Validation(format!(
            "This support contract ended on {}.",
            expires_at.format("%d/%m/%Y")
        )));
    }

    if let Some(plan) = claims.plan.as_deref() {
        if plan.chars().count() > 120 {
            return Err(AppError::Validation(
                "The plan name ('plan') is too long.".into(),
            ));
        }
    }
    if let Some(perimeter) = claims.perimeter.as_deref() {
        if perimeter.chars().count() > 2000 {
            return Err(AppError::Validation(
                "The contract scope is too long.".into(),
            ));
        }
    }
    if let Some(contact) = claims.contact.as_deref() {
        validate_contact(contact)?;
    }

    // A key bound to another installation. Said plainly rather than refused with
    // a generic "invalide": an operator who pasted the wrong contract has to be
    // able to tell that from a typo.
    if let Some(bound) = claims.instance.as_deref() {
        if !bound.trim().is_empty() && !bound.trim().eq_ignore_ascii_case(instance_id) {
            return Err(AppError::Validation(
                "This key was issued for another instance.".into(),
            ));
        }
    }

    Ok(())
}

/// A support contact is an e-mail address or an `https://` URL, and nothing
/// else. The console renders it as a link, so a `javascript:` or `data:` string
/// arriving here would become a clickable one.
fn validate_contact(contact: &str) -> Result<(), AppError> {
    let value = contact.trim();
    if value.is_empty() || value.chars().count() > 320 {
        return Err(AppError::Validation(
            "The support contact is empty or too long.".into(),
        ));
    }
    if value.contains(char::is_whitespace) {
        return Err(AppError::Validation(
            "The support contact cannot contain spaces.".into(),
        ));
    }

    let is_url = value.starts_with("https://") && value.len() > "https://".len();
    // Deliberately minimal: exactly one `@`, something on each side, and a dot
    // in the domain. Anything stricter rejects addresses that exist.
    let is_email = {
        let mut halves = value.split('@');
        match (halves.next(), halves.next(), halves.next()) {
            (Some(local), Some(domain), None) => {
                !local.is_empty() && domain.contains('.') && !domain.starts_with('.')
                    && !domain.ends_with('.')
            }
            _ => false,
        }
    };

    if is_url || is_email {
        Ok(())
    } else {
        Err(AppError::Validation(
            "The support contact must be an email address or an https:// URL.".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_with(payload: serde_json::Value) -> String {
        let header = serde_json::json!({ "alg": "EdDSA", "typ": "JWT", "kid": "unknown" });
        format!(
            "{}.{}.{}",
            B64URL.encode(header.to_string()),
            B64URL.encode(payload.to_string()),
            B64URL.encode("not-a-real-signature"),
        )
    }

    const INSTANCE: &str = "11111111-1111-1111-1111-111111111111";

    fn in_a_year() -> i64 {
        (Utc::now() + chrono::Duration::days(365)).timestamp()
    }

    #[test]
    fn no_trusted_key_yields_a_declarative_contract() {
        let key = key_with(serde_json::json!({
            "sub": "ACME", "exp": in_a_year(), "plan": "Standard",
        }));
        let read = read_key(&key, INSTANCE).expect("clé lisible");
        assert_eq!(read.trust, Trust::Declarative);
        assert!(!read.is_verified());
        assert_eq!(read.claims.sub, "ACME");
    }

    #[test]
    fn an_expired_contract_is_refused() {
        let key = key_with(serde_json::json!({
            "sub": "ACME", "exp": (Utc::now() - chrono::Duration::days(1)).timestamp(),
        }));
        assert!(read_key(&key, INSTANCE).is_err());
    }

    #[test]
    fn a_key_bound_to_another_instance_is_refused() {
        let key = key_with(serde_json::json!({
            "sub": "ACME", "exp": in_a_year(),
            "instance": "22222222-2222-2222-2222-222222222222",
        }));
        assert!(read_key(&key, INSTANCE).is_err());
    }

    #[test]
    fn a_key_bound_to_this_instance_is_accepted() {
        let key = key_with(serde_json::json!({
            "sub": "ACME", "exp": in_a_year(), "instance": INSTANCE,
        }));
        assert!(read_key(&key, INSTANCE).is_ok());
    }

    #[test]
    fn garbage_is_not_a_key() {
        assert!(read_key("pas-une-cle", INSTANCE).is_err());
        assert!(read_key("", INSTANCE).is_err());
    }

    #[test]
    fn a_contact_must_be_an_address_or_an_https_url() {
        assert!(validate_contact("support@example.org").is_ok());
        assert!(validate_contact("https://support.example.org").is_ok());
        assert!(validate_contact("javascript:alert(1)").is_err());
        assert!(validate_contact("http://support.example.org").is_err());
        assert!(validate_contact("deux mots").is_err());
    }
}
