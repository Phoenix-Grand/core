//! Job types shipped by the core itself.
//!
//! * [`CLEANUP_EVENT_LOG`] - periodic purge of `core.event_log` (30-day
//!   retention). The SQL function `core.cleanup_event_log()` has existed since
//!   migration `000003` and nothing ever called it; this is its caller.
//! * [`PURGE_ADMIN_AUDIT`] - periodic purge of `core.admin_audit`, honouring the
//!   configurable `security.audit_retention_days` window. Same shape as above;
//!   [`crate::audit::retention::purge_expired`] records its own entry in the
//!   trail, so a purge is never an invisible deletion.
//! * [`PURGE_MODULE_USAGE`] - periodic purge of `core.module_usage_daily`,
//!   honouring the configurable `usage.retention_days` window. The counters say
//!   who used which application; keeping them past their window would be the
//!   difference between a statistic and a file on somebody.
//! * [`SELFTEST`] - diagnostic job used to exercise the runner end to end
//!   (execution, retry with backoff, crash recovery) on a real instance,
//!   without waiting for a real workload. It does nothing but sleep and,
//!   optionally, fail on purpose.

use std::time::Duration;

use kubuno_db::dialect::SqlType;
use kubuno_db::{params, DbPool};

use super::queue::{self, NewJob};
use super::registry::JobRegistry;

pub const CLEANUP_EVENT_LOG: &str = "core.cleanup_event_log";
pub const PURGE_ADMIN_AUDIT: &str = "core.purge_admin_audit";
pub const STORAGE_USAGE_RECONCILE: &str = "core.storage.usage_reconcile";
pub const SELFTEST: &str = "core.selftest";
/// Erases accounts whose deletion grace period has run out.
pub const PURGE_DELETED_USERS: &str = "core.purge_deleted_users";
/// Trims `core.jobs` of its completed rows.
pub const PURGE_FINISHED_JOBS: &str = "core.purge_finished_jobs";
/// Trims the module attendance counters to their retention window.
pub const PURGE_MODULE_USAGE: &str = "core.purge_module_usage";

/// How often the event log is purged.
const CLEANUP_INTERVAL: Duration = Duration::from_secs(24 * 3_600);

/// How often the administrative audit trail is trimmed to its retention window.
const AUDIT_PURGE_INTERVAL: Duration = Duration::from_secs(24 * 3_600);

/// How often the storage breakdown is checked against the authoritative total
/// and its declarants checked for silence.
///
/// Hourly, and deliberately more often than the staleness window it enforces
/// (`storage.usage_stale_hours`, 24 h by default): a check that ran at the same
/// period as the threshold would report a module a whole period late.
const USAGE_RECONCILE_INTERVAL: Duration = Duration::from_secs(3_600);

/// Daily, like the other sweeps. The grace period is counted in days, so a
/// finer cadence would only move the moment of erasure inside a day nobody is
/// watching.
const USER_PURGE_INTERVAL: Duration = Duration::from_secs(24 * 3_600);

/// How often finished jobs are trimmed.
const FINISHED_JOBS_PURGE_INTERVAL: Duration = Duration::from_secs(24 * 3_600);

/// How often the attendance counters are trimmed. Daily: the rows are keyed on
/// a calendar day, so nothing finer would ever remove a different set.
const USAGE_PURGE_INTERVAL: Duration = Duration::from_secs(24 * 3_600);

/// Retention applied when `usage.retention_days` is missing or unreadable.
/// Same figure the migration seeds, so the code and the settings row agree even
/// on an instance whose row was deleted by hand.
const DEFAULT_USAGE_RETENTION_DAYS: i64 = 90;

/// How long a *successful* job stays readable.
///
/// The table had no retention at all, which was survivable while the queue
/// carried a handful of periodic sweeps and the odd e-mail. Event delivery
/// (`core.events.deliver`) changed the order of magnitude: one row per event per
/// subscribed module, forever. A week is long enough to answer "did that
/// deletion propagate on Monday" and short enough that nobody has to think about
/// the table again.
const DONE_JOB_RETENTION_DAYS: i32 = 7;

