//! Outgoing mail relay.
//!
//! ## Why this exists
//!
//! The core had no SMTP client at all. `POST /auth/forgot-password` dutifully
//! minted a token in `core.verification_tokens` and then dropped it: nothing in
//! the process could deliver it, so "forgot my password" was decorative and an
//! administrator had no way out either. This module is the missing half.
//!
//! ## Shape
//!
//! ```text
//!   core.settings ──► config::MailConfig ──► send::deliver  (lettre, rustls)
//!         ▲                   ▲
//!         │                   │
//!   /admin/mail/settings   job::register ──► core.send_email  (crate::jobs)
//!                                  ▲
//!            templates::render ────┘   13 locales, HTML + text
//! ```
//!
//! * **Configuration** lives in `core.settings` (`mail.*`), the password
//!   AES-256-GCM-encrypted and never returned by the API. The generic settings
//!   route refuses the whole category so there is exactly one writer.
//! * **Delivery** is a background job (`core.send_email`), retried with the
//!   runner's exponential backoff. Only the relay *test* is synchronous, because
//!   its entire purpose is to hand the operator the raw SMTP answer.
//! * **Rendering** is a fixed table of translated sentences, not a template
//!   engine - see [`templates`].
//!
//! ## What never happens here
//!
//! No `execve`. `kubuno-seccomp` forbids it in the core process, so `sendmail`
//! and friends are not an option; `lettre` speaks SMTP itself, over rustls (the
//! rest of the core's TLS is rustls too).

pub mod config;
pub mod job;
pub mod send;
pub mod templates;

pub use config::{MailConfig, Security};
pub use job::{register as register_jobs, EmailPayload, SEND_EMAIL};
pub use send::{Outgoing, SendError};
pub use templates::{render, Stamp, Template};

use chrono_tz::Tz;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

use crate::errors::AppError;
use crate::settings::intl;

/// Instance name shown in messages: `instance.name` from the settings, falling
/// back to the product name rather than to an empty subject line.
pub async fn instance_name(db: &DbPool) -> String {
    let value: Option<serde_json::Value> = db
        .fetch_optional_scalar::<serde_json::Value>(
            "SELECT value FROM core.settings WHERE \"key\" = 'instance.name'",
            params![],
        )
        .await
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "mailer: reading instance.name");
            None
        });

    value
        .as_ref()
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Kubuno")
        .to_string()
}

/// Base URL of the instance as seen from outside, used to build links.
///
/// `mail.public_url` wins when the operator pinned one - behind a reverse proxy
/// that rewrites nothing, the request headers are not trustworthy enough to
/// build a link a user will click. Otherwise the request's own origin is used,
/// with the same header precedence as the OIDC redirect builder.
pub fn origin_from_headers(headers: &axum::http::HeaderMap) -> String {
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(if host.contains("localhost") || host.starts_with("127.0.0.1") {
            "http"
        } else {
            "https"
        });
    format!("{scheme}://{host}")
}

/// Base URL of a link that carries a secret (a password-reset token), or `None` when
/// none can be trusted.
///
/// Only configuration is trusted: `mail.public_url` when the operator set one, else the
/// request's origin **only if** it is one of the configured `server.cors_origins`. The
/// `Host` / `X-Forwarded-Host` headers are chosen by whoever sends the request, so an
/// origin built from them alone would let an anonymous caller have the instance mail a
/// victim a valid reset token pointing at the caller's own host.
pub fn trusted_link_base(
    cfg: &MailConfig,
    headers: &axum::http::HeaderMap,
    configured_origins: &[String],
) -> Option<String> {
    if !cfg.public_url.trim().is_empty() {
        return Some(cfg.public_url.trim().trim_end_matches('/').to_string());
    }
    let origin = origin_from_headers(headers);
    let normalise = |s: &str| s.trim().trim_end_matches('/').to_ascii_lowercase();
    let wanted = normalise(&origin);
    configured_origins
        .iter()
        .find(|o| !o.trim().is_empty() && normalise(o) == wanted)
        .map(|o| o.trim().trim_end_matches('/').to_string())
}

