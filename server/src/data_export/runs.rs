//! `core.data_export_runs` and `core.data_export_subjects` - the record of every
//! archive the instance ever produced.
//!
//! ## The rule of this file
//!
//! **The row is opened before the work starts, and it outlives the file.** The
//! first half is the discipline `core.backup_runs` follows, for the same reason:
//! a history written only on success cannot tell "nothing ran" from "something
//! ran and died".
//!
//! The second half is specific to this feature and is the more important one. An
//! archive is deleted - by the retention pass, by an operator, by a
//! cancellation. The row is not. "An export covering these 214 accounts was
//! produced on 14 August, by this person, and downloaded twice" is a fact an
//! investigation starts from, and it must survive the file it describes by
//! years. Every deletion path in this module therefore sets `file_deleted` and
//! keeps everything else.
//!
//! Nothing here ever stores a path outside `destination`, and `error` is
//! composed from the failing step rather than from an input.

use chrono::{DateTime, Utc};
use kubuno_db::{new_id, params, DbPool};
use serde::Serialize;
use uuid::Uuid;

use crate::errors::AppError;

/// `error` is unbounded `TEXT`; a runaway message is still pointless to keep in
/// full, and the console renders it inline.
const MAX_ERROR_LEN: usize = 2_000;

/// A run left `running` by a process that died. Generous: an export of a large
/// instance genuinely takes hours, and closing a live run as "interrupted" would
/// destroy work and lie about it.
pub const STALE_RUN_HOURS: i64 = 24;

// ── Wire types ───────────────────────────────────────────────────────────────

/// One row of the history, as the API serves it.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ExportRun {
    pub id: Uuid,
    pub scope: String,
    /// `admin` (requested from the console) or `self` (an account asking for its
    /// own data). Migration `000122`.
    pub origin: String,
    // List columns travel as JSON so they decode identically on every engine.
    #[sqlx(json)]
    pub services: Vec<String>,
    pub with_instance: bool,
    pub requested_by: Option<Uuid>,
    pub actor_label: Option<String>,
    pub status: String,
    pub requested_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<i64>,
    /// When the archive becomes downloadable. In the future while the hold runs.
    pub available_at: DateTime<Utc>,
    /// When the retention pass removes it.
    pub expires_at: DateTime<Utc>,
    pub subjects_total: i32,
    pub subjects_done: i32,
    pub file_name: Option<String>,
    pub destination: Option<String>,
    pub size_bytes: Option<i64>,
    pub entries_count: Option<i32>,
    pub error: Option<String>,
    pub file_deleted: bool,
    pub deleted_at: Option<DateTime<Utc>>,
    pub download_count: i32,
    pub last_downloaded_at: Option<DateTime<Utc>>,
    /// How many times this archive may be fetched in all. `None` = no ceiling,
    /// which is what an administrator's archive carries (the audit trail is the
    /// control there).
    pub download_limit: Option<i32>,
    /// The per-file ceiling frozen at creation, when the requester chose one.
    /// `None` = whatever the policy says when the job runs.
    pub max_file_mb: Option<i32>,
}

impl ExportRun {
    /// Downloads still allowed, or `None` when there is no ceiling.
    ///
    /// Saturated at zero: a counter that ran past its ceiling (a limit lowered
    /// by hand in the database) must read as "none left", never as a negative
    /// number the interface would then render.
    pub fn downloads_left(&self) -> Option<i32> {
        self.download_limit
            .map(|limit| (limit - self.download_count).max(0))
    }

    /// True when the ceiling has been reached. Always false without a ceiling.
    pub fn download_exhausted(&self) -> bool {
        matches!(self.downloads_left(), Some(0))
    }

    /// Can this archive be handed over right now?
    ///
    /// Four conditions, and the caller must never re-derive them from two of
    /// them: the run finished, the hold has elapsed, the file has not been
    /// removed, and the retention has not passed.
    pub fn is_downloadable(&self, now: DateTime<Utc>) -> bool {
        self.status == "ready" && !self.file_deleted && now >= self.available_at && now < self.expires_at
    }
}

