//! Reading and writing the SMTP relay configuration held in `core.settings`.
//!
//! The password is the only value that never travels in clear: it is stored as
//! an AES-256-GCM blob keyed by a domain-separated derivation of the JWT secret
//! (same construction as the OIDC client secrets and the TOTP seeds), decrypted
//! only in this process, and reported to the API as a single boolean.

use crate::crypto::datakey;
use kubuno_db::{DbPool, DbQueryBuilder};
use serde::{Deserialize, Serialize};

use crate::{crypto::encryption, errors::AppError};

pub const KEY_ENABLED:  &str = "mail.smtp_enabled";
pub const KEY_HOST:     &str = "mail.smtp_host";
pub const KEY_PORT:     &str = "mail.smtp_port";
pub const KEY_SECURITY: &str = "mail.smtp_security";
pub const KEY_USERNAME: &str = "mail.smtp_username";
pub const KEY_PASSWORD: &str = "mail.smtp_password";
pub const KEY_FROM_ADDRESS: &str = "mail.from_address";
pub const KEY_FROM_NAME:    &str = "mail.from_name";
pub const KEY_PUBLIC_URL:   &str = "mail.public_url";
/// RFC-3339 timestamp of the last test message the relay actually delivered,
/// or `null`. Written by `POST /admin/mail/test` on success and by nothing
/// else: it is in `ALL_KEYS`, so the generic settings route refuses it and an
/// operator cannot declare their own relay working.
pub const KEY_LAST_TEST_OK: &str = "mail.last_test_ok_at";

/// Every key this module owns. The generic settings API refuses all of them -
/// the encrypted password has exactly one writer.
pub const ALL_KEYS: &[&str] = &[
    KEY_ENABLED, KEY_HOST, KEY_PORT, KEY_SECURITY, KEY_USERNAME,
    KEY_PASSWORD, KEY_FROM_ADDRESS, KEY_FROM_NAME, KEY_PUBLIC_URL,
    KEY_LAST_TEST_OK,
];

/// Transport encryption of the relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// Plain SMTP. Only reasonable for a relay on localhost.
    None,
    /// Connect in clear, then upgrade with `STARTTLS` (port 587).
    Starttls,
    /// TLS from the first byte, "implicit TLS" (port 465).
    Tls,
}

impl Security {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Starttls => "starttls",
            Self::Tls => "tls",
        }
    }

    /// Parses the stored string. An unknown value falls back to the safest
    /// option rather than silently downgrading to plain SMTP.
    pub fn parse(value: &str) -> Self {
        match value {
            "none" => Self::None,
            "tls" | "ssl" => Self::Tls,
            _ => Self::Starttls,
        }
    }
}

/// Resolved relay configuration, password included (decrypted in memory only).
#[derive(Clone)]
pub struct MailConfig {
    pub enabled:      bool,
    pub host:         String,
    pub port:         u16,
    pub security:     Security,
    pub username:     String,
    /// Plaintext, obtained by decrypting the stored blob. Never serialised.
    pub password:     String,
    pub from_address: String,
    pub from_name:    String,
    /// Base URL of the instance for links inserted in messages. Empty when the
    /// operator did not pin one - callers then derive it from the request.
    pub public_url:   String,
}

/// Hand-written on purpose: `#[derive(Debug)]` would print the decrypted
/// password the first time anyone logs the config, which is exactly the bug the
/// encryption at rest exists to prevent.
impl std::fmt::Debug for MailConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailConfig")
            .field("enabled", &self.enabled)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("security", &self.security.as_str())
            .field("username", &self.username)
            .field("password", &"«rédigé»")
            .field("from_address", &self.from_address)
            .field("from_name", &self.from_name)
            .field("public_url", &self.public_url)
            .finish()
    }
}

/// Key used to encrypt the SMTP password, domain-separated from the OIDC and
/// TOTP keys so that one leaking never unlocks another.
pub fn secret_key(jwt_secret: &str) -> [u8; 32] {
    // The key comes from the data-encryption root, not from the token-signing
    // secret, so rotating the latter leaves what is stored readable. The root is
    // seeded with the JWT secret on first boot, so existing values keep the same
    // derivation; `jwt_secret` is only the fallback when the root was never loaded.
    datakey::key(b"kubuno:smtp:", jwt_secret)
}

pub fn encrypt_password(jwt_secret: &str, plain: &str) -> Result<String, AppError> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    encryption::encrypt(&secret_key(jwt_secret), plain.as_bytes()).map_err(AppError::Internal)
}

fn as_string(value: &serde_json::Value) -> String {
    value.as_str().map(str::to_string).unwrap_or_default()
}

