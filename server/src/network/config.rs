//! The instance's HTTP/HTTPS configuration, read from `core.settings`.
//!
//! Only non-secret knobs live here - ports, protocol floor, HSTS, which mode
//! issues the certificate. The key material itself is deliberately absent: it is
//! held on disk by [`super::store`], never in the database.

use kubuno_db::DbPool;

use crate::errors::AppError;

// ── Setting keys (declared by migration 000125) ──────────────────────────────
pub const KEY_HTTPS_ENABLED: &str = "network.https_enabled";
pub const KEY_HTTPS_PORT: &str = "network.https_port";
pub const KEY_HTTP_REDIRECT: &str = "network.http_redirect_to_https";
pub const KEY_HTTP_REDIRECT_PORT: &str = "network.http_redirect_port";
pub const KEY_TLS_MIN_VERSION: &str = "network.tls_min_version";
pub const KEY_HSTS_ENABLED: &str = "network.hsts_enabled";
pub const KEY_HSTS_MAX_AGE_DAYS: &str = "network.hsts_max_age_days";
pub const KEY_HSTS_INCLUDE_SUBDOMAINS: &str = "network.hsts_include_subdomains";
pub const KEY_HSTS_PRELOAD: &str = "network.hsts_preload";
pub const KEY_CERT_MODE: &str = "network.cert_mode";

// The TLS private key is NOT stored in the database and therefore not encrypted
// with a derived key any more: it lives on disk under the service's own state
// directory, protected by POSIX permissions like every other web server does
// (see `super::store`). That also removes a real failure mode - material sealed
// with the JWT secret became unreadable the day that secret was rotated.

/// The minimum TLS version the core will accept. rustls cannot speak anything
/// older than 1.2 regardless, so this chooses between "1.2 and up" and "1.3
/// only".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMinVersion {
    V1_2,
    V1_3,
}

impl TlsMinVersion {
    pub fn from_setting(s: &str) -> Self {
        match s {
            "1.3" => Self::V1_3,
            _ => Self::V1_2,
        }
    }
}

/// HSTS parameters. The header is only ever emitted when the core actually
/// serves over HTTPS (an HSTS header on a plain-HTTP response is ignored by
/// browsers and, worse, misleading).
#[derive(Debug, Clone)]
pub struct HstsConfig {
    pub enabled: bool,
    pub max_age_days: i64,
    pub include_subdomains: bool,
    pub preload: bool,
}

/// Upper bound on the HSTS max-age, in days (two years - above what any
/// preload list asks for).
///
/// Clamped at the point of USE rather than only at the point of write: the value
/// comes from the database, where a row can predate the validation or be edited
/// by other means, and `days * 86_400` on an unbounded `i64` overflows - which
/// panics in a debug build and wraps to a negative max-age in release.
const MAX_HSTS_DAYS: i64 = 730;

impl HstsConfig {
    /// The `Strict-Transport-Security` value, or `None` when disabled.
    pub fn header_value(&self) -> Option<String> {
        if !self.enabled {
            return None;
        }
        let max_age = self.max_age_days.clamp(0, MAX_HSTS_DAYS) * 86_400;
        let mut v = format!("max-age={max_age}");
        if self.include_subdomains {
            v.push_str("; includeSubDomains");
        }
        if self.preload {
            v.push_str("; preload");
        }
        Some(v)
    }
}

/// The instance's whole HTTP/HTTPS configuration, resolved to concrete values.
#[derive(Debug, Clone)]
pub struct NetworkConfig {
    pub https_enabled: bool,
    pub https_port: u16,
    pub http_redirect_to_https: bool,
    pub http_redirect_port: u16,
    pub tls_min_version: TlsMinVersion,
    pub hsts: HstsConfig,
    pub cert_mode: String,
}