/// One account inside one export.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ExportSubject {
    pub id: Uuid,
    pub user_id: Option<Uuid>,
    pub user_label: String,
    pub folder: String,
    pub status: String,
    pub size_bytes: Option<i64>,
    // List columns travel as JSON so they decode identically on every engine.
    #[sqlx(json)]
    pub services_ok: Vec<String>,
    #[sqlx(json)]
    pub services_ko: Vec<String>,
    pub error: Option<String>,
}

/// What the console - or an account asking for its own data - asked for,
/// validated.
pub struct NewExport {
    pub scope: String,
    /// `ORIGIN_ADMIN` or `ORIGIN_SELF`.
    pub origin: &'static str,
    pub services: Vec<String>,
    pub with_instance: bool,
    pub requested_by: Uuid,
    pub actor_label: String,
    pub available_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub destination: String,
    /// Download ceiling of this archive, `None` for no ceiling.
    pub download_limit: Option<i32>,
    /// Per-file ceiling chosen by the requester, `None` to follow the policy.
    pub max_file_mb: Option<i32>,
    /// `(user_id, label, folder)`, folders already made unique by the caller.
    pub subjects: Vec<(Uuid, String, String)>,
}

/// Requested from the administration console, for other accounts.
pub const ORIGIN_ADMIN: &str = "admin";

/// Requested by an account, for itself, from its own settings.
pub const ORIGIN_SELF: &str = "self";

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

// ── Creation ─────────────────────────────────────────────────────────────────

/// Opens a run and its subjects, atomically.
///
/// One transaction, deliberately: a run whose subject list is half written would
/// export half an organisation and report success. The whole point of the
/// subjects table is that it says who is in the archive, and a partial answer
/// there is worse than none.
pub async fn create(db: &DbPool, new: &NewExport) -> Result<Uuid, AppError> {
    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "export: ouverture de transaction impossible");
        AppError::Database(e)
    })?;

    // The key is generated in Rust and bound explicitly rather than read back
    // through RETURNING, which not every engine offers.
    let id = new_id();
    tx.execute(
        "INSERT INTO core.data_export_runs \
             (id, scope, origin, services, with_instance, requested_by, actor_label, \
              available_at, expires_at, destination, subjects_total, \
              download_limit, max_file_mb) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        params![
            id,
            &new.scope,
            new.origin,
            new.services.clone(),
            new.with_instance,
            new.requested_by,
            &new.actor_label,
            new.available_at,
            new.expires_at,
            &new.destination,
            new.subjects.len() as i32,
            new.download_limit,
            new.max_file_mb
        ],
    )
    .await
    .map_err(|e| {
        // The unique index `uq_core_data_export_self_active` lands here when two
        // requests for the same account race. The caller turns it into a
        // sentence; what matters at this level is that the second one never
        // opens a second run.
        tracing::error!(error = %e, origin = %new.origin,
            "export: ouverture d'une exécution impossible");
        match e.as_database_error().and_then(|d| d.constraint()) {
            Some("uq_core_data_export_self_active") => AppError::Conflict(
                "An export request is already in progress for this account".into(),
            ),
            _ => AppError::Database(e),
        }
    })?;

    for (user_id, label, folder) in &new.subjects {
        let subject_id = new_id();
        tx.execute(
            "INSERT INTO core.data_export_subjects (id, export_id, user_id, user_label, folder) \
             VALUES ($1, $2, $3, $4, $5)",
            params![subject_id, id, user_id, label, folder],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, export_id = %id, "export: inscription d'un compte impossible");
            AppError::Database(e)
        })?;
    }

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "export: validation de la transaction impossible");
        AppError::Database(e)
    })?;
    Ok(id)
}

// ── Reads ────────────────────────────────────────────────────────────────────

