//! The migration, expressed as one job type of the runner that already exists.
//!
//! ## One type, no payload, no timer of its own
//!
//! There is deliberately no loop here and no job per campaign. `crate::jobs`
//! already provides claiming with `SKIP LOCKED`, backoff, crash recovery and an
//! admin-tunable concurrency; a second scheduler beside it would be a thing to
//! supervise that the panel supervising the first cannot see.
//!
//! And it is one type carrying **no campaign id**, because
//! [`queue::ensure_scheduled`] refuses to insert while a job of the same type
//! is pending: a per-campaign payload would let the second campaign started
//! that minute silently swallow the first one's re-arm. So the type means "walk
//! whatever is running", the tick walks every running campaign, and starting a
//! campaign is `ensure_scheduled` - idempotent by construction.
//!
//! ## A failed mailbox is not a failed job
//!
//! A source that refuses a password fails ONE account, is recorded on that row,
//! and the tick moves to the next mailbox. Returning `Err` there would hand the
//! whole campaign to the runner's retry-then-give-up path and stop two hundred
//! other accounts because one password was wrong.
//!
//! A module that is unreachable is the other case: nothing is wrong with the
//! account, so the row is released untouched and the chain re-arms later. The
//! distinction is what stops a module restart from marking every mailbox red.
//!
//! ## Why the chain stops
//!
//! The tick re-arms itself only while work remains. An instance that has never
//! migrated anything runs no timer at all - the queue is empty and stays empty
//! until an administrator starts a campaign.

use std::sync::Arc;
use std::time::{Duration, Instant};

use kubuno_db::DbPool;

use super::{dispatch, store};
use crate::config::settings::ServerSettings;
use crate::jobs::queue::{self, NewJob};
use crate::jobs::registry::JobRegistry;

/// Walks whatever is running.
pub const STEP: &str = "core.data_migration.step";

/// Wall-clock budget of one tick. Several chunks fit in it, so a small campaign
/// finishes without waiting for a re-arm, while the job still returns often
/// enough to be visible as "running" rather than as a stuck worker.
const TICK_BUDGET: Duration = Duration::from_secs(120);

/// Delay before the next tick when there is still work.
const CONTINUE_DELAY: Duration = Duration::from_secs(2);

/// Delay before retrying when the module could not be reached at all.
const MODULE_DOWN_DELAY: Duration = Duration::from_secs(60);

/// Registers the job.
///
/// Two things are captured because a [`crate::jobs::JobContext`] carries only a
/// pool: the server settings (calling a module means presenting **that
/// module's** derived internal secret) and the JWT secret (the source
/// credentials are sealed at rest and must be opened to be handed over).
pub fn register(registry: &mut JobRegistry, server: Arc<ServerSettings>, jwt_secret: Arc<String>) {
    registry.register_fn(STEP, move |ctx, job| {
        let server = Arc::clone(&server);
        let jwt_secret = Arc::clone(&jwt_secret);
        async move {
            let outcome = tick(&ctx.db, &server, &jwt_secret).await;

            // Whatever happened above, the ledger decides whether the chain
            // continues: a tick that crashed halfway must not leave running
            // campaigns with nobody coming back for them.
            match store::has_work(&ctx.db).await {
                Ok(true) => {
                    let delay = match outcome {
                        TickOutcome::ModuleUnreachable => MODULE_DOWN_DELAY,
                        _ => CONTINUE_DELAY,
                    };
                    if let Err(e) =
                        queue::reschedule_after(&ctx.db, NewJob::new(STEP).delay(delay), job.id)
                            .await
                    {
                        tracing::error!(error = %e, "data_migration: ré-armement impossible");
                    }
                }
                Ok(false) => {
                    tracing::debug!("data_migration: plus rien à migrer - la chaîne s'arrête");
                }
                Err(e) => {
                    tracing::error!(error = %e, "data_migration: état du travail restant illisible");
                }
            }
            Ok(())
        }
    });
}

/// Arms the chain if anything is waiting. Called at boot, so a campaign left
/// running by a restart carries on by itself.
pub async fn resume(db: &DbPool) {
    match store::has_work(db).await {
        Ok(true) => kick(db).await,
        Ok(false) => {}
        Err(e) => tracing::error!(error = %e, "data_migration: reprise au démarrage impossible"),
    }
}

/// Wakes the chain. Idempotent: a second call while a tick is queued does
/// nothing.
pub async fn kick(db: &DbPool) {
    match queue::ensure_scheduled(db, NewJob::new(STEP)).await {
        Ok(Some(id)) => tracing::info!(tâche = %id, "data_migration: migration mise en file"),
        Ok(None) => tracing::debug!("data_migration: une étape est déjà en file"),
        Err(e) => tracing::error!(error = %e, "data_migration: mise en file impossible"),
    }
}

enum TickOutcome {
    Idle,
    Advanced,
    ModuleUnreachable,
}

