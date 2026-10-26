//! Reading and writing the campaign ledger.
//!
//! Two disciplines run through every query here.
//!
//! **The credential is never selected by accident.** No read enumerates `*`;
//! `secret_enc` appears in exactly two statements - the insert that writes it
//! and [`secret_of`], which the background job calls and no handler does. The
//! struct the console gets back has no field able to hold it.
//!
//! **Progress is written after the work, never before.** A chunk is recorded
//! once the module has answered, so a crash mid-chunk loses the chunk and not
//! the count. Re-running the same cursor is safe by contract (see the module
//! header), which is what makes "record late" the correct side to err on.

use crate::crypto::datakey;
use std::collections::HashMap;

use chrono::{NaiveDate, Utc};
use kubuno_db::dialect::SqlType;
use kubuno_db::{new_id, params, DbPool, DbTx};
use uuid::Uuid;

use super::model::{
    AccountMappingInput, Campaign, CampaignTally, MigrationAccount, ServiceKind, SourceSpec,
};
use crate::crypto::encryption;
use crate::errors::AppError;

/// Columns of a campaign, everywhere. Listed rather than `*` so adding a column
/// to the table can never silently widen an API response.
///
/// A macro rather than a `const` so call sites splice it with `concat!`: each
/// query is then a single compile-time literal the driver takes as-is.
macro_rules! campaign_columns {
    () => {
        "id, name, service, module_id, source_kind, source_host, \
     source_port, source_security, since_date, exclude_folders, status, created_by, \
     actor_label, created_at, started_at, finished_at, error"
    };
}

/// The key the source credentials are sealed with.
///
/// Derived from the instance's JWT secret with its own domain separator, like
/// every other secret at rest in the core (`mailer::config`, `directory::config`):
/// one compromised subsystem must not hand an attacker the others' plaintext.
fn secret_key(jwt_secret: &str) -> [u8; 32] {
    // The key comes from the data-encryption root, not from the token-signing
    // secret, so rotating the latter leaves what is stored readable. The root is
    // seeded with the JWT secret on first boot, so existing values keep the same
    // derivation; `jwt_secret` is only the fallback when the root was never loaded.
    datakey::key(b"kubuno:data-migration:", jwt_secret)
}

pub fn seal(jwt_secret: &str, plain: &str) -> Result<String, AppError> {
    encryption::encrypt(&secret_key(jwt_secret), plain.as_bytes()).map_err(AppError::Internal)
}

pub fn unseal(jwt_secret: &str, sealed: &str) -> Result<String, AppError> {
    let bytes = encryption::decrypt(&secret_key(jwt_secret), sealed).map_err(AppError::Internal)?;
    String::from_utf8(bytes)
        .map_err(|_| AppError::Internal(anyhow::anyhow!("Identifiant source illisible")))
}

// ── Reads ───────────────────────────────────────────────────────────────────

pub async fn list(db: &DbPool) -> Result<Vec<Campaign>, AppError> {
    db.fetch_all_as::<Campaign>(
        concat!(
            "SELECT ",
            campaign_columns!(),
            " FROM core.migration_campaigns ORDER BY created_at DESC"
        ),
        params![],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "data_migration: liste des campagnes");
        AppError::Database(e)
    })
}

pub async fn get(db: &DbPool, id: Uuid) -> Result<Campaign, AppError> {
    db.fetch_optional_as::<Campaign>(
        concat!(
            "SELECT ",
            campaign_columns!(),
            " FROM core.migration_campaigns WHERE id = $1"
        ),
        params![id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, campagne = %id, "data_migration: lecture d'une campagne");
        AppError::Database(e)
    })?
    .ok_or_else(|| AppError::NotFound("Migration campaign not found".into()))
}

/// What the console counts on a campaign row, read back per campaign.
#[derive(sqlx::FromRow)]
struct TallyRow {
    campaign_id: Uuid,
    accounts:    i64,
    pending:     i64,
    running:     i64,
    done:        i64,
    failed:      i64,
    copied:      i64,
    total:       i64,
}