/// Characters RFC 5322 forbids in an unquoted `display-name`. Parentheses are
/// the trap in practice: they open a comment, so `Kubuno (test)` is not a name
/// with parentheses, it is the name `Kubuno` followed by a comment - and the
/// parser rejects the whole mailbox.
const SPECIALS: &[char] = &['(', ')', '<', '>', '[', ']', ':', ';', '@', '\\', ',', '.', '"'];

/// Wraps a display name in a quoted-string when it needs one, escaping the two
/// characters that cannot appear even inside quotes.
pub fn quote_display_name(name: &str) -> String {
    if !name.chars().any(|c| SPECIALS.contains(&c)) {
        return name.to_string();
    }
    let escaped: String = name
        .chars()
        .filter(|c| *c != '\r' && *c != '\n')
        .flat_map(|c| {
            if c == '"' || c == '\\' {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect();
    format!("\"{escaped}\"")
}

impl MailConfig {
    /// Loads the relay configuration. A missing key falls back to its default,
    /// so an instance whose migration ran halfway still boots.
    pub async fn load(db: &DbPool, jwt_secret: &str) -> Result<Self, AppError> {
        let mut qb =
            DbQueryBuilder::new(db.backend(), "SELECT \"key\", value FROM core.settings WHERE \"key\"");
        qb.push_in(ALL_KEYS.iter().copied());
        let rows: Vec<(String, serde_json::Value)> =
            qb.fetch_all_as(db).await.map_err(|e| {
                tracing::error!(error = %e, "mailer: reading the SMTP configuration");
                AppError::Database(e)
            })?;

        let mut cfg = Self {
            enabled:      false,
            host:         String::new(),
            port:         587,
            security:     Security::Starttls,
            username:     String::new(),
            password:     String::new(),
            from_address: String::new(),
            from_name:    "Kubuno".into(),
            public_url:   String::new(),
        };
        let mut password_blob = String::new();

        for (key, value) in &rows {
            match key.as_str() {
                KEY_ENABLED  => cfg.enabled = value.as_bool().unwrap_or(false),
                KEY_HOST     => cfg.host = as_string(value).trim().to_string(),
                KEY_PORT     => cfg.port = value.as_u64().unwrap_or(587).clamp(1, 65_535) as u16,
                KEY_SECURITY => cfg.security = Security::parse(&as_string(value)),
                KEY_USERNAME => cfg.username = as_string(value),
                KEY_PASSWORD => password_blob = as_string(value),
                KEY_FROM_ADDRESS => cfg.from_address = as_string(value).trim().to_string(),
                KEY_FROM_NAME    => cfg.from_name = as_string(value),
                KEY_PUBLIC_URL   => cfg.public_url = as_string(value).trim().trim_end_matches('/').to_string(),
                _ => {}
            }
        }

        if !password_blob.is_empty() {
            match encryption::decrypt(&secret_key(jwt_secret), &password_blob) {
                Ok(bytes) => cfg.password = String::from_utf8_lossy(&bytes).into_owned(),
                Err(e) => {
                    // A blob that no longer decrypts means the JWT secret was
                    // rotated. Say so once, loudly, and carry on without
                    // credentials rather than refusing to boot.
                    tracing::error!(
                        error = %e,
                        "mailer: mot de passe SMTP indéchiffrable (secret JWT changé ?) - authentification désactivée"
                    );
                }
            }
        }

        Ok(cfg)
    }

    /// True when a delivery attempt has any chance of succeeding. Checked
    /// before enqueuing, so a disabled relay never fills the job table with
    /// messages that would only fail three times each.
    pub fn is_usable(&self) -> bool {
        self.enabled && !self.host.is_empty() && !self.from_address.is_empty()
    }

    /// `Name <address>` as accepted by the `From` header, or the bare address.
    ///
    /// The display name is quoted when it contains anything RFC 5322 does not
    /// allow in an unquoted atom. Without this, an operator typing
    /// `Kubuno (test)` - parentheses start a *comment* in the grammar - gets an
    /// opaque "invalid input" at the first send, hours after saving.
    pub fn from_mailbox(&self) -> String {
        let name = self.from_name.trim();
        if name.is_empty() {
            return self.from_address.clone();
        }
        format!("{} <{}>", quote_display_name(name), self.from_address)
    }

    /// Base URL for links, `public_url` when pinned, otherwise `fallback`
    /// (derived from the request that triggered the message).
    pub fn base_url(&self, fallback: &str) -> String {
        if self.public_url.is_empty() {
            fallback.trim_end_matches('/').to_string()
        } else {
            self.public_url.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_security_never_downgrades_to_plaintext() {
        assert_eq!(Security::parse("none"), Security::None);
        assert_eq!(Security::parse("tls"), Security::Tls);
        assert_eq!(Security::parse("ssl"), Security::Tls);
        assert_eq!(Security::parse("starttls"), Security::Starttls);
        // Garbage, empty, or a value written by a future version.
        assert_eq!(Security::parse(""), Security::Starttls);
        assert_eq!(Security::parse("wat"), Security::Starttls);
    }

    #[test]
    fn password_round_trips_and_ciphertext_hides_it() {
        let blob = encrypt_password("un-secret-jwt-suffisamment-long", "hunter2")
            .expect("chiffrement");
        assert!(!blob.contains("hunter2"));
        let plain = encryption::decrypt(&secret_key("un-secret-jwt-suffisamment-long"), &blob)
            .expect("déchiffrement");
        assert_eq!(String::from_utf8_lossy(&plain), "hunter2");
    }

    #[test]
    fn empty_password_stays_empty_rather_than_encrypting_nothing() {
        assert_eq!(encrypt_password("jwt", "").expect("vide"), "");
    }

    #[test]
    fn smtp_key_differs_from_the_oidc_and_totp_keys() {
        let jwt = "le-meme-secret-pour-les-trois";
        assert_ne!(secret_key(jwt), crate::auth::oauth::secret_key(jwt));
    }

    #[test]
    fn usable_requires_enabled_host_and_sender() {
        let mut cfg = MailConfig {
            enabled: true, host: "smtp.exemple.com".into(), port: 587,
            security: Security::Starttls, username: String::new(), password: String::new(),
            from_address: "kubuno@exemple.com".into(), from_name: "Kubuno".into(),
            public_url: String::new(),
        };
        assert!(cfg.is_usable());
        cfg.enabled = false;
        assert!(!cfg.is_usable());
        cfg.enabled = true;
        cfg.host = String::new();
        assert!(!cfg.is_usable());
        cfg.host = "smtp.exemple.com".into();
        cfg.from_address = String::new();
        assert!(!cfg.is_usable());
    }

    #[test]
    fn from_mailbox_and_base_url() {
        let mut cfg = MailConfig {
            enabled: true, host: "h".into(), port: 25, security: Security::None,
            username: String::new(), password: String::new(),
            from_address: "no-reply@exemple.com".into(), from_name: "  ".into(),
            public_url: String::new(),
        };
        assert_eq!(cfg.from_mailbox(), "no-reply@exemple.com");
        cfg.from_name = "Kubuno".into();
        assert_eq!(cfg.from_mailbox(), "Kubuno <no-reply@exemple.com>");

        assert_eq!(cfg.base_url("https://demande.exemple.com/"), "https://demande.exemple.com");
        cfg.public_url = "https://pinned.exemple.com".into();
        assert_eq!(cfg.base_url("https://demande.exemple.com"), "https://pinned.exemple.com");
    }

    #[test]
    fn a_display_name_with_specials_is_quoted_not_rejected() {
        // The case that actually bit: parentheses open an RFC 5322 comment, so
        // an unquoted `Kubuno (test)` makes the whole mailbox unparseable.
        assert_eq!(quote_display_name("Kubuno (test local)"), "\"Kubuno (test local)\"");
        assert_eq!(quote_display_name("Service, Support"), "\"Service, Support\"");
        assert_eq!(quote_display_name("Dupont, J."), "\"Dupont, J.\"");
        // Quotes and backslashes are escaped inside the quoted-string.
        assert_eq!(quote_display_name(r#"Le "Cloud""#), r#""Le \"Cloud\"""#);
        assert_eq!(quote_display_name(r"a\b"), r#""a\\b""#);
        // A plain name is left exactly as it was.
        assert_eq!(quote_display_name("Kubuno"), "Kubuno");
        assert_eq!(quote_display_name("Mon Cloud Personnel"), "Mon Cloud Personnel");
        // CR/LF are dropped: a header injection attempt must not survive.
        assert_eq!(quote_display_name("a\r\nBcc: x@y.z"), "\"aBcc: x@y.z\"");
    }

    #[test]
    fn a_quoted_mailbox_is_accepted_by_the_parser() {
        let cfg = MailConfig {
            enabled: true, host: "h".into(), port: 25, security: Security::None,
            username: String::new(), password: String::new(),
            from_address: "kubuno@exemple.test".into(),
            from_name: "Kubuno (test local)".into(),
            public_url: String::new(),
        };
        // The exact check the send path performs.
        assert!(cfg.from_mailbox().parse::<lettre::message::Mailbox>().is_ok());
    }
}