async fn tick(db: &DbPool, server: &ServerSettings, jwt_secret: &str) -> TickOutcome {
    match store::reclaim_stalled(db).await {
        Ok(n) if n > 0 => {
            tracing::info!(comptes = n, "data_migration: comptes interrompus remis en file")
        }
        Ok(_) => {}
        Err(e) => tracing::error!(error = %e, "data_migration: reprise des comptes interrompus"),
    }

    let started = Instant::now();
    let mut outcome = TickOutcome::Idle;

    while started.elapsed() < TICK_BUDGET {
        let claimed = match store::claim_next(db).await {
            Ok(Some(claimed)) => claimed,
            Ok(None) => break,
            Err(e) => {
                tracing::error!(error = %e, "data_migration: réservation impossible");
                break;
            }
        };

        let account_id = claimed.account_id;
        let campaign = &claimed.campaign;

        // Where the module answers. Absent means it is down or was removed -
        // not the account's fault, so the row goes back untouched.
        let base_url = match store::module_base_url(db, &campaign.module_id).await {
            Ok(Some(url)) => url,
            Ok(None) => {
                tracing::warn!(
                    module = %campaign.module_id,
                    campagne = %campaign.id,
                    "data_migration: module absent - migration différée"
                );
                release(db, account_id).await;
                return TickOutcome::ModuleUnreachable;
            }
            Err(e) => {
                tracing::error!(error = %e, "data_migration: adresse du module illisible");
                release(db, account_id).await;
                return TickOutcome::ModuleUnreachable;
            }
        };

        // Opened here, dropped at the end of the iteration. Never logged.
        let password = match store::secret_of(db, account_id).await {
            Ok(sealed) => match store::unseal(jwt_secret, &sealed) {
                Ok(plain) => plain,
                Err(e) => {
                    // The stored blob cannot be opened: the instance secret
                    // changed, or the row was written by another instance.
                    // Retrying will never help, so this is the account's own
                    // failure and it says what to do about it.
                    tracing::error!(compte = %account_id, error = %e, "data_migration: identifiant illisible");
                    fail(
                        db,
                        account_id,
                        "Identifiant du compte source illisible : ressaisissez le mot de passe.",
                    )
                    .await;
                    continue;
                }
            },
            Err(e) => {
                tracing::error!(compte = %account_id, error = %e, "data_migration: identifiant introuvable");
                release(db, account_id).await;
                continue;
            }
        };

        let source = dispatch::SourceCredentials {
            host:     campaign.source_host.clone(),
            // Guarded by a CHECK constraint and by validation at creation, so
            // the clamp is a formality - but a truncating cast would silently
            // dial a different port, and that is a bad thing to be silent about.
            port:     campaign.source_port.clamp(1, 65535) as u16,
            security: campaign.source_security.clone(),
            username: claimed.source_login.clone(),
            password,
        };

        let result = dispatch::run_chunk(
            server,
            &campaign.module_id,
            &base_url,
            &source,
            claimed.target_user_id,
            campaign.since_date,
            &campaign.exclude_folders,
            claimed.cursor.clone().unwrap_or(serde_json::Value::Null),
        )
        .await;

        match result {
            Ok(chunk) if chunk.ok => {
                if let Err(e) = store::record_chunk(
                    db,
                    account_id,
                    chunk.copied,
                    chunk.total,
                    &chunk.cursor,
                    chunk.done,
                )
                .await
                {
                    tracing::error!(compte = %account_id, error = %e, "data_migration: lot non enregistré");
                }
                outcome = TickOutcome::Advanced;
            }
            Ok(chunk) => {
                // The module worked and the SOURCE refused: a wrong password, a
                // server that closed the connection, a mailbox that does not
                // exist. One account's failure, retryable from the console.
                let message = chunk
                    .error
                    .unwrap_or_else(|| "Migration impossible pour ce compte.".into());
                tracing::warn!(compte = %account_id, motif = %message, "data_migration: compte en échec");
                fail(db, account_id, &message).await;
                outcome = TickOutcome::Advanced;
            }
            Err(e) => {
                // Transport: the module is gone, or answered nonsense. Nothing
                // is wrong with this account.
                tracing::error!(compte = %account_id, error = %e, "data_migration: lot non exécuté");
                release(db, account_id).await;
                return TickOutcome::ModuleUnreachable;
            }
        }
    }

    match store::close_finished(db).await {
        Ok(ids) => {
            for id in ids {
                tracing::info!(campagne = %id, "data_migration: campagne terminée");
            }
        }
        Err(e) => tracing::error!(error = %e, "data_migration: clôture des campagnes"),
    }

    outcome
}

async fn release(db: &DbPool, account_id: uuid::Uuid) {
    if let Err(e) = store::release_account(db, account_id).await {
        tracing::error!(compte = %account_id, error = %e, "data_migration: libération du compte");
    }
}

async fn fail(db: &DbPool, account_id: uuid::Uuid, message: &str) {
    if let Err(e) = store::fail_account(db, account_id, message).await {
        tracing::error!(compte = %account_id, error = %e, "data_migration: échec non enregistré");
    }
}