// A macro rather than a `const` so the reads below splice it with `concat!` and
// hand the driver one compile-time literal.
macro_rules! run_columns {
    () => {
        "id, scope, origin, services, with_instance, requested_by, actor_label, status, \
     requested_at, started_at, finished_at, duration_ms, available_at, expires_at, \
     subjects_total, subjects_done, file_name, destination, size_bytes, entries_count, \
     error, file_deleted, deleted_at, download_count, last_downloaded_at, \
     download_limit, max_file_mb"
    };
}

/// The statement behind the two lookups above, built around a literal predicate.
///
/// A macro rather than a runtime `format!`: `concat!` keeps the whole thing a
/// compile-time `&'static str`, so the query the driver receives is a literal
/// and the predicate physically cannot be anything a request produced.
macro_rules! active_sql {
    ($predicate:literal) => {
        concat!(
            "SELECT ",
            run_columns!(),
            " FROM core.data_export_runs WHERE status IN ('pending', 'running') AND ",
            $predicate,
            " ORDER BY requested_at LIMIT 1"
        )
    };
}

pub async fn get(db: &DbPool, id: Uuid) -> Result<Option<ExportRun>, AppError> {
    db.fetch_optional_as::<ExportRun>(
        concat!(
            "SELECT ",
            run_columns!(),
            " FROM core.data_export_runs WHERE id = $1"
        ),
        params![id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, export_id = %id, "export: lecture d'une exécution impossible");
        AppError::Database(e)
    })
}

/// One **administrative** run, or `None`.
///
/// What the console reads, everywhere it reads one. A personal archive is not an
/// administrative object: it is produced without the alert and without the hold
/// that make an administrative export supervisable, and `core.data_export.read` -
/// held by the read-only administrator out of the box - must therefore not be
/// a way to fetch one. Whoever needs somebody else's data asks for it with
/// `core.data_export.execute`, which tells every administrator and waits.
pub async fn get_admin(db: &DbPool, id: Uuid) -> Result<Option<ExportRun>, AppError> {
    db.fetch_optional_as::<ExportRun>(
        concat!(
            "SELECT ",
            run_columns!(),
            " FROM core.data_export_runs WHERE id = $1 AND origin = 'admin'"
        ),
        params![id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, export_id = %id, "export: lecture d'une exécution impossible");
        AppError::Database(e)
    })
}

/// One run **owned by** `user_id`, or `None`.
///
/// The read the personal routes use, and the only one they use: the owner is a
/// condition of the query rather than a check performed on the result, so a
/// handler cannot forget it and cannot be given an id belonging to somebody
/// else. `origin` is part of the predicate too - an administrator's archive
/// covering several accounts is not "one's own data" even when the requester
/// happens to be its author.
pub async fn get_own(db: &DbPool, id: Uuid, user_id: Uuid) -> Result<Option<ExportRun>, AppError> {
    db.fetch_optional_as::<ExportRun>(
        concat!(
            "SELECT ",
            run_columns!(),
            " FROM core.data_export_runs WHERE id = $1 AND requested_by = $2 AND origin = 'self'"
        ),
        params![id, user_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, export_id = %id, "export: lecture d'une demande personnelle impossible");
        AppError::Database(e)
    })
}

/// The most recent **administrative** runs, newest first.
///
/// Personal requests are excluded for the same reason [`get_admin`] excludes
/// them, plus a practical one: on an instance where everybody exercises their
/// portability right, they would be the entire history and the operator would
/// stop reading it.
pub async fn list(db: &DbPool, limit: i64) -> Result<Vec<ExportRun>, AppError> {
    let limit = limit.clamp(1, 200);
    db.fetch_all_as::<ExportRun>(
        concat!(
            "SELECT ",
            run_columns!(),
            " FROM core.data_export_runs WHERE origin = 'admin' ORDER BY requested_at DESC LIMIT $1"
        ),
        params![limit],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "export: lecture de l'historique impossible");
        AppError::Database(e)
    })
}

