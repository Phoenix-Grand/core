//! The event bus on an engine without `LISTEN`/`NOTIFY`.
//!
//! On PostgreSQL the bus is `pg_notify` + [`PgListener`](sqlx::postgres::PgListener)
//! (see [`super::notify`]). Neither MySQL/MariaDB nor SQLite has anything like
//! it, so `kubuno_db::events::notify` writes the event to a **transactional
//! outbox** table, `core.kubuno_event_outbox`, and this module is its reader:
//! a background poller that drains the table and republishes each event onto the
//! in-process [`EventBus`], the very contract the `PgListener` path fulfils.
//!
//! # One abstraction, chosen at run time
//!
//! [`start_event_source`] is what boot code calls regardless of engine. It
//! inspects the pool's backend and starts either the listener or the poller, so
//! the rest of the core never learns which one is running.
//!
//! # Exactly-once across processes
//!
//! Several core processes may share one database. Each outbox row is therefore
//! **claimed** before it is published - `UPDATE ... SET delivered_at = ? WHERE
//! id = ? AND delivered_at IS NULL`, published only when `rows_affected() == 1` -
//! so two processes never deliver the same event twice. Delivered rows are
//! purged after a grace period.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use kubuno_db::{params, Backend, DbPool};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::events::{AppEvent, EventBus, EventMeta};

/// The channel the core's bus listens on (mirrors [`super::notify`]).
const EVENTS_CHANNEL: &str = "kubuno_events";

/// How often the poller drains the outbox. The bus is not latency-critical
/// (rules and dispatch tolerate a short delay); a second keeps the load light.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Rows drained per pass. Bounds a single query and a burst after a quiet spell.
const BATCH: i64 = 256;

/// A delivered row is kept this long before purging, so a slow observer or an
/// operator inspecting the table still sees it.
const PURGE_AFTER: Duration = Duration::from_secs(3_600);

/// One pass in this many also purges delivered rows (≈ every 5 min at a 1s tick).
const PURGE_EVERY_TICKS: u64 = 300;

/// What travels in an outbox `payload`, identical to the wire form the
/// `PgListener` path decodes: either an envelope with metadata, or a bare event
/// published before the envelope existed.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum WireEvent {
    Enveloped { event: AppEvent, meta: EventMeta },
    Bare(AppEvent),
}

/// One undelivered outbox row.
#[derive(Debug, sqlx::FromRow)]
struct OutboxRow {
    id: Uuid,
    channel: String,
    payload: String,
    #[allow(dead_code)]
    created_at: DateTime<Utc>,
}

/// Starts the right event source for the pool's engine and returns immediately;
/// the source runs in a background task.
///
/// * PostgreSQL → `LISTEN`/`NOTIFY` via [`super::notify::start_pg_listener`].
/// * MySQL / SQLite → the [`OutboxPoller`].
pub async fn start_event_source(pool: &DbPool, event_bus: Arc<EventBus>) -> Result<()> {
    match pool.backend() {
        Backend::Postgres => {
            if let Some(pg) = pool.as_pg() {
                super::notify::start_pg_listener(pg, event_bus).await?;
            }
        }
        Backend::MySql | Backend::Sqlite => {
            // The table is created here, not by a migration: it is the transport of
            // these engines only. Without it every publish and every poll failed,
            // so no event was ever delivered on MySQL/SQLite.
            if let Err(e) = kubuno_db::events::ensure_outbox(pool, super::SCHEMA).await {
                tracing::error!(error = %e, "Création de 'core.kubuno_event_outbox' impossible");
                return Err(e.into());
            }
            OutboxPoller::new(pool.clone(), event_bus).spawn();
            tracing::info!("Poller d'outbox démarré sur 'core.kubuno_event_outbox'");
        }
    }
    Ok(())
}

/// Drains `core.kubuno_event_outbox` and republishes onto the [`EventBus`].
pub struct OutboxPoller {
    pool: DbPool,
    event_bus: Arc<EventBus>,
}

impl OutboxPoller {
    pub fn new(pool: DbPool, event_bus: Arc<EventBus>) -> Self {
        Self { pool, event_bus }
    }

    /// Runs the poll loop forever on a background task.
    pub fn spawn(self) {
        tokio::spawn(async move {
            let mut ticks: u64 = 0;
            loop {
                tokio::time::sleep(POLL_INTERVAL).await;
                if let Err(e) = self.drain_once().await {
                    tracing::error!(error = %e, "Passe de lecture de l'outbox échouée");
                }
                ticks = ticks.wrapping_add(1);
                if ticks.is_multiple_of(PURGE_EVERY_TICKS) {
                    if let Err(e) = self.purge_delivered().await {
                        tracing::error!(error = %e, "Purge de l'outbox échouée");
                    }
                }
            }
        });
    }

    /// One drain pass: read a batch of undelivered rows, claim and publish each.
    /// Public so a test can drive delivery deterministically without the loop.
    pub async fn drain_once(&self) -> Result<usize, sqlx::Error> {
        let rows: Vec<OutboxRow> = self
            .pool
            .fetch_all_as(
                "SELECT id, channel, payload, created_at FROM core.kubuno_event_outbox \
                 WHERE delivered_at IS NULL ORDER BY created_at, id LIMIT $1",
                params![BATCH],
            )
            .await?;

        let mut delivered = 0usize;
        for row in rows {
            // Claim: only the process whose UPDATE changes the row publishes it.
            let affected = self
                .pool
                .execute(
                    "UPDATE core.kubuno_event_outbox SET delivered_at = $1 \
                     WHERE id = $2 AND delivered_at IS NULL",
                    params![Utc::now(), row.id],
                )
                .await?;
            if affected != 1 {
                continue; // another process claimed it
            }
            if row.channel == EVENTS_CHANNEL {
                self.publish(&row.payload);
            }
            // Rows on other channels are still marked delivered: the poller owns
            // the table and other channels have no in-process subscriber here.
            delivered += 1;
        }
        Ok(delivered)
    }

    fn publish(&self, payload: &str) {
        match serde_json::from_str::<WireEvent>(payload) {
            Ok(WireEvent::Enveloped { event, meta }) => {
                self.event_bus.publish_with(event, meta);
            }
            Ok(WireEvent::Bare(event)) => {
                self.event_bus.publish(event);
            }
            Err(e) => {
                tracing::warn!(error = %e, payload, "Événement d'outbox non désérialisable");
            }
        }
    }

    async fn purge_delivered(&self) -> Result<u64, sqlx::Error> {
        let cutoff = Utc::now() - chrono::Duration::from_std(PURGE_AFTER).unwrap_or_default();
        self.pool
            .execute(
                "DELETE FROM core.kubuno_event_outbox \
                 WHERE delivered_at IS NOT NULL AND delivered_at < $1",
                params![cutoff],
            )
            .await
    }
}
