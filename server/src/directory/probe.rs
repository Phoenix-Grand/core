//! The two buttons that make a directory configurable at all.
//!
//! An LDAP configuration has a dozen fields and eleven of them can be wrong in
//! a way that produces the same symptom: nobody can sign in. These two probes
//! exist so an operator finds out *which* one, in seconds, from the console -
//! rather than from a log line that says "invalid credentials" an hour after
//! somebody complained.
//!
//! Both return the peer's own answer, truncated and verbatim. That raw line is
//! the whole point: `data 52e` at the end of an Active Directory message means
//! "wrong password", `data 525` means "no such user", and no amount of
//! rephrasing on our side conveys that.

use serde::Serialize;
use kubuno_db::DbPool;

use super::client::{Connection, DirectoryError};
use super::mapping::map_user;
use super::model::LdapDirectory;
use super::{config, filter};

/// Result of a connection probe.
#[derive(Debug, Serialize)]
pub struct ConnectionProbe {
    pub ok: bool,
    /// Short verdict, translated in the console.
    pub message: String,
    /// The peer's own words, truncated. Absent when there were none.
    pub detail: Option<String>,
    /// What to check next.
    pub hint: Option<String>,
    /// Echoed so a mistyped host is visible in the answer itself.
    pub host: String,
    pub port: i32,
    pub security: String,
    /// True when the link is encrypted but the certificate was not verified.
    pub unverified_tls: bool,
    /// How many entries the sample search matched. `None` when it never ran.
    pub entries: Option<usize>,
    /// The DN of the first match, so an operator can see the shape of the tree.
    pub sample_dn: Option<String>,
    /// Attributes actually returned for that first entry, mapped through the
    /// configuration - the fastest way to see that `uid` was the wrong choice.
    pub sample_mapping: Option<SampleMapping>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct SampleMapping {
    pub username: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    /// Present or absent only - the value is an opaque identifier and printing
    /// it teaches nobody anything.
    pub has_unique_id: bool,
    pub groups: usize,
}

/// Result of an authentication probe.
#[derive(Debug, Serialize)]
pub struct AuthProbe {
    pub ok: bool,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// The login that was tried, echoed back. Never the password.
    pub login: String,
    /// The DN the search resolved to, when it resolved to one.
    pub dn: Option<String>,
    pub sample_mapping: Option<SampleMapping>,
    /// What would happen to this person on a real sign-in.
    pub would_provision: Option<String>,
    pub elapsed_ms: u64,
}

fn failure_fields(e: &DirectoryError) -> (String, Option<String>, Option<String>) {
    (
        e.message(),
        e.detail().map(str::to_string),
        Some(e.hint().to_string()),
    )
}

/// Connects, binds the service account, and runs the configured filter widened
/// to everybody - the exact sequence a synchronisation performs.
pub async fn probe_connection(jwt_secret: &str, dir: &LdapDirectory) -> ConnectionProbe {
    let started = std::time::Instant::now();
    let unverified_tls = dir.security() != super::model::Security::None && !dir.verify_certificate;
    let mut probe = ConnectionProbe {
        ok: false,
        message: String::new(),
        detail: None,
        hint: None,
        host: dir.host.clone(),
        port: dir.port,
        security: dir.security.clone(),
        unverified_tls,
        entries: None,
        sample_dn: None,
        sample_mapping: None,
        elapsed_ms: 0,
    };

    let sample_filter = match filter::build_sync_filter(&dir.user_filter) {
        Ok(f) => f,
        Err(e) => {
            probe.message = "Invalid search filter".into();
            probe.detail = Some(e.message().to_string());
            probe.hint = Some(
                "The filter must contain '{login}', where the entered username is inserted."
                    .into(),
            );
            probe.elapsed_ms = started.elapsed().as_millis() as u64;
            return probe;
        }
    };

    let service_password = config::decrypt_password(jwt_secret, &dir.bind_password_enc);
    let mut conn = match Connection::open(dir, &service_password).await {
        Ok(c) => c,
        Err(e) => {
            let (m, d, h) = failure_fields(&e);
            probe.message = m;
            probe.detail = d;
            probe.hint = h;
            probe.elapsed_ms = started.elapsed().as_millis() as u64;
            return probe;
        }
    };

    let attrs = dir.attributes();
    let entries = match conn
        .search(&dir.base_dn, dir.scope(), &sample_filter, &attrs.requested())
        .await
    {
        Ok(e) => e,
        Err(e) => {
            conn.close().await;
            let (m, d, h) = failure_fields(&e);
            probe.message = m;
            probe.detail = d;
            probe.hint = h;
            probe.elapsed_ms = started.elapsed().as_millis() as u64;
            return probe;
        }
    };
    conn.close().await;

    probe.entries = Some(entries.len());
    if let Some(first) = entries.first() {
        let mapped = map_user(first, &attrs);
        probe.sample_dn = Some(mapped.dn.clone());
        probe.sample_mapping = Some(SampleMapping {
            username: mapped.username.clone(),
            email: mapped.email.clone(),
            display_name: mapped.display_name.clone(),
            has_unique_id: mapped.uid.is_some(),
            groups: mapped.member_of.len(),
        });
    }

    probe.ok = true;
    probe.message = if entries.is_empty() {
        // Connected, bound, searched - and matched nobody. Worth its own
        // wording: the connection is fine and the mapping is not.
        probe.hint = Some(
            "The connection and bind work, but the filter finds no users. Check the base DN and username attribute (uid for a standard directory, sAMAccountName for Active Directory)."
                .into(),
        );
        "Connected; no entries found".into()
    } else {
        "Connected".into()
    };
    probe.elapsed_ms = started.elapsed().as_millis() as u64;
    probe
}

/// Runs a full search-then-bind for one person, with a password the operator
/// supplies. The password is used and dropped; it is never stored, never
/// logged, and never echoed back.
pub async fn probe_authentication(
    db: &DbPool,
    jwt_secret: &str,
    dir: &LdapDirectory,
    login: &str,
    password: &str,
) -> AuthProbe {
    let started = std::time::Instant::now();
    let mut probe = AuthProbe {
        ok: false,
        message: String::new(),
        detail: None,
        hint: None,
        login: login.to_string(),
        dn: None,
        sample_mapping: None,
        would_provision: None,
        elapsed_ms: 0,
    };

    let service_password = config::decrypt_password(jwt_secret, &dir.bind_password_enc);
    match super::auth::search_then_bind(dir, &service_password, login, password).await {
        Ok(mapped) => {
            probe.ok = true;
            probe.message = "Authentication succeeded".into();
            probe.dn = Some(mapped.dn.clone());
            probe.sample_mapping = Some(SampleMapping {
                username: mapped.username.clone(),
                email: mapped.email.clone(),
                display_name: mapped.display_name.clone(),
                has_unique_id: mapped.uid.is_some(),
                groups: mapped.member_of.len(),
            });

            // Say what a real sign-in would do, without doing it: the probe must
            // not create an account as a side effect of being run.
            probe.would_provision = Some(match super::provision::find_existing(db, dir, &mapped).await {
                Ok(Some(u)) if u.password_hash.is_some() => format!(
                    "Le compte local « {} » existe et conserve un mot de passe local : c'est ce mot de passe \
                     qui l'authentifie, pas l'annuaire.",
                    u.username
                ),
                Ok(Some(u)) => format!("Account '{}' is managed by this directory.", u.username),
                Ok(None) if dir.allow_signup => {
                    "No local account; a real sign-in would create one.".into()
                }
                Ok(None) => {
                    "No local account, and account creation is disabled for this directory. Sign-in would fail despite a successful bind."
                        .into()
                }
                Err(_) => "Could not determine the local account's state.".into(),
            });
        }
        Err(e) => {
            let (m, d, h) = failure_fields(&e);
            probe.message = m;
            probe.detail = d;
            probe.hint = h;
        }
    }

    probe.elapsed_ms = started.elapsed().as_millis() as u64;
    probe
}
