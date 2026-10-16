//! The SMTP client itself.
//!
//! Pure Rust on purpose: `kubuno-seccomp` forbids `execve` in the core process,
//! so shelling out to `sendmail`/`msmtp` is not an option - it would be killed
//! by the filter, and re-introducing a spawn is forbidden by the project rules
//! anyway. `lettre` is the crate the mail module already uses, with the same
//! `AsyncSmtpTransport<Tokio1Executor>` shape; the only deliberate divergence is
//! the TLS backend: the core is rustls end to end (axum-server, sqlx), so the
//! relay is too, instead of pulling native-tls/OpenSSL in for one feature.

use std::sync::Once;

use lettre::{
    message::{header::ContentType, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};

use super::config::{MailConfig, Security};

/// Longest raw SMTP error kept. The whole point of surfacing the server's own
/// words is diagnosability ("535 5.7.8 Username and Password not accepted"), but
/// a hostile or broken relay must not be able to write a novel into the trail,
/// the job row or the admin screen.
pub const MAX_ERROR_LEN: usize = 600;

/// A message ready to hand to the relay.
#[derive(Debug, Clone)]
pub struct Outgoing {
    pub to:      String,
    pub to_name: Option<String>,
    pub subject: String,
    pub html:    String,
    /// Plain-text alternative. Always sent: a transactional message that only
    /// renders in an HTML client is a message some recipients never read.
    pub text:    String,
}

/// Why a delivery failed, in the two forms the caller needs: a short reason for
/// the operator, and the relay's raw answer for the person debugging it.
#[derive(Debug, Clone)]
pub struct SendError {
    /// Stage that failed, in French, shown as the headline.
    pub stage: &'static str,
    /// The transport's own message, truncated. Never contains the password:
    /// `lettre` reports the SASL exchange as a status code and text, not as the
    /// credentials it sent.
    pub raw:   String,
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} : {}", self.stage, self.raw)
    }
}

impl std::error::Error for SendError {}

/// Truncates on a character boundary - the error text is arbitrary bytes from a
/// remote server and slicing it blindly would panic on a multi-byte sequence.
pub fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}…")
}

/// rustls 0.23 requires a process-wide crypto provider. The HTTPS listener
/// installs one, but only when native TLS is configured - a relay must work on
/// a plain-HTTP instance too, so the first outgoing message installs it itself.
/// `install_default` is fallible by design (it refuses to replace an existing
/// provider); ignoring that is correct here, since any provider will do.
fn ensure_crypto_provider() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Builds the transport for `cfg`. Split out so the connection test and the
/// real send exercise exactly the same code path.
pub fn build_transport(cfg: &MailConfig) -> Result<AsyncSmtpTransport<Tokio1Executor>, SendError> {
    let mut builder = match cfg.security {
        // `builder_dangerous` is lettre's name for "no TLS at all". It is the
        // only way to talk to a relay on 127.0.0.1 (or a capture server), and
        // it is reachable only when the operator explicitly picked "aucun".
        Security::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host),
        Security::Starttls => {
            ensure_crypto_provider();
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host).map_err(|e| SendError {
                stage: "Ouverture du transport SMTP (STARTTLS)",
                raw:   truncate(&e.to_string(), MAX_ERROR_LEN),
            })?
        }
        Security::Tls => {
            ensure_crypto_provider();
            AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host).map_err(|e| SendError {
                stage: "Ouverture du transport SMTP (TLS)",
                raw:   truncate(&e.to_string(), MAX_ERROR_LEN),
            })?
        }
    };

    builder = builder.port(cfg.port).timeout(Some(std::time::Duration::from_secs(30)));

    // An empty username means an open relay (typically on localhost): sending
    // `AUTH` anyway makes such a server answer 502 and the delivery fail for a
    // reason that has nothing to do with the message.
    if !cfg.username.is_empty() {
        builder = builder.credentials(Credentials::new(
            cfg.username.clone(),
            cfg.password.clone(),
        ));
    }

    Ok(builder.build())
}

/// `Auto-Submitted: auto-generated` (RFC 3834). lettre only accepts typed
/// headers, hence the one-value type.
#[derive(Debug, Clone, Copy)]
struct AutoSubmitted;

impl lettre::message::header::Header for AutoSubmitted {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("Auto-Submitted")
    }

    fn parse(_s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self)
    }

    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), "auto-generated".into())
    }
}

