//! Reaching the directory: connect, protect the link, bind, search.
//!
//! ## No process is ever spawned
//!
//! `kubuno-seccomp` refuses `execve`, so `ldapsearch` and every other external
//! tool are off the table by construction. This is a pure-Rust LDAPv3 client
//! (`ldap3`) speaking BER over a socket the core opens itself.
//!
//! ## Certificates
//!
//! An internal directory is nearly always fronted by an internal authority, so
//! "paste your CA" is the first-class answer here, not "switch verification
//! off". Supplying a PEM builds a root store made of the system roots **plus**
//! that authority - adding, never replacing, because an instance that also talks
//! to a public directory must not lose the public roots to gain a private one.
//! Turning verification off remains possible and is reported as a warning by
//! every test.
//!
//! ## Errors are meant to be read
//!
//! [`DirectoryError`] keeps the peer's own words. A directory misconfiguration
//! is diagnosed from the server's answer ("Invalid credentials", "No such
//! object", the TLS alert) and a generic "connection failed" costs an operator
//! an afternoon. The raw text is truncated, never interpreted away - and it is
//! shown in the console only, never on the sign-in path.

use std::sync::Arc;
use std::time::Duration;

use ldap3::{Ldap, LdapConnAsync, LdapConnSettings, SearchEntry};
use rustls::{pki_types::CertificateDer, ClientConfig, RootCertStore};

use super::mapping::safe_entry;
use super::model::{LdapDirectory, Scope, Security};

/// Longest raw peer message kept. Enough for a full LDAP diagnostic message
/// (Active Directory's `data 52e` lives at the end of a long one) and bounded so
/// a hostile server cannot write a novel into an audit row.
pub const MAX_ERROR_LEN: usize = 600;

/// Ceiling on what one search may return, whatever the operator's filter says.
/// A base DN pointed at the top of a forest would otherwise pull the whole
/// directory into memory.
pub const MAX_ENTRIES: usize = 20_000;

/// What went wrong, in the order an operator debugs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectoryError {
    /// The row cannot describe a connection (missing host, base DN, filter).
    Misconfigured(String),
    /// TCP or TLS never came up: wrong host, wrong port, firewall, expired or
    /// untrusted certificate.
    Unreachable(String),
    /// The service account could not bind. Almost always a wrong DN or a
    /// rotated password.
    ServiceBindFailed(String),
    /// The search itself was refused or malformed (bad base DN, bad filter).
    SearchFailed(String),
    /// The search ran and matched nobody.
    NoSuchUser,
    /// The search matched more than one entry. Binding against "the first one"
    /// would be authenticating an arbitrary person.
    Ambiguous(usize),
    /// The entry exists and the password is wrong (or the account is locked,
    /// expired, or disabled - the directory does not always distinguish).
    InvalidCredentials(String),
}

impl DirectoryError {
    /// Wording for the administration console. Never reaches the sign-in path.
    pub fn message(&self) -> String {
        match self {
            Self::Misconfigured(d) => format!("Incomplete configuration: {d}"),
            Self::Unreachable(_) => "Directory unreachable".into(),
            Self::ServiceBindFailed(_) => "Service account bind refused".into(),
            Self::SearchFailed(_) => "Search refused by the directory".into(),
            Self::NoSuchUser => "No entry matches the filter".into(),
            Self::Ambiguous(n) => format!("The filter matches {n} entries; it must identify exactly one"),
            Self::InvalidCredentials(_) => "Credentials refused by the directory".into(),
        }
    }

    /// The peer's own answer, truncated. `None` when there was nothing to quote.
    pub fn detail(&self) -> Option<&str> {
        match self {
            Self::Misconfigured(d)
            | Self::Unreachable(d)
            | Self::ServiceBindFailed(d)
            | Self::SearchFailed(d)
            | Self::InvalidCredentials(d) => Some(d).filter(|s| !s.is_empty()).map(String::as_str),
            Self::NoSuchUser | Self::Ambiguous(_) => None,
        }
    }