/// One tally per campaign, in a single pass - a per-row count would be N+1
/// queries on a page whose whole point is to be glanced at.
pub async fn tallies(db: &DbPool) -> Result<HashMap<Uuid, CampaignTally>, AppError> {
    // `COUNT(*) FILTER (WHERE ...)` is PostgreSQL-only, so the conditional
    // counts are expressed as `SUM(CASE WHEN ... THEN 1 ELSE 0 END)`, which the
    // three engines all understand; the aggregate cast lives in the helpers.
    let backend = db.backend();
    let sql = format!(
        "SELECT campaign_id, \
                {accounts} AS accounts, \
                {pending} AS pending, \
                {running} AS running, \
                {done} AS done, \
                {failed} AS failed, \
                {copied} AS copied, \
                {total} AS total \
           FROM core.migration_accounts GROUP BY campaign_id",
        accounts = backend.count_bigint("*"),
        pending = backend.sum_bigint("CASE WHEN status = 'pending' THEN 1 ELSE 0 END"),
        running = backend.sum_bigint("CASE WHEN status = 'running' THEN 1 ELSE 0 END"),
        done = backend.sum_bigint("CASE WHEN status = 'done' THEN 1 ELSE 0 END"),
        failed = backend.sum_bigint("CASE WHEN status = 'failed' THEN 1 ELSE 0 END"),
        copied = backend.sum_bigint("items_copied"),
        total = backend.sum_bigint("items_total"),
    );
    let rows = db.fetch_all_as::<TallyRow>(&sql, params![]).await.map_err(|e| {
        tracing::error!(error = %e, "data_migration: décompte des campagnes");
        AppError::Database(e)
    })?;

    let mut out = HashMap::new();
    for row in rows {
        out.insert(
            row.campaign_id,
            CampaignTally {
                accounts: row.accounts,
                pending:  row.pending,
                running:  row.running,
                done:     row.done,
                failed:   row.failed,
                copied:   row.copied,
                total:    row.total,
            },
        );
    }
    Ok(out)
}

/// The mapped accounts of one campaign, with the destination resolved.
pub async fn accounts(db: &DbPool, campaign_id: Uuid) -> Result<Vec<MigrationAccount>, AppError> {
    // `u.email` is CITEXT on PostgreSQL and plain text elsewhere; the cast keeps
    // it decodable as `String` on every engine.
    let backend = db.backend();
    let sql = format!(
        "SELECT a.id, a.campaign_id, a.source_login, a.target_user_id, \
                {} AS target_email, u.display_name AS target_name, \
                a.status, a.items_copied, a.items_total, a.attempts, a.error, \
                a.started_at, a.finished_at, a.updated_at \
           FROM core.migration_accounts a \
           LEFT JOIN core.users u ON u.id = a.target_user_id \
          WHERE a.campaign_id = $1 \
          ORDER BY a.source_login",
        backend.cast("u.email", SqlType::Text),
    );
    db.fetch_all_as::<MigrationAccount>(&sql, params![campaign_id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, campagne = %campaign_id, "data_migration: comptes d'une campagne");
            AppError::Database(e)
        })
}

/// One row of the module-instances read below.
#[derive(sqlx::FromRow)]
struct ModuleIdRow {
    module_id: String,
}

/// The services this instance can actually migrate right now: those the core
/// knows how to orchestrate AND whose module is currently registered.
///
/// Answered from the registry rather than from a list in the code, so an
/// instance that has not installed the mail module is never offered a mail
/// migration - and so adding a module later needs no change here.
pub async fn available_services(db: &DbPool) -> Result<Vec<(ServiceKind, bool)>, AppError> {
    let rows = db
        .fetch_all_as::<ModuleIdRow>(
            "SELECT module_id FROM core.module_instances \
              WHERE status IN ('healthy', 'starting')",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "data_migration: modules disponibles");
            AppError::Database(e)
        })?;

    let installed: Vec<String> = rows.into_iter().map(|r| r.module_id).collect();

    Ok(ServiceKind::ALL
        .iter()
        .map(|service| {
            let ready = installed.iter().any(|m| m == service.module_id());
            (*service, ready)
        })
        .collect())
}