/// Registers the core's own job types.
pub fn register(registry: &mut JobRegistry) {
    registry.register_fn(CLEANUP_EVENT_LOG, |ctx, job| async move {
        let backend = ctx.db.backend();
        let count_sql =
            format!("SELECT {} FROM core.event_log", backend.count_bigint("*"));
        let before: i64 = ctx
            .db
            .fetch_scalar(&count_sql, params![])
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Comptage de core.event_log échoué");
                e
            })?;

        // Portable replacement for the PL/pgSQL `core.cleanup_event_log()`: the
        // 30-day cutoff is computed in Rust and bound, so no engine-specific
        // date function appears in the text.
        let cutoff = chrono::Utc::now() - chrono::Duration::days(30);
        ctx.db
            .execute(
                "DELETE FROM core.event_log WHERE created_at < $1",
                params![cutoff],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Purge de core.event_log échouée");
                e
            })?;

        let after: i64 = ctx
            .db
            .fetch_scalar(&count_sql, params![])
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Comptage de core.event_log échoué");
                e
            })?;

        tracing::info!(
            purgées = before - after,
            restantes = after,
            "Purge du journal d'événements (rétention 30 jours)"
        );

        // Schedule the next occurrence. Done on success only: a failing purge
        // is retried by the runner, and the startup call below re-arms the
        // cycle if it ever gave up for good.
        let next = NewJob::new(CLEANUP_EVENT_LOG).delay(CLEANUP_INTERVAL);
        queue::reschedule_after(&ctx.db, next, job.id).await?;
        Ok(())
    });

    // Only `done` rows. A `failed` job is what an operator opens the queue to
    // look at - the delivery a module refused, the e-mail that never went out -
    // and a purge that swept those away would delete the evidence rather than
    // the noise. They are cleared by hand, from the console.
    registry.register_fn(PURGE_FINISHED_JOBS, |ctx, job| async move {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(DONE_JOB_RETENTION_DAYS as i64);
        let deleted = ctx
            .db
            .execute(
                "DELETE FROM core.jobs \
                  WHERE status = 'done' \
                    AND done_at IS NOT NULL \
                    AND done_at < $1",
                params![cutoff],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Purge des tâches terminées échouée");
                e
            })?;

        tracing::info!(purgées = deleted, "Purge des tâches de fond terminées");

        let next = NewJob::new(PURGE_FINISHED_JOBS).delay(FINISHED_JOBS_PURGE_INTERVAL);
        queue::reschedule_after(&ctx.db, next, job.id).await?;
        Ok(())
    });

    // Attendance counters (`core.module_usage_daily`).
    //
    // The table says who used which application, which is the most personal
    // thing the console counts - so it is the one whose window an operator must
    // be able to shorten, and the purge honours the setting rather than a
    // constant. A window of 0 keeps nothing at all: "measure nothing" has to be
    // reachable from the settings page, not only by editing the source.
    registry.register_fn(PURGE_MODULE_USAGE, |ctx, job| async move {
        let raw: Option<serde_json::Value> = ctx
            .db
            .fetch_optional_scalar(
                "SELECT value FROM core.settings WHERE \"key\" = 'usage.retention_days'",
                params![],
            )
            .await
            .unwrap_or(None)
            .flatten();
        // Clamped like every other window read from a writable column: an absurd
        // figure is nonsense, and the cutoff date is computed in Rust.
        let days = raw
            .and_then(|v| v.as_i64())
            .unwrap_or(DEFAULT_USAGE_RETENTION_DAYS)
            .clamp(0, 3_650);

        let cutoff_day = (chrono::Utc::now() - chrono::Duration::days(days)).date_naive();
        let deleted = ctx
            .db
            .execute(
                "DELETE FROM core.module_usage_daily WHERE day < $1",
                params![cutoff_day],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Purge des compteurs de fréquentation échouée");
                e
            })?;

        if deleted > 0 {
            tracing::info!(
                purgées = deleted,
                rétention_jours = days,
                "Purge des compteurs de fréquentation des modules"
            );
        }

        let next = NewJob::new(PURGE_MODULE_USAGE).delay(USAGE_PURGE_INTERVAL);
        queue::reschedule_after(&ctx.db, next, job.id).await?;
        Ok(())
    });

    registry.register_fn(PURGE_ADMIN_AUDIT, |ctx, job| async move {
        // `purge_expired` reads the configured window, applies the floor, logs
        // its own database errors and writes its own audit entry.
        let deleted = crate::audit::retention::purge_expired(&ctx.db).await?;
        tracing::info!(
            purgées = deleted,
            "Purge du journal d'audit administratif (rétention configurable)"
        );

        // Same discipline as the event-log purge: re-arm on success only, so a
        // failing purge is retried by the runner instead of silently skipping a
        // day, and the startup call below revives the cycle if it gave up.
        let next = NewJob::new(PURGE_ADMIN_AUDIT).delay(AUDIT_PURGE_INTERVAL);
        queue::reschedule_after(&ctx.db, next, job.id).await?;
        Ok(())
    });

    // ── Storage provenance ──────────────────────────────────────────────────
    //
    // The declarations that feed the per-module breakdown are pushed by the
    // modules themselves; this is the core's side of the bargain. It does two
    // things, and deliberately not a third.
    //
    // * It states the divergence between the authoritative total
    //   (`SUM(core.users.used_bytes)`, what quotas are enforced against) and the
    //   sum of the declarations. That residue is normal - it is every module
    //   that does not declare yet - and the point is that it is written down
    //   somewhere periodically rather than only visible to whoever opens the
    //   console.
    // * It raises an alert for a module that used to declare and has gone quiet,
    //   and resolves it as soon as the module speaks again. Silence is the one
    //   failure mode of a push channel that produces no error anywhere: the
    //   figure simply stops moving, and a stale figure that looks fresh is worse
    //   than no figure.
    //
    // What it does **not** do is recompute anything on a module's behalf. The
    // core cannot enumerate another module's storage - that is the entire reason
    // the module has to declare - so a "reconciliation" that recounted would be
    // inventing the number it is supposed to be checking.
    registry.register_fn(STORAGE_USAGE_RECONCILE, |ctx, job| async move {
        let sum_sql = format!(
            "SELECT {} FROM core.users",
            ctx.db.backend().sum_bigint("used_bytes")
        );
        let authoritative: i64 = ctx
            .db
            .fetch_scalar(&sum_sql, params![])
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "storage_usage: total faisant autorité");
                e
            })?;

        let breakdown = crate::storage::usage::breakdown(&ctx.db, authoritative).await?;
        tracing::info!(
            déclaré = breakdown.declared_bytes,
            non_attribué = breakdown.unattributed_bytes,
            sur_déclaré = breakdown.over_declared_bytes,
            modules_silencieux = breakdown.silent_modules,
            "Réconciliation du stockage : provenance de la consommation"
        );

        let stale = crate::storage::usage::stale_reporters(&ctx.db).await?;
        let mut live = Vec::new();
        for (module_id, display_name, last, used) in &stale {
            let hours = (chrono::Utc::now() - *last).num_hours().max(0);
            let alert = crate::alerts::model::NewAlert::new(
                crate::alerts::catalog::USAGE_STALE,
                crate::alerts::catalog::SRC_STORAGE,
                crate::alerts::catalog::default_severity(crate::alerts::catalog::USAGE_STALE),
                format!("“{display_name}” has stopped declaring what it stores"),
            )
            .summary(format!(
                "Its last declaration was {hours} h ago. Its share of the storage breakdown is still shown - it is the last measurement known to be true - but it is no longer being refreshed."
            ))
            .payload(serde_json::json!({
                "module_id":        module_id,
                "module_name":      display_name,
                "last_declared_at": last,
                "hours_silent":     hours,
                "declared_bytes":   used,
                "stale_hours":      breakdown.stale_hours,
            }))
            .module(module_id.clone())
            .dedup(module_id);

            live.push(alert.dedup_key.clone());
            crate::alerts::store::raise(&ctx.db, alert).await?;
        }

        // A module that started declaring again closes its own alert: the queue
        // must never keep a card about a condition that has ended.
        crate::alerts::store::auto_resolve(&ctx.db, crate::alerts::catalog::USAGE_STALE, &live)
            .await?;

        // ── Then the repair ─────────────────────────────────────────────────
        //
        // Ordered after the staleness check on purpose: the pass suspends itself
        // whenever a declarant is stale, so the alert that explains *why* nothing
        // was corrected is already raised by the time the repair declines to run.
        let repair = crate::storage::usage::repair_counters(&ctx.db).await?;
        if !repair.enabled {
            tracing::debug!("Recalage du stockage désactivé par la configuration");
        } else if !repair.blocked_by.is_empty() {
            tracing::info!(
                modules = ?repair.blocked_by.iter().map(|b| (b.module_id.as_str(), b.blocker)).collect::<Vec<_>>(),
                comptes_en_écart = repair.drifting_accounts,
                "Recalage du stockage suspendu : un déclarant n'est pas à jour"
            );
        }

        let next = NewJob::new(STORAGE_USAGE_RECONCILE).delay(USAGE_RECONCILE_INTERVAL);
        queue::reschedule_after(&ctx.db, next, job.id).await?;
        Ok(())
    });

    // Erases accounts whose grace period has expired.
    //
    // Keyed on `deleted_at`, **never** on `is_active`: the two mean the same
    // thing in the column and opposite things to a person, because a suspension
    // also deactivates. A purge reading `is_active` would destroy accounts
    // somebody had merely put on hold. See `migrations/000109`.
    //
    // `deleted_at` is stamped only by `admin::users::delete_user` and cleared by
    // reactivation, so accounts that were already inactive when this shipped
    // carry no stamp and are never swept - erasing them stays a deliberate,
    // one-at-a-time act through the purge route.
    registry.register_fn(PURGE_DELETED_USERS, |ctx, job| async move {
        // Read straight from the instance row, like `audit::retention`: this is
        // an instance-wide policy, so resolving it through the per-unit chain
        // would invite a unit to shorten its own grace period.
        let raw: Option<serde_json::Value> = ctx
            .db
            .fetch_optional_scalar(
                "SELECT value FROM core.settings WHERE \"key\" = 'users.purge_after_days'",
                params![],
            )
            .await
            .unwrap_or(None)
            .flatten();
        // Clamped to ten years: a value read from a column somebody can write is
        // an input; the cutoff instant is computed in Rust and bound.
        let days = raw.and_then(|v| v.as_i64()).unwrap_or(20).clamp(0, 3_650);
        let cutoff = chrono::Utc::now() - chrono::Duration::days(days);

        // Release alerts these accounts had taken, first. `core.alerts` pairs
        // `assignee_id` with `assigned_at` under a CHECK, while the foreign key
        // nulls only the first - so the delete below would fail on the
        // constraint. Same reasoning as `admin::users::purge_user`. Written as a
        // correlated subquery (portable) rather than PostgreSQL's `UPDATE … FROM`.
        if let Err(e) = ctx
            .db
            .execute(
                "UPDATE core.alerts SET assignee_id = NULL, assigned_at = NULL \
                  WHERE assignee_id IN ( \
                      SELECT id FROM core.users \
                       WHERE deleted_at IS NOT NULL AND deleted_at < $1)",
                params![cutoff],
            )
            .await
        {
            tracing::error!(error = %e, "Libération des alertes avant purge échouée");
            return Err(e.into());
        }

        // Read what will be destroyed, then destroy it: MySQL has no
        // `DELETE … RETURNING`, so the two-statement form is the portable one.
        // The audit trail below needs the erased (id, email) pairs.
        let email_txt = ctx.db.backend().cast("email", SqlType::Text);
        let select_sql = format!(
            "SELECT id, {email_txt} AS email FROM core.users \
              WHERE deleted_at IS NOT NULL AND deleted_at < $1"
        );
        let erased: Vec<PurgedUser> = ctx
            .db
            .fetch_all_as(&select_sql, params![cutoff])
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Lecture des comptes à purger échouée");
                e
            })?;
        // Take each account's setting overrides with it - the
        // `setting_values_purge_scope` trigger's job on PostgreSQL, which has no
        // equivalent for the polymorphic `scope_id` on the other engines.
        if ctx.db.backend() != kubuno_db::Backend::Postgres {
            ctx.db
                .execute(
                    "DELETE FROM core.setting_values \
                      WHERE scope_type = 'user' \
                        AND scope_id IN ( \
                            SELECT id FROM core.users \
                             WHERE deleted_at IS NOT NULL AND deleted_at < $1)",
                    params![cutoff],
                )
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Purge des réglages des comptes supprimés échouée");
                    e
                })?;
        }
        ctx.db
            .execute(
                "DELETE FROM core.users WHERE deleted_at IS NOT NULL AND deleted_at < $1",
                params![cutoff],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Purge des comptes supprimés échouée");
                e
            })?;

        if !erased.is_empty() {
            let audit = crate::audit::AuditContext::system("Purge des comptes supprimés");
            for u in &erased {
                audit
                    .record(
                        &ctx.db,
                        crate::audit::AuditEntry::new("core.users.purge")
                            .target(crate::audit::redact::target::USER, u.id, u.email.clone())
                            .detail(format!("délai de grâce de {days} jour(s) écoulé")),
                    )
                    .await;
            }
            tracing::info!(
                comptes = erased.len(),
                délai_jours = days,
                "Comptes supprimés effacés définitivement"
            );
        }

        let next = NewJob::new(PURGE_DELETED_USERS).delay(USER_PURGE_INTERVAL);
        queue::reschedule_after(&ctx.db, next, job.id).await?;
        Ok(())
    });

    registry.register_fn(SELFTEST, |_ctx, job| async move {
        let sleep_ms = job.payload.get("sleep_ms").and_then(|v| v.as_u64()).unwrap_or(0);
        if sleep_ms > 0 {
            tokio::time::sleep(Duration::from_millis(sleep_ms.min(600_000))).await;
        }
        let label = job.payload.get("label").and_then(|v| v.as_str()).unwrap_or("");
        if job.payload.get("fail").and_then(|v| v.as_bool()).unwrap_or(false) {
            anyhow::bail!("échec volontaire (core.selftest{}{label})", if label.is_empty() { "" } else { " " });
        }
        tracing::info!(job_id = %job.id, label = %label, "Tâche de diagnostic exécutée");
        Ok(())
    });
}