/// Assembles the MIME message. `multipart/alternative`, text first - the order
/// mail clients read as "prefer the last part they understand".
fn build_message(cfg: &MailConfig, msg: &Outgoing) -> Result<Message, SendError> {
    let from = cfg.from_mailbox().parse().map_err(|e: lettre::address::AddressError| SendError {
        stage: "Adresse d'expédition invalide",
        raw:   truncate(&e.to_string(), MAX_ERROR_LEN),
    })?;

    // Same quoting discipline as the sender: a display name is user data
    // (`display_name` on the account), and `Dupont, J.` would otherwise parse
    // as two mailboxes.
    let recipient = match msg.to_name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => {
            format!("{} <{}>", super::config::quote_display_name(name), msg.to)
        }
        _ => msg.to.clone(),
    };
    let to = recipient.parse().map_err(|e: lettre::address::AddressError| SendError {
        stage: "Adresse destinataire invalide",
        raw:   truncate(&e.to_string(), MAX_ERROR_LEN),
    })?;

    Message::builder()
        .from(from)
        .to(to)
        .subject(&msg.subject)
        // RFC 3834: marks the message as machine-generated, so out-of-office
        // responders and mailing lists do not answer a password-reset mail.
        .header(AutoSubmitted)
        .multipart(
            MultiPart::alternative()
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_PLAIN)
                        .body(msg.text.clone()),
                )
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_HTML)
                        .body(msg.html.clone()),
                ),
        )
        .map_err(|e| SendError {
            stage: "Construction du message",
            raw:   truncate(&e.to_string(), MAX_ERROR_LEN),
        })
}

/// Connects to the relay and delivers `msg`.
///
/// Never logs the recipient's message body, the reset link it may contain, or
/// the SMTP password - only the address and the outcome.
pub async fn deliver(cfg: &MailConfig, msg: &Outgoing) -> Result<(), SendError> {
    let email = build_message(cfg, msg)?;
    let transport = build_transport(cfg)?;

    transport.send(email).await.map_err(|e| {
        let err = SendError {
            stage: "Envoi SMTP",
            raw:   truncate(&e.to_string(), MAX_ERROR_LEN),
        };
        tracing::error!(
            host = %cfg.host, port = cfg.port, security = cfg.security.as_str(),
            error = %err.raw,
            "mailer: envoi SMTP échoué"
        );
        err
    })?;

    tracing::info!(to = %msg.to, subject = %msg.subject, "mailer: courriel remis au relais");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> MailConfig {
        MailConfig {
            enabled: true, host: "127.0.0.1".into(), port: 2525,
            security: Security::None, username: String::new(), password: String::new(),
            from_address: "kubuno@exemple.test".into(), from_name: "Kubuno".into(),
            public_url: String::new(),
        }
    }

    #[test]
    fn truncate_never_splits_a_multibyte_character() {
        let long = "é".repeat(1_000);
        let out = truncate(&long, 10);
        assert_eq!(out.chars().count(), 11); // 10 + the ellipsis
        assert!(out.ends_with('…'));
        assert_eq!(truncate("  court  ", 100), "court");
    }

    #[test]
    fn message_is_built_with_both_alternatives() {
        let msg = Outgoing {
            to: "dest@exemple.test".into(),
            to_name: Some("Alice".into()),
            subject: "Sujet".into(),
            html: "<p>Bonjour</p>".into(),
            text: "Bonjour".into(),
        };
        let built = build_message(&cfg(), &msg).expect("construction");
        let rendered = String::from_utf8_lossy(&built.formatted()).to_string();
        assert!(rendered.contains("multipart/alternative"));
        assert!(rendered.contains("text/plain"));
        assert!(rendered.contains("text/html"));
        assert!(rendered.contains("Kubuno <kubuno@exemple.test>"));
        assert!(rendered.contains("Alice <dest@exemple.test>"));
    }

    #[test]
    fn a_recipient_name_with_a_comma_does_not_split_into_two_mailboxes() {
        let msg = Outgoing {
            to: "dest@exemple.test".into(),
            to_name: Some("Dupont, Jean".into()),
            subject: "Sujet".into(), html: "<p>h</p>".into(), text: "h".into(),
        };
        let built = build_message(&cfg(), &msg).expect("construction");
        assert_eq!(built.envelope().to().len(), 1);
        let rendered = String::from_utf8_lossy(&built.formatted()).to_string();
        assert!(rendered.contains("dest@exemple.test"));
    }

    #[test]
    fn an_invalid_recipient_is_reported_not_panicked_on() {
        let msg = Outgoing {
            to: "pas une adresse".into(), to_name: None,
            subject: "s".into(), html: "h".into(), text: "t".into(),
        };
        let err = build_message(&cfg(), &msg).expect_err("adresse invalide");
        assert_eq!(err.stage, "Adresse destinataire invalide");
    }

    #[test]
    fn plain_transport_builds_without_a_crypto_provider() {
        // The "aucun" path must not depend on rustls being initialised.
        assert!(build_transport(&cfg()).is_ok());
    }
}
