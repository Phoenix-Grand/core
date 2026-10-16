//! The directory synchronisation as a background job.
//!
//! Registered into the existing runner (`crate::jobs`) rather than driven by a
//! loop of its own: the runner already claims work with `SKIP LOCKED`, so two
//! core processes never synchronise the same directory twice; it already
//! retries with a backoff; and it already puts back the jobs a crash left
//! `running`. A private `tokio::spawn` would have none of that and would run the
//! same import N times on an instance behind a load balancer.
//!
//! One job carries one directory (`payload.directory_id`) and re-arms itself for
//! that directory's own interval on success, which is the same shape the two
//! built-in purges use.

use std::time::Duration;

use kubuno_db::{new_id, params, DbPool};
use uuid::Uuid;

use crate::jobs::{
    queue::{self, NewJob},
    JobRegistry,
};

use super::{config, sync};

pub const SYNC: &str = "core.directory_sync";

/// Registers the job type. The JWT secret is captured because the service
/// password is encrypted with a key derived from it, and a background task has
/// no `AppState` to read it from.
pub fn register(registry: &mut JobRegistry, jwt_secret: String) {
    registry.register_fn(SYNC, move |ctx, job| {
        let jwt_secret = jwt_secret.clone();
        async move {
            let Some(id) = job
                .payload
                .get("directory_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                // A payload we cannot read is not worth three retries.
                tracing::warn!(job_id = %job.id, "annuaire : tâche sans directory_id exploitable");
                return Ok(());
            };

            let dir = match config::load(&ctx.db, id).await {
                Ok(d) => d,
                Err(_) => {
                    // Already logged. The directory was deleted while a job for
                    // it was queued: nothing to do, and nothing to retry.
                    tracing::info!(directory_id = %id, "annuaire : tâche orpheline abandonnée");
                    return Ok(());
                }
            };

            if !dir.enabled || !dir.sync_enabled {
                tracing::debug!(directory = %dir.slug, "annuaire : synchronisation périodique désarmée");
                return Ok(());
            }

            let report = sync::run(&ctx.db, &jwt_secret, &dir).await?;

            // Re-arm for this directory's own interval, on success only - a
            // failing run is retried by the runner rather than skipping a cycle.
            let delay = Duration::from_secs(dir.sync_interval_min.clamp(5, 10_080) as u64 * 60);
            ensure_one_per_directory(&ctx.db, id, Some(delay), Some(job.id)).await?;

            if report.status == "failed" {
                // The report is already written to the row and to the trail. The
                // job itself succeeded at doing what it could, so it does not
                // burn its attempts: the next cycle will try again.
                tracing::warn!(directory = %dir.slug, "annuaire : cycle terminé en échec, prochain cycle planifié");
            }
            Ok(())
        }
    });
}

/// Inserts a cycle for **this** directory unless one is already pending or
/// running for it.
///
/// [`queue::ensure_scheduled`] deduplicates on `job_type` alone, which is right
/// for a singleton purge and wrong here: every directory has its own cycle, and
/// the shared helper would let the first one starve all the others. The
/// duplicate check is therefore narrowed to the payload - same statement shape,
/// same `INSERT … WHERE NOT EXISTS`, and the executor is untouched.
///
/// `exclude` is the caller's own row, still `running` while it schedules its
/// successor.
async fn ensure_one_per_directory(
    db: &DbPool,
    directory_id: Uuid,
    delay: Option<Duration>,
    exclude: Option<Uuid>,
) -> Result<Option<Uuid>, sqlx::Error> {
    // The old `RETURNING id` (which MySQL lacks) is replaced by generating the id
    // in Rust and inserting it: the `INSERT … SELECT … WHERE NOT EXISTS` inserts
    // exactly zero or one row, so a `rows_affected() == 1` means the id we bound
    // was written. `NOW()`/`COALESCE` are folded into a bound instant, the JSON
    // text extraction goes through the backend, and each value is bound once (no
    // reused placeholder). The `FROM (SELECT 1)` derived table keeps the
    // conditional insert legal on MySQL, which forbids a bare `SELECT … WHERE`.
    let run_after = delay
        .map(|d| chrono::Utc::now() + chrono::Duration::from_std(d).unwrap_or_default())
        .unwrap_or_else(chrono::Utc::now);
    let id = new_id();
    let payload_key = db.backend().json_text("payload", &["directory_id"]);
    let sql = format!(
        r#"INSERT INTO core.jobs (id, job_type, payload, run_after)
           SELECT $1, $2, $3, $4 FROM (SELECT 1) AS _one
            WHERE NOT EXISTS (
                SELECT 1 FROM core.jobs
                 WHERE job_type = $5
                   AND status IN ('pending', 'running')
                   AND {payload_key} = $6
                   AND ($7 IS NULL OR id <> $8)
            )"#
    );
    let affected = db
        .execute(
            &sql,
            params![
                id,
                SYNC,
                serde_json::json!({ "directory_id": directory_id.to_string() }),
                run_after,
                SYNC,
                directory_id.to_string(),
                exclude,
                exclude
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, directory_id = %directory_id, "annuaire : planification de la synchronisation");
            e
        })?;
    Ok((affected == 1).then_some(id))
}

/// Arms one directory's cycle. Idempotent across restarts and processes.
pub async fn schedule_one(db: &DbPool, directory_id: Uuid) {
    match ensure_one_per_directory(db, directory_id, None, None).await {
        Ok(Some(id)) => tracing::info!(job_id = %id, directory_id = %directory_id, "annuaire : synchronisation planifiée"),
        Ok(None) => tracing::debug!(directory_id = %directory_id, "annuaire : synchronisation déjà planifiée"),
        Err(_) => { /* already logged */ }
    }
}

/// Queues an immediate run. Used by the "synchronise now" button when the
/// operator does not want to wait for the answer.
pub async fn run_now(db: &DbPool, directory_id: Uuid) -> Result<Uuid, sqlx::Error> {
    queue::enqueue(
        db,
        NewJob::new(SYNC).payload(serde_json::json!({ "directory_id": directory_id.to_string() })),
    )
    .await
}

/// Arms every directory that asks for a periodic import. Called at startup,
/// beside the built-in purges.
pub async fn schedule_all(db: &DbPool) {
    let rows = db
        .fetch_all_as::<(Uuid,)>(
            "SELECT id FROM core.ldap_directories WHERE enabled = TRUE AND sync_enabled = TRUE",
            params![],
        )
        .await;

    match rows {
        Ok(ids) => {
            for (id,) in ids {
                schedule_one(db, id).await;
            }
        }
        Err(e) => {
            tracing::error!(error = %e, "annuaire : lecture des annuaires à synchroniser");
        }
    }
}
