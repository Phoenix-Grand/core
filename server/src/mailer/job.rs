//! `core.send_email` - outgoing mail as a background job.
//!
//! Delivery never happens on the request path. An SMTP relay that is slow,
//! greylisting, or simply down would otherwise turn "I forgot my password" into
//! a thirty-second spinner, and a transient failure into a lost message. The
//! job runner shipped with `crate::jobs` already has the retry-with-backoff and
//! crash-recovery semantics this needs, so this module only contributes the
//! handler and the enqueue helpers.
//!
//! ## The payload holds the message body
//!
//! Rendering happens at enqueue time (the request knows the recipient's locale,
//! the instance name and the origin the link must point at; the worker does
//! not). That puts the reset link - a bearer secret - in `core.jobs.payload`
//! until delivery. Two mitigations: the row is scrubbed the moment the message
//! is accepted by the relay ([`scrub_payload`]), and the tokens themselves are
//! short-lived and single-use. A job that ends up `failed` keeps its payload, on
//! purpose: retrying a delivery is the whole point, and a link that has expired
//! by then is inert anyway.

use kubuno_db::{params, DbPool};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::jobs::{queue, JobRegistry, NewJob};

use super::{
    config::MailConfig,
    send::{self, Outgoing},
};

pub const SEND_EMAIL: &str = "core.send_email";

/// A relay hiccup is normal; five attempts with the runner's exponential
/// backoff spans roughly ten minutes, which covers a restart or a greylist.
const MAX_ATTEMPTS: i32 = 5;

/// Serialised form of a queued message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailPayload {
    pub to:      String,
    #[serde(default)]
    pub to_name: Option<String>,
    pub subject: String,
    pub html:    String,
    pub text:    String,
    /// Free-form tag for the operator reading the job list ("password_reset",
    /// "invite"…). Never a secret.
    #[serde(default)]
    pub kind:    Option<String>,
}

impl From<&EmailPayload> for Outgoing {
    fn from(p: &EmailPayload) -> Self {
        Self {
            to:      p.to.clone(),
            to_name: p.to_name.clone(),
            subject: p.subject.clone(),
            html:    p.html.clone(),
            text:    p.text.clone(),
        }
    }
}

/// Queues a message. Returns the job id, or `None` when the relay is not
/// configured - in which case nothing is queued and a warning is logged.
///
/// Callers on public routes must treat both outcomes identically: whether a
/// message was queued is exactly the kind of observable difference that turns
/// "forgot password" into an account-enumeration oracle.
pub async fn enqueue(
    db: &DbPool,
    cfg: &MailConfig,
    payload: EmailPayload,
) -> Option<Uuid> {
    if !cfg.is_usable() {
        tracing::warn!(
            kind = payload.kind.as_deref().unwrap_or("-"),
            "mailer: relais SMTP non configuré - message non envoyé"
        );
        return None;
    }

    let value = match serde_json::to_value(&payload) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, "mailer: sérialisation du message impossible");
            return None;
        }
    };

    let job = NewJob::new(SEND_EMAIL)
        .module("core")
        .payload(value)
        .max_attempts(MAX_ATTEMPTS);

    match queue::enqueue(db, job).await {
        Ok(id) => {
            tracing::info!(
                job_id = %id,
                kind = payload.kind.as_deref().unwrap_or("-"),
                "mailer: courriel mis en file"
            );
            Some(id)
        }
        // `enqueue` already logged the database error.
        Err(_) => None,
    }
}

/// Replaces a delivered job's payload with its metadata only.
///
/// Called after the relay accepted the message: the body (and the one-time link
/// it may carry) has no reason to survive in the queue table, which an operator
/// can read and which backups keep for months.
async fn scrub_payload(db: &DbPool, job_id: Uuid, payload: &EmailPayload) {
    let meta = serde_json::json!({
        "to":      payload.to,
        "subject": payload.subject,
        "kind":    payload.kind,
        "scrubbed": true,
    });
    if let Err(e) = db
        .execute(
            "UPDATE core.jobs SET payload = $2 WHERE id = $1",
            params![job_id, meta],
        )
        .await
    {
        tracing::error!(error = %e, job_id = %job_id, "mailer: scrubbing the message body failed");
    }
}

/// Registers the `core.send_email` handler.
///
/// `jwt_secret` is captured (not read from a global) because the handler must
/// decrypt the stored SMTP password, and [`crate::jobs::JobContext`] carries
/// only the pool by design.
pub fn register(registry: &mut JobRegistry, jwt_secret: &str) {
    let jwt_secret = jwt_secret.to_string();

    registry.register_fn(SEND_EMAIL, move |ctx, job| {
        let jwt_secret = jwt_secret.clone();
        async move {
            let payload: EmailPayload = serde_json::from_value(job.payload.clone())
                .map_err(|e| anyhow::anyhow!("Charge utile de courriel invalide : {e}"))?;

            // Read the configuration at delivery time, not at enqueue time: an
            // operator fixing a wrong port must see the queued messages go out
            // on the next retry rather than have to re-trigger them.
            let cfg = MailConfig::load(&ctx.db, &jwt_secret).await?;
            if !cfg.is_usable() {
                anyhow::bail!("Relais SMTP non configuré - envoi impossible");
            }

            send::deliver(&cfg, &Outgoing::from(&payload))
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;

            scrub_payload(&ctx.db, job.id, &payload).await;
            Ok(())
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_round_trips_and_tolerates_missing_optionals() {
        let json = serde_json::json!({
            "to": "a@b.test", "subject": "S", "html": "<p>h</p>", "text": "h",
        });
        let payload: EmailPayload = serde_json::from_value(json).expect("désérialisation");
        assert_eq!(payload.to, "a@b.test");
        assert!(payload.to_name.is_none());
        assert!(payload.kind.is_none());

        let out = Outgoing::from(&payload);
        assert_eq!(out.subject, "S");
        assert_eq!(out.text, "h");
    }
}
