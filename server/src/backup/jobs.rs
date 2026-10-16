//! The scheduler, expressed as two job types of the runner that already exists.
//!
//! There is deliberately **no loop of its own** here. `crate::jobs` already
//! provides claiming with `SKIP LOCKED`, exponential backoff, crash recovery,
//! wake-up by `NOTIFY` and an admin-tunable concurrency; a timer spawned beside
//! it would be a second thing to supervise, invisible to the panel that
//! supervises the first. The recurring type re-arms itself on success, exactly
//! like `core.cleanup_event_log` and `core.purge_admin_audit`.
//!
//! ## Two types, and why not one
//!
//! * [`RUN`] - the recurring occurrence. It re-arms itself.
//! * [`RUN_NOW`] - a manual run, enqueued by the console.
//!
//! They are separate because `queue::reschedule_after` refuses to insert when a
//! job of the same type is already pending: a manual run sitting in the queue
//! would silently swallow the recurring job's re-arm and stop the schedule dead
//! - a bug whose only symptom is that backups quietly stop, which is the exact
//! failure this feature exists to prevent.
//!
//! ## A failed dump is not a failed job
//!
//! Tonight's failure must not cancel tomorrow's attempt. So the handler records
//! the failure in `core.backup_runs` (where the alert producer and the health
//! check read it), re-arms the next occurrence and returns `Ok`. Returning `Err`
//! would hand the job to the runner's retry-then-give-up path and leave the
//! chain dead until the next restart - trading a visible failure for an
//! invisible one. Only a failure of the *bookkeeping itself* is an `Err`: at
//! that point nothing can be recorded, and the queue's own machinery is the last
//! thing still watching.

use std::time::Duration;

use chrono::Utc;
use kubuno_db::DbPool;
use uuid::Uuid;

use super::policy::{self, Policy};
use super::runs::{self, Trigger};
use crate::errors::AppError;
use crate::jobs::queue::{self, NewJob};
use crate::jobs::registry::JobRegistry;

/// The recurring occurrence. Its `done_at` is not what the console reads -
/// `core.backup_runs` is - because a job that ran and produced nothing is not a
/// backup.
pub const RUN: &str = "core.backup.run";

/// A run asked for by a human, right now.
pub const RUN_NOW: &str = "core.backup.run_now";

/// How long a scheduled occurrence waits when another run is already in flight.
const BUSY_RETRY: Duration = Duration::from_secs(300);

/// Runs one backup end to end: open the row, write the file, rotate the old
/// ones, close the row.
///
/// Returns the id of the history row in both outcomes - a caller that wants to
/// know what happened reads the row, so a failure is never a message that exists
/// only in a log.
pub async fn execute(
    db: &DbPool,
    trigger: Trigger,
    actor: Option<(Uuid, String)>,
) -> Result<Uuid, AppError> {
    let policy = policy::load(db).await;
    let destination = std::path::PathBuf::from(&policy.destination);

    let run_id = runs::open(db, trigger, actor, &policy.destination).await?;
    let started = std::time::Instant::now();

    // The portable format is written on every engine, so a backup taken here can
    // be restored onto any engine from the admin console.
    match super::portable::write_dump(db, &destination).await {
        Ok(outcome) => {
            let elapsed = started.elapsed().as_millis() as i64;
            tracing::info!(
                run_id = %run_id,
                fichier = %outcome.file_name,
                octets = outcome.size_bytes,
                schémas = outcome.schemas,
                tables = outcome.tables,
                lignes = outcome.rows,
                durée_ms = elapsed,
                "Sauvegarde de la base écrite"
            );
            runs::succeed(db, run_id, &outcome, elapsed).await?;

            // Rotation happens *after* the success is recorded: a failure to
            // delete an old file must never make a written backup look failed.
            match super::dump::prune(&destination, policy.retention_count).await {
                Ok(removed) if !removed.is_empty() => {
                    tracing::info!(
                        supprimés = removed.len(),
                        conservés = policy.retention_count,
                        "Rotation des sauvegardes"
                    );
                    if let Err(e) = runs::mark_pruned(db, &removed).await {
                        tracing::error!(error = %e, "backup: historique non marqué après rotation");
                    }
                }
                Ok(_) => {}
                Err(e) => tracing::error!(error = %e, "backup: rotation impossible"),
            }
        }
        Err(e) => {
            let elapsed = started.elapsed().as_millis() as i64;
            // `{e:#}` prints the whole anyhow chain - "Export de core.users:
            // connection closed" rather than "Export de core.users". The
            // operator gets the sentence that names the fix.
            let message = format!("{e:#}");
            tracing::error!(run_id = %run_id, error = %message, "Sauvegarde du schéma core échouée");
            runs::fail(db, run_id, &message, elapsed).await?;
        }
    }

    // The health report caches "is there a recent backup?" for a minute; a
    // manual run whose result does not show up is a screen nobody trusts.
    crate::health::invalidate();
    Ok(run_id)
}

