//! The engine's job types, plugged into the **existing** runner.
//!
//! No scheduler of its own, for the reason [`crate::alerts::jobs`] gives: the
//! core already has one, with claiming, backoff, crash recovery and an
//! admin-tunable concurrency, and a second timer beside it would be a second
//! thing to supervise - invisible to the panel that supervises the first.
//!
//! * [`super::dispatch::ACTION_JOB`] - carries out a matched rule's actions.
//! * [`super::backtest::BACKTEST_JOB`] - replays history for one rule.
//! * [`MAINTENANCE`] - purges the execution log and the threshold counters,
//!   re-arming itself on success like every other recurring job of the core.

use std::sync::Arc;
use std::time::Duration;

use kubuno_db::DbPool;

use crate::config::settings::ServerSettings;
use crate::jobs::queue::{self, NewJob};
use crate::jobs::registry::JobRegistry;

use super::{backtest, dispatch, store};

/// Recurring housekeeping of the engine's own tables.
pub const MAINTENANCE: &str = "core.rules.maintenance";

const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(6 * 3_600);

/// Registers the three job types.
///
/// `server` is captured because dispatching a **module's** action is an
/// authenticated internal call, and the job context carries a pool and nothing
/// else - the same reason [`crate::mailer::register_jobs`] captures the JWT
/// secret. The settings block travels rather than a single string because the
/// call must present the secret **of the target module**
/// ([`crate::config::settings::ServerSettings::module_secret`]), which is
/// derived per module and only known here.
pub fn register(registry: &mut JobRegistry, server: Arc<ServerSettings>) {
    // ── Actions of a matched rule ────────────────────────────────────────────
    registry.register_fn(dispatch::ACTION_JOB, move |ctx, job| {
        let server = Arc::clone(&server);
        async move {
            let action_job: dispatch::ActionJob = serde_json::from_value(job.payload.clone())
                .map_err(|e| {
                    tracing::error!(error = %e, job_id = %job.id, "rules: charge du travail d'action illisible");
                    anyhow::anyhow!("charge du travail d'action illisible : {e}")
                })?;

            let outcome = dispatch::run_all(&ctx.db, &action_job, &server).await;
            let detail = dispatch::detail_of(&outcome);

            store::settle_execution(
                &ctx.db,
                action_job.execution_id,
                outcome.ok,
                outcome.failed,
                &detail,
            )
            .await?;

            if outcome.failed > 0 {
                // An alert rather than a silent retry: an action that did not
                // happen is the one thing an operator must be told about, and
                // the runner's backoff would otherwise hide it for an hour.
                raise_action_failure(&ctx.db, &action_job, outcome.failed).await;
                // The job itself is NOT failed: the per-action idempotency
                // claims were released, so a retry would re-run only what did
                // not take effect - but a rule whose module is down would
                // otherwise burn its attempts and dead-letter. The alert is the
                // durable signal; the operator decides.
            }
            Ok(())
        }
    });

    // ── Retrospective replay ─────────────────────────────────────────────────
    registry.register_fn(backtest::BACKTEST_JOB, |ctx, job| async move {
        let id = job
            .payload
            .get("backtest_id")
            .and_then(|v| v.as_str())
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .ok_or_else(|| anyhow::anyhow!("backtest_id absent ou invalide"))?;
        backtest::run(&ctx.db, id).await?;
        Ok(())
    });

    // ── Housekeeping ─────────────────────────────────────────────────────────
    registry.register_fn(MAINTENANCE, |ctx, job| async move {
        let days = store::setting_u64(&ctx.db, "rules.execution_retention_days", 90, 1, 3_650).await;
        let executions = store::purge_executions(&ctx.db, days as i64).await?;
        let hits = store::purge_hits(&ctx.db).await?;
        tracing::info!(
            exécutions = executions,
            occurrences = hits,
            "Purge des tables du moteur de règles"
        );

        // Re-armed on success only, like the event-log and audit purges: a
        // failing pass is retried by the runner instead of skipping a cycle.
        let next = NewJob::new(MAINTENANCE).delay(MAINTENANCE_INTERVAL);
        queue::reschedule_after(&ctx.db, next, job.id).await?;
        Ok(())
    });
}

async fn raise_action_failure(db: &DbPool, job: &dispatch::ActionJob, failed: i16) {
    use crate::alerts::{self, catalog, NewAlert, Severity};

    let alert = NewAlert::new(
        catalog::RULE_ACTION_FAILED,
        catalog::SRC_RULES,
        Severity::Warning,
        format!("Rule action failed: '{}'", job.rule_name),
    )
    .summary(format!(
        "{failed} action(s) of this rule could not run."
    ))
    .payload(serde_json::json!({
        "rule_id":         job.rule_id,
        "rule_name":       job.rule_name,
        "rule_version":    job.rule_version,
        "event_type":      job.event_type,
        "subject_user_id": job.subject_user_id,
        "failed":          failed,
    }))
    .dedup(job.rule_id);

    if let Err(e) = alerts::raise(db, alert).await {
        tracing::error!(error = %e, "rules: levée de l'alerte d'action en échec");
    }
}

/// Arms the recurring housekeeping at startup. Idempotent across restarts and
/// across several core processes.
pub async fn schedule(db: &DbPool) {
    match queue::ensure_scheduled(db, NewJob::new(MAINTENANCE)).await {
        Ok(Some(id)) => tracing::info!(job_id = %id, "Entretien du moteur de règles planifié"),
        Ok(None) => tracing::debug!("Entretien du moteur de règles déjà planifié"),
        Err(_) => { /* already logged by the queue */ }
    }
}