/// Where a module answers, if it is up.
pub async fn module_base_url(db: &DbPool, module_id: &str) -> Result<Option<String>, AppError> {
    // `(last_heartbeat IS NULL)` sorts the nulls last on every engine, replacing
    // PostgreSQL's `NULLS LAST`.
    db.fetch_optional_scalar::<String>(
        "SELECT base_url FROM core.module_instances \
          WHERE module_id = $1 AND status IN ('healthy', 'starting') \
          ORDER BY (last_heartbeat IS NULL), last_heartbeat DESC LIMIT 1",
        params![module_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, module = %module_id, "data_migration: adresse du module");
        AppError::Database(e)
    })
}

/// The sealed credential of one mapped account. Called by the background job
/// and by nothing else.
pub async fn secret_of(db: &DbPool, account_id: Uuid) -> Result<String, AppError> {
    db.fetch_optional_scalar::<String>(
        "SELECT secret_enc FROM core.migration_accounts WHERE id = $1",
        params![account_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, compte = %account_id, "data_migration: lecture d'identifiant");
        AppError::Database(e)
    })?
    .ok_or_else(|| AppError::NotFound("Migration account not found".into()))
}

// ── Writes ──────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)] // a campaign is a source plus a data range
pub async fn create_campaign(
    tx: &mut DbTx,
    name: &str,
    service: ServiceKind,
    source: &SourceSpec,
    since: Option<NaiveDate>,
    exclude: &[String],
    actor: Uuid,
    actor_label: &str,
) -> Result<Uuid, AppError> {
    // The primary key is generated here rather than by a DB default: MySQL and
    // SQLite have no `gen_random_uuid()`, and only `RETURNING` (which MySQL
    // lacks) would learn a DB-generated key back.
    let id = new_id();
    tx.execute(
        "INSERT INTO core.migration_campaigns \
             (id, name, service, module_id, source_kind, source_host, source_port, \
              source_security, since_date, exclude_folders, created_by, actor_label) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        params![
            id,
            name,
            service.as_str(),
            service.module_id(),
            &source.kind,
            &source.host,
            source.port,
            &source.security,
            since,
            exclude.to_vec(),
            actor,
            actor_label
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "data_migration: création de campagne");
        AppError::Database(e)
    })?;
    Ok(id)
}

/// Writes the mappings. The credential is sealed here and nowhere else.
pub async fn add_accounts(
    tx: &mut DbTx,
    campaign_id: Uuid,
    mappings: &[AccountMappingInput],
    jwt_secret: &str,
) -> Result<(), AppError> {
    for mapping in mappings {
        let sealed = seal(jwt_secret, &mapping.password)?;
        let id = new_id();
        tx.execute(
            "INSERT INTO core.migration_accounts \
                 (id, campaign_id, source_login, secret_enc, target_user_id) \
             VALUES ($1, $2, $3, $4, $5)",
            params![id, campaign_id, mapping.source_login.trim(), &sealed, mapping.target_user_id],
        )
        .await
        .map_err(|e| match e {
            // The unique index on (campaign, login) speaking: two rows for the
            // same source account would migrate it twice.
            sqlx::Error::Database(ref db_err) if db_err.code().as_deref() == Some("23505") => {
                AppError::Conflict(format!(
                    "Le compte source « {} » figure deux fois dans cette campagne.",
                    mapping.source_login.trim()
                ))
            }
            // A destination that does not exist, or was deleted between the
            // form and the submission.
            sqlx::Error::Database(ref db_err) if db_err.code().as_deref() == Some("23503") => {
                AppError::Validation(
                    "Unknown destination account. Reload the page and map the accounts again."
                        .into(),
                )
            }
            other => {
                tracing::error!(error = %other, campagne = %campaign_id, "data_migration: ajout d'un compte");
                AppError::Database(other)
            }
        })?;
    }
    Ok(())
}

