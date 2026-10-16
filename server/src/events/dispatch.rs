//! Delivery of events **to the modules that subscribed to them**.
//!
//! ## The defect this closes
//!
//! Every module declares `[events] subscribed = [...]` in its manifest, the
//! registration route stores the list in `core.module_instances.subscribed_events`,
//! and the administration console displays it. Nothing ever read it back to send
//! anything: [`crate::handlers::modules::publish_event`] fed the in-process
//! [`EventBus`] and `core.event_log`, and the bus had exactly three consumers -
//! the WebSocket hub, the push worker and the rules engine. None of them is a
//! module.
//!
//! The consequence was not a missing feature but silent data retention: modules
//! carry handlers for `UserDeleted` that purge the data of a deleted account,
//! and those handlers had never once run. The subscription was a declaration
//! nobody honoured.
//!
//! ## Shape
//!
//! ```text
//!   EventBus ──► fanout_worker ──► one core.jobs row per subscribed module
//!                                     └─► core.events.deliver ──► POST {base_url}/ipc/events
//! ```
//!
//! The queue is in the middle on purpose. A direct POST from the bus consumer
//! would lose every event a module was not running to receive - which is
//! precisely the case that matters, since "the account was deleted while the
//! module was restarting" must still erase the data. `core.jobs` already gives
//! retry with backoff, crash recovery and a visible failure, and nothing here
//! reinvents any of it.
//!
//! ## Which events, to which modules
//!
//! * The type is [`bus::event_type_name`] - the inner type for
//!   [`AppEvent::Custom`], the variant name otherwise. That is the name the
//!   manifests spell.
//! * A module never receives its own event. Without that rule a module that
//!   re-emits on receipt has an infinite loop, and the depth counter of the
//!   rules engine does not protect this path.
//! * Facts flagged [`EventMeta::internal`] are not delivered: they exist so the
//!   *core* can react to them (the audit bridge feeding the rules engine), and
//!   the bus already treats them as never leaving the process. A module that
//!   needs to act on one does so through a rule action, which is auditable.
//! * Only instances that are registered and not `stopped`, and whose module is
//!   enabled. A disabled module is one an administrator switched off; sending it
//!   work would make the switch a lie.
//!
//! ## The endpoint
//!
//! `POST {base_url}/ipc/events`, the convention the modules that implement a
//! receiver already use, under the same `/ipc/` prefix as every other
//! core→module call. `POST {base_url}/events` is tried once as a fallback,
//! because one module shipped its receiver there before the prefix settled; the
//! fallback is logged, so the drift is visible rather than permanent.
//!
//! A `404` on both is treated as **final, not retryable**: the module declared a
//! subscription it has no receiver for. Retrying would burn five attempts per
//! event to reach a route that does not exist. The warning names the module and
//! the event type, which is the only way that declaration gap ever gets noticed.

use std::sync::Arc;
use std::time::Duration;

use kubuno_db::{params, DbPool};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;

use super::bus::{self, EventBus, EventMeta};
use super::AppEvent;
use crate::config::settings::ServerSettings;
use crate::jobs::queue::{self, NewJob};
use crate::jobs::registry::JobRegistry;

/// `job_type` of one delivery to one module.
pub const DELIVER: &str = "core.events.deliver";

/// One module, one event, five tries. Beyond that the job is `failed` and
/// visible in the administration console rather than retried forever.
const MAX_ATTEMPTS: i32 = 5;

/// A module that takes longer than this to acknowledge an event is a module in
/// trouble; the retry is cheaper than holding a runner slot.
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

/// The convention. See the module preamble.
const PRIMARY_PATH: &str = "/ipc/events";
/// Tried once when the primary answers 404.
const FALLBACK_PATH: &str = "/events";

/// What one delivery job carries.
///
/// The event travels in the payload rather than being re-read from
/// `core.event_log`: not every event is logged, and an event is immutable, so
/// there is nothing to re-read that could be fresher. `base_url` deliberately
/// does **not** travel - it is resolved at delivery time, so a module that
/// restarted on another port between the enqueue and the retry is still reached.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeliveryPayload {
    pub module_id:  String,
    /// The name the manifest spells, carried alongside so the receiver does not
    /// have to re-derive it from the enum shape.
    pub event_type: String,
    pub event:      AppEvent,
    #[serde(default)]
    pub meta:       EventMeta,
}