/// Registers both job types.
pub fn register(registry: &mut JobRegistry) {
    registry.register_fn(RUN, |ctx, job| async move {
        // Any run left `running` by a killed process is closed first, or the
        // concurrency guard below would refuse every occurrence for ever.
        if let Err(e) = runs::close_stalled(&ctx.db).await {
            tracing::error!(error = %e, "backup: reprise des exécutions interrompues");
        }

        let policy = policy::load(&ctx.db).await;

        if !policy.enabled {
            // Not an error and not a silent skip: the schedule keeps ticking so
            // that switching the policy on takes effect within the hour rather
            // than at the next restart.
            tracing::debug!("Sauvegarde automatique désactivée : occurrence ignorée");
            rearm(&ctx.db, job.id, policy::DISABLED_RECHECK).await;
            return Ok(());
        }

        if runs::is_running(&ctx.db).await.unwrap_or(false) {
            tracing::info!("Une sauvegarde est déjà en cours : occurrence reportée");
            rearm(&ctx.db, job.id, BUSY_RETRY).await;
            return Ok(());
        }

        // A dump failure is recorded, not propagated - see the module header.
        if let Err(e) = execute(&ctx.db, Trigger::Scheduled, None).await {
            tracing::error!(error = %e, "backup: écriture de l'historique impossible");
            // Re-armed even here: losing one history row must not stop the
            // schedule, and the next occurrence may well succeed.
            rearm(&ctx.db, job.id, next_delay(&policy)).await;
            return Err(anyhow::anyhow!("Historique de sauvegarde inaccessible : {e}"));
        }

        rearm(&ctx.db, job.id, next_delay(&policy)).await;
        Ok(())
    });

    registry.register_fn(RUN_NOW, |ctx, job| async move {
        if let Err(e) = runs::close_stalled(&ctx.db).await {
            tracing::error!(error = %e, "backup: reprise des exécutions interrompues");
        }
        if runs::is_running(&ctx.db).await.unwrap_or(false) {
            // Refused rather than queued: an operator who clicks twice wants one
            // backup, not two dumps competing for the same disk.
            tracing::info!("Sauvegarde manuelle ignorée : une exécution est déjà en cours");
            return Ok(());
        }

        // The console records who asked, so the history can name them after the
        // fact. A payload without an actor is still run - the row simply says
        // "manual" with nobody attached, which is honest.
        let actor = match (
            job.payload.get("actor_id").and_then(|v| v.as_str()).and_then(|s| Uuid::parse_str(s).ok()),
            job.payload.get("actor_label").and_then(|v| v.as_str()),
        ) {
            (Some(id), Some(label)) => Some((id, label.to_string())),
            (Some(id), None) => Some((id, String::new())),
            _ => None,
        };

        execute(&ctx.db, Trigger::Manual, actor).await?;
        Ok(())
    });
}

/// How long until the next scheduled occurrence.
fn next_delay(policy: &Policy) -> Duration {
    policy.delay_until_next(Utc::now())
}

/// Schedules the next occurrence, logging rather than failing: a re-arm that
/// could not be written is recovered by [`schedule`] at the next startup, and
/// turning it into an error would mark a *successful* backup as a failed job.
async fn rearm(db: &DbPool, current: Uuid, delay: Duration) {
    let next = NewJob::new(RUN).delay(delay);
    if let Err(e) = queue::reschedule_after(db, next, current).await {
        tracing::error!(error = %e, "backup: replanification de la prochaine occurrence impossible");
    }
}

/// Enqueues a manual run and returns the job id.
///
/// The actor is carried in the payload rather than resolved later: by the time
/// the job runs, the request that authorised it is long gone.
pub async fn enqueue_manual(
    db: &DbPool,
    actor_id: Uuid,
    actor_label: &str,
) -> Result<Uuid, AppError> {
    let job = NewJob::new(RUN_NOW)
        // Exactly one attempt. A human asked once; three silent retries with a
        // backoff would produce backups they never requested and hide the error
        // they are waiting to read.
        .max_attempts(1)
        .payload(serde_json::json!({
            "actor_id":    actor_id.to_string(),
            "actor_label": actor_label,
        }));

    queue::enqueue(db, job).await.map_err(|e| {
        tracing::error!(error = %e, "backup: mise en file d'une sauvegarde manuelle impossible");
        AppError::Database(e)
    })
}

/// Arms the recurring occurrence at startup. Idempotent across restarts and
/// across several core processes.
///
/// The first occurrence is due at the policy's own hour, not immediately: a
/// restart at 14:00 must not dump the database because somebody deployed.
pub async fn schedule(db: &DbPool) {
    let policy = policy::load(db).await;
    let delay = if policy.enabled {
        next_delay(&policy)
    } else {
        policy::DISABLED_RECHECK
    };

    match queue::ensure_scheduled(db, NewJob::new(RUN).delay(delay)).await {
        Ok(Some(id)) => tracing::info!(
            job_id = %id,
            activée = policy.enabled,
            dans_s = delay.as_secs(),
            "Sauvegarde automatique planifiée"
        ),
        Ok(None) => tracing::debug!("Sauvegarde automatique déjà planifiée"),
        Err(_) => { /* already logged by the queue */ }
    }
}