/// The **administrative** run currently pending or under way, if any.
///
/// One administrative export at a time, instance-wide. Not a technical limit -
/// two concurrent exports would work - but a deliberate one: they compete for
/// the same disk and the same modules, and, more to the point, "how many exports
/// are running?" must have an answer an operator can hold in their head while
/// deciding whether the one they are looking at is legitimate.
///
/// Personal requests are deliberately **outside** that count. An archive of one
/// account is small, and letting one person's portability request block the
/// console - or the console block everybody's portability - would make each
/// feature the other's outage.
pub async fn active_admin(db: &DbPool) -> Result<Option<ExportRun>, AppError> {
    active_where(db, active_sql!("origin = 'admin'"), None).await
}

/// The personal request of `user_id` that has not finished, if any.
///
/// The readable half of `uq_core_data_export_self_active`: the index makes two
/// concurrent requests impossible, this makes the refusal a sentence instead of
/// a constraint violation.
pub async fn active_for_user(db: &DbPool, user_id: Uuid) -> Result<Option<ExportRun>, AppError> {
    active_where(db, active_sql!("origin = 'self' AND requested_by = $1"), Some(user_id)).await
}

/// Shared body of the two lookups above. The statement arrives as a literal
/// assembled by [`active_sql`]; nothing here is built at run time.
async fn active_where(
    db: &DbPool,
    sql: &'static str,
    bind: Option<Uuid>,
) -> Result<Option<ExportRun>, AppError> {
    let params = match bind {
        Some(id) => params![id],
        None => params![],
    };

    db.fetch_optional_as::<ExportRun>(sql, params)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "export: lecture de l'exécution en cours impossible");
            AppError::Database(e)
        })
}

/// One account's own requests, newest first.
pub async fn list_own(db: &DbPool, user_id: Uuid, limit: i64) -> Result<Vec<ExportRun>, AppError> {
    db.fetch_all_as::<ExportRun>(
        concat!(
            "SELECT ",
            run_columns!(),
            " FROM core.data_export_runs \
          WHERE origin = 'self' AND requested_by = $1 \
          ORDER BY requested_at DESC LIMIT $2"
        ),
        params![user_id, limit.clamp(1, 50)],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "export: lecture de l'historique personnel impossible");
        AppError::Database(e)
    })
}

/// Every account of a run, in a stable order.
pub async fn subjects(db: &DbPool, export_id: Uuid) -> Result<Vec<ExportSubject>, AppError> {
    db.fetch_all_as::<ExportSubject>(
        "SELECT id, user_id, user_label, folder, status, size_bytes, services_ok, services_ko, error \
           FROM core.data_export_subjects WHERE export_id = $1 ORDER BY folder",
        params![export_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, export_id = %export_id, "export: lecture des comptes impossible");
        AppError::Database(e)
    })
}

/// The next accounts still to process, oldest first.
pub async fn pending_subjects(
    db: &DbPool,
    export_id: Uuid,
    limit: i64,
) -> Result<Vec<ExportSubject>, AppError> {
    db.fetch_all_as::<ExportSubject>(
        "SELECT id, user_id, user_label, folder, status, size_bytes, services_ok, services_ko, error \
           FROM core.data_export_subjects \
          WHERE export_id = $1 AND status = 'pending' ORDER BY folder LIMIT $2",
        params![export_id, limit.clamp(1, 100)],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, export_id = %export_id, "export: lecture des comptes restants impossible");
        AppError::Database(e)
    })
}

// ── Transitions ──────────────────────────────────────────────────────────────

/// Moves a `pending` run to `running`. Returns `false` when somebody else got
/// there first, or when the run was cancelled in between - which is how a
/// cancellation during the hold actually stops the work.
pub async fn start(db: &DbPool, id: Uuid) -> Result<bool, AppError> {
    let affected = db
        .execute(
            "UPDATE core.data_export_runs SET status = 'running', started_at = COALESCE(started_at, $2) \
          WHERE id = $1 AND status = 'pending'",
            params![id, Utc::now()],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, export_id = %id, "export: démarrage impossible");
            AppError::Database(e)
        })?;
    Ok(affected == 1)
}