/// One erased account, read back before the purge deletes it.
#[derive(sqlx::FromRow)]
struct PurgedUser {
    id:    uuid::Uuid,
    email: String,
}

/// Arms the recurring maintenance jobs at startup. Idempotent across restarts
/// and across several core processes.
pub async fn schedule(db: &DbPool) {
    match queue::ensure_scheduled(db, NewJob::new(CLEANUP_EVENT_LOG)).await {
        Ok(Some(id)) => tracing::info!(job_id = %id, "Purge du journal d'événements planifiée"),
        Ok(None) => tracing::debug!("Purge du journal d'événements déjà planifiée"),
        Err(_) => { /* already logged */ }
    }
    match queue::ensure_scheduled(db, NewJob::new(PURGE_ADMIN_AUDIT)).await {
        Ok(Some(id)) => tracing::info!(job_id = %id, "Purge du journal d'audit planifiée"),
        Ok(None) => tracing::debug!("Purge du journal d'audit déjà planifiée"),
        Err(_) => { /* already logged */ }
    }
    match queue::ensure_scheduled(db, NewJob::new(PURGE_DELETED_USERS)).await {
        Ok(Some(id)) => tracing::info!(job_id = %id, "Purge des comptes supprimés planifiée"),
        Ok(None) => tracing::debug!("Purge des comptes supprimés déjà planifiée"),
        Err(_) => { /* already logged */ }
    }
    match queue::ensure_scheduled(db, NewJob::new(PURGE_FINISHED_JOBS)).await {
        Ok(Some(id)) => tracing::info!(job_id = %id, "Purge des tâches terminées planifiée"),
        Ok(None) => tracing::debug!("Purge des tâches terminées déjà planifiée"),
        Err(_) => { /* already logged */ }
    }
    match queue::ensure_scheduled(db, NewJob::new(PURGE_MODULE_USAGE)).await {
        Ok(Some(id)) => tracing::info!(job_id = %id, "Purge des compteurs de fréquentation planifiée"),
        Ok(None) => tracing::debug!("Purge des compteurs de fréquentation déjà planifiée"),
        Err(_) => { /* already logged */ }
    }
    match queue::ensure_scheduled(db, NewJob::new(STORAGE_USAGE_RECONCILE)).await {
        Ok(Some(id)) => tracing::info!(job_id = %id, "Réconciliation du stockage planifiée"),
        Ok(None) => tracing::debug!("Réconciliation du stockage déjà planifiée"),
        Err(_) => { /* already logged */ }
    }
}
