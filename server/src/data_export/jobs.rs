//! The producer, expressed as two job types of the runner that already exists.
//!
//! There is deliberately **no loop of its own** here, for the same reason
//! [`crate::backup::jobs`] has none: `crate::jobs` already provides claiming with
//! `SKIP LOCKED`, backoff, crash recovery, wake-up by `NOTIFY` and an
//! admin-tunable concurrency, and a timer spawned beside it would be a second
//! thing to supervise, invisible to the panel that supervises the first.
//!
//! ## Two types
//!
//! * [`RUN`] - produces one archive. **Re-enqueues itself** after each batch of
//!   accounts until there are none left.
//! * [`PRUNE`] - the retention pass. Recurring, self-re-arming.
//!
//! ## Why the run is batched
//!
//! `jobs.job_timeout_s` defaults to fifteen minutes, and an export of a real
//! instance is hours. A handler that tried to do it in one call would be killed
//! by the runner, retried from zero, killed again, and would exhaust its
//! attempts having produced nothing - the failure mode being: the bigger the
//! instance, the more certainly the feature does not work.
//!
//! So each invocation works for a **budget** derived from that very timeout, then
//! writes what it has and re-arms. Three properties come out of it:
//!
//!   * a restart or a deployment costs the accounts of one batch, never the run;
//!   * progress is visible while it happens, because `subjects_done` is written
//!     as the work advances rather than at the end;
//!   * a cancellation takes effect within one batch - checked at the top of every
//!     invocation, which is what makes the "cancel a malicious export" story
//!     actually true rather than a button that sets a flag.
//!
//! ## A failed export is not a failed job
//!
//! Same rule as the backup, one degree stronger: a module being unreachable is
//! recorded against the account it happened on, named in the archive's manifest,
//! and the export **continues**. An archive missing one service is useful; an
//! export that fell over because one module was restarting is not. Only a failure
//! of the bookkeeping itself - the run row, the archive - closes the run as
//! failed.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde_json::json;
use kubuno_db::DbPool;
use uuid::Uuid;

use super::{archive, contract, core_data, policy, runs};
use crate::config::settings::ServerSettings;
use crate::errors::AppError;
use crate::jobs::queue::{self, NewJob};
use crate::jobs::registry::JobRegistry;

/// Produces one archive.
pub const RUN: &str = "core.data_export.run";

/// Deletes the archives whose retention has elapsed.
pub const PRUNE: &str = "core.data_export.prune";

/// How often the retention pass runs. Hourly rather than daily: `expires_at` is
/// an exact moment an operator was shown, and an archive still downloadable
/// eleven hours after the date on screen makes the whole window meaningless.
const PRUNE_INTERVAL: Duration = Duration::from_secs(3_600);

/// Accounts examined between two checks of the time budget. Small on purpose:
/// the budget is only honoured between accounts, so a large step is a large
/// overshoot.
const BATCH: i64 = 4;

/// Fallback budget when `jobs.job_timeout_s` cannot be read.
const DEFAULT_BUDGET: Duration = Duration::from_secs(600);

/// The service id the core answers for. Always present in an archive: an export
/// with every module unticked still says who the person is, and every other
/// file refers to that one.
pub const CORE_SERVICE: &str = "core";

// ── Registration ─────────────────────────────────────────────────────────────

/// Registers both job types.
///
/// `server` is captured because producing an archive means calling **modules**,
/// which is an authenticated internal call, and a [`crate::jobs::JobContext`]
/// carries a pool and nothing else.
pub fn register(registry: &mut JobRegistry, server: Arc<ServerSettings>) {
    let for_run = Arc::clone(&server);
    registry.register_fn(RUN, move |ctx, job| {
        let server = Arc::clone(&for_run);
        async move {
            let Some(export_id) = job
                .payload
                .get("export_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                // Not retried: a payload without a run id will never acquire one,
                // and three attempts would only delay the log line that matters.
                anyhow::bail!("Charge utile d'export sans identifiant d'exécution");
            };

            match advance(&ctx.db, &server, export_id, job.id).await {
                Ok(()) => Ok(()),
                Err(e) => {
                    // The run has already been closed as failed by `advance`
                    // whenever it could be; reaching here means the bookkeeping
                    // itself is what broke, and the queue's own machinery is the
                    // last thing still watching.
                    tracing::error!(error = %e, export_id = %export_id,
                        "export: production de l'archive impossible");
                    Err(anyhow::anyhow!("Export {export_id} : {e}"))
                }
            }
        }
    });

    registry.register_fn(PRUNE, |ctx, job| async move {
        if let Err(e) = runs::close_stalled(&ctx.db).await {
            tracing::error!(error = %e, "export: reprise des exécutions interrompues");
        }
        if let Err(e) = prune(&ctx.db).await {
            tracing::error!(error = %e, "export: purge des archives expirées impossible");
        }
        // Re-armed whatever happened: one failed pass must not stop the
        // retention for ever, and the next one will find the same files.
        let next = NewJob::new(PRUNE).delay(PRUNE_INTERVAL);
        if let Err(e) = queue::reschedule_after(&ctx.db, next, job.id).await {
            tracing::error!(error = %e, "export: replanification de la purge impossible");
        }
        Ok(())
    });
}