// ── Fan-out: bus → queue ────────────────────────────────────────────────────

/// Consumes the bus and enqueues one delivery per subscribed module.
///
/// Started next to the WebSocket and push workers (`main.rs`). Never returns
/// while the bus is alive; a lagging receiver is logged and resumes rather than
/// aborting, exactly as the push worker does - a worker that gave up on the
/// first burst would be worse than one that missed a few events.
pub async fn fanout_worker(bus: Arc<EventBus>, db: DbPool) {
    let mut rx = bus.subscribe();
    loop {
        match rx.recv().await {
            Ok(envelope) => {
                if envelope.meta.internal {
                    continue;
                }
                let event_type = bus::event_type_name(&envelope.event);
                let subscribers =
                    match subscribers_of(&db, &event_type, envelope.meta.source_module.as_deref())
                        .await
                    {
                        Ok(list) => list,
                        // Already logged. Dropping this event is the correct
                        // failure: the alternative is a hot loop against a
                        // database that is down.
                        Err(()) => continue,
                    };

                for module_id in subscribers {
                    let payload = DeliveryPayload {
                        module_id:  module_id.clone(),
                        event_type: event_type.clone(),
                        event:      envelope.event.clone(),
                        meta:       envelope.meta.clone(),
                    };
                    let body = match serde_json::to_value(&payload) {
                        Ok(v) => v,
                        Err(e) => {
                            tracing::error!(
                                error = %e, module_id = %module_id, event_type = %event_type,
                                "events: sérialisation de la livraison impossible"
                            );
                            continue;
                        }
                    };
                    // The enqueue failure is logged by `queue::enqueue`; one
                    // module failing must not stop the fan-out to the others.
                    let _ = queue::enqueue(
                        &db,
                        NewJob::new(DELIVER)
                            .module(module_id)
                            .payload(body)
                            .max_attempts(MAX_ATTEMPTS),
                    )
                    .await;
                }
            }
            Err(RecvError::Lagged(n)) => {
                tracing::warn!("events: livraison aux modules en retard de {n} événement(s)");
            }
            Err(RecvError::Closed) => break,
        }
    }
}

/// Modules that asked for this event type and may currently receive it.
///
/// `DISTINCT` because a module may have several registered instances; the
/// delivery targets the module, and the handler picks the most recent instance.
async fn subscribers_of(
    db: &DbPool,
    event_type: &str,
    source_module: Option<&str>,
) -> Result<Vec<String>, ()> {
    // `subscribed_events` is a stored list column: the membership test is a
    // JSON-array containment so it works on every engine. `source_module` is
    // bound twice (a placeholder is never reused).
    let contains = db.backend().json_array_contains("mi.subscribed_events", 1);
    let sql = format!(
        "SELECT DISTINCT mi.module_id \
           FROM core.module_instances mi \
           JOIN core.modules m ON m.id = mi.module_id \
          WHERE {contains} \
            AND mi.status <> 'stopped' \
            AND m.is_enabled \
            AND ($2 IS NULL OR mi.module_id <> $3)"
    );
    db.fetch_all_as::<(String,)>(&sql, params![event_type, source_module, source_module])
        .await
        .map(|rows| rows.into_iter().map(|(module_id,)| module_id).collect())
        .map_err(|e| {
            tracing::error!(
                error = %e, event_type = %event_type,
                "events: reading subscribed modules failed"
            );
        })
}

// ── Delivery: queue → module ────────────────────────────────────────────────

