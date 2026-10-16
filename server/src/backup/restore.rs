//! The hot restore: replace the whole database from a backup file, from the
//! admin console, **without ever spawning `psql`**.
//!
//! ## The order that makes it safe
//!
//! 1. The chosen file is validated - a base name inside the configured
//!    destination, one of our own archives, matching this engine.
//! 2. A **safety backup** of the current state is taken first and recorded, so
//!    the operator can always return to what was there a moment ago.
//! 3. Only then is the archive loaded, in one transaction (COPY for PostgreSQL,
//!    the portable loader for MySQL/SQLite). A failure rolls back and leaves the
//!    database exactly as the safety backup found it; the source archive and the
//!    safety backup are never touched.
//!
//! ## The brief window of inconsistency
//!
//! The load empties and refills every table inside a single transaction, so
//! readers see either the old state or the new one, never a half. What is "hot"
//! is that the instance keeps serving during the load: a request that lands
//! mid-restore may see the pre-restore data until the transaction commits. This
//! is stated on the console next to the button.

use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{DateTime, Utc};
use kubuno_db::{new_id, params, DbPool};
use serde::Serialize;
use uuid::Uuid;

use super::archive;
use super::runs::{self, Trigger};
use crate::errors::AppError;

/// One row of the restore history, as the API serves it.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RestoreRun {
    pub id: Uuid,
    pub triggered_by: Option<Uuid>,
    pub actor_label: Option<String>,
    pub status: String,
    pub source_file: String,
    pub safety_file: Option<String>,
    pub format: Option<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<i64>,
    pub schemas_count: Option<i32>,
    pub rows_count: Option<i64>,
    pub error: Option<String>,
}

/// What a completed restore produced, returned to the console.
#[derive(Debug, Clone, Serialize)]
pub struct RestoreOutcome {
    pub id: Uuid,
    pub source_file: String,
    pub safety_file: String,
    pub rows: u64,
}

const MAX_ERROR_LEN: usize = 2_000;

fn truncate(message: &str) -> String {
    if message.len() <= MAX_ERROR_LEN {
        return message.to_string();
    }
    let mut end = MAX_ERROR_LEN;
    while end > 0 && !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &message[..end])
}

/// Refuses a restore this engine cannot perform, before anything is touched.
///
/// A **portable** archive restores onto any engine (that is the whole point). A
/// legacy PostgreSQL **COPY** archive (`.sql`) is same-engine only.
fn ensure_engine_matches(db: &DbPool, format: &str) -> Result<(), AppError> {
    let ok = match format {
        "portable" => true,
        "postgres" => db.backend() == kubuno_db::Backend::Postgres,
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Cette sauvegarde (format PostgreSQL COPY) ne peut être restaurée que sur une instance PostgreSQL".into(),
        ))
    }
}

/// Performs a hot restore of `file_name` from `destination`.
///
/// `actor` names the administrator for the history. Returns the recorded outcome
/// on success; on failure the database is intact (rolled back), the safety backup
/// exists, and the error is both recorded and returned.
pub async fn restore_from_file(
    db: &DbPool,
    destination: &str,
    file_name: &str,
    actor: Option<(Uuid, String)>,
) -> Result<RestoreOutcome, AppError> {
    // 1. Validate the destination and the name - no traversal, our own file.
    let destination = super::policy::validate_destination(destination)?;
    archive::validate_backup_name(file_name)?;
    let dest_dir = PathBuf::from(&destination);
    let source_path = dest_dir.join(file_name);

    if !tokio::fs::try_exists(&source_path).await.unwrap_or(false) {
        return Err(AppError::NotFound(format!("Sauvegarde introuvable : {file_name}")));
    }
    let format = archive::format_of(file_name);
    ensure_engine_matches(db, format)?;

    let (actor_id, actor_label) = match &actor {
        Some((id, label)) => (Some(*id), Some(label.clone())),
        None => (None, None),
    };

    // 2. Open the restore row before any work, so a crash leaves a visible trace.
    let run_id = open(db, actor_id, actor_label.as_deref(), file_name, format).await?;
    let started = Instant::now();

    // 3. Safety backup FIRST. If it fails, the restore is abandoned - never
    //    replace data without a way back.
    let safety = match take_safety_backup(db, &dest_dir, &actor).await {
        Ok(s) => s,
        Err(e) => {
            let msg = format!("Sauvegarde de secours impossible : {e:#}");
            tracing::error!(run_id = %run_id, error = %msg, "restore: sauvegarde de secours échouée, restauration annulée");
            fail(db, run_id, &msg, started.elapsed().as_millis() as i64).await?;
            return Err(AppError::Internal(anyhow::anyhow!(msg)));
        }
    };
    set_safety_file(db, run_id, &safety.file_name).await;

    // 4. Load the archive. Both loaders are transactional: an error rolls back and
    //    leaves the database as the safety backup found it.
    let result = match format {
        "postgres" => super::dump::restore(db, &source_path).await,
        _ => super::portable::restore(db, &source_path).await,
    };

    match result {
        Ok(rows) => {
            let elapsed = started.elapsed().as_millis() as i64;
            tracing::info!(
                run_id = %run_id,
                source = %file_name,
                secours = %safety.file_name,
                lignes = rows,
                durée_ms = elapsed,
                "Restauration à chaud terminée"
            );
            succeed(db, run_id, safety.schemas as i32, rows as i64, elapsed).await?;
            // Sessions, settings and the like have all changed underneath the
            // caches; drop what can be dropped.
            crate::health::invalidate();
            Ok(RestoreOutcome {
                id: run_id,
                source_file: file_name.to_string(),
                safety_file: safety.file_name,
                rows,
            })
        }
        Err(e) => {
            let elapsed = started.elapsed().as_millis() as i64;
            let msg = format!("{e:#}");
            tracing::error!(run_id = %run_id, error = %msg, "Restauration à chaud échouée - base inchangée");
            fail(db, run_id, &msg, elapsed).await?;
            Err(AppError::Internal(anyhow::anyhow!(
                "Restauration échouée, la base est inchangée. Sauvegarde de secours : {}. Détail : {msg}",
                safety.file_name
            )))
        }
    }
}