impl NetworkConfig {
    /// Reads every `network.*` key at the instance scope, each with the factory
    /// default the migration declared as a fallback. Never fails: an unreadable
    /// setting takes the safe default rather than the instance down.
    pub async fn load(db: &DbPool) -> Self {
        async fn bool_of(db: &DbPool, key: &str, default: bool) -> bool {
            crate::settings::instance_value(db, key)
                .await
                .and_then(|v| v.as_bool())
                .unwrap_or(default)
        }
        async fn int_of(db: &DbPool, key: &str, default: i64) -> i64 {
            crate::settings::instance_value(db, key)
                .await
                .and_then(|v| v.as_i64())
                .unwrap_or(default)
        }
        async fn str_of(db: &DbPool, key: &str, default: &str) -> String {
            crate::settings::instance_value(db, key)
                .await
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| default.to_string())
        }

        // A port stored out of range falls back to its default rather than
        // wrapping to a nonsense value.
        let port = |n: i64, default: u16| -> u16 {
            u16::try_from(n).ok().filter(|p| *p > 0).unwrap_or(default)
        };

        NetworkConfig {
            https_enabled: bool_of(db, KEY_HTTPS_ENABLED, false).await,
            https_port: port(int_of(db, KEY_HTTPS_PORT, 8443).await, 8443),
            http_redirect_to_https: bool_of(db, KEY_HTTP_REDIRECT, false).await,
            http_redirect_port: port(int_of(db, KEY_HTTP_REDIRECT_PORT, 80).await, 80),
            tls_min_version: TlsMinVersion::from_setting(
                &str_of(db, KEY_TLS_MIN_VERSION, "1.2").await,
            ),
            hsts: HstsConfig {
                enabled: bool_of(db, KEY_HSTS_ENABLED, true).await,
                max_age_days: int_of(db, KEY_HSTS_MAX_AGE_DAYS, 365).await,
                include_subdomains: bool_of(db, KEY_HSTS_INCLUDE_SUBDOMAINS, true).await,
                preload: bool_of(db, KEY_HSTS_PRELOAD, false).await,
            },
            cert_mode: str_of(db, KEY_CERT_MODE, "manual").await,
        }
    }
}