/// Registers the `core.events.deliver` handler.
///
/// `server` is captured because the call must carry the internal secret **of
/// the target module** ([`ServerSettings::module_secret`]), which is derived per
/// module when `derive_module_secrets` is on, and [`crate::jobs::JobContext`]
/// carries only the pool by design.
pub fn register(registry: &mut JobRegistry, server: Arc<ServerSettings>) {
    registry.register_fn(DELIVER, move |ctx, job| {
        let server = Arc::clone(&server);
        async move {
            let payload: DeliveryPayload = serde_json::from_value(job.payload.clone())
                .map_err(|e| anyhow::anyhow!("Charge utile de livraison invalide : {e}"))?;

            let base_url: Option<String> = ctx
                .db
                .fetch_optional_scalar::<String>(
                    "SELECT base_url FROM core.module_instances \
                  WHERE module_id = $1 AND status <> 'stopped' \
                  ORDER BY registered_at DESC LIMIT 1",
                    params![&payload.module_id],
                )
                .await
                .map_err(|e| {
                    tracing::error!(
                        error = %e, module_id = %payload.module_id,
                        "events: resolving the module address"
                    );
                    e
                })?;

            // Retryable: the module is restarting, and the backoff is exactly
            // the mechanism that lets it come back and still receive the event.
            let Some(base_url) = base_url else {
                anyhow::bail!(
                    "Module « {} » sans instance active - livraison différée",
                    payload.module_id
                );
            };

            let client = reqwest::Client::builder()
                .timeout(DELIVERY_TIMEOUT)
                .build()
                .map_err(|e| anyhow::anyhow!("Client HTTP indisponible : {e}"))?;

            let secret = server.module_secret(&payload.module_id);
            let base = base_url.trim_end_matches('/');

            // The body is the event and nothing else. `AppEvent` serialises as
            // `{ "type": …, "payload": { … } }` (`#[serde(tag, content)]`), and
            // that is exactly the shape the receivers already parse - they
            // deserialise the whole body into their own mirror enum, declared
            // with the same attributes. Wrapping it in an envelope would break
            // every module that implements the contract today.
            //
            // What does not fit in the event travels in headers, where an old
            // receiver ignores it instead of failing to parse.
            let body = &payload.event;

            let mut last_status = None;
            for (index, path) in [PRIMARY_PATH, FALLBACK_PATH].into_iter().enumerate() {
                let response = client
                    .post(format!("{base}{path}"))
                    .header("X-Internal-Secret", secret.as_str())
                    // The type as the manifest spells it, so a receiver can
                    // route without re-deriving it, and the emitter, so a module
                    // can tell an event it caused from one it merely observes.
                    .header("X-Kubuno-Event-Type", payload.event_type.as_str())
                    .header(
                        "X-Kubuno-Event-Source",
                        payload.meta.source_module.as_deref().unwrap_or("core"),
                    )
                    .json(body)
                    .send()
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!(
                            "Module « {} » injoignable : {e}",
                            payload.module_id
                        )
                    })?;

                let status = response.status();
                if status.is_success() {
                    if index > 0 {
                        tracing::warn!(
                            module_id = %payload.module_id,
                            "events: récepteur trouvé sur « {FALLBACK_PATH} » - la convention est « {PRIMARY_PATH} »"
                        );
                    }
                    return Ok(());
                }
                last_status = Some(status);
                // Anything other than "this route does not exist" is the
                // module's answer about the event itself: retry it rather than
                // knocking on a second door.
                if status != reqwest::StatusCode::NOT_FOUND {
                    break;
                }
            }

            match last_status {
                // Declared a subscription, exposes no receiver. Final: five
                // retries would not create the route, and the warning is the
                // only place that gap is ever stated.
                Some(s) if s == reqwest::StatusCode::NOT_FOUND => {
                    tracing::warn!(
                        module_id = %payload.module_id,
                        event_type = %payload.event_type,
                        "events: le module déclare s'abonner à cet événement mais n'expose aucun \
                         récepteur ({PRIMARY_PATH}) - l'abonnement de son manifeste est sans effet"
                    );
                    Ok(())
                }
                Some(s) => anyhow::bail!(
                    "Le module « {} » a refusé l'événement ({s})",
                    payload.module_id
                ),
                // Unreachable: the loop either returns, breaks with a status, or
                // propagates the transport error.
                None => Ok(()),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn the_payload_round_trips() {
        let payload = DeliveryPayload {
            module_id:  "drive".into(),
            event_type: "UserDeleted".into(),
            event:      AppEvent::UserDeleted { user_id: Uuid::nil() },
            meta:       EventMeta::default(),
        };
        let raw = serde_json::to_value(&payload).expect("sérialisation");
        let back: DeliveryPayload = serde_json::from_value(raw).expect("désérialisation");
        assert_eq!(back.module_id, "drive");
        assert_eq!(back.event_type, "UserDeleted");
    }

    #[test]
    fn a_custom_event_is_named_by_its_inner_type() {
        // The manifests spell `office.document_shared`, not `Custom`: delivering
        // by variant name would send every custom event to every module that
        // subscribed to any of them.
        let event = AppEvent::Custom {
            event_type: "office.document_shared".into(),
            module_id:  "office".into(),
            payload:    json!({}),
        };
        assert_eq!(bus::event_type_name(&event), "office.document_shared");
    }
}