    /// What to try next. Written for somebody who has the directory in front of
    /// them and no idea which of six fields is wrong.
    pub fn hint(&self) -> &'static str {
        match self {
            Self::Misconfigured(_) => "Enter the host, base DN, and search filter.",
            Self::Unreachable(_) => {
                "Check the host, port, and encryption mode. For LDAPS, the certificate must be signed by a trusted authority. Paste your directory's private CA if needed."
            }
            Self::ServiceBindFailed(_) => {
                "Check the service account's full DN (e.g. cn=service,ou=accounts,dc=example,dc=com) and its password. Active Directory also accepts service@example.com."
            }
            Self::SearchFailed(_) => {
                "Check the base DN and filter syntax. The service account must have permission to read this branch."
            }
            Self::NoSuchUser => {
                "The filter is syntactically valid but finds no users. Check the username attribute (uid for a standard directory, sAMAccountName for Active Directory) and the base DN."
            }
            Self::Ambiguous(_) => "Add a filter clause so it identifies exactly one entry.",
            Self::InvalidCredentials(_) => {
                "The account was found in the directory, but the bind failed: the password is incorrect or the account is disabled, expired, or locked in the directory."
            }
        }
    }

    /// Is this a failure of the instance's configuration rather than of the
    /// person signing in? Used to decide what deserves a log line at `error`.
    pub fn is_operational(&self) -> bool {
        matches!(
            self,
            Self::Misconfigured(_) | Self::Unreachable(_) | Self::ServiceBindFailed(_) | Self::SearchFailed(_)
        )
    }
}

impl std::fmt::Display for DirectoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.detail() {
            Some(d) => write!(f, "{} - {}", self.message(), d),
            None => write!(f, "{}", self.message()),
        }
    }
}

/// Truncates a peer message on a character boundary.
pub fn truncate(text: &str) -> String {
    let text = text.trim().replace(['\n', '\r'], " ");
    if text.chars().count() <= MAX_ERROR_LEN {
        return text;
    }
    let cut: String = text.chars().take(MAX_ERROR_LEN).collect();
    format!("{cut}…")
}

// ── TLS ──────────────────────────────────────────────────────────────────────

/// Builds a root store made of the system roots plus the supplied authority.
///
/// A PEM that parses to no certificate is an error rather than a silent
/// fallback to the public roots: an operator who pasted the wrong file would
/// otherwise be told the connection failed for an unrelated reason.
fn root_store_with(ca_pem: &str) -> Result<RootCertStore, DirectoryError> {
    let mut store = RootCertStore::empty();

    // System roots first, best effort. An instance in a container without a
    // trust store is a normal situation when the only peer is the private one.
    match rustls_native_certs::load_native_certs() {
        result if result.certs.is_empty() => {
            tracing::debug!("annuaire : aucun certificat système chargé, seule l'autorité fournie fera foi");
        }
        result => {
            let (added, _ignored) = store.add_parsable_certificates(result.certs);
            tracing::debug!(added, "annuaire : racines système chargées");
        }
    }

    let mut reader = std::io::BufReader::new(ca_pem.as_bytes());
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| {
            DirectoryError::Misconfigured(format!("Cannot read the certificate authority: {e}"))
        })?;
    if certs.is_empty() {
        return Err(DirectoryError::Misconfigured(
            "The supplied certificate authority contains no PEM certificates".into(),
        ));
    }
    let count = certs.len();
    let (added, ignored) = store.add_parsable_certificates(certs);
    if added == 0 {
        return Err(DirectoryError::Misconfigured(format!(
            "The supplied certificate authority ({count} PEM block(s)) could not be loaded"
        )));
    }
    if ignored > 0 {
        tracing::warn!(ignored, "annuaire : blocs PEM ignorés dans l'autorité fournie");
    }
    Ok(store)
}

