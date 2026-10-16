//! The runner itself: wake-up, claiming loop, bounded concurrency, graceful
//! shutdown and crash recovery.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt;
use kubuno_db::DbPool;
use sqlx::postgres::PgListener;
use tokio::sync::{watch, Semaphore};

use super::portable;
use super::queue::{FailOutcome, JOB_CHANNEL};
use super::registry::{JobContext, JobRegistry};

/// Runner tuning. Defaults are sized for a self-hosted instance: a handful of
/// concurrent jobs, a five-second safety poll, generous timeouts.
#[derive(Debug, Clone)]
pub struct JobRunnerConfig {
    /// Jobs executed in parallel by this process.
    pub concurrency:   usize,
    /// Fallback poll, for when a `NOTIFY` is missed (listener reconnecting) or
    /// a retry becomes runnable without any new insert.
    pub poll_interval: Duration,
    /// A `running` job older than this is considered orphaned by a dead
    /// process and put back in the queue. Must stay well above `job_timeout`.
    pub stalled_after: Duration,
    /// Hard ceiling for a single execution; past it the job is failed (and
    /// retried) instead of holding a slot forever.
    pub job_timeout:   Duration,
}

impl Default for JobRunnerConfig {
    fn default() -> Self {
        Self {
            concurrency:   4,
            poll_interval: Duration::from_secs(5),
            stalled_after: Duration::from_secs(1_800),
            job_timeout:   Duration::from_secs(900),
        }
    }
}

fn as_u64(v: &serde_json::Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// One `core.settings` row read for the runner tuning.
#[derive(sqlx::FromRow)]
struct SettingRow {
    key:   String,
    value: serde_json::Value,
}

impl JobRunnerConfig {
    /// Reads `jobs.*` from `core.settings`, falling back to the defaults for
    /// any key that is missing or holds a nonsensical value. Never fails: a
    /// misconfigured setting must not stop the server from booting.
    pub async fn from_db(db: &DbPool) -> Self {
        let mut cfg = Self::default();

        let rows = db
            .fetch_all_as::<SettingRow>(
                "SELECT \"key\", value FROM core.settings
                  WHERE \"key\" IN ('jobs.concurrency',
                                'jobs.poll_interval_s',
                                'jobs.stalled_after_s',
                                'jobs.job_timeout_s')",
                kubuno_db::params![],
            )
            .await
            .unwrap_or_else(|e| {
                tracing::error!(error = %e, "Lecture des réglages jobs.* impossible - valeurs par défaut");
                Vec::new()
            })
            .into_iter()
            .map(|r| (r.key, r.value));

        for (key, value) in rows {
            let Some(n) = as_u64(&value) else { continue };
            if n == 0 {
                continue;
            }
            match key.as_str() {
                // Capped: one runaway setting must not open 10 000 connections.
                "jobs.concurrency"     => cfg.concurrency = (n as usize).min(64),
                "jobs.poll_interval_s" => cfg.poll_interval = Duration::from_secs(n.min(3_600)),
                "jobs.stalled_after_s" => cfg.stalled_after = Duration::from_secs(n),
                "jobs.job_timeout_s"   => cfg.job_timeout = Duration::from_secs(n),
                _ => {}
            }
        }

        cfg
    }
}

/// Handle on a started runner, used to stop it without killing running jobs.
pub struct JobRunnerHandle {
    shutdown:    watch::Sender<bool>,
    slots:       Arc<Semaphore>,
    concurrency: u32,
}

impl JobRunnerHandle {
    /// Stops claiming and waits - at most `grace` - for the jobs in flight.
    ///
    /// Waiting on every slot is what guarantees no job is cut in half by a
    /// restart: a half-executed job would be retried from the start, and not
    /// every handler is idempotent.
    pub async fn shutdown(self, grace: Duration) {
        let _ = self.shutdown.send(true);
        let in_flight = self.concurrency as usize - self.slots.available_permits();
        if in_flight == 0 {
            tracing::info!("Exécuteur de tâches arrêté (aucune tâche en cours)");
            return;
        }
        tracing::info!("Arrêt de l'exécuteur : {in_flight} tâche(s) en cours, attente jusqu'à {}s…", grace.as_secs());
        match tokio::time::timeout(grace, self.slots.acquire_many(self.concurrency)).await {
            Ok(Ok(_)) => tracing::info!("Exécuteur de tâches arrêté proprement"),
            Ok(Err(e)) => tracing::warn!(error = %e, "Sémaphore de l'exécuteur fermé pendant l'arrêt"),
            Err(_) => tracing::warn!(
                "Délai d'arrêt dépassé : des tâches étaient encore en cours - elles seront reprises au prochain démarrage"
            ),
        }
    }
}