/// Moves a campaign to `status`, stamping the timestamp that goes with it.
pub async fn set_campaign_status(
    db: &DbPool,
    id: Uuid,
    status: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    // The current instant is bound rather than `NOW()`, and the status value is
    // repeated as its own placeholder at every reuse.
    let now = Utc::now();
    db.execute(
        "UPDATE core.migration_campaigns \
            SET status      = $1, \
                error       = $2, \
                started_at  = CASE WHEN $3 = 'running' THEN COALESCE(started_at, $4) ELSE started_at END, \
                finished_at = CASE WHEN $5 IN ('done', 'failed') THEN $6 \
                                   WHEN $7 = 'running'           THEN NULL \
                                   ELSE finished_at END \
          WHERE id = $8",
        params![status, error, status, now, status, now, status, id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, campagne = %id, "data_migration: changement d'état");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Puts one failed account back in the queue, keeping its cursor: a retry
/// resumes where the failure happened rather than copying everything again.
pub async fn retry_account(db: &DbPool, campaign_id: Uuid, account_id: Uuid) -> Result<(), AppError> {
    let now = Utc::now();
    let affected = db
        .execute(
            "UPDATE core.migration_accounts \
                SET status = 'pending', error = NULL, finished_at = NULL, updated_at = $1 \
              WHERE id = $2 AND campaign_id = $3 AND status = 'failed'",
            params![now, account_id, campaign_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, compte = %account_id, "data_migration: relance d'un compte");
            AppError::Database(e)
        })?;

    if affected == 0 {
        return Err(AppError::Conflict(
            "This account has not failed; there is nothing to retry.".into(),
        ));
    }
    Ok(())
}

pub async fn delete_campaign(tx: &mut DbTx, id: Uuid) -> Result<(), AppError> {
    // The accounts go with it (ON DELETE CASCADE), and with them the sealed
    // credentials - a finished campaign must not keep an organisation's
    // passwords alive for ever.
    tx.execute("DELETE FROM core.migration_campaigns WHERE id = $1", params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, campagne = %id, "data_migration: suppression");
            AppError::Database(e)
        })?;
    Ok(())
}

// ── The job's side of the ledger ────────────────────────────────────────────

/// One account to work on: everything the job needs to call the module.
pub struct ClaimedAccount {
    pub account_id:     Uuid,
    pub campaign:       Campaign,
    pub source_login:   String,
    pub target_user_id: Uuid,
    pub cursor:         Option<serde_json::Value>,
}

/// Rows a killed process left `running` go back in the queue.
///
/// The stall window is generous on purpose: a chunk is bounded by the module's
/// own budget, so a row untouched for ten minutes is a dead worker rather than
/// a slow one, and reclaiming a live row would only duplicate work the module
/// would then discard.
pub async fn reclaim_stalled(db: &DbPool) -> Result<u64, AppError> {
    // The stall cutoff is computed in Rust and bound, rather than expressed as
    // `NOW() - INTERVAL '10 minutes'` in SQL.
    let now = Utc::now();
    let cutoff = now - chrono::Duration::minutes(10);
    let affected = db
        .execute(
            "UPDATE core.migration_accounts \
                SET status = 'pending', updated_at = $1 \
              WHERE status = 'running' AND updated_at < $2",
            params![now, cutoff],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "data_migration: reprise des comptes interrompus");
            AppError::Database(e)
        })?;
    Ok(affected)
}

