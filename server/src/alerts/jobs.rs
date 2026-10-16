//! The recurring scan, expressed as a job type of the existing runner.
//!
//! There is deliberately **no loop of its own** in this feature. The core
//! already has one scheduler (`crate::jobs`), with claiming, backoff, crash
//! recovery and an admin-tunable concurrency; a second timer spawned next to it
//! would be a second thing to supervise, invisible to the panel that supervises
//! the first.
//!
//! The handler re-arms itself on success, exactly like the event-log and audit
//! purges do: a failing pass is retried by the runner instead of silently
//! skipping a cycle, and [`schedule`] revives the chain at startup if it ever
//! gave up for good.

use std::sync::Arc;
use std::time::Duration;

use kubuno_db::{params, DbPool};

use crate::config::Settings;
use crate::jobs::queue::{self, NewJob};
use crate::jobs::registry::JobRegistry;

/// Recurring analysis pass. Its `done_at` is also what the console reads as
/// "last checked" - see [`super::producers::last_scan_at`].
pub const SCAN: &str = "core.alerts.scan";

/// Fallback cadence when the setting is missing or absurd.
const DEFAULT_INTERVAL_S: u64 = 300;
const MIN_INTERVAL_S: u64 = 30;
const MAX_INTERVAL_S: u64 = 6 * 3_600;

async fn interval(db: &DbPool) -> Duration {
    let raw: Option<serde_json::Value> = db
        .fetch_optional_scalar::<Option<serde_json::Value>>(
            "SELECT value FROM core.settings WHERE \"key\" = 'alerts.scan_interval_s'",
            params![],
        )
        .await
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "alerts: reading the scan interval");
            None
        })
        .flatten();

    let secs = raw
        .as_ref()
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(DEFAULT_INTERVAL_S)
        .clamp(MIN_INTERVAL_S, MAX_INTERVAL_S);
    Duration::from_secs(secs)
}

/// Registers the scan. `settings` is captured because the health evaluation and
/// the disk probe both need the instance configuration, which the job context
/// (a pool and nothing else) does not carry.
pub fn register(registry: &mut JobRegistry, settings: Arc<Settings>) {
    registry.register_fn(SCAN, move |ctx, job| {
        let settings = Arc::clone(&settings);
        async move {
            super::producers::run_all(&ctx.db, &settings).await?;

            // Re-armed on success only. The next occurrence is scheduled with
            // the interval read *now*, so changing the setting takes effect on
            // the following pass rather than at the next restart.
            let next = NewJob::new(SCAN).delay(interval(&ctx.db).await);
            queue::reschedule_after(&ctx.db, next, job.id).await?;
            Ok(())
        }
    });
}

/// Arms the scan at startup. Idempotent across restarts and across several core
/// processes - `ensure_scheduled` refuses to pile up duplicates.
pub async fn schedule(db: &DbPool) {
    match queue::ensure_scheduled(db, NewJob::new(SCAN)).await {
        Ok(Some(id)) => tracing::info!(job_id = %id, "Analyse du centre d'alertes planifiée"),
        Ok(None) => tracing::debug!("Analyse du centre d'alertes déjà planifiée"),
        Err(_) => { /* already logged by the queue */ }
    }
}