/// Arms the retention pass at startup. Idempotent across restarts and across
/// several core processes.
pub async fn schedule(db: &DbPool) {
    match queue::ensure_scheduled(db, NewJob::new(PRUNE).delay(PRUNE_INTERVAL)).await {
        Ok(Some(id)) => tracing::info!(job_id = %id, "Purge des exports planifiée"),
        Ok(None) => tracing::debug!("Purge des exports déjà planifiée"),
        Err(_) => { /* already logged by the queue */ }
    }
}

/// Enqueues the production of one archive.
pub async fn enqueue_run(db: &DbPool, export_id: Uuid) -> Result<Uuid, AppError> {
    let job = NewJob::new(RUN)
        // Exactly one attempt. A retry would restart the batch on a run whose
        // state already says where it got to, and the retry of a *bookkeeping*
        // failure is the runner replaying a job whose database is unavailable -
        // three times, with a backoff, for nothing.
        .max_attempts(1)
        .payload(json!({ "export_id": export_id.to_string() }));

    queue::enqueue(db, job).await.map_err(|e| {
        tracing::error!(error = %e, export_id = %export_id, "export: mise en file impossible");
        AppError::Database(e)
    })
}

// ── One invocation ───────────────────────────────────────────────────────────

/// Works on one run for one budget, then either re-arms or seals the archive.
async fn advance(
    db: &DbPool,
    server: &ServerSettings,
    export_id: Uuid,
    job_id: Uuid,
) -> Result<(), AppError> {
    let Some(run) = runs::get(db, export_id).await? else {
        tracing::warn!(export_id = %export_id, "export: exécution introuvable - tâche abandonnée");
        return Ok(());
    };

    let pol = policy::load(db).await;
    let destination = PathBuf::from(
        run.destination
            .clone()
            .unwrap_or_else(|| pol.destination.clone()),
    );

    // The cancellation check, first, on every invocation. This is what makes the
    // "cancel a malicious export" story true: an operator who cancels during the
    // hold stops the remaining batches, and the staging tree goes with them.
    if run.status != "pending" && run.status != "running" {
        tracing::info!(export_id = %export_id, statut = %run.status,
            "export: exécution close - production interrompue");
        archive::discard_staging(&destination, export_id).await;
        return Ok(());
    }

    if run.status == "pending" && !runs::start(db, export_id).await? {
        // Somebody else claimed it, or it was cancelled between the read and the
        // write. Either way this invocation has nothing to do.
        return Ok(());
    }

    let started = Instant::now();
    let staging = match archive::prepare(&destination, export_id).await {
        Ok(s) => s,
        Err(e) => {
            let message = format!("{e:#}");
            tracing::error!(export_id = %export_id, error = %message,
                "export: préparation du répertoire impossible");
            runs::fail(db, export_id, &message, 0).await?;
            return Ok(());
        }
    };

    // Instance referentials, once. Guarded by the presence of the first file
    // rather than by the run's status: a process killed just after `start` would
    // otherwise leave a run whose instance folder is empty for ever.
    if run.with_instance && !staging.join("instance/comptes.json").exists() {
        if let Err(e) = write_instance(db, &staging).await {
            tracing::error!(export_id = %export_id, error = %e,
                "export: extraction des référentiels d'instance impossible");
            runs::fail(db, export_id, &format!("Référentiels d'instance : {e}"), 0).await?;
            return Ok(());
        }
    }

    // What every account will be asked of, resolved once per invocation and not
    // once per account: a module list re-read fifty times would make a module
    // restarting mid-export produce fifty different archives.
    let plan = build_plan(db, server, &run.services).await;
    let budget = budget_of(db).await;

    loop {
        let pending = runs::pending_subjects(db, export_id, BATCH).await?;
        if pending.is_empty() {
            break;
        }
        for subject in &pending {
            process_subject(db, server, &run, &plan, &pol, &staging, subject).await?;
        }
        if started.elapsed() >= budget {
            // Re-armed rather than continued: the runner would kill this task at
            // `jobs.job_timeout_s`, and a run killed mid-account is a run that
            // repeats the account it was on.
            tracing::debug!(export_id = %export_id, "export: budget épuisé - lot suivant replanifié");
            let next = NewJob::new(RUN)
                .max_attempts(1)
                .payload(json!({ "export_id": export_id.to_string() }));
            if let Err(e) = queue::reschedule_after(db, next, job_id).await {
                tracing::error!(error = %e, export_id = %export_id,
                    "export: replanification du lot suivant impossible");
                return Err(AppError::Database(e));
            }
            return Ok(());
        }
    }

    finalise(db, &run, &staging, &destination, export_id).await
}