/// Connection settings for one directory.
///
/// The custom rustls configuration is built **only** when a private authority
/// is supplied and verification is on. Otherwise `ldap3`'s own configuration
/// applies - and when verification is off, `set_no_tls_verify` is what installs
/// the permissive verifier, which only works if we do not hand it a config.
fn conn_settings(dir: &LdapDirectory) -> Result<LdapConnSettings, DirectoryError> {
    let timeout = Duration::from_secs(dir.connect_timeout_s.clamp(1, 120) as u64);
    let mut settings = LdapConnSettings::new().set_conn_timeout(timeout);

    let security = dir.security();
    if security == Security::Starttls {
        settings = settings.set_starttls(true);
    }

    if security == Security::None {
        return Ok(settings);
    }

    if !dir.verify_certificate {
        tracing::warn!(
            directory = %dir.slug,
            "annuaire : vérification du certificat désactivée - la liaison est chiffrée mais non authentifiée"
        );
        return Ok(settings.set_no_tls_verify(true));
    }

    if !dir.ca_certificate.trim().is_empty() {
        let store = root_store_with(&dir.ca_certificate)?;
        let config = ClientConfig::builder()
            .with_root_certificates(store)
            .with_no_client_auth();
        settings = settings.set_config(Arc::new(config));
    }

    Ok(settings)
}

// ── Connection ───────────────────────────────────────────────────────────────

/// A live connection, already bound as the service account.
pub struct Connection {
    pub ldap: Ldap,
}

/// Hand-written and deliberately opaque. The handle carries the session that was
/// bound with the service password; a derived `Debug` would print whatever
/// `ldap3` chooses to expose the first time anyone logs a connection.
impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Connection { ldap: «session ouverte» }")
    }
}

impl Connection {
    /// Opens a connection and binds the service account (or stays anonymous
    /// when no DN is configured).
    ///
    /// `service_password` is the decrypted secret. It is a parameter rather than
    /// something this function reads, so the decryption happens in exactly one
    /// place and the plaintext never lives longer than the call.
    pub async fn open(
        dir: &LdapDirectory,
        service_password: &str,
    ) -> Result<Self, DirectoryError> {
        if dir.host.trim().is_empty() {
            return Err(DirectoryError::Misconfigured("Host not specified".into()));
        }
        if dir.base_dn.trim().is_empty() {
            return Err(DirectoryError::Misconfigured("Base DN not specified".into()));
        }

        // rustls refuses to build anything before a crypto provider exists.
        // Fallible by design - it declines to replace one already installed,
        // which is exactly what happens when the HTTPS listener got there first.
        let _ = rustls::crypto::ring::default_provider().install_default();

        let settings = conn_settings(dir)?;
        let url = dir.url();

        let (conn, mut ldap) = LdapConnAsync::with_settings(settings, &url)
            .await
            .map_err(|e| DirectoryError::Unreachable(truncate(&e.to_string())))?;

        // The connection future drives the protocol; without it nothing moves.
        // It ends on its own when the `Ldap` handle is dropped.
        ldap3::drive!(conn);

        if !dir.bind_dn.trim().is_empty() {
            let res = ldap
                .simple_bind(dir.bind_dn.trim(), service_password)
                .await
                .map_err(|e| DirectoryError::Unreachable(truncate(&e.to_string())))?;
            if res.rc != 0 {
                return Err(DirectoryError::ServiceBindFailed(truncate(&format!(
                    "code {} - {}",
                    res.rc, res.text
                ))));
            }
        }

        Ok(Self { ldap })
    }

    /// Runs a search and returns the entries, bounded by [`MAX_ENTRIES`].
    pub async fn search(
        &mut self,
        base: &str,
        scope: Scope,
        filter: &str,
        attrs: &[String],
    ) -> Result<Vec<SearchEntry>, DirectoryError> {
        let result = self
            .ldap
            .search(base, scope.to_ldap3(), filter, attrs)
            .await
            .map_err(|e| DirectoryError::SearchFailed(truncate(&e.to_string())))?;

        let (entries, res) = result
            .success()
            .map_err(|e| DirectoryError::SearchFailed(truncate(&e.to_string())))?;

        if entries.len() > MAX_ENTRIES {
            tracing::warn!(
                returned = entries.len(),
                cap = MAX_ENTRIES,
                "annuaire : résultat tronqué - restreignez le DN de base ou le filtre"
            );
        }
        if res.rc != 0 {
            return Err(DirectoryError::SearchFailed(truncate(&format!(
                "code {} - {}",
                res.rc, res.text
            ))));
        }

        Ok(entries
            .into_iter()
            .take(MAX_ENTRIES)
            .filter_map(safe_entry)
            .collect())
    }