/// How long a password-reset link stays usable. Mirrors the window
/// `handlers::auth::password_reset` writes into `core.verification_tokens`.
pub const RESET_TOKEN_HOURS: i64 = 2;

/// How long an invitation link stays usable.
pub const INVITE_TOKEN_HOURS: i64 = 48;

/// Everything a message needs to know about its recipient.
pub struct Recipient {
    pub email:  String,
    /// Display name, or the username. May be empty.
    pub name:   String,
    /// Normalised locale (see [`templates::normalise_locale`]).
    pub locale: &'static str,
    /// Zone the message is dated in.
    pub timezone: Tz,
}

/// The language and the zone a message must be written in, for one recipient.
///
/// Resolved in the order that matters: an account that *chose* a language keeps
/// it, and an account that never did is written to in the language its
/// organisational unit - failing that, the instance - declares. The time zone
/// has no per-account equivalent in the core, so it comes straight from the
/// chain.
///
/// Note that both answers come from [`crate::settings::intl`], so a value set on
/// an organisational unit reaches its members without anybody touching an
/// account.
#[derive(Debug, Clone, Copy)]
pub struct Audience {
    pub locale:   &'static str,
    pub timezone: Tz,
}

impl Audience {
    /// A [`Stamp`] for a message being produced now.
    pub fn stamp(&self) -> Stamp {
        Stamp::now(self.timezone)
    }
}

/// Resolves the audience of a message.
///
/// `user_id` is the recipient's account when there is one. `preferences` is that
/// account's `preferences` document - pass `&Value::Null` when writing to an
/// address that belongs to no account.
pub async fn audience(
    db: &DbPool,
    user_id: Option<Uuid>,
    preferences: &serde_json::Value,
) -> Audience {
    let locale = match templates::preferred_locale(preferences) {
        Some(chosen) => chosen,
        None => intl::locale_for(db, user_id).await,
    };
    Audience { locale, timezone: intl::timezone_for(db, user_id).await }
}

/// Renders and queues a password-reset message. Returns whether it was queued;
/// **callers on public routes must ignore that answer** (see [`job::enqueue`]).
pub async fn queue_password_reset(
    db: &DbPool,
    cfg: &MailConfig,
    instance: &str,
    to: &Recipient,
    link: &str,
) -> bool {
    let rendered = templates::render(
        to.locale,
        instance,
        &to.name,
        &Template::PasswordReset { link, hours: RESET_TOKEN_HOURS },
        Stamp::now(to.timezone),
    );
    job::enqueue(
        db,
        cfg,
        EmailPayload {
            to:      to.email.clone(),
            to_name: Some(to.name.clone()).filter(|n| !n.is_empty()),
            subject: rendered.subject,
            html:    rendered.html,
            text:    rendered.text,
            kind:    Some("password_reset".into()),
        },
    )
    .await
    .is_some()
}

/// Renders and queues an invitation message.
pub async fn queue_invite(
    db: &DbPool,
    cfg: &MailConfig,
    instance: &str,
    to: &Recipient,
    inviter: &str,
    link: &str,
) -> bool {
    let rendered = templates::render(
        to.locale,
        instance,
        &to.name,
        &Template::Invite { link, inviter, hours: INVITE_TOKEN_HOURS },
        Stamp::now(to.timezone),
    );
    job::enqueue(
        db,
        cfg,
        EmailPayload {
            to:      to.email.clone(),
            to_name: Some(to.name.clone()).filter(|n| !n.is_empty()),
            subject: rendered.subject,
            html:    rendered.html,
            text:    rendered.text,
            kind:    Some("invite".into()),
        },
    )
    .await
    .is_some()
}