/// Closes one account, and moves the run's counter in the same statement pair.
#[allow(clippy::too_many_arguments)]
pub async fn finish_subject(
    db: &DbPool,
    export_id: Uuid,
    subject_id: Uuid,
    status: &str,
    size_bytes: u64,
    services_ok: &[String],
    services_ko: &[String],
    error: Option<&str>,
) -> Result<(), AppError> {
    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "export: ouverture de transaction impossible");
        AppError::Database(e)
    })?;

    tx.execute(
        "UPDATE core.data_export_subjects \
            SET status = $2, size_bytes = $3, services_ok = $4, services_ko = $5, \
                error = $6, finished_at = $7 \
          WHERE id = $1",
        params![
            subject_id,
            status,
            size_bytes.min(i64::MAX as u64) as i64,
            services_ok.to_vec(),
            services_ko.to_vec(),
            error.map(truncate),
            Utc::now()
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, subject_id = %subject_id, "export: clôture d'un compte impossible");
        AppError::Database(e)
    })?;

    // Recounted from the subjects rather than incremented: an increment is
    // wrong the first time a job is retried after a crash, and the progress
    // figure is what an operator uses to decide whether to wait or to cancel.
    tx.execute(
        "UPDATE core.data_export_runs r \
            SET subjects_done = (SELECT COUNT(*) FROM core.data_export_subjects s \
                                  WHERE s.export_id = r.id AND s.status <> 'pending') \
          WHERE r.id = $1",
        params![export_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, export_id = %export_id, "export: mise à jour de l'avancement impossible");
        AppError::Database(e)
    })?;

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "export: validation de la transaction impossible");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Closes a run as ready. The archive exists; the hold decides when it can be
/// fetched.
pub async fn succeed(
    db: &DbPool,
    id: Uuid,
    file_name: &str,
    size_bytes: u64,
    entries: usize,
    duration_ms: i64,
) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.data_export_runs \
            SET status = 'ready', finished_at = $6, duration_ms = $2, \
                file_name = $3, size_bytes = $4, entries_count = $5, error = NULL \
          WHERE id = $1 AND status = 'running'",
        params![
            id,
            duration_ms.max(0),
            file_name,
            size_bytes.min(i64::MAX as u64) as i64,
            entries.min(i32::MAX as usize) as i32,
            Utc::now()
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, export_id = %id, "export: clôture d'une exécution réussie impossible");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Closes a run as failed.
pub async fn fail(db: &DbPool, id: Uuid, error: &str, duration_ms: i64) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.data_export_runs \
            SET status = 'failed', finished_at = $4, duration_ms = $2, error = $3 \
          WHERE id = $1 AND status IN ('pending', 'running')",
        params![id, duration_ms.max(0), truncate(error), Utc::now()],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, export_id = %id, "export: clôture d'une exécution en échec impossible");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Cancels a run that has not finished. Returns `false` when it was already
/// closed - a cancellation that arrives one second late must say so rather than
/// pretend to have stopped something.
pub async fn cancel(db: &DbPool, id: Uuid, reason: &str) -> Result<bool, AppError> {
    let now = Utc::now();
    let affected = db
        .execute(
            "UPDATE core.data_export_runs \
            SET status = 'cancelled', finished_at = $3, error = $2, \
                file_deleted = TRUE, deleted_at = $4 \
          WHERE id = $1 AND status IN ('pending', 'running')",
            params![id, truncate(reason), now, now],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, export_id = %id, "export: annulation impossible");
            AppError::Database(e)
        })?;
    Ok(affected == 1)
}

/// Records that the archive of a finished run is gone, and why.
///
/// `status` moves to `expired` when the retention pass removed it, and stays
/// `ready` when an operator did: "it aged out" and "somebody deleted it" are
/// different facts and the history has to keep both.
pub async fn mark_file_deleted(db: &DbPool, id: Uuid, expired: bool) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.data_export_runs \
            SET file_deleted = TRUE, deleted_at = $3, \
                status = CASE WHEN $2 AND status = 'ready' THEN 'expired' ELSE status END \
          WHERE id = $1",
        params![id, expired, Utc::now()],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, export_id = %id, "export: marquage de suppression impossible");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Records a download. Best-effort by design: a counter that could not be