/// Which module answers for which of the requested services.
///
/// Discovered, never listed: see [`super::contract`]. A service the operator
/// asked for that no live module claims any more is simply absent from the plan,
/// and every account records it as missing - which is what the manifest then
/// says, in as many words.
async fn build_plan(
    db: &DbPool,
    server: &ServerSettings,
    requested: &[String],
) -> BTreeMap<String, (String, Vec<String>)> {
    let wanted: Vec<&str> = requested
        .iter()
        .map(String::as_str)
        .filter(|s| *s != CORE_SERVICE)
        .collect();
    if wanted.is_empty() {
        return BTreeMap::new();
    }

    let mut plan: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    for offer in contract::describe_all(db, server).await {
        let kept: Vec<String> = offer
            .services
            .iter()
            .filter(|s| wanted.contains(&s.id.as_str()))
            .map(|s| s.id.clone())
            .collect();
        if kept.is_empty() {
            continue;
        }
        let Some(base_url) = contract::base_url_of(db, &offer.module_id).await else {
            continue;
        };
        plan.insert(offer.module_id.clone(), (base_url, kept));
    }
    plan
}

/// The wall-clock budget of one invocation.
///
/// Two thirds of `jobs.job_timeout_s`: the remaining third is what an account
/// already in flight needs to finish before the runner would kill the task.
async fn budget_of(db: &DbPool) -> Duration {
    let timeout = crate::settings::instance_value(db, "jobs.job_timeout_s")
        .await
        .as_ref()
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(900)
        .clamp(60, 86_400);
    if timeout <= 0 {
        return DEFAULT_BUDGET;
    }
    Duration::from_secs((timeout as u64 * 2 / 3).max(30))
}

// ── The instance folder ──────────────────────────────────────────────────────

async fn write_instance(db: &DbPool, staging: &std::path::Path) -> Result<(), String> {
    // `comptes.json` is written FIRST and is what the resumption guard above
    // looks for. Any other order would let a crash between two extracts leave a
    // marker claiming a folder that is only half there.
    let accounts = core_data::instance_accounts(db).await.map_err(err)?;
    put(staging, "instance/comptes.json", &pretty(&accounts)).await?;

    let groups = core_data::instance_groups(db).await.map_err(err)?;
    put(staging, "instance/groupes.json", &pretty(&groups)).await?;

    let units = core_data::instance_org_units(db).await.map_err(err)?;
    put(
        staging,
        "instance/unites-organisationnelles.json",
        &pretty(&units),
    )
    .await?;

    let settings = core_data::instance_settings(db).await.map_err(err)?;
    put(staging, "instance/reglages.json", &pretty(&settings)).await?;

    let audit = core_data::instance_audit_csv(db).await.map_err(err)?;
    put(staging, "instance/journal-audit.csv", audit.as_bytes()).await?;

    Ok(())
}

/// Writes one staged file, reducing the error to the sentence an operator reads.
async fn put(root: &std::path::Path, relative: &str, body: &[u8]) -> Result<(), String> {
    archive::write_file(root, relative, body)
        .await
        .map_err(|e| format!("{e:#}"))
}

// ── One account ──────────────────────────────────────────────────────────────

