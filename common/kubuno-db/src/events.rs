//! Publishing an event to the core, on an engine that may have no `NOTIFY`.
//!
//! Kubuno's event bus is PostgreSQL `LISTEN`/`NOTIFY`. Neither MySQL nor SQLite
//! has anything like it, so the fallback is a **transactional outbox**: the
//! event is inserted in the module's own schema and the core picks it up.
//!
//! ⚠️ **The reader does not exist yet.** On MySQL and SQLite the core still has
//! to grow a poller for `<schema>.kubuno_event_outbox`. Until then, events are
//! durably recorded and silently undelivered - the largest piece of core work a
//! non-PostgreSQL deployment needs.

use chrono::Utc;

use crate::dialect::Backend;
use crate::{new_id, params, DbPool};

/// The channel the core listens on.
pub const CHANNEL: &str = "kubuno_events";

/// Publishes an event. Best-effort at the call site: the caller logs and
/// carries on.
pub async fn notify(
    pool: &DbPool,
    schema: &'static str,
    channel: &str,
    payload: &str,
) -> Result<(), sqlx::Error> {
    match pool.backend() {
        Backend::Postgres => {
            pool.execute("SELECT pg_notify($1, $2)", params![channel, payload])
                .await?;
        }
        Backend::MySql | Backend::Sqlite => {
            let sql = format!(
                "INSERT INTO {schema}.kubuno_event_outbox (id, channel, payload, created_at) \
                 VALUES ($1, $2, $3, $4)"
            );
            pool.execute(&sql, params![new_id(), channel, payload, Utc::now()])
                .await?;
        }
    }
    Ok(())
}

/// Creates the outbox table when the engine needs one. A no-op on PostgreSQL.
pub async fn ensure_outbox(pool: &DbPool, schema: &'static str) -> Result<(), sqlx::Error> {
    let ddl = match pool.backend() {
        Backend::Postgres => return Ok(()),
        Backend::MySql => format!(
            "CREATE TABLE IF NOT EXISTS {schema}.kubuno_event_outbox (
                 id           BINARY(16)  NOT NULL PRIMARY KEY,
                 channel      VARCHAR(64) NOT NULL,
                 payload      LONGTEXT    NOT NULL,
                 created_at   DATETIME(6) NOT NULL,
                 delivered_at DATETIME(6) NULL,
                 INDEX idx_outbox_pending (delivered_at, created_at)
             )"
        ),
        Backend::Sqlite => format!(
            "CREATE TABLE IF NOT EXISTS {schema}.kubuno_event_outbox (
                 id           BLOB NOT NULL PRIMARY KEY,
                 channel      TEXT NOT NULL,
                 payload      TEXT NOT NULL,
                 created_at   TEXT NOT NULL,
                 delivered_at TEXT
             )"
        ),
    };
    pool.execute(&ddl, params![]).await?;
    Ok(())
}