/// The next account to advance, across every running campaign.
///
/// Ordered by `updated_at` so a worker shares itself fairly between the
/// accounts of a campaign rather than finishing the first mailbox before
/// touching the second - an operator watching two hundred rows needs to see all
/// of them move, and a source server throttles a single login long before it
/// throttles the connection.
///
/// The claim is a guarded `UPDATE` whose `rows_affected` decides the winner,
/// rather than PostgreSQL's `FOR UPDATE ... SKIP LOCKED` + `RETURNING`: a
/// candidate is picked, then claimed with `WHERE ... status IN
/// ('pending','running')`; a rival that got there first leaves `rows_affected`
/// at zero and the loop picks the next candidate.
pub async fn claim_next(db: &DbPool) -> Result<Option<ClaimedAccount>, AppError> {
    loop {
        let candidate = db
            .fetch_optional_row(
                "SELECT inner_a.id \
                   FROM core.migration_accounts inner_a \
                   JOIN core.migration_campaigns c ON c.id = inner_a.campaign_id \
                  WHERE c.status = 'running' \
                    AND inner_a.status IN ('pending', 'running') \
                  ORDER BY inner_a.updated_at ASC \
                  LIMIT 1",
                params![],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "data_migration: recherche d'un compte à réserver");
                AppError::Database(e)
            })?;

        let Some(candidate) = candidate else { return Ok(None) };
        let id: Uuid = candidate.try_get("id").map_err(AppError::Database)?;

        let now = Utc::now();
        let affected = db
            .execute(
                "UPDATE core.migration_accounts \
                    SET status     = 'running', \
                        attempts   = attempts + 1, \
                        started_at = COALESCE(started_at, $1), \
                        updated_at = $2 \
                  WHERE id = $3 AND status IN ('pending', 'running')",
                params![now, now, id],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "data_migration: réservation d'un compte");
                AppError::Database(e)
            })?;

        // Another worker won the race; try the next candidate.
        if affected != 1 {
            continue;
        }

        let row = db
            .fetch_optional_row(
                "SELECT id, campaign_id, source_login, target_user_id, cursor \
                   FROM core.migration_accounts WHERE id = $1",
                params![id],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "data_migration: relecture d'un compte réservé");
                AppError::Database(e)
            })?;

        // The row we just claimed cannot vanish under our own connection.
        let Some(row) = row else { return Ok(None) };

        let campaign_id: Uuid = row.try_get("campaign_id").map_err(AppError::Database)?;
        let campaign = get(db, campaign_id).await?;

        return Ok(Some(ClaimedAccount {
            account_id:     row.try_get("id").map_err(AppError::Database)?,
            campaign,
            source_login:   row.try_get("source_login").map_err(AppError::Database)?,
            target_user_id: row.try_get("target_user_id").map_err(AppError::Database)?,
            cursor:         row.try_get("cursor").map_err(AppError::Database)?,
        }));
    }
}