/// Renders and queues the "an administrator reset your password" notice.
///
/// The new password travels in the body because that is what the operator asked
/// for by ticking the box; the message says so plainly and tells the recipient
/// to change it. The password is *never* written to a log or to the audit trail
/// on this path - only the fact that a notice was queued.
pub async fn queue_admin_password_reset(
    db: &DbPool,
    cfg: &MailConfig,
    instance: &str,
    to: &Recipient,
    password: &str,
    must_change: bool,
    login_link: &str,
) -> bool {
    let rendered = templates::render(
        to.locale,
        instance,
        &to.name,
        &Template::AdminPasswordReset { password, must_change, link: login_link },
        Stamp::now(to.timezone),
    );
    job::enqueue(
        db,
        cfg,
        EmailPayload {
            to:      to.email.clone(),
            to_name: Some(to.name.clone()).filter(|n| !n.is_empty()),
            subject: rendered.subject,
            html:    rendered.html,
            text:    rendered.text,
            kind:    Some("admin_password_reset".into()),
        },
    )
    .await
    .is_some()
}

/// Loads the relay configuration for a handler.
pub async fn load_config(db: &DbPool, jwt_secret: &str) -> Result<MailConfig, AppError> {
    MailConfig::load(db, jwt_secret).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            if let (Ok(name), Ok(value)) = (
                axum::http::HeaderName::from_bytes(k.as_bytes()),
                axum::http::HeaderValue::from_str(v),
            ) {
                h.insert(name, value);
            }
        }
        h
    }

    #[test]
    fn origin_prefers_the_forwarded_headers() {
        assert_eq!(
            origin_from_headers(&headers(&[
                ("host", "127.0.0.1:8080"),
                ("x-forwarded-host", "dev.exemple.com"),
                ("x-forwarded-proto", "https"),
            ])),
            "https://dev.exemple.com"
        );
    }

    #[test]
    fn a_local_host_is_not_assumed_to_be_https() {
        assert_eq!(origin_from_headers(&headers(&[("host", "localhost:8080")])), "http://localhost:8080");
        assert_eq!(origin_from_headers(&headers(&[("host", "127.0.0.1:8080")])), "http://127.0.0.1:8080");
        assert_eq!(origin_from_headers(&headers(&[("host", "cloud.exemple.com")])), "https://cloud.exemple.com");
    }

    fn mail_config(public_url: &str) -> MailConfig {
        MailConfig {
            enabled: true,
            host: "smtp.exemple.com".into(),
            port: 587,
            security: Security::Starttls,
            username: String::new(),
            password: String::new(),
            from_address: "noreply@exemple.com".into(),
            from_name: "Kubuno".into(),
            public_url: public_url.into(),
        }
    }

    #[test]
    fn a_secret_link_never_follows_the_request_host() {
        let forged = headers(&[("host", "evil.example"), ("x-forwarded-host", "evil.example")]);
        // The pinned public URL wins whatever the request says.
        assert_eq!(
            trusted_link_base(&mail_config("https://cloud.exemple.com/"), &forged, &[]).as_deref(),
            Some("https://cloud.exemple.com")
        );
        // No public URL: a host that is not configured gives no link at all.
        assert_eq!(trusted_link_base(&mail_config(""), &forged, &[]), None);
        assert_eq!(
            trusted_link_base(&mail_config(""), &forged, &["https://cloud.exemple.com".into()]),
            None
        );
        // ... and a configured origin is accepted (compared without case or trailing slash).
        let genuine = headers(&[("host", "Cloud.Exemple.com"), ("x-forwarded-proto", "https")]);
        assert_eq!(
            trusted_link_base(&mail_config(""), &genuine, &["https://cloud.exemple.com/".into()]).as_deref(),
            Some("https://cloud.exemple.com")
        );
    }

    #[test]
    fn a_request_with_no_host_still_yields_a_url() {
        assert_eq!(origin_from_headers(&HeaderMap::new()), "http://localhost");
    }
}
