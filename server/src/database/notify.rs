use crate::database::SCHEMA;
use crate::events::{AppEvent, EventBus, EventMeta};
use anyhow::Result;
use kubuno_db::DbPool;
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgListener;
use sqlx::PgPool;
use std::sync::Arc;

/// What travels on the `kubuno_events` channel.
///
/// Historically the payload was a bare [`AppEvent`]. It still may be: a module,
/// or an older core process sharing the same database, publishes that shape and
/// must keep working. The enveloped form carries the metadata an event cannot
/// hold on its own - most importantly the rule-feedback depth, without which a
/// loop that crosses a process boundary is invisible to the guard.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum WireEvent {
    /// `{"event": {...}, "meta": {...}}`
    Enveloped { event: AppEvent, meta: EventMeta },
    /// A bare event, as published before the envelope existed.
    Bare(AppEvent),
}

pub async fn start_pg_listener(pool: &PgPool, event_bus: Arc<EventBus>) -> Result<()> {
    let mut listener = PgListener::connect_with(pool).await?;
    listener.listen("kubuno_events").await?;
    tracing::info!("PgListener démarré sur le canal 'kubuno_events'");

    tokio::spawn(async move {
        loop {
            match listener.recv().await {
                Ok(notification) => {
                    match serde_json::from_str::<WireEvent>(notification.payload()) {
                        Ok(WireEvent::Enveloped { event, meta }) => {
                            event_bus.publish_with(event, meta);
                        }
                        Ok(WireEvent::Bare(event)) => {
                            event_bus.publish(event);
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, payload = notification.payload(), "Notification PG non désérialisable");
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "Erreur PgListener, tentative de reconnexion…");
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                }
            }
        }
    });

    Ok(())
}

pub async fn pg_notify(db: &DbPool, event: &AppEvent) -> Result<()> {
    pg_notify_with(db, event, &EventMeta::default()).await
}

/// Publishes an event on the channel together with its metadata.
///
/// The path a background job takes: a job handler holds a pool and nothing else,
/// so this is how work performed off the request path reaches the bus - and how
/// the depth counter survives the hop. Engine-agnostic: on PostgreSQL it is a
/// `pg_notify`; on MySQL/SQLite `kubuno_db::events::notify` writes the enveloped
/// payload to `core.kubuno_event_outbox`, which the outbox poller drains.
pub async fn pg_notify_with(db: &DbPool, event: &AppEvent, meta: &EventMeta) -> Result<()> {
    let payload = serde_json::to_string(&serde_json::json!({
        "event": event,
        "meta":  meta,
    }))?;
    kubuno_db::events::notify(db, SCHEMA, "kubuno_events", &payload).await?;
    Ok(())
}
