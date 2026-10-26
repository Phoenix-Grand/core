//! The only thing that turns a typed name into a proven one.
//!
//! ## Why the product resolves DNS itself
//!
//! Ownership of a domain cannot be asserted from inside the console: whoever
//! filled the form is exactly the person whose claim is in doubt. The proof has
//! to be something only the domain's controller can produce, and reading it has
//! to happen somewhere they cannot forge - which leaves a DNS query.
//!
//! This is the one outward request this feature makes, it is made against the
//! name an administrator typed, and it is made when they ask for it (or by the
//! background refresh of the mail diagnosis). Nothing here contacts a third
//! party on a user's behalf, and no user data leaves the instance: the query is
//! the domain name, which the administrator just published to the world anyway.
//!
//! ## What it deliberately cannot do
//!
//! It reads. It never writes, never suggests a registrar, never proxies through
//! anybody's API. An instance whose resolver is unreachable degrades to "je n'ai
//! pas pu vérifier, voici pourquoi" - never to "vérifié" and never to a silent
//! failure.

use std::sync::OnceLock;
use std::time::Duration;

use hickory_resolver::proto::rr::RecordType;
use hickory_resolver::TokioResolver;
use serde::Serialize;

/// The prefix of the TXT value an administrator publishes. Named after the
/// product, like every other verification token in the wild, so that somebody
/// reading their zone file a year later knows what put it there.
pub const TOKEN_PREFIX: &str = "kubuno-domain-verification";

/// Longest a single query may take.
///
/// Five seconds: a resolver that has not answered by then is unreachable or
/// being blocked, and the console is a synchronous page somebody is waiting in
/// front of. The failure is reported, not retried into a hang.
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);

type SharedResolver = TokioResolver;

static RESOLVER: OnceLock<Option<SharedResolver>> = OnceLock::new();

/// The system resolver, built once.
///
/// `None` when the host has no usable configuration - a container without
/// `/etc/resolv.conf` is the realistic case. Every caller then reports that it
/// could not check, which is the truth, rather than reporting a failed check.
fn resolver() -> Option<&'static SharedResolver> {
    RESOLVER
        .get_or_init(|| match TokioResolver::builder_tokio().and_then(|b| b.build()) {
            Ok(resolver) => Some(resolver),
            Err(e) => {
                tracing::error!(
                    error = %e,
                    "domains: aucun résolveur DNS utilisable (configuration système illisible)"
                );
                None
            }
        })
        .as_ref()
}

/// What a probe could not do, in the words the console shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum ProbeError {
    /// The instance itself cannot resolve anything.
    NoResolver,
    /// The name does not exist at all - almost always a typo in the domain.
    UnknownDomain,
    /// The name exists but carries no record of the kind we asked for.
    NoRecord,
    /// Timed out, refused, SERVFAIL…
    Unreachable(String),
}

impl ProbeError {
    /// A sentence for the console. French, like every other message the product
    /// shows an administrator.
    pub fn message(&self) -> String {
        match self {
            Self::NoResolver => "This instance has no usable DNS resolver. Verification is impossible until the server can query DNS.".into(),
            Self::UnknownDomain => "This domain does not exist in DNS. Check its spelling.".into(),
            Self::NoRecord => "No record of this type is published for this domain.".into(),
            Self::Unreachable(detail) => format!("DNS did not respond: {detail}"),
        }
    }
}

/// Runs one lookup, mapping every failure onto the closed vocabulary above.
async fn lookup(name: &str, record_type: RecordType) -> Result<Vec<String>, ProbeError> {
    let resolver = resolver().ok_or(ProbeError::NoResolver)?;
    // The trailing dot makes it a fully qualified name: without it the resolver
    // appends the *server's* search domains, and `example.com` would be looked
    // up as `example.com.internal.lan` on a host that has one.
    let query = format!("{}.", name.trim_end_matches('.'));

    let response = match tokio::time::timeout(QUERY_TIMEOUT, resolver.lookup(query, record_type)).await {
        Err(_) => return Err(ProbeError::Unreachable("Timed out".into())),
        Ok(Ok(response)) => response,
        Ok(Err(e)) => {
            let text = e.to_string();
            // hickory reports both "no records" and "no such name" as errors;
            // they mean very different things to somebody debugging a zone.
            return Err(if e.is_nx_domain() {
                ProbeError::UnknownDomain
            } else if e.is_no_records_found() {
                ProbeError::NoRecord
            } else {
                ProbeError::Unreachable(text)
            });
        }
    };

    let mut out = Vec::new();
    for record in response.answers() {
        match &record.data {
            // A TXT value can be split into several strings by the zone file;
            // they are one value and must be joined before being compared.
            hickory_resolver::proto::rr::RData::TXT(txt) => {
                let joined: String = txt
                    .txt_data
                    .iter()
                    .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
                    .collect();
                out.push(joined);
            }
            hickory_resolver::proto::rr::RData::MX(mx) => {
                out.push(format!("{} {}", mx.preference, mx.exchange));
            }
            other => out.push(other.to_string()),
        }
    }
    if out.is_empty() {
        return Err(ProbeError::NoRecord);
    }
    Ok(out)
}