/// Writes the pre-restore safety backup and records it as a run of its own, so it
/// appears in the ordinary backup history and rotation.
async fn take_safety_backup(
    db: &DbPool,
    dest_dir: &Path,
    actor: &Option<(Uuid, String)>,
) -> anyhow::Result<super::dump::DumpOutcome> {
    let label = match actor {
        Some((_, l)) if !l.is_empty() => format!("{l} - sauvegarde de secours avant restauration"),
        _ => "Sauvegarde de secours avant restauration".to_string(),
    };
    let run_actor = actor.as_ref().map(|(id, _)| (*id, label.clone()));

    let started = Instant::now();
    let run_id = runs::open(db, Trigger::Manual, run_actor, &dest_dir.to_string_lossy())
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    // The portable writer covers every engine, so the safety backup is itself
    // cross-restorable.
    match super::portable::write_dump(db, dest_dir).await {
        Ok(outcome) => {
            let elapsed = started.elapsed().as_millis() as i64;
            if let Err(e) = runs::succeed(db, run_id, &outcome, elapsed).await {
                tracing::error!(error = %e, "restore: historique de la sauvegarde de secours non écrit");
            }
            Ok(outcome)
        }
        Err(e) => {
            let elapsed = started.elapsed().as_millis() as i64;
            let _ = runs::fail(db, run_id, &format!("{e:#}"), elapsed).await;
            Err(e)
        }
    }
}

// ── bookkeeping (core.backup_restores) ───────────────────────────────────────

async fn open(
    db: &DbPool,
    actor_id: Option<Uuid>,
    actor_label: Option<&str>,
    source_file: &str,
    format: &str,
) -> Result<Uuid, AppError> {
    let id = new_id();
    db.execute(
        "INSERT INTO core.backup_restores (id, triggered_by, actor_label, source_file, format) \
         VALUES ($1, $2, $3, $4, $5)",
        params![id, actor_id, actor_label, source_file, format],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "restore: ouverture d'une restauration impossible");
        AppError::Database(e)
    })?;
    Ok(id)
}

async fn set_safety_file(db: &DbPool, id: Uuid, safety_file: &str) {
    if let Err(e) = db
        .execute(
            "UPDATE core.backup_restores SET safety_file = $1 WHERE id = $2",
            params![safety_file, id],
        )
        .await
    {
        tracing::error!(error = %e, run_id = %id, "restore: enregistrement de la sauvegarde de secours impossible");
    }
}

async fn succeed(
    db: &DbPool,
    id: Uuid,
    schemas_count: i32,
    rows_count: i64,
    duration_ms: i64,
) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.backup_restores \
            SET status = 'success', finished_at = $1, duration_ms = $2, \
                schemas_count = $3, rows_count = $4, error = NULL \
          WHERE id = $5",
        params![Utc::now(), duration_ms.max(0), schemas_count.max(0), rows_count.max(0), id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, run_id = %id, "restore: clôture d'une restauration réussie impossible");
        AppError::Database(e)
    })?;
    Ok(())
}

async fn fail(db: &DbPool, id: Uuid, error: &str, duration_ms: i64) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.backup_restores \
            SET status = 'failed', finished_at = $1, duration_ms = $2, error = $3 \
          WHERE id = $4",
        params![Utc::now(), duration_ms.max(0), truncate(error), id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, run_id = %id, "restore: clôture d'une restauration en échec impossible");
        AppError::Database(e)
    })?;
    Ok(())
}

/// The most recent restores, newest first - for the console.
pub async fn list(db: &DbPool, limit: i64) -> Result<Vec<RestoreRun>, AppError> {
    let limit = limit.clamp(1, 100);
    db.fetch_all_as::<RestoreRun>(
        "SELECT id, triggered_by, actor_label, status, source_file, safety_file, format, \
                started_at, finished_at, duration_ms, schemas_count, rows_count, error \
           FROM core.backup_restores ORDER BY started_at DESC LIMIT $1",
        params![limit],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "restore: lecture de l'historique impossible");
        AppError::Database(e)
    })
}
