//! Background job runner, against a real PostgreSQL (see `common`).
//!
//! Covers: exclusive claiming between concurrent runners, exponential backoff,
//! definitive failure, crash recovery, end-to-end execution through the
//! registry, and a shutdown that does not cut a running job in half.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use kubuno_core::jobs::queue::{self, FailOutcome};
use kubuno_core::jobs::{runner, JobRegistry, JobRunnerConfig, NewJob};
use kubuno_db::{params, DbPool, DbQueryBuilder};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct ErrDone {
    error:   Option<String>,
    done_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Job types are namespaced per test run so tests never interfere with each
/// other nor with jobs left over from a previous run.
fn unique_type(prefix: &str) -> String {
    format!("test.{prefix}.{}", Uuid::new_v4().simple())
}

async fn status_of(db: &DbPool, id: Uuid) -> String {
    db.fetch_scalar::<String>("SELECT status FROM core.jobs WHERE id = $1", params![id])
        .await
        .expect("lecture du statut")
}

/// Seconds between now and the job's `run_after` (negative = runnable).
async fn seconds_until_runnable(db: &DbPool, id: Uuid) -> f64 {
    db.fetch_scalar::<f64>(
        "SELECT EXTRACT(EPOCH FROM (run_after - NOW()))::float8 FROM core.jobs WHERE id = $1",
        params![id],
    )
    .await
    .expect("lecture de run_after")
}

async fn cleanup(db: &DbPool, job_type: &str) {
    let _ = db
        .execute("DELETE FROM core.jobs WHERE job_type = $1", params![job_type])
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_runners_never_claim_the_same_job() {
    let Some(db) = common::test_pool().await else { return };
    let job_type = unique_type("claim");

    // One job, two runners claiming at the very same time.
    let id = queue::enqueue(&db, NewJob::new(job_type.as_str())).await.expect("enqueue");
    let types = vec![job_type.clone()];
    let (a, b) = tokio::join!(queue::claim(&db, &types), queue::claim(&db, &types));
    let a = a.expect("claim A");
    let b = b.expect("claim B");
    let claimed: Vec<_> = [a, b].into_iter().flatten().collect();
    assert_eq!(claimed.len(), 1, "un seul exécuteur doit obtenir la tâche");
    assert_eq!(claimed[0].id, id);
    assert_eq!(claimed[0].attempts, 1, "la tentative est comptée à la réclamation");
    assert_eq!(status_of(&db, id).await, "running");

    // Two jobs, two runners: each gets a distinct one.
    let id1 = queue::enqueue(&db, NewJob::new(job_type.as_str())).await.expect("enqueue 1");
    let id2 = queue::enqueue(&db, NewJob::new(job_type.as_str())).await.expect("enqueue 2");
    let (a, b) = tokio::join!(queue::claim(&db, &types), queue::claim(&db, &types));
    let mut got: Vec<Uuid> = [a.expect("claim"), b.expect("claim")]
        .into_iter()
        .flatten()
        .map(|j| j.id)
        .collect();
    got.sort();
    let mut expected = vec![id1, id2];
    expected.sort();
    assert_eq!(got, expected, "les deux tâches doivent être réparties, sans doublon");

    // Nothing left to claim.
    assert!(queue::claim(&db, &types).await.expect("claim vide").is_none());

    cleanup(&db, &job_type).await;
}

#[tokio::test]
async fn failures_back_off_exponentially_then_give_up() {
    let Some(db) = common::test_pool().await else { return };
    let job_type = unique_type("backoff");
    let types = vec![job_type.clone()];

    let id = queue::enqueue(&db, NewJob::new(job_type.as_str()).max_attempts(3))
        .await
        .expect("enqueue");

    // Attempt 1 → retry in ~5s.
    let job = queue::claim(&db, &types).await.expect("claim").expect("tâche");
    let outcome = queue::fail(&db, &job, "boum 1").await.expect("fail");
    assert!(matches!(outcome, FailOutcome::Retry { delay, attempts_left: 2 } if delay == Duration::from_secs(5)));
    assert_eq!(status_of(&db, id).await, "pending");
    let d1 = seconds_until_runnable(&db, id).await;
    assert!((4.0..=5.5).contains(&d1), "délai attendu ~5s, obtenu {d1}");

    // A job whose backoff has not elapsed is NOT claimable.
    assert!(queue::claim(&db, &types).await.expect("claim").is_none(), "backoff non respecté");

    // Fast-forward the backoff instead of sleeping.
    db.execute("UPDATE core.jobs SET run_after = NOW() WHERE id = $1", params![id])
        .await
        .expect("avance du temps");

    // Attempt 2 → retry in ~10s (doubling).
    let job = queue::claim(&db, &types).await.expect("claim").expect("tâche");
    assert_eq!(job.attempts, 2);
    let outcome = queue::fail(&db, &job, "boum 2").await.expect("fail");
    assert!(matches!(outcome, FailOutcome::Retry { delay, .. } if delay == Duration::from_secs(10)));
    let d2 = seconds_until_runnable(&db, id).await;
    assert!(d2 > d1, "le délai doit croître ({d1} → {d2})");

    db.execute("UPDATE core.jobs SET run_after = NOW() WHERE id = $1", params![id])
        .await
        .expect("avance du temps");

    // Attempt 3 = max_attempts → definitive failure, error kept.
    let job = queue::claim(&db, &types).await.expect("claim").expect("tâche");
    assert_eq!(job.attempts, 3);
    let outcome = queue::fail(&db, &job, "boum 3").await.expect("fail");
    assert_eq!(outcome, FailOutcome::GaveUp);
    assert_eq!(status_of(&db, id).await, "failed");

    let row = db
        .fetch_one_as::<ErrDone>("SELECT error, done_at FROM core.jobs WHERE id = $1", params![id])
        .await
        .expect("lecture");
    assert_eq!(row.error.as_deref(), Some("boum 3"));
    assert!(row.done_at.is_some(), "done_at doit être renseigné en échec définitif");

    // A failed job is never claimed again.
    assert!(queue::claim(&db, &types).await.expect("claim").is_none());

    cleanup(&db, &job_type).await;
}

#[tokio::test]
async fn stalled_jobs_are_requeued_after_a_crash() {
    let Some(db) = common::test_pool().await else { return };
    let job_type = unique_type("stalled");

    // A job left `running` an hour ago by a process that died, with attempts
    // left…
    let alive: Uuid = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.jobs (id, job_type, status, attempts, max_attempts, started_at)
         VALUES ($1, $2, 'running', 1, 3, NOW() - INTERVAL '1 hour')",
        params![alive, &job_type],
    )
    .await
    .expect("insertion");

    // …and one that had already burnt all of them.
    let exhausted: Uuid = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.jobs (id, job_type, status, attempts, max_attempts, started_at)
         VALUES ($1, $2, 'running', 3, 3, NOW() - INTERVAL '1 hour')",
        params![exhausted, &job_type],
    )
    .await
    .expect("insertion");

    // A job that started a second ago is still alive: it must NOT be touched.
    let running_now: Uuid = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.jobs (id, job_type, status, attempts, max_attempts, started_at)
         VALUES ($1, $2, 'running', 1, 3, NOW())",
        params![running_now, &job_type],
    )
    .await
    .expect("insertion");

    let recovered = queue::requeue_stalled(&db, Duration::from_secs(600))
        .await
        .expect("reprise");
    assert!(recovered >= 2, "au moins les deux tâches orphelines reprises");

    assert_eq!(status_of(&db, alive).await, "pending", "tâche orpheline remise en file");
    assert!(seconds_until_runnable(&db, alive).await <= 0.5, "immédiatement rejouable");
    assert_eq!(status_of(&db, exhausted).await, "failed", "plus de tentative disponible");
    assert_eq!(status_of(&db, running_now).await, "running", "tâche vivante non touchée");

    // And the requeued one is claimable again.
    let types = vec![job_type.clone()];
    let job = queue::claim(&db, &types).await.expect("claim").expect("tâche");
    assert_eq!(job.id, alive);
    assert_eq!(job.attempts, 2, "la tentative interrompue reste comptée");

    cleanup(&db, &job_type).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn runner_executes_registered_jobs_end_to_end() {
    let Some(db) = common::test_pool().await else { return };
    let ok_type = unique_type("run.ok");
    let ko_type = unique_type("run.ko");

    let runs = Arc::new(AtomicUsize::new(0));
    let mut registry = JobRegistry::new();
    {
        let runs = Arc::clone(&runs);
        registry.register_fn(ok_type.clone(), move |_ctx, _job| {
            let runs = Arc::clone(&runs);
            async move {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        });
    }
    registry.register_fn(ko_type.clone(), |_ctx, _job| async move {
        anyhow::bail!("échec volontaire")
    });

    let cfg = JobRunnerConfig {
        concurrency:   2,
        poll_interval: Duration::from_secs(1),
        stalled_after: Duration::from_secs(600),
        job_timeout:   Duration::from_secs(30),
    };
    let handle = runner::start(db.clone(), Arc::new(registry), cfg).await;

    // Enqueued AFTER the runner started: the wake-up path (NOTIFY + poll) is
    // what gets these executed.
    let mut ids = Vec::new();
    for _ in 0..5 {
        ids.push(queue::enqueue(&db, NewJob::new(ok_type.as_str())).await.expect("enqueue"));
    }
    let failing = queue::enqueue(&db, NewJob::new(ko_type.as_str()).max_attempts(1))
        .await
        .expect("enqueue");

    // An unregistered type must stay untouched - no runner may burn it.
    let orphan_type = unique_type("run.unknown");
    let orphan = queue::enqueue(&db, NewJob::new(orphan_type.as_str())).await.expect("enqueue");

    let done = common::wait_until(Duration::from_secs(20), || {
        let db = db.clone();
        let ids = ids.clone();
        async move {
            let mut qb = DbQueryBuilder::new(db.backend(), "SELECT COUNT(*) FROM core.jobs WHERE ");
            qb.push("id").push_in(ids.clone());
            qb.push(" AND status = 'done'");
            let n: i64 = qb.fetch_scalar(&db).await.unwrap_or(0);
            n == ids.len() as i64
        }
    })
    .await;
    assert!(done, "les 5 tâches doivent être exécutées par l'exécuteur");
    assert_eq!(runs.load(Ordering::SeqCst), 5);

    let failed = common::wait_until(Duration::from_secs(20), || {
        let db = db.clone();
        async move { status_of(&db, failing).await == "failed" }
    })
    .await;
    assert!(failed, "la tâche en échec (max_attempts=1) doit finir en 'failed'");

    assert_eq!(status_of(&db, orphan).await, "pending", "type non enregistré : jamais réclamé");

    handle.shutdown(Duration::from_secs(5)).await;

    cleanup(&db, &ok_type).await;
    cleanup(&db, &ko_type).await;
    cleanup(&db, &orphan_type).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_lets_running_jobs_finish() {
    let Some(db) = common::test_pool().await else { return };
    let job_type = unique_type("shutdown");

    let finished = Arc::new(AtomicUsize::new(0));
    let mut registry = JobRegistry::new();
    {
        let finished = Arc::clone(&finished);
        registry.register_fn(job_type.clone(), move |_ctx, _job| {
            let finished = Arc::clone(&finished);
            async move {
                tokio::time::sleep(Duration::from_millis(1_500)).await;
                finished.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        });
    }

    let cfg = JobRunnerConfig {
        concurrency:   2,
        poll_interval: Duration::from_millis(200),
        stalled_after: Duration::from_secs(600),
        job_timeout:   Duration::from_secs(30),
    };
    let handle = runner::start(db.clone(), Arc::new(registry), cfg).await;

    let id = queue::enqueue(&db, NewJob::new(job_type.as_str())).await.expect("enqueue");
    // Let the runner pick it up, then ask for shutdown while it is running.
    let claimed = common::wait_until(Duration::from_secs(10), || {
        let db = db.clone();
        async move { status_of(&db, id).await == "running" }
    })
    .await;
    assert!(claimed, "la tâche doit être en cours avant l'arrêt");

    handle.shutdown(Duration::from_secs(10)).await;

    assert_eq!(finished.load(Ordering::SeqCst), 1, "la tâche en cours doit avoir été menée à son terme");
    assert_eq!(status_of(&db, id).await, "done");

    cleanup(&db, &job_type).await;
}

#[tokio::test]
async fn recurring_jobs_are_not_duplicated() {
    let Some(db) = common::test_pool().await else { return };
    let job_type = unique_type("recurring");

    let first = queue::ensure_scheduled(&db, NewJob::new(job_type.as_str())).await.expect("schedule");
    assert!(first.is_some());
    let second = queue::ensure_scheduled(&db, NewJob::new(job_type.as_str())).await.expect("schedule");
    assert!(second.is_none(), "une seule occurrence à la fois");

    // A running occurrence may schedule its own successor.
    let current = first.expect("id");
    db.execute(
        "UPDATE core.jobs SET status = 'running', started_at = NOW() WHERE id = $1",
        params![current],
    )
    .await
    .expect("mise en cours");
    let next = queue::reschedule_after(&db, NewJob::new(job_type.as_str()).delay(Duration::from_secs(3600)), current)
        .await
        .expect("reschedule");
    assert!(next.is_some(), "la prochaine occurrence doit être planifiée");
    assert!(seconds_until_runnable(&db, next.expect("id")).await > 3_000.0);

    cleanup(&db, &job_type).await;
}