    /// Attempts a simple bind as `dn`. This is the authentication itself.
    ///
    /// An empty password is refused before it reaches the wire: RFC 4513 §5.1.2
    /// makes a simple bind with an empty password an *unauthenticated* bind,
    /// which many servers answer with success. Sending it would turn "no
    /// password" into "signed in".
    pub async fn bind_as(&mut self, dn: &str, password: &str) -> Result<(), DirectoryError> {
        if password.is_empty() {
            return Err(DirectoryError::InvalidCredentials(
                "Empty password (unauthenticated bind refused)".into(),
            ));
        }
        let res = self
            .ldap
            .simple_bind(dn, password)
            .await
            .map_err(|e| DirectoryError::Unreachable(truncate(&e.to_string())))?;
        if res.rc != 0 {
            return Err(DirectoryError::InvalidCredentials(truncate(&format!(
                "code {} - {}",
                res.rc, res.text
            ))));
        }
        Ok(())
    }

    /// Closes the session politely. Failure is not worth propagating: the
    /// socket goes away with the handle either way.
    pub async fn close(mut self) {
        let _ = self.ldap.unbind().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_message_is_truncated_on_a_character_boundary() {
        let long = "é".repeat(MAX_ERROR_LEN + 50);
        let cut = truncate(&long);
        assert_eq!(cut.chars().count(), MAX_ERROR_LEN + 1); // + the ellipsis
        assert!(cut.ends_with('…'));
        // Short messages pass through, newlines flattened so one error is one line.
        assert_eq!(truncate("  ligne1\nligne2  "), "ligne1 ligne2");
    }

    #[test]
    fn every_error_carries_something_actionable() {
        let cases = [
            DirectoryError::Misconfigured("x".into()),
            DirectoryError::Unreachable("connection refused".into()),
            DirectoryError::ServiceBindFailed("code 49".into()),
            DirectoryError::SearchFailed("no such object".into()),
            DirectoryError::NoSuchUser,
            DirectoryError::Ambiguous(3),
            DirectoryError::InvalidCredentials("code 49".into()),
        ];
        for e in &cases {
            assert!(!e.message().is_empty());
            assert!(!e.hint().is_empty());
        }
        // The raw answer survives where there is one, and only there.
        assert_eq!(
            DirectoryError::InvalidCredentials("code 49".into()).detail(),
            Some("code 49")
        );
        assert_eq!(DirectoryError::NoSuchUser.detail(), None);
    }

    #[test]
    fn an_operational_failure_is_told_from_a_users_mistake() {
        assert!(DirectoryError::Unreachable(String::new()).is_operational());
        assert!(DirectoryError::ServiceBindFailed(String::new()).is_operational());
        // A wrong password is not an incident.
        assert!(!DirectoryError::InvalidCredentials(String::new()).is_operational());
        assert!(!DirectoryError::NoSuchUser.is_operational());
    }

    #[test]
    fn an_unparsable_authority_is_refused_rather_than_ignored() {
        let err = root_store_with("ceci n'est pas un certificat").unwrap_err();
        assert!(matches!(err, DirectoryError::Misconfigured(_)));
        let err = root_store_with("").unwrap_err();
        assert!(matches!(err, DirectoryError::Misconfigured(_)));
    }

    #[test]
    fn plain_ldap_asks_for_no_tls_and_starttls_does() {
        let mut d = crate::directory::model::tests_support::sample();
        d.security = "none".into();
        assert!(conn_settings(&d).is_ok());
        d.security = "starttls".into();
        assert!(conn_settings(&d).expect("réglages").starttls());
        d.security = "ldaps".into();
        assert!(!conn_settings(&d).expect("réglages").starttls());
    }

    // ── Live-socket tests ────────────────────────────────────────────────────
    //
    // Everything below binds a listener on the loopback interface and talks to
    // it. Nothing leaves the machine, and no directory has to be installed for
    // `cargo test` to exercise the two failures that matter most: a directory
    // that is not there, and one that refuses the bind.

    /// A directory row pointed at `127.0.0.1:port`, plain LDAP.
    fn local_directory(port: u16) -> LdapDirectory {
        let mut d = crate::directory::model::tests_support::sample();
        d.host = "127.0.0.1".into();
        d.port = port as i32;
        d.security = "none".into();
        d.bind_dn = "cn=service,dc=exemple,dc=test".into();
        d.connect_timeout_s = 2;
        d
    }

    #[tokio::test]
    async fn an_unreachable_directory_is_reported_as_unreachable() {
        // A port nothing listens on. Bound and dropped first, so the number is
        // known to be free rather than guessed.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").expect("port libre");
            let p = l.local_addr().expect("adresse").port();
            drop(l);
            p
        };

        let err = Connection::open(&local_directory(port), "peu-importe")
            .await
            .expect_err("la connexion doit échouer");

        assert!(
            matches!(err, DirectoryError::Unreachable(_)),
            "attendu Unreachable, obtenu {err:?}"
        );
        // The operator gets the peer's own words and something to check.
        assert!(err.detail().is_some_and(|d| !d.is_empty()));
        assert!(err.hint().contains("port"));
        assert!(err.is_operational(), "une panne d'annuaire est un incident d'instance");
    }

