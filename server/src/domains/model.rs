//! What a domain is, and what a name has to look like to become one.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::errors::AppError;

/// The three kinds, and the whole of the model's expressiveness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DomainKind {
    /// The instance's own name. Exactly one, enforced by a unique index.
    Primary,
    /// Another name this instance answers for, with its own accounts.
    Secondary,
    /// A second address for the accounts of another domain. Creates nobody.
    Alias,
}

impl DomainKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Secondary => "secondary",
            Self::Alias => "alias",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, AppError> {
        Ok(match raw {
            "primary" => Self::Primary,
            "secondary" => Self::Secondary,
            "alias" => Self::Alias,
            other => {
                return Err(AppError::Validation(format!(
                    "Unknown domain type '{other}'"
                )))
            }
        })
    }
}

/// One declared domain, as the console and the API see it.
#[derive(Debug, Clone, Serialize)]
pub struct Domain {
    pub id: Uuid,
    pub name: String,
    pub kind: DomainKind,
    pub parent_id: Option<Uuid>,
    /// The name of the domain an alias lends its addresses to.
    pub parent_name: Option<String>,
    /// The random half of the TXT value; the console composes the full record.
    pub verify_token: String,
    pub verified_at: Option<DateTime<Utc>>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub mx_hosts: Value,
    pub has_spf: Option<bool>,
    pub has_dmarc: Option<bool>,
    pub mail_checked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    /// How many accounts carry an address at this domain - what makes a removal
    /// destructive, and the figure the confirmation names.
    pub account_count: i64,
}

impl Domain {
    pub fn is_verified(&self) -> bool {
        self.verified_at.is_some()
    }

    /// The one domain the instance answers as its own.
    pub fn is_primary(&self) -> bool {
        matches!(self.kind, DomainKind::Primary)
    }

    /// At least one MX host was seen at the last probe. Stored as a JSON array.
    pub fn has_mx(&self) -> bool {
        self.mx_hosts.as_array().map(|a| !a.is_empty()).unwrap_or(false)
    }

    /// Ready to host mailboxes: the primary domain, ownership proven (TXT) and
    /// mail actually routable (MX). This is the condition the mail module waits
    /// on before provisioning an address for every account.
    pub fn mail_ready(&self) -> bool {
        self.is_primary() && self.is_verified() && self.has_mx()
    }

    /// The TXT value to publish, prefix included.
    pub fn expected_record(&self) -> String {
        format!("{}={}", super::dns::TOKEN_PREFIX, self.verify_token)
    }
}

/// Normalises and refuses a name.
///
/// Refused early and precisely, because everything downstream - the unique
/// index, the address comparison, the DNS query - assumes a name that is already
/// lower-case, ASCII and free of a scheme, a port, a path or a trailing dot.
/// A form that accepts `https://Example.COM/` and stores it is a form that
/// produces a domain nothing will ever match.
pub fn normalise_name(raw: &str) -> Result<String, AppError> {
    let mut name = raw.trim().to_ascii_lowercase();

    // The three things people paste instead of a domain.
    for scheme in ["https://", "http://"] {
        if let Some(rest) = name.strip_prefix(scheme) {
            name = rest.to_string();
        }
    }
    if let Some((host, _)) = name.split_once('/') {
        name = host.to_string();
    }
    if let Some((host, _)) = name.split_once(':') {
        name = host.to_string();
    }
    // A user typing their own address instead of their domain is the single
    // most common slip on this form.
    if let Some((_, host)) = name.split_once('@') {
        name = host.to_string();
    }
    let name = name.trim_end_matches('.').trim().to_string();

    if name.is_empty() {
        return Err(AppError::Validation("Enter a domain name.".into()));
    }
    if name.len() > 253 {
        return Err(AppError::Validation("The domain name is too long.".into()));
    }
    if !name.contains('.') {
        return Err(AppError::Validation(
            "A domain must contain at least one dot (e.g. 'example.com').".into(),
        ));
    }
    if !name.is_ascii() {
        return Err(AppError::Validation(
            "Accented or non-Latin names must be entered in punycode form ('xn--…'), which is the form used by DNS."
                .into(),
        ));
    }
    for label in name.split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(AppError::Validation(
                "Each domain label must contain between 1 and 63 characters.".into(),
            ));
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err(AppError::Validation(
                "A domain label cannot start or end with a hyphen.".into(),
            ));
        }
        if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(AppError::Validation(
                "A domain can only contain letters, numbers, and hyphens.".into(),
            ));
        }
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_people_paste_instead_of_a_domain_is_understood() {
        assert_eq!(normalise_name("Exemple.FR").expect("valide"), "exemple.fr");
        assert_eq!(normalise_name("  exemple.fr.  ").expect("valide"), "exemple.fr");
        assert_eq!(normalise_name("https://exemple.fr/contact").expect("valide"), "exemple.fr");
        assert_eq!(normalise_name("http://exemple.fr:8080").expect("valide"), "exemple.fr");
        // The most common slip: their own address instead of their domain.
        assert_eq!(normalise_name("marie@exemple.fr").expect("valide"), "exemple.fr");
        assert_eq!(normalise_name("sous.domaine.exemple.fr").expect("valide"), "sous.domaine.exemple.fr");
    }

    #[test]
    fn a_name_that_could_never_match_an_address_is_refused() {
        assert!(normalise_name("").is_err());
        assert!(normalise_name("localhost").is_err(), "sans point");
        assert!(normalise_name("-exemple.fr").is_err());
        assert!(normalise_name("exemple-.fr").is_err());
        assert!(normalise_name("exem ple.fr").is_err());
        assert!(normalise_name("exemple..fr").is_err());
        // Accented names are refused with the punycode instruction rather than
        // silently mangled - the DNS carries the encoded form, not this one.
        let refusal = normalise_name("café.fr").expect_err("refusé");
        assert!(refusal.to_string().contains("punycode"));
        assert!(normalise_name("xn--caf-dma.fr").is_ok());
    }

    #[test]
    fn the_kind_vocabulary_is_closed() {
        for kind in [DomainKind::Primary, DomainKind::Secondary, DomainKind::Alias] {
            assert_eq!(DomainKind::parse(kind.as_str()).expect("connu"), kind);
        }
        assert!(DomainKind::parse("test").is_err());
    }
}