/// Exports one account: the core's own record, then every planned module.
///
/// Returns `Err` only when the *subject row* could not be closed. Everything
/// else - an unreachable module, a refused entry, an extraction that failed - is
/// recorded and carried into the manifest.
async fn process_subject(
    db: &DbPool,
    server: &ServerSettings,
    run: &runs::ExportRun,
    plan: &BTreeMap<String, (String, Vec<String>)>,
    pol: &policy::Policy,
    staging: &std::path::Path,
    subject: &runs::ExportSubject,
) -> Result<(), AppError> {
    let Some(user_id) = subject.user_id else {
        // The account was erased between the request and now. Recorded as such
        // rather than skipped: "this person was in the export and is gone" is
        // exactly the kind of thing a reader must not have to infer.
        runs::finish_subject(
            db,
            run.id,
            subject.id,
            "failed",
            0,
            &[],
            &[],
            Some("Le compte a été supprimé avant son traitement"),
        )
        .await?;
        return Ok(());
    };

    // The per-file ceiling of THIS run. A requester may have chosen a tighter one
    // (the personal export offers it, so a large mailbox comes back as something
    // that fits on the disk they are copying it to); nobody may choose a wider
    // one, because the policy's value is the instance's protection rather than a
    // preference - `SelfPolicy::resolve_max_file_mb` clamps on the way in and the
    // column is frozen at creation.
    let max_file_bytes = subject_file_ceiling(run, pol);

    let folder = format!("comptes/{}", subject.folder);
    let mut ok: Vec<String> = Vec::new();
    let mut ko: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut bytes: u64 = 0;

    // ── The core's own record ───────────────────────────────────────────────
    match write_account_core(db, staging, &folder, user_id).await {
        Ok(written) => {
            bytes = bytes.saturating_add(written);
            ok.push(CORE_SERVICE.to_string());
        }
        Err(e) => {
            ko.push(CORE_SERVICE.to_string());
            notes.push(format!("core : {e}"));
        }
    }

    // ── The modules ─────────────────────────────────────────────────────────
    for (module_id, (base_url, services)) in plan {
        let temp = staging.join(format!(".{}-{module_id}.zip", subject.folder));
        let payload = contract::fetch_account(
            server,
            module_id,
            base_url,
            run.id,
            user_id,
            services,
            pol.module_timeout(),
            &temp,
        )
        .await;

        match payload {
            Ok(contract::ModulePayload::Empty) => {
                // Nothing to say, and deliberately not an error: the account
                // simply holds nothing there. It is not listed as produced
                // either, so the manifest never claims a folder that is absent.
            }
            Ok(contract::ModulePayload::Archive(path)) => {
                let target = staging.join(&folder);
                match archive::merge_module_zip(
                    path.clone(),
                    target,
                    services.to_vec(),
                    max_file_bytes,
                )
                .await
                {
                    Ok(outcome) => {
                        bytes = bytes.saturating_add(outcome.bytes);
                        for skipped in &outcome.skipped {
                            notes.push(format!("{module_id} : {skipped}"));
                        }
                        if outcome.files > 0 {
                            ok.extend(services.iter().cloned());
                        }
                        if outcome.files == 0 && !outcome.skipped.is_empty() {
                            ko.extend(services.iter().cloned());
                        }
                    }
                    Err(e) => {
                        ko.extend(services.iter().cloned());
                        notes.push(format!("{module_id} : extraction impossible ({e:#})"));
                    }
                }
                let _ = tokio::fs::remove_file(&path).await;
            }
            Err(message) => {
                ko.extend(services.iter().cloned());
                notes.push(message);
            }
        }
    }

    // Services the operator asked for that no live module claims any more.
    for service in run.services.iter().filter(|s| s.as_str() != CORE_SERVICE) {
        let planned = plan.values().any(|(_, s)| s.contains(service));
        if !planned && !ko.contains(service) {
            ko.push(service.clone());
            notes.push(format!(
                "{service} : aucun module actif ne fournit ce service"
            ));
        }
    }

    let status = if ko.is_empty() {
        "done"
    } else if ok.is_empty() {
        "failed"
    } else {
        "partial"
    };
    let error = (!notes.is_empty()).then(|| notes.join(" · "));

    runs::finish_subject(
        db,
        run.id,
        subject.id,
        status,
        bytes,
        &ok,
        &ko,
        error.as_deref(),
    )
    .await
}