/// Starts the runner: crash recovery, `LISTEN` wake-ups, claiming loop and the
/// periodic recovery pass. Returns immediately.
pub async fn start(db: DbPool, registry: Arc<JobRegistry>, cfg: JobRunnerConfig) -> JobRunnerHandle {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let slots = Arc::new(Semaphore::new(cfg.concurrency));

    let handle = JobRunnerHandle {
        shutdown:    shutdown_tx,
        slots:       Arc::clone(&slots),
        concurrency: cfg.concurrency as u32,
    };

    if registry.is_empty() {
        tracing::warn!("Aucun type de tâche enregistré - l'exécuteur ne démarre pas");
        return handle;
    }

    // Crash recovery before anything else: whatever a previous process left
    // `running` must be runnable again before we start claiming.
    recover_stalled(&db, cfg.stalled_after).await;

    let wake = Arc::new(tokio::sync::Notify::new());
    spawn_listener(db.clone(), Arc::clone(&wake), shutdown_rx.clone());
    spawn_recovery_loop(db.clone(), cfg.clone(), shutdown_rx.clone());

    tracing::info!(
        "Exécuteur de tâches démarré : {} en parallèle, {} type(s) - {}",
        cfg.concurrency,
        registry.len(),
        registry.job_types().join(", ")
    );

    tokio::spawn(dispatch_loop(db, registry, cfg, slots, wake, shutdown_rx));

    handle
}

/// Claims jobs one by one and hands each to a task, never exceeding
/// `concurrency` in flight.
async fn dispatch_loop(
    db: DbPool,
    registry: Arc<JobRegistry>,
    cfg: JobRunnerConfig,
    slots: Arc<Semaphore>,
    wake: Arc<tokio::sync::Notify>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let job_types = registry.job_types();

    loop {
        if *shutdown_rx.borrow() {
            break;
        }

        // Wait for a free slot - but stay interruptible.
        let permit = tokio::select! {
            biased;
            _ = shutdown_rx.changed() => break,
            p = Arc::clone(&slots).acquire_owned() => match p {
                Ok(p) => p,
                Err(_) => break, // semaphore closed
            },
        };

        match portable::claim(&db, &job_types).await {
            Ok(Some(job)) => {
                let Some(handler) = registry.get(&job.job_type) else {
                    // Only registered types are claimed, so this cannot happen
                    // unless the registry changed under us.
                    tracing::error!(job_type = %job.job_type, "Tâche réclamée sans gestionnaire - remise en file");
                    let _ = portable::fail(&db, &job, "Aucun gestionnaire pour ce type de tâche").await;
                    drop(permit);
                    continue;
                };
                let ctx = JobContext { db: db.clone() };
                let db2 = db.clone();
                let timeout = cfg.job_timeout;
                tokio::spawn(async move {
                    execute(&db2, handler, ctx, job, timeout).await;
                    drop(permit);
                });
            }
            Ok(None) => {
                drop(permit);
                // Nothing runnable: sleep until a NOTIFY arrives, the safety
                // poll fires, or we are asked to stop.
                tokio::select! {
                    biased;
                    _ = shutdown_rx.changed() => break,
                    _ = wake.notified() => {}
                    _ = tokio::time::sleep(cfg.poll_interval) => {}
                }
            }
            Err(_) => {
                // Already logged in portable::claim (DB down, most likely).
                drop(permit);
                tokio::select! {
                    biased;
                    _ = shutdown_rx.changed() => break,
                    _ = tokio::time::sleep(cfg.poll_interval) => {}
                }
            }
        }
    }

    tracing::info!("Boucle de réclamation des tâches arrêtée");
}

