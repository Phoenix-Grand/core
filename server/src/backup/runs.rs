//! `core.backup_runs` - the record that turns a backup into something anybody
//! can believe.
//!
//! ## The rule of this file
//!
//! **The row is opened before the work starts.** A history written only on
//! success cannot distinguish "nothing ran" from "something ran and died", and
//! those are opposite emergencies: the first needs a scheduler, the second needs
//! a disk. Opening first also means a process killed mid-dump leaves a visibly
//! stuck `running` row instead of no trace at all - which is exactly the silence
//! this whole feature exists to break.
//!
//! Nothing here ever stores a path outside `destination`, a credential, or a
//! connection string: `file_name` is a base name and `error` is composed from
//! the failing step, never from an input.

use chrono::{DateTime, Duration, Utc};
use kubuno_db::{new_id, params, DbPool, DbQueryBuilder};
use serde::Serialize;
use uuid::Uuid;

use crate::errors::AppError;

/// `core.backup_runs.error` is unbounded `TEXT`; a runaway message is still
/// pointless to keep in full, and the console renders it inline.
const MAX_ERROR_LEN: usize = 2_000;

/// A `running` row older than this belongs to a process that is gone. Generous:
/// a first dump on a large instance is minutes, not hours, and closing a live
/// run as "interrupted" would be a lie in the other direction.
pub const STALE_RUN_HOURS: i64 = 6;

/// Who asked for the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    Scheduled,
    Manual,
}

impl Trigger {
    pub const fn as_str(self) -> &'static str {
        match self {
            Trigger::Scheduled => "scheduled",
            Trigger::Manual => "manual",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "scheduled" => Some(Trigger::Scheduled),
            "manual" => Some(Trigger::Manual),
            _ => None,
        }
    }
}

/// One row of the history, as the API serves it.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct BackupRun {
    pub id: Uuid,
    pub trigger_kind: String,
    pub triggered_by: Option<Uuid>,
    pub actor_label: Option<String>,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<i64>,
    pub file_name: Option<String>,
    pub destination: Option<String>,
    pub size_bytes: Option<i64>,
    pub tables_count: Option<i32>,
    pub rows_count: Option<i64>,
    pub error: Option<String>,
    /// The file this run produced has since been rotated out. The row stays:
    /// "a backup ran that night" and "the file is still there" are two facts.
    pub file_pruned: bool,
}

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

/// Opens a run. Returns its id, which is the only handle the caller needs.
pub async fn open(
    db: &DbPool,
    trigger: Trigger,
    actor: Option<(Uuid, String)>,
    destination: &str,
) -> Result<Uuid, AppError> {
    let (actor_id, actor_label) = match actor {
        Some((id, label)) => (Some(id), Some(label)),
        None => (None, None),
    };

    // The id is generated in Rust and bound explicitly: no engine but PostgreSQL
    // has a `gen_random_uuid()` default, and MySQL has no `RETURNING`.
    let id = new_id();
    db.execute(
        "INSERT INTO core.backup_runs (id, trigger_kind, triggered_by, actor_label, destination) \
         VALUES ($1, $2, $3, $4, $5)",
        params![id, trigger.as_str(), actor_id, actor_label.as_deref(), destination],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "backup: ouverture d'une exécution impossible");
        AppError::Database(e)
    })?;
    Ok(id)
}

/// Closes a run as successful.
pub async fn succeed(
    db: &DbPool,
    id: Uuid,
    outcome: &super::dump::DumpOutcome,
    duration_ms: i64,
) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.backup_runs \
            SET status = 'success', finished_at = $1, duration_ms = $2, \
                file_name = $3, size_bytes = $4, tables_count = $5, rows_count = $6, error = NULL \
          WHERE id = $7",
        params![
            Utc::now(),
            duration_ms.max(0),
            &outcome.file_name,
            outcome.size_bytes as i64,
            outcome.tables as i32,
            outcome.rows as i64,
            id
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, run_id = %id, "backup: clôture d'une exécution réussie impossible");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Closes a run as failed. The message is the operator's only clue, so it is
/// stored verbatim (truncated) rather than reduced to a code.
pub async fn fail(db: &DbPool, id: Uuid, error: &str, duration_ms: i64) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.backup_runs \
            SET status = 'failed', finished_at = $1, duration_ms = $2, error = $3 \
          WHERE id = $4",
        params![Utc::now(), duration_ms.max(0), truncate(error), id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, run_id = %id, "backup: clôture d'une exécution en échec impossible");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Closes rows left `running` by a process that died mid-dump.
///
/// The equivalent of [`crate::jobs::queue::requeue_stalled`], for the history
/// rather than the queue: without it the console would keep showing "a backup is
/// running" for a process that stopped last month, and the concurrency guard
/// below would refuse every new run for ever.
pub async fn close_stalled(db: &DbPool) -> Result<u64, AppError> {
    // The "older than N hours" cutoff is computed in Rust and bound, rather than
    // expressed with `NOW() - make_interval(...)` which no other engine has.
    let now = Utc::now();
    let cutoff = now - Duration::hours(STALE_RUN_HOURS);
    db.execute(
        "UPDATE core.backup_runs \
            SET status = 'failed', finished_at = $1, \
                error = 'Sauvegarde interrompue (processus arrêté en cours d''exécution)' \
          WHERE status = 'running' \
            AND started_at < $2",
        params![now, cutoff],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "backup: reprise des exécutions interrompues impossible");
        AppError::Database(e)
    })
}