/// Is the expected token published on `name`?
///
/// Returns the values that *were* found when it is not: an administrator who
/// pasted the token of another instance, or published it on `www` instead of the
/// apex, is helped by seeing what the world actually serves.
pub async fn check_verification(name: &str, token: &str) -> Result<VerificationProbe, ProbeError> {
    let expected = format!("{TOKEN_PREFIX}={token}");
    let values = lookup(name, RecordType::TXT).await?;
    let found = values.iter().any(|v| v.trim() == expected);
    Ok(VerificationProbe {
        found,
        // Only the values that look like a verification token: a zone's TXT
        // records also carry SPF, DKIM and vendor tokens, and dumping them into
        // the console would disclose more than the question asked.
        others: values
            .into_iter()
            .filter(|v| v.contains("-verification=") || v.contains("-site-verification="))
            .take(5)
            .collect(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct VerificationProbe {
    pub found: bool,
    /// Other verification tokens seen on the name, to explain a near-miss.
    pub others: Vec<String>,
}

/// What the domain publishes about mail. A *diagnosis*, never a verdict: the
/// core does not run the mail service and has no business declaring somebody's
/// records wrong.
#[derive(Debug, Clone, Default, Serialize)]
pub struct MailProbe {
    /// `"10 mx.example.com."`, in the order the resolver returned them.
    pub mx: Vec<String>,
    pub spf: bool,
    pub dmarc: bool,
    /// Set when the probe could not run at all; the three fields above are then
    /// meaningless rather than false.
    pub error: Option<String>,
}

/// Reads MX, SPF and DMARC in one go.
///
/// The three are separate questions and a missing answer to one says nothing
/// about the others, so a failure on any single lookup leaves that field alone
/// instead of failing the whole diagnosis.
pub async fn probe_mail(name: &str) -> MailProbe {
    let mx = match lookup(name, RecordType::MX).await {
        Ok(values) => values,
        Err(ProbeError::NoResolver) => {
            return MailProbe {
                error: Some(ProbeError::NoResolver.message()),
                ..MailProbe::default()
            }
        }
        Err(_) => Vec::new(),
    };

    let spf = lookup(name, RecordType::TXT)
        .await
        .map(|values| values.iter().any(|v| v.trim_start().to_ascii_lowercase().starts_with("v=spf1")))
        .unwrap_or(false);

    let dmarc = lookup(&format!("_dmarc.{name}"), RecordType::TXT)
        .await
        .map(|values| values.iter().any(|v| v.trim_start().to_ascii_uppercase().starts_with("V=DMARC1")))
        .unwrap_or(false);

    MailProbe { mx, spf, dmarc, error: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_failure_says_something_an_operator_can_act_on() {
        // The point of the enum: four failures, four different next steps.
        for error in [
            ProbeError::NoResolver,
            ProbeError::UnknownDomain,
            ProbeError::NoRecord,
            ProbeError::Unreachable("SERVFAIL".into()),
        ] {
            let message = error.message();
            assert!(!message.is_empty());
            // No jargon leaking a crate name or a record type into a sentence
            // somebody has to act on.
            assert!(!message.contains("hickory"), "{message}");
        }
        assert!(ProbeError::Unreachable("SERVFAIL".into()).message().contains("SERVFAIL"));
    }

    #[test]
    fn the_token_is_named_after_the_product() {
        // Somebody reading their zone file a year from now must be able to tell
        // what put this record there.
        assert_eq!(TOKEN_PREFIX, "kubuno-domain-verification");
    }
}