/// Largest single file admitted into this run's archive, in bytes.
///
/// The run's own value when it has one, the policy's otherwise - read at the
/// moment the job runs, which is what every export produced before migration
/// `000122` did and keeps doing.
fn subject_file_ceiling(run: &runs::ExportRun, pol: &policy::Policy) -> u64 {
    match run.max_file_mb {
        Some(mb) if mb > 0 => (mb as u64).saturating_mul(1024 * 1024),
        _ => pol.max_file_bytes(),
    }
}

/// The three files the core writes for every account.
async fn write_account_core(
    db: &DbPool,
    staging: &std::path::Path,
    folder: &str,
    user_id: Uuid,
) -> Result<u64, String> {
    let mut bytes = 0u64;

    let profile = core_data::account_profile(db, user_id).await.map_err(err)?;
    let body = pretty(&profile);
    bytes += body.len() as u64;
    archive::write_file(staging, &format!("{folder}/compte.json"), &body)
        .await
        .map_err(|e| format!("{e:#}"))?;

    let devices = core_data::account_devices(db, user_id).await.map_err(err)?;
    let body = pretty(&devices);
    bytes += body.len() as u64;
    archive::write_file(staging, &format!("{folder}/appareils.json"), &body)
        .await
        .map_err(|e| format!("{e:#}"))?;

    let audit = core_data::account_audit_csv(db, user_id).await.map_err(err)?;
    bytes += audit.len() as u64;
    archive::write_file(
        staging,
        &format!("{folder}/journal-audit.csv"),
        audit.as_bytes(),
    )
    .await
    .map_err(|e| format!("{e:#}"))?;

    Ok(bytes)
}

// ── Sealing ──────────────────────────────────────────────────────────────────

/// Writes the manifest and the readme, seals the archive, closes the run.
async fn finalise(
    db: &DbPool,
    run: &runs::ExportRun,
    staging: &std::path::Path,
    destination: &std::path::Path,
    export_id: Uuid,
) -> Result<(), AppError> {
    let subjects = runs::subjects(db, export_id).await?;
    let started = Instant::now();

    let manifest = json!({
        "produit_le":        Utc::now(),
        "instance":          crate::mailer::instance_name(db).await,
        "export_id":         export_id,
        "contrat_module":    contract::CONTRACT_VERSION,
        "perimetre":         run.scope,
        "services_demandes": run.services,
        "referentiels_instance": run.with_instance,
        "demande_par":       run.actor_label,
        "demande_le":        run.requested_at,
        "disponible_le":     run.available_at,
        "expire_le":         run.expires_at,
        "comptes": subjects.iter().map(|s| json!({
            "dossier":          s.folder,
            "compte":           s.user_label,
            "etat":             s.status,
            "services_produits": s.services_ok,
            "services_absents":  s.services_ko,
            "remarques":         s.error,
        })).collect::<Vec<_>>(),
        // Repeated in the file itself so the claim travels with the archive: the
        // person reading it six months from now has no access to this console.
        "jamais_inclus": [
            "mots de passe et leurs empreintes",
            "jetons de session, d'API ou de vérification",
            "secrets de double authentification et codes de secours",
            "secrets des fournisseurs d'authentification externes",
            "clés et secrets de configuration du serveur",
        ],
    });
    if let Err(e) = archive::write_file(staging, "MANIFESTE.json", &pretty(&manifest)).await {
        tracing::error!(error = %e, export_id = %export_id, "export: manifeste non écrit");
    }

    let readme = readme_text(run, &subjects);
    if let Err(e) = archive::write_file(staging, "LISEZ-MOI.txt", readme.as_bytes()).await {
        tracing::error!(error = %e, export_id = %export_id, "export: notice non écrite");
    }

    match archive::seal(
        staging.to_path_buf(),
        destination.to_path_buf(),
        export_id,
    )
    .await
    {
        Ok(outcome) => {
            let elapsed = started.elapsed().as_millis() as i64;
            tracing::info!(
                export_id = %export_id,
                fichier = %outcome.file_name,
                octets = outcome.size_bytes,
                entrées = outcome.entries,
                comptes = subjects.len(),
                "Archive d'export produite"
            );
            runs::succeed(
                db,
                export_id,
                &outcome.file_name,
                outcome.size_bytes,
                outcome.entries,
                elapsed,
            )
            .await?;
            // Only once the archive is safely renamed into place: a cleanup that
            // ran first would delete the source of a seal that then failed.
            archive::discard_staging(destination, export_id).await;
        }
        Err(e) => {
            let message = format!("{e:#}");
            tracing::error!(export_id = %export_id, error = %message, "export: archive non scellée");
            runs::fail(db, export_id, &message, 0).await?;
            archive::discard_staging(destination, export_id).await;
        }
    }
    Ok(())
}

