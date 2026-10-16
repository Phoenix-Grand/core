//! Engine-agnostic queue operations on `kubuno_db::DbPool`.
//!
//! This is the portable form of [`super::queue`], written for the runtime-engine
//! foundation (`kubuno-db`): the same `core.jobs` table driven identically on
//! PostgreSQL, MySQL/MariaDB and SQLite.
//!
//! # The two places PostgreSQL-only SQL had to go
//!
//! * **Claiming** used `FOR UPDATE SKIP LOCKED`, which SQLite has not got and
//!   which - outside an explicit transaction - guarantees nothing. The portable
//!   claim is a **conditional `UPDATE` checked by `rows_affected()`**: a worker
//!   reads a few candidate ids, then races to flip one from `pending` to
//!   `running`; the row is won only when its own `UPDATE` reports exactly one
//!   row changed. Two workers cannot both win the same row, because the second
//!   `UPDATE` sees `status <> 'pending'` and touches nothing.
//! * **Time arithmetic** (`NOW()`, `make_interval`) is computed in Rust and
//!   bound as a timestamp, so no engine-specific date function appears in the
//!   text.
//!
//! Ids are minted in Rust ([`kubuno_db::new_id`]) and bound, because MySQL has
//! no `RETURNING` and no `gen_random_uuid()` default.

use chrono::Utc;
use kubuno_db::{new_id, params, DbPool, DbQueryBuilder};
use uuid::Uuid;

use super::queue::{backoff_delay, truncate_error, FailOutcome, NewJob, JOB_CHANNEL};
use super::Job;
use kubuno_db::Backend;

/// How many candidate rows a claimer reads before racing for one. A small
/// number keeps the read cheap; if every candidate is lost to another worker
/// the caller simply polls again.
const CLAIM_CANDIDATES: i64 = 8;

/// The columns [`Job`] decodes from, schema-qualified and in field order.
const JOB_COLS: &str = "id, job_type, module_id, payload, attempts, max_attempts";

/// A single `id` column read back from the candidate scan.
#[derive(sqlx::FromRow)]
struct IdRow {
    id: Uuid,
}

/// Inserts a job. The id is minted here (no `RETURNING`).
///
/// Returns the new id. On PostgreSQL the insert trigger still wakes the runners;
/// on the other engines a runner poll picks it up.
pub async fn enqueue(db: &DbPool, job: NewJob) -> Result<Uuid, sqlx::Error> {
    let id = new_id();
    let run_after = job.run_after.unwrap_or_else(Utc::now);
    db.execute(
        "INSERT INTO core.jobs (id, job_type, module_id, payload, max_attempts, run_after) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        params![
            id,
            job.job_type.clone(),
            job.module_id.clone(),
            job.payload.clone(),
            job.max_attempts,
            run_after
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, job_type = %job.job_type, "Insertion d'une tâche de fond échouée");
        e
    })?;
    Ok(id)
}

/// Inserts `job` only if no job of that type is already pending or running.
///
/// Returns `None` when one was already scheduled. Portable form of the
/// `INSERT ... SELECT ... WHERE NOT EXISTS` (standard SQL on all three engines);
/// the outcome is read from `rows_affected()` rather than `RETURNING`.
pub async fn ensure_scheduled(db: &DbPool, job: NewJob) -> Result<Option<Uuid>, sqlx::Error> {
    ensure_scheduled_inner(db, job, None).await
}

/// Same, ignoring `current` in the duplicate check - the form a recurring
/// handler uses to schedule its own next occurrence while its own row is still
/// `running`.
pub async fn reschedule_after(
    db: &DbPool,
    job: NewJob,
    current: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    ensure_scheduled_inner(db, job, Some(current)).await
}

async fn ensure_scheduled_inner(
    db: &DbPool,
    job: NewJob,
    exclude: Option<Uuid>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let id = new_id();
    let run_after = job.run_after.unwrap_or_else(Utc::now);

    // Placeholders strictly increasing in text order. The duplicate guard reuses
    // no value, so `job_type` is bound a second time.
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        "INSERT INTO core.jobs (id, job_type, module_id, payload, max_attempts, run_after) SELECT ",
    );
    qb.push_bind(id)
        .push(", ")
        .push_bind(job.job_type.clone())
        .push(", ")
        .push_bind(job.module_id.clone())
        .push(", ")
        .push_bind(job.payload.clone())
        .push(", ")
        .push_bind(job.max_attempts)
        .push(", ")
        .push_bind(run_after)
        .push(" WHERE NOT EXISTS (SELECT 1 FROM core.jobs WHERE job_type = ")
        .push_bind(job.job_type.clone())
        .push(" AND status IN ('pending', 'running')");
    if let Some(ex) = exclude {
        qb.push(" AND id <> ").push_bind(ex);
    }
    qb.push(")");

    let affected = qb.execute(db).await.map_err(|e| {
        tracing::error!(error = %e, job_type = %job.job_type, "Planification d'une tâche récurrente échouée");
        e
    })?;
    Ok((affected == 1).then_some(id))
}