/// written must never prevent the archive from being served - the operator has
/// the right to it, and the audit entry is written on the other side of this
/// call whatever happens here.
pub async fn record_download(db: &DbPool, id: Uuid, by: Uuid) {
    if let Err(e) = db
        .execute(
            "UPDATE core.data_export_runs \
            SET download_count = download_count + 1, last_downloaded_at = $3, \
                last_downloaded_by = $2 \
          WHERE id = $1",
            params![id, by, Utc::now()],
        )
        .await
    {
        tracing::error!(error = %e, export_id = %id, "export: compteur de téléchargement non écrit");
    }
}

/// Claims one download **against the ceiling**, atomically.
///
/// Returns the number of downloads left afterwards, or `None` when the ceiling
/// was already reached - in which case nothing was written and the caller must
/// refuse.
///
/// Deliberately not the best-effort [`record_download`]: that one may fail
/// silently because an administrator's right to their archive must not depend on
/// a counter, whereas here the counter **is** the rule. Expressed as a single
/// conditional `UPDATE` rather than a read followed by a write, because two tabs
/// pressing the button at the same moment is the ordinary case, not the exotic
/// one.
pub async fn claim_download(
    db: &DbPool,
    id: Uuid,
    by: Uuid,
) -> Result<Option<i32>, AppError> {
    // Expressed as a transaction rather than an `UPDATE ... RETURNING`, which
    // MySQL lacks: the guarded update claims the slot, and the remainder is
    // recomputed in Rust from the row it just wrote (avoiding `GREATEST`, which
    // SQLite does not have). A guard that matched updates exactly one row.
    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, export_id = %id, "export: décompte de téléchargement impossible");
        AppError::Database(e)
    })?;

    let affected = tx
        .execute(
            "UPDATE core.data_export_runs \
            SET download_count = download_count + 1, last_downloaded_at = $3, \
                last_downloaded_by = $2 \
          WHERE id = $1 \
            AND (download_limit IS NULL OR download_count < download_limit)",
            params![id, by, Utc::now()],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, export_id = %id, "export: décompte de téléchargement impossible");
            AppError::Database(e)
        })?;

    if affected == 0 {
        // The ceiling was already reached (or the row is gone): nothing written.
        tx.rollback().await.ok();
        return Ok(None);
    }

    let row = tx
        .fetch_optional_row(
            "SELECT download_limit, download_count FROM core.data_export_runs WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, export_id = %id, "export: décompte de téléchargement impossible");
            AppError::Database(e)
        })?;

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, export_id = %id, "export: décompte de téléchargement impossible");
        AppError::Database(e)
    })?;

    let left = match row {
        Some(r) => {
            let limit: Option<i32> = r.try_get("download_limit").map_err(|e| {
                tracing::error!(error = %e, export_id = %id, "export: décompte de téléchargement impossible");
                AppError::Database(e)
            })?;
            let count: i32 = r.try_get("download_count").map_err(|e| {
                tracing::error!(error = %e, export_id = %id, "export: décompte de téléchargement impossible");
                AppError::Database(e)
            })?;
            Some((limit.unwrap_or(i32::MAX) - count).max(0))
        }
        None => None,
    };
    Ok(left)
}

/// Runs whose archive is past its date and still on the disk.
pub async fn expired_files(db: &DbPool) -> Result<Vec<(Uuid, String, String)>, AppError> {
    #[derive(sqlx::FromRow)]
    struct ExpiredFile {
        id: Uuid,
        destination: String,
        file_name: String,
    }
    let rows = db
        .fetch_all_as::<ExpiredFile>(
            "SELECT id, destination, file_name FROM core.data_export_runs \
          WHERE status = 'ready' AND file_deleted = FALSE AND expires_at <= $1 \
            AND destination IS NOT NULL AND file_name IS NOT NULL",
            params![Utc::now()],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "export: lecture des archives expirées impossible");
            AppError::Database(e)
        })?;
    Ok(rows
        .into_iter()
        .map(|r| (r.id, r.destination, r.file_name))
        .collect())
}