/// Refuses a `network.*` value the declared type cannot describe.
///
/// The schema says "a string" or "a number"; it cannot say "an https URL that is
/// not pointing back inside the infrastructure", nor "a port in range". Called
/// from the settings write path, before anything is stored.
pub fn validate_setting(key: &str, value: &serde_json::Value) -> Result<(), AppError> {
    match key {
        super::acme::KEY_DIRECTORY_URL => {
            validate_acme_directory_url(value.as_str().unwrap_or_default())
        }
        KEY_HTTPS_PORT | KEY_HTTP_REDIRECT_PORT => {
            let n = value.as_i64().unwrap_or(0);
            if !(1..=65_535).contains(&n) {
                return Err(AppError::Validation(
                    "Port invalide : un entier entre 1 et 65535 est attendu".into(),
                ));
            }
            Ok(())
        }
        KEY_HSTS_MAX_AGE_DAYS => {
            let n = value.as_i64().unwrap_or(-1);
            if !(0..=MAX_HSTS_DAYS).contains(&n) {
                return Err(AppError::Validation(format!(
                    "Durée HSTS invalide : entre 0 et {MAX_HSTS_DAYS} jours"
                )));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// The ACME directory must be an `https` URL naming a public host.
///
/// Two reasons, and both matter even though only an administrator can write it:
///   * `http` would expose the whole ACME dialogue (including the account key's
///     use) to anyone on the path;
///   * a URL naming loopback, a link-local or a private address turns this
///     endpoint into a request forwarder aimed at the infrastructure behind the
///     server - the cloud metadata service being the classic target, with the
///     answer partly readable from the console's "last attempt" detail.
///
/// This blocks address LITERALS. A hostname that resolves to an internal address
/// cannot be caught here without resolving it, and a resolution done at write
/// time says nothing about the one done at connect time; the value is an
/// administrator-only setting, and this closes the direct path.
pub fn validate_acme_directory_url(raw: &str) -> Result<(), AppError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(AppError::Validation(
            "L'URL du répertoire ACME est requise".into(),
        ));
    }
    let url = url::Url::parse(raw)
        .map_err(|_| AppError::Validation("URL du répertoire ACME invalide".into()))?;
    if url.scheme() != "https" {
        return Err(AppError::Validation(
            "Le répertoire ACME doit être en https (le dialogue avec l'autorité ne doit pas circuler en clair)".into(),
        ));
    }
    let host = url
        .host()
        .ok_or_else(|| AppError::Validation("URL du répertoire ACME sans hôte".into()))?;

    let refuse = || {
        Err(AppError::Validation(
            "Le répertoire ACME ne peut pas désigner une adresse interne (bouclage, lien-local ou réseau privé)".into(),
        ))
    };
    match host {
        url::Host::Domain(d) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".localhost") {
                return refuse();
            }
        }
        url::Host::Ipv4(ip) => {
            if ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() {
                return refuse();
            }
        }
        url::Host::Ipv6(ip) => {
            // `is_unique_local` / `is_unicast_link_local` are still unstable for
            // Ipv6Addr, so the two ranges are matched on their prefixes: fc00::/7
            // (unique local) and fe80::/10 (link local).
            let seg = ip.segments()[0];
            if ip.is_loopback()
                || ip.is_unspecified()
                || (seg & 0xfe00) == 0xfc00
                || (seg & 0xffc0) == 0xfe80
            {
                return refuse();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_acme_directory_must_be_https_and_public() {
        assert!(validate_acme_directory_url("https://acme-v02.api.letsencrypt.org/directory").is_ok());
        assert!(validate_acme_directory_url(
            "https://acme-staging-v02.api.letsencrypt.org/directory"
        )
        .is_ok());
        // Plain HTTP would expose the dialogue.
        assert!(validate_acme_directory_url("http://acme-v02.api.letsencrypt.org/directory").is_err());
        // Internal targets: the request-forwarding case.
        for internal in [
            "https://127.0.0.1/directory",
            "https://localhost/directory",
            "https://169.254.169.254/latest/meta-data/",
            "https://10.0.0.5/directory",
            "https://192.168.1.1/directory",
            "https://172.16.0.1/directory",
            "https://[::1]/directory",
            "https://[fe80::1]/directory",
            "https://[fd00::1]/directory",
        ] {
            assert!(
                validate_acme_directory_url(internal).is_err(),
                "doit refuser {internal}"
            );
        }
        assert!(validate_acme_directory_url("").is_err());
        assert!(validate_acme_directory_url("pas une url").is_err());
    }

    #[test]
    fn ports_and_hsts_duration_are_bounded_at_the_write() {
        use serde_json::json;
        assert!(validate_setting(KEY_HTTPS_PORT, &json!(443)).is_ok());
        assert!(validate_setting(KEY_HTTPS_PORT, &json!(0)).is_err());
        assert!(validate_setting(KEY_HTTPS_PORT, &json!(70_000)).is_err());
        assert!(validate_setting(KEY_HSTS_MAX_AGE_DAYS, &json!(365)).is_ok());
        assert!(validate_setting(KEY_HSTS_MAX_AGE_DAYS, &json!(-1)).is_err());
        // The overflow case: days that would wrap `days * 86_400`.
        assert!(validate_setting(KEY_HSTS_MAX_AGE_DAYS, &json!(i64::MAX / 86_400)).is_err());
    }

    /// A stored value that predates the validation must still produce a sane
    /// header rather than panicking or wrapping.
    #[test]
    fn an_absurd_stored_hsts_duration_is_clamped_not_overflowed() {
        let h = HstsConfig {
            enabled: true,
            max_age_days: i64::MAX,
            include_subdomains: false,
            preload: false,
        };
        assert_eq!(
            h.header_value().as_deref(),
            Some(format!("max-age={}", MAX_HSTS_DAYS * 86_400).as_str())
        );
    }




    #[test]
    fn hsts_header_is_built_from_its_parts() {
        let h = HstsConfig {
            enabled: true,
            max_age_days: 365,
            include_subdomains: true,
            preload: false,
        };
        assert_eq!(
            h.header_value().as_deref(),
            Some("max-age=31536000; includeSubDomains")
        );
        let off = HstsConfig {
            enabled: false,
            ..h.clone()
        };
        assert_eq!(off.header_value(), None);
    }
}