    #[tokio::test]
    async fn a_refused_service_bind_keeps_the_directorys_own_answer() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("écoute");
        let port = listener.local_addr().expect("adresse").port();

        // The smallest possible LDAP server: read one message, answer
        // `bindResponse(49, "invalid credentials")`. Hand-encoded BER, because
        // the point is to prove the client surfaces the diagnostic verbatim.
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let mut buf = [0u8; 512];
            let Ok(n) = socket.read(&mut buf).await else { return };
            // LDAPMessage ::= SEQUENCE { messageID INTEGER, protocolOp … }
            // 30 <len> 02 01 <id> …  - echo the id back or the client ignores us.
            let message_id = if n >= 5 && buf[0] == 0x30 && buf[2] == 0x02 { buf[4] } else { 1 };

            const DIAG: &[u8] = b"invalid credentials";
            let mut op = vec![0x0A, 0x01, 49, 0x04, 0x00, 0x04, DIAG.len() as u8];
            op.extend_from_slice(DIAG);

            let mut msg = vec![0x02, 0x01, message_id, 0x61, op.len() as u8];
            msg.extend_from_slice(&op);

            let mut frame = vec![0x30, msg.len() as u8];
            frame.extend_from_slice(&msg);

            let _ = socket.write_all(&frame).await;
            let _ = socket.flush().await;
            // Held open: closing immediately would race the client's read.
            tokio::time::sleep(Duration::from_millis(300)).await;
        });

        let err = Connection::open(&local_directory(port), "mauvais-mot-de-passe")
            .await
            .expect_err("la liaison doit être refusée");

        match &err {
            DirectoryError::ServiceBindFailed(detail) => {
                // Both halves matter: the numeric code an operator greps for,
                // and the words the directory chose.
                assert!(detail.contains("49"), "code absent de « {detail} »");
                assert!(detail.contains("invalid credentials"), "diagnostic perdu : « {detail} »");
            }
            other => panic!("attendu ServiceBindFailed, obtenu {other:?}"),
        }
        assert!(err.hint().contains("service account"));
    }

    #[test]
    fn a_directory_with_a_broken_authority_never_opens_a_socket() {
        let mut d = crate::directory::model::tests_support::sample();
        d.security = "ldaps".into();
        d.verify_certificate = true;
        d.ca_certificate = "-----BEGIN CERTIFICATE-----\nn'importe quoi\n-----END CERTIFICATE-----".into();
        assert!(matches!(conn_settings(&d), Err(DirectoryError::Misconfigured(_))));
    }
}