/// Closes rows left `running` by a process that died mid-export.
///
/// The equivalent of [`crate::backup::runs::close_stalled`]: without it, the
/// console would report an export in progress for a process that stopped last
/// month, and the "one at a time" guard would refuse every new request for ever.
pub async fn close_stalled(db: &DbPool) -> Result<u64, AppError> {
    // "N hours ago" is computed in Rust and bound, rather than with `make_interval`
    // (a PostgreSQL function) inside the statement.
    let now = Utc::now();
    let cutoff = now - chrono::Duration::hours(STALE_RUN_HOURS);
    let affected = db
        .execute(
            "UPDATE core.data_export_runs \
            SET status = 'failed', finished_at = $1, \
                file_deleted = TRUE, deleted_at = $2, \
                error = 'Export interrompu (processus arrêté en cours d''exécution)' \
          WHERE status IN ('pending', 'running') \
            AND requested_at < $3",
            params![now, now, cutoff],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "export: reprise des exécutions interrompues impossible");
            AppError::Database(e)
        })?;
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(d: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, d, 12, 0, 0)
            .single()
            .expect("date de test valide")
    }

    fn run(status: &str, deleted: bool) -> ExportRun {
        ExportRun {
            id: Uuid::nil(),
            scope: "instance".into(),
            origin: ORIGIN_ADMIN.into(),
            services: vec!["core".into()],
            with_instance: true,
            requested_by: None,
            actor_label: None,
            status: status.into(),
            requested_at: at(10),
            started_at: None,
            finished_at: None,
            duration_ms: None,
            available_at: at(12),
            expires_at: at(19),
            subjects_total: 1,
            subjects_done: 1,
            file_name: Some("kubuno-export.zip".into()),
            destination: Some("/var/lib/kubuno/exports".into()),
            size_bytes: Some(10),
            entries_count: Some(3),
            error: None,
            file_deleted: deleted,
            deleted_at: None,
            download_count: 0,
            last_downloaded_at: None,
            download_limit: None,
            max_file_mb: None,
        }
    }

    /// The four conditions of a download, each tested alone: this is the guard
    /// that stands between a stolen session and every account's data.
    #[test]
    fn an_archive_is_downloadable_only_inside_its_window() {
        let ready = run("ready", false);
        assert!(!ready.is_downloadable(at(11)), "avant la mise à disposition");
        assert!(ready.is_downloadable(at(12)), "à l'heure exacte");
        assert!(ready.is_downloadable(at(18)), "pendant la fenêtre");
        assert!(!ready.is_downloadable(at(19)), "à l'expiration");
        assert!(!ready.is_downloadable(at(20)), "après l'expiration");

        assert!(!run("ready", true).is_downloadable(at(15)), "fichier supprimé");
        assert!(!run("running", false).is_downloadable(at(15)), "non terminé");
        assert!(!run("failed", false).is_downloadable(at(15)), "en échec");
        assert!(!run("cancelled", false).is_downloadable(at(15)), "annulé");
    }

    /// The ceiling of a personal archive: what the interface displays, and what
    /// the download route refuses on. An administrator's archive has none.
    #[test]
    fn the_download_ceiling_counts_down_and_stops_at_zero() {
        let mut r = run("ready", false);
        assert_eq!(r.downloads_left(), None, "pas de plafond côté administration");
        assert!(!r.download_exhausted());

        r.download_limit = Some(5);
        assert_eq!(r.downloads_left(), Some(5));
        r.download_count = 3;
        assert_eq!(r.downloads_left(), Some(2));
        r.download_count = 5;
        assert_eq!(r.downloads_left(), Some(0));
        assert!(r.download_exhausted());

        // A ceiling lowered by hand under an already higher counter must read as
        // "none left", never as a negative number on screen.
        r.download_count = 9;
        assert_eq!(r.downloads_left(), Some(0));
        assert!(r.download_exhausted());
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