/// Claims at most one runnable job among `job_types`.
///
/// Portable replacement for `FOR UPDATE SKIP LOCKED`: read candidate ids, then
/// win one with a conditional `UPDATE` guarded by `status = 'pending'` and
/// confirmed by `rows_affected() == 1`. Concurrent claimers race, and only the
/// one whose `UPDATE` changed the row proceeds.
pub async fn claim(db: &DbPool, job_types: &[String]) -> Result<Option<Job>, sqlx::Error> {
    if job_types.is_empty() {
        return Ok(None);
    }
    let now = Utc::now();

    let mut qb = DbQueryBuilder::new(
        db.backend(),
        "SELECT id FROM core.jobs WHERE status = 'pending' AND run_after <= ",
    );
    qb.push_bind(now).push(" AND job_type");
    qb.push_in(job_types.iter().cloned()); // appends ` IN (...)`
    qb.push_order_by("run_after, created_at");
    qb.push_limit_offset(CLAIM_CANDIDATES, 0);

    let candidates: Vec<Uuid> = qb
        .fetch_all_as::<IdRow>(db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Lecture des tâches candidates échouée");
            e
        })?
        .into_iter()
        .map(|r| r.id)
        .collect();

    for id in candidates {
        // The win: flip exactly this row, only while it is still pending.
        // `attempts` is incremented at claim time, so a crash still counts the
        // try (see `requeue_stalled`).
        let affected = db
            .execute(
                "UPDATE core.jobs SET status = 'running', attempts = attempts + 1, \
                 started_at = $1 WHERE id = $2 AND status = 'pending'",
                params![now, id],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, job_id = %id, "Réclamation d'une tâche de fond échouée");
                e
            })?;
        if affected == 1 {
            // We own it: read the claimed row back (no `RETURNING` on MySQL).
            let job = db
                .fetch_optional_as::<Job>(
                    &format!("SELECT {JOB_COLS} FROM core.jobs WHERE id = $1"),
                    params![id],
                )
                .await?;
            if job.is_some() {
                return Ok(job);
            }
        }
        // Lost the race (another worker won it, or it was cancelled): try next.
    }
    Ok(None)
}

/// Marks a job done.
pub async fn complete(db: &DbPool, id: Uuid) -> Result<(), sqlx::Error> {
    db.execute(
        "UPDATE core.jobs SET status = 'done', done_at = $1, error = NULL WHERE id = $2",
        params![Utc::now(), id],
    )
    .await
    .map(|_| ())
    .map_err(|e| {
        tracing::error!(error = %e, job_id = %id, "Clôture d'une tâche de fond échouée");
        e
    })
}

/// Records a failed attempt: retry with an exponential backoff, or definitive
/// failure once `max_attempts` is reached. Time arithmetic is done in Rust.
pub async fn fail(db: &DbPool, job: &Job, error: &str) -> Result<FailOutcome, sqlx::Error> {
    let error = truncate_error(error);

    if job.attempts >= job.max_attempts {
        db.execute(
            "UPDATE core.jobs SET status = 'failed', done_at = $1, error = $2 WHERE id = $3",
            params![Utc::now(), error.clone(), job.id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, job_id = %job.id, "Marquage en échec définitif impossible");
            e
        })?;
        return Ok(FailOutcome::GaveUp);
    }

    let delay = backoff_delay(job.attempts);
    let run_after = Utc::now() + chrono::Duration::from_std(delay).unwrap_or_default();
    db.execute(
        "UPDATE core.jobs SET status = 'pending', run_after = $1, error = $2 WHERE id = $3",
        params![run_after, error.clone(), job.id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, job_id = %job.id, "Replanification après échec impossible");
        e
    })?;

    Ok(FailOutcome::Retry {
        delay,
        attempts_left: job.max_attempts - job.attempts,
    })
}

/// Crash recovery: jobs still `running` past `stalled_after` belong to a dead
/// process. Their attempt was counted at claim time, so an exhausted job is
/// closed as failed rather than looping. Returns the number of rows recovered.
///
/// The `CASE` on the status/`done_at` columns is standard SQL; the cutoff
/// instant is computed in Rust and bound.
pub async fn requeue_stalled(
    db: &DbPool,
    stalled_after: std::time::Duration,
) -> Result<u64, sqlx::Error> {
    let now = Utc::now();
    let cutoff = now - chrono::Duration::from_std(stalled_after).unwrap_or_default();
    // Placeholders are strictly increasing and never reused (SqlSafeStr), so
    // `now` is bound twice - once for `run_after` ($1), once for `done_at` ($2).
    db.execute(
        "UPDATE core.jobs \
            SET status    = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END, \
                run_after = $1, \
                done_at   = CASE WHEN attempts >= max_attempts THEN $2 ELSE done_at END, \
                error     = 'Tâche interrompue (processus arrêté en cours d''exécution)' \
          WHERE status = 'running' AND started_at IS NOT NULL AND started_at < $3",
        params![now, now, cutoff],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Reprise des tâches interrompues échouée");
        e
    })
}

/// Wakes idle runners. On PostgreSQL this is a `NOTIFY` on the job channel (the
/// listener path); on MySQL/SQLite there is no `LISTEN`/`NOTIFY`, so it is a
/// no-op and the runners' safety poll picks the work up instead.
pub async fn notify_runners(db: &DbPool) {
    if db.backend() != Backend::Postgres {
        return;
    }
    if let Err(e) = db
        .execute("SELECT pg_notify($1, '')", params![JOB_CHANNEL])
        .await
    {
        tracing::error!(error = %e, "pg_notify sur le canal des tâches échoué");
    }
}