/// Is a run already in flight?
///
/// Two dumps at once are not a corruption - the file names differ to the second -
/// but they double the I/O of the one operation an instance runs precisely
/// when it is least able to afford it.
pub async fn is_running(db: &DbPool) -> Result<bool, AppError> {
    db.fetch_scalar::<bool>(
        "SELECT EXISTS (SELECT 1 FROM core.backup_runs WHERE status = 'running')",
        params![],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "backup: lecture des exécutions en cours impossible");
        AppError::Database(e)
    })
}

/// Marks the rows whose file the retention pass has just removed.
pub async fn mark_pruned(db: &DbPool, file_names: &[String]) -> Result<(), AppError> {
    if file_names.is_empty() {
        return Ok(());
    }
    // `file_name = ANY($1)` over an array becomes a variadic `IN (...)`, which
    // every engine has.
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        "UPDATE core.backup_runs SET file_pruned = TRUE WHERE file_name",
    );
    qb.push_in(file_names.iter().map(String::as_str));
    qb.execute(db).await.map_err(|e| {
        tracing::error!(error = %e, "backup: marquage des fichiers supprimés impossible");
        AppError::Database(e)
    })?;
    Ok(())
}

/// The most recent runs, newest first.
pub async fn list(db: &DbPool, limit: i64) -> Result<Vec<BackupRun>, AppError> {
    let limit = limit.clamp(1, 200);
    db.fetch_all_as::<BackupRun>(
        "SELECT id, trigger_kind, triggered_by, actor_label, status, started_at, finished_at, \
                duration_ms, file_name, destination, size_bytes, tables_count, rows_count, \
                error, file_pruned \
           FROM core.backup_runs ORDER BY started_at DESC LIMIT $1",
        params![limit],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "backup: lecture de l'historique impossible");
        AppError::Database(e)
    })
}

/// What the health check and the alert producer both need, in one round trip.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RunStats {
    /// When a backup last actually succeeded. `None` means never - which the
    /// console renders as "never", never as "unknown".
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_success_bytes: Option<i64>,
    pub last_success_file: Option<String>,
    /// Outcome of the most recent attempt, whatever it was.
    pub last_status: Option<String>,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    /// Failures since the last success. One is a bad night; three in a row is a
    /// policy that has stopped working.
    pub consecutive_failures: i64,
    pub total_runs: i64,
}

pub async fn stats(db: &DbPool) -> Result<RunStats, AppError> {
    // `COUNT(*)::bigint` becomes the engine-agnostic `count_bigint`, and the
    // `-infinity` floor of the "failures since the last success" window is bound
    // from Rust as the minimum timestamp rather than expressed with a
    // PostgreSQL-only literal.
    let backend = db.backend();
    let count = backend.count_bigint("*");
    // The Unix epoch, not `DateTime::MIN_UTC`: chrono's minimum year is far below
    // what PostgreSQL/MySQL accept for a timestamp, so binding it fails with
    // "timestamp out of range". Epoch is a valid floor on every engine and is
    // only a COALESCE fallback for "failures since the last success" anyway.
    let floor = DateTime::from_timestamp(0, 0).unwrap_or_else(Utc::now);
    let sql = format!(
        r#"WITH last_ok AS (
               SELECT finished_at, size_bytes, file_name
                 FROM core.backup_runs
                WHERE status = 'success'
                ORDER BY finished_at DESC
                LIMIT 1
           ),
           last_any AS (
               SELECT status, started_at, error
                 FROM core.backup_runs
                WHERE status <> 'running'
                ORDER BY started_at DESC
                LIMIT 1
           )
           SELECT (SELECT finished_at FROM last_ok)                        AS last_success_at,
                  (SELECT size_bytes  FROM last_ok)                        AS last_success_bytes,
                  (SELECT file_name   FROM last_ok)                        AS last_success_file,
                  (SELECT status      FROM last_any)                       AS last_status,
                  (SELECT started_at  FROM last_any)                       AS last_attempt_at,
                  (SELECT error       FROM last_any)                       AS last_error,
                  (SELECT {count} FROM core.backup_runs
                    WHERE status = 'failed'
                      AND started_at > COALESCE((SELECT finished_at FROM last_ok), $1)) AS consecutive_failures,
                  (SELECT {count} FROM core.backup_runs)                   AS total_runs"#
    );

    let row = db
        .fetch_optional_row(&sql, params![floor])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "backup: lecture de l'état des sauvegardes impossible");
            AppError::Database(e)
        })?;
    let Some(row) = row else {
        return Ok(RunStats::default());
    };

    Ok(RunStats {
        last_success_at: row.try_get::<Option<DateTime<Utc>>>("last_success_at").unwrap_or(None),
        last_success_bytes: row.try_get::<Option<i64>>("last_success_bytes").unwrap_or(None),
        last_success_file: row.try_get::<Option<String>>("last_success_file").unwrap_or(None),
        last_status: row.try_get::<Option<String>>("last_status").unwrap_or(None),
        last_attempt_at: row.try_get::<Option<DateTime<Utc>>>("last_attempt_at").unwrap_or(None),
        last_error: row.try_get::<Option<String>>("last_error").unwrap_or(None),
        consecutive_failures: row.try_get::<i64>("consecutive_failures").unwrap_or(0),
        total_runs: row.try_get::<i64>("total_runs").unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triggers_round_trip() {
        assert_eq!(Trigger::parse("manual"), Some(Trigger::Manual));
        assert_eq!(Trigger::parse("scheduled"), Some(Trigger::Scheduled));
        assert_eq!(Trigger::parse("cron"), None);
        assert_eq!(Trigger::Manual.as_str(), "manual");
    }

    #[test]
    fn a_long_error_is_cut_on_a_character_boundary() {
        let long = "é".repeat(4_000);
        let out = truncate(&long);
        assert!(out.len() <= MAX_ERROR_LEN + 4);
        assert!(out.ends_with('…'));
        assert_eq!(truncate("court"), "court");
    }
}