/// Runs one job and records its outcome.
async fn execute(
    db: &DbPool,
    handler: Arc<dyn super::JobHandler>,
    ctx: JobContext,
    job: super::Job,
    timeout: Duration,
) {
    let started = Instant::now();
    tracing::debug!(job_id = %job.id, job_type = %job.job_type, attempt = job.attempts, "Tâche démarrée");

    // A panicking handler must not take the runner down, and must not leave the
    // row `running` until the recovery pass notices it.
    let run = std::panic::AssertUnwindSafe(handler.handle(&ctx, &job)).catch_unwind();
    let outcome = match tokio::time::timeout(timeout, run).await {
        Ok(Ok(Ok(()))) => None,
        Ok(Ok(Err(e))) => Some(format!("{e:#}")),
        Ok(Err(_panic)) => Some("Le gestionnaire a paniqué".to_string()),
        Err(_) => Some(format!("Délai d'exécution dépassé ({}s)", timeout.as_secs())),
    };

    let elapsed_ms = started.elapsed().as_millis();
    match outcome {
        None => {
            if portable::complete(db, job.id).await.is_ok() {
                tracing::info!(job_id = %job.id, job_type = %job.job_type, durée_ms = elapsed_ms, "Tâche terminée");
            }
        }
        Some(error) => match portable::fail(db, &job, &error).await {
            Ok(FailOutcome::Retry { delay, attempts_left }) => {
                tracing::warn!(
                    job_id = %job.id, job_type = %job.job_type, erreur = %error,
                    "Tâche en échec (tentative {}/{}) - nouvelle tentative dans {}s ({} restante(s))",
                    job.attempts, job.max_attempts, delay.as_secs(), attempts_left
                );
            }
            Ok(FailOutcome::GaveUp) => {
                tracing::error!(
                    job_id = %job.id, job_type = %job.job_type, erreur = %error,
                    "Tâche en échec définitif après {} tentative(s)", job.attempts
                );
            }
            Err(_) => { /* already logged */ }
        },
    }
}

/// `LISTEN kubuno_jobs` on a dedicated connection, reconnecting on error.
/// Every notification simply wakes the dispatcher up - the payload carries no
/// authority, the claim query decides what actually runs.
fn spawn_listener(db: DbPool, wake: Arc<tokio::sync::Notify>, mut shutdown_rx: watch::Receiver<bool>) {
    // Only PostgreSQL has `LISTEN`/`NOTIFY`. On MySQL/SQLite there is nothing to
    // listen on, so the dispatcher's safety poll is the only wake path - start
    // no listener task there.
    let Some(pg) = db.as_pg().cloned() else {
        return;
    };
    tokio::spawn(async move {
        loop {
            if *shutdown_rx.borrow() {
                return;
            }
            let mut listener = match PgListener::connect_with(&pg).await {
                Ok(l) => l,
                Err(e) => {
                    tracing::error!(error = %e, "Écoute du canal des tâches impossible - nouvelle tentative dans 5s");
                    tokio::select! {
                        _ = shutdown_rx.changed() => return,
                        _ = tokio::time::sleep(Duration::from_secs(5)) => continue,
                    }
                }
            };
            if let Err(e) = listener.listen(JOB_CHANNEL).await {
                tracing::error!(error = %e, "LISTEN {JOB_CHANNEL} échoué - nouvelle tentative dans 5s");
                tokio::select! {
                    _ = shutdown_rx.changed() => return,
                    _ = tokio::time::sleep(Duration::from_secs(5)) => continue,
                }
            }
            tracing::info!("Écoute du canal '{JOB_CHANNEL}' active");

            // A notification emitted while we were reconnecting is simply lost;
            // the dispatcher's safety poll is what covers that hole.
            wake.notify_one();

            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => return,
                    recv = listener.recv() => match recv {
                        Ok(_) => wake.notify_one(),
                        Err(e) => {
                            tracing::warn!(error = %e, "Connexion d'écoute des tâches perdue - reconnexion");
                            break;
                        }
                    },
                }
            }
        }
    });
}

/// Periodic crash recovery, for a *sibling* runner that died while this one
/// keeps going (the startup pass only covers this process).
fn spawn_recovery_loop(db: DbPool, cfg: JobRunnerConfig, mut shutdown_rx: watch::Receiver<bool>) {
    let period = std::cmp::max(cfg.stalled_after / 2, Duration::from_secs(60));
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => return,
                _ = tokio::time::sleep(period) => {}
            }
            recover_stalled(&db, cfg.stalled_after).await;
        }
    });
}

async fn recover_stalled(db: &DbPool, stalled_after: Duration) {
    match portable::requeue_stalled(db, stalled_after).await {
        Ok(0) => {}
        Ok(n) => {
            tracing::warn!("Reprise après incident : {n} tâche(s) restée(s) « en cours » remise(s) en file");
            portable::notify_runners(db).await;
        }
        Err(_) => { /* already logged */ }
    }
}