/// Records what one chunk achieved.
///
/// `copied` is a DELTA - what this chunk moved - because the module is
/// stateless between calls and only the ledger knows the running total.
pub async fn record_chunk(
    db: &DbPool,
    account_id: Uuid,
    copied: i32,
    total: i32,
    cursor: &serde_json::Value,
    done: bool,
) -> Result<(), AppError> {
    let now = Utc::now();
    // `GREATEST` has no SQLite spelling; the running maximum is expressed as a
    // portable `CASE`, with the incoming total bound twice.
    db.execute(
        "UPDATE core.migration_accounts \
            SET items_copied = items_copied + $1, \
                items_total  = CASE WHEN items_total >= $2 THEN items_total ELSE $3 END, \
                cursor       = $4, \
                status       = CASE WHEN $5 THEN 'done' ELSE 'running' END, \
                finished_at  = CASE WHEN $6 THEN $7 ELSE NULL END, \
                error        = NULL, \
                updated_at   = $8 \
          WHERE id = $9",
        params![copied.max(0), total.max(0), total.max(0), cursor.clone(), done, done, now, now, account_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, compte = %account_id, "data_migration: enregistrement d'un lot");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Puts a claimed account back without holding the attempt against it.
///
/// Used when the failure was not the account's: the module was down, its
/// address could not be read. `attempts` is walked back because it is the
/// number the console shows next to "relancé N fois", and an unreachable module
/// must not make a mailbox look like it keeps failing.
pub async fn release_account(db: &DbPool, account_id: Uuid) -> Result<(), AppError> {
    let now = Utc::now();
    // `GREATEST(attempts - 1, 0)` written portably, so it never underflows below
    // zero on any engine.
    db.execute(
        "UPDATE core.migration_accounts \
            SET status = 'pending', \
                attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END, \
                updated_at = $1 \
          WHERE id = $2 AND status = 'running'",
        params![now, account_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, compte = %account_id, "data_migration: libération d'un compte");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Marks one account failed, keeping its cursor so a retry resumes.
pub async fn fail_account(db: &DbPool, account_id: Uuid, message: &str) -> Result<(), AppError> {
    // Truncated: a server that answers with a wall of text must not turn one
    // row of a table into a page of it.
    let message: String = message.chars().take(500).collect();
    let now = Utc::now();
    db.execute(
        "UPDATE core.migration_accounts \
            SET status = 'failed', error = $1, finished_at = $2, updated_at = $3 \
          WHERE id = $4",
        params![&message, now, now, account_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, compte = %account_id, "data_migration: échec d'un compte");
        AppError::Database(e)
    })?;
    Ok(())
}

/// One id read back from a set-returning query.
#[derive(sqlx::FromRow)]
struct IdRow {
    id: Uuid,
}

/// Closes every running campaign that has nothing left to do.
///
/// A campaign is *finished*, not *successful*: accounts that failed keep their
/// error and stay retryable, and the report is what says which. Calling it
/// "done" while a row is red would be the report lying about the campaign it
/// exists to describe, so the console reads the tally rather than the status
/// when it wants that distinction.
///
/// Expressed as a select of the finished campaigns followed by a guarded update
/// of each, rather than `UPDATE ... RETURNING`, which MySQL has not.
pub async fn close_finished(db: &DbPool) -> Result<Vec<Uuid>, AppError> {
    let candidates = db
        .fetch_all_as::<IdRow>(
            "SELECT c.id FROM core.migration_campaigns c \
              WHERE c.status = 'running' \
                AND NOT EXISTS ( \
                    SELECT 1 FROM core.migration_accounts a \
                     WHERE a.campaign_id = c.id AND a.status IN ('pending', 'running'))",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "data_migration: clôture des campagnes");
            AppError::Database(e)
        })?;

    let now = Utc::now();
    let mut ids = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let affected = db
            .execute(
                "UPDATE core.migration_campaigns \
                    SET status = 'done', finished_at = $1 \
                  WHERE id = $2 AND status = 'running'",
                params![now, candidate.id],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "data_migration: clôture d'une campagne");
                AppError::Database(e)
            })?;
        if affected == 1 {
            ids.push(candidate.id);
        }
    }
    Ok(ids)
}

/// Is there anything at all for the job to do? Decides whether the chain
/// re-arms - an idle instance must not poll for ever.
pub async fn has_work(db: &DbPool) -> Result<bool, AppError> {
    // `EXISTS(...)` decoded straight into `bool` is not portable, so the boolean
    // is folded to `1`/`0` and read as `i64`, keeping the short-circuit.
    let backend = db.backend();
    let sql = format!(
        "SELECT {}",
        backend.cast(
            "CASE WHEN EXISTS( \
                SELECT 1 FROM core.migration_accounts a \
                  JOIN core.migration_campaigns c ON c.id = a.campaign_id \
                 WHERE c.status = 'running' AND a.status IN ('pending', 'running')) \
             THEN 1 ELSE 0 END",
            SqlType::BigInt,
        ),
    );
    let flag = db.fetch_scalar::<i64>(&sql, params![]).await.map_err(|e| {
        tracing::error!(error = %e, "data_migration: recherche de travail restant");
        AppError::Database(e)
    })?;
    Ok(flag != 0)
}