/// The notice a human opens first.
fn readme_text(run: &runs::ExportRun, subjects: &[runs::ExportSubject]) -> String {
    let mut out = String::new();
    out.push_str("EXPORT DE DONNÉES KUBUNO\n========================\n\n");
    out.push_str(&format!(
        "Demandé le      : {}\nDemandé par     : {}\nPérimètre       : {}\nComptes couverts: {}\n\n",
        run.requested_at.format("%d/%m/%Y %H:%M UTC"),
        run.actor_label.as_deref().unwrap_or("-"),
        if run.scope == "instance" {
            "toute l'instance"
        } else {
            "une sélection de comptes"
        },
        subjects.len(),
    ));
    out.push_str(
        "ORGANISATION\n\
         ------------\n\
         MANIFESTE.json  ce que contient précisément cette archive, compte par compte.\n\
         instance/       les référentiels de l'instance (comptes, groupes, unités,\n\
                         réglages, journal d'audit), lorsqu'ils ont été demandés.\n\
         comptes/        un dossier par compte ; à l'intérieur, un dossier par service.\n\n",
    );
    out.push_str(
        "CE QUI N'Y EST PAS, ET N'Y SERA JAMAIS\n\
         --------------------------------------\n\
         Aucun mot de passe ni empreinte de mot de passe, aucun jeton de session,\n\
         d'API ou de vérification, aucun secret de double authentification, aucun\n\
         secret de configuration du serveur. Cette archive permet de LIRE des\n\
         données ; elle ne permet jamais de se connecter à quoi que ce soit.\n\n",
    );
    out.push_str(&format!(
        "CONSERVATION\n\
         ------------\n\
         Cette archive est supprimée automatiquement du serveur le {}.\n\
         Le fichier que vous avez téléchargé, lui, ne l'est pas : il contient des\n\
         données personnelles et doit être protégé et effacé en conséquence.\n",
        run.expires_at.format("%d/%m/%Y à %H:%M UTC"),
    ));

    let incomplete: Vec<&runs::ExportSubject> =
        subjects.iter().filter(|s| s.status != "done").collect();
    if !incomplete.is_empty() {
        out.push_str(&format!(
            "\nATTENTION : EXPORT PARTIEL\n\
             --------------------------\n\
             {} compte(s) sur {} sont incomplets. Le détail, service par service,\n\
             figure dans MANIFESTE.json.\n",
            incomplete.len(),
            subjects.len(),
        ));
    }
    out
}

// ── Retention ────────────────────────────────────────────────────────────────

/// Deletes every archive whose retention has elapsed, and records it.
///
/// The row survives: "an export of everyone was produced that day" must outlive
/// the file by years - see [`super::runs`].
pub async fn prune(db: &DbPool) -> Result<u64, AppError> {
    let expired = runs::expired_files(db).await?;
    let mut removed = 0u64;

    // Grouped so one unreadable directory does not stop the pass on another.
    let mut by_dir: HashMap<String, Vec<(Uuid, String)>> = HashMap::new();
    for (id, destination, file_name) in expired {
        by_dir
            .entry(destination)
            .or_default()
            .push((id, file_name));
    }

    for (destination, files) in by_dir {
        let dir = PathBuf::from(&destination);
        for (id, file_name) in files {
            match archive::delete_archive(&dir, &file_name).await {
                Ok(()) => {
                    runs::mark_file_deleted(db, id, true).await?;
                    removed += 1;
                    tracing::info!(export_id = %id, fichier = %file_name,
                        "Archive d'export supprimée (rétention écoulée)");
                }
                Err(e) => tracing::error!(error = %format!("{e:#}"), export_id = %id,
                    "export: suppression d'une archive expirée impossible"),
            }
        }
    }
    Ok(removed)
}

// ── Small helpers ────────────────────────────────────────────────────────────

fn err(e: AppError) -> String {
    e.to_string()
}

/// JSON an operator can read in a text editor. The archive is compressed, so the
/// indentation costs nothing on disk and buys everything on the other side.
fn pretty(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec_pretty(value).unwrap_or_else(|e| {
        tracing::error!(error = %e, "export: sérialisation JSON impossible");
        b"null".to_vec()
    })
}
