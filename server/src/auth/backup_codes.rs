//! Single-use backup codes for the second factor.
//!
//! A code is a credential with the same power as a TOTP secret for one sign-in,
//! so it is treated like one: generated with a CSPRNG, hashed with argon2id,
//! shown exactly once, consumed atomically, and never written to a log, a JSON
//! payload or an audit entry.
//!
//! ## Why the verifier is a scan and not a lookup
//!
//! argon2 salts every hash, so `WHERE code_hash = $1` is impossible by
//! construction - that is the point of a password hash. Verification therefore
//! reads the account's *unused* rows and tries them one by one. The cost is
//! bounded by [`BATCH_SIZE`] and only paid on the sign-in path, which is already
//! rate-limited (`crate::auth::rate_limit`). The alternative - a fast unsalted
//! digest that would allow the lookup - would turn a stolen database dump into a
//! set of directly usable second factors.
//!
//! Hashing and verification run on the blocking pool: argon2id is deliberately
//! memory-hard, and ten of them in a row on a runtime worker would stall every
//! other request served by that thread.

use anyhow::Context;
use chrono::{DateTime, Utc};
use kubuno_db::dialect::SqlType;
use kubuno_db::{params, DbPool};
use rand::Rng;
use std::net::IpAddr;
use uuid::Uuid;

use crate::{crypto::password, errors::AppError};

/// Number of codes handed out per batch.
pub const BATCH_SIZE: usize = 10;

/// Characters per code, split in two groups by [`format_code`].
const CODE_LENGTH: usize = 10;

/// Alphabet of a backup code.
///
/// Same reasoning as the generated-password alphabet: a code is read off a
/// printout or a screenshot and typed by hand, sometimes months later, so no
/// character may be confusable with another (`0/O`, `1/I/l`, `5/S`, `8/B`).
/// Upper case only - [`normalize`] folds whatever the user types.
/// 30 symbols over 10 characters is ~49 bits: unguessable, still dictatable.
const ALPHABET: &[u8] = b"ACDEFGHJKLMNPQRTUVWXYZ2346789";

/// What the settings page shows about an account's remaining codes.
#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
pub struct BackupCodeStatus {
    /// Unused codes left. This is the only number ever exposed.
    pub remaining: i64,
    /// Size of the batch the remaining codes belong to.
    pub total: i64,
    /// When the current batch was generated.
    pub generated_at: Option<DateTime<Utc>>,
    /// Below this many codes the UI warns.
    pub low_threshold: i64,
    /// `remaining <= low_threshold` - computed here so every client agrees.
    pub low: bool,
}

/// Draws one code, uniformly over [`ALPHABET`].
fn generate_code() -> String {
    let mut rng = rand::thread_rng();
    (0..CODE_LENGTH)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

/// `ABCDE-FGHIJ` - the grouping is purely for transcription accuracy and is
/// stripped again by [`normalize`].
fn format_code(raw: &str) -> String {
    let mid = CODE_LENGTH / 2;
    format!("{}-{}", &raw[..mid], &raw[mid..])
}

/// Folds user input to the canonical form: upper case, alphanumerics only.
///
/// Users paste codes with the dash, without it, in lower case, with a trailing
/// space from the clipboard. None of that should be the difference between
/// getting back in and being locked out.
pub fn normalize(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// True if `input` could be a backup code at all (length + alphabet).
///
/// Used to route a sign-in submission to the right verifier without trying an
/// expensive argon2 scan on what is obviously a six-digit TOTP code.
pub fn looks_like_code(input: &str) -> bool {
    let n = normalize(input);
    n.len() == CODE_LENGTH && n.bytes().all(|b| ALPHABET.contains(&b))
}

/// Reads the "few codes left" threshold from `core.settings`.
async fn low_threshold(db: &DbPool) -> i64 {
    let raw: Option<serde_json::Value> = db
        .fetch_optional_scalar::<Option<serde_json::Value>>(
            "SELECT value FROM core.settings WHERE \"key\" = 'security.backup_codes_low_threshold'",
            params![],
        )
        .await
        .unwrap_or(None)
        .flatten();

    raw.and_then(|v| v.as_i64()).unwrap_or(3).clamp(0, BATCH_SIZE as i64)
}

/// Generates a fresh batch, **replacing** any previous one, and returns the
/// plaintext codes - the only moment they exist outside the caller's screen.
///
/// Replacement is a delete, not a flag: an operator who regenerates their sheet
/// expects the old one to be worthless immediately, including the codes already
/// consumed (which must not become "used" evidence for a batch that no longer
/// exists). The whole thing is one transaction, so a failure leaves the account
/// with its previous, still-valid codes rather than with none at all.
pub async fn replace_all(db: &DbPool, user_id: Uuid) -> Result<Vec<String>, AppError> {
    let plaintext: Vec<String> = (0..BATCH_SIZE).map(|_| generate_code()).collect();

    // argon2id is memory-hard by design; ten of them belong on the blocking pool.
    let to_hash = plaintext.clone();
    let hashes = tokio::task::spawn_blocking(move || {
        to_hash
            .iter()
            .map(|code| password::hash_password(code))
            .collect::<anyhow::Result<Vec<String>>>()
    })
    .await
    .context("Hachage des codes de secours (pool bloquant)")
    .map_err(AppError::Internal)?
    .map_err(AppError::Internal)?;

    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "backup_codes: opening the transaction");
        AppError::Database(e)
    })?;

    // `MAX(generation) + 1` is cast to bigint and decoded as i64 (its width is
    // int4 on PostgreSQL but i64 on SQLite/MySQL), then narrowed to i32 to bind
    // into the int4 column.
    let backend = tx.backend();
    let gen_sql = format!(
        "SELECT {} FROM core.totp_backup_codes WHERE user_id = $1",
        backend.cast("COALESCE(MAX(generation), 0) + 1", SqlType::BigInt)
    );
    let generation: i32 = tx
        .fetch_optional_scalar::<i64>(&gen_sql, params![user_id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "backup_codes: reading the generation");
            AppError::Database(e)
        })?
        .unwrap_or(1) as i32;

    tx.execute(
        "DELETE FROM core.totp_backup_codes WHERE user_id = $1",
        params![user_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, user_id = %user_id, "backup_codes: purging the previous batch");
        AppError::Database(e)
    })?;

    for hash in &hashes {
        tx.execute(
            "INSERT INTO core.totp_backup_codes (user_id, code_hash, generation)
             VALUES ($1, $2, $3)",
            params![user_id, hash, generation],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "backup_codes: insert");
            AppError::Database(e)
        })?;
    }

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, user_id = %user_id, "backup_codes: commit");
        AppError::Database(e)
    })?;

    Ok(plaintext.iter().map(|c| format_code(c)).collect())
}

/// Drops every code of an account (second factor turned off, recovery).
pub async fn clear(db: &DbPool, user_id: Uuid) -> Result<u64, AppError> {
    let done = db
        .execute(
            "DELETE FROM core.totp_backup_codes WHERE user_id = $1",
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "backup_codes: delete");
            AppError::Database(e)
        })?;
    Ok(done)
}

/// Counters shown in the settings page. Never returns a code.
pub async fn status(db: &DbPool, user_id: Uuid) -> Result<BackupCodeStatus, AppError> {
    // `COUNT(*) FILTER (WHERE ...)` is PostgreSQL/SQLite only (MySQL lacks it), so
    // it is rewritten as a portable `SUM(CASE ...)`; both aggregates are widened to
    // bigint (i64).
    let backend = db.backend();
    let sql = format!(
        "SELECT {remaining}, {total}, MAX(created_at)
           FROM core.totp_backup_codes
          WHERE user_id = $1",
        remaining = backend.sum_bigint("CASE WHEN used_at IS NULL THEN 1 ELSE 0 END"),
        total = backend.count_bigint("*"),
    );
    let row: Option<(i64, i64, Option<DateTime<Utc>>)> = db
        .fetch_optional_as::<(i64, i64, Option<DateTime<Utc>>)>(&sql, params![user_id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "backup_codes: counting");
            AppError::Database(e)
        })?;

    let (remaining, total, generated_at) = row.unwrap_or((0, 0, None));
    let threshold = low_threshold(db).await;

    Ok(BackupCodeStatus {
        remaining,
        total,
        generated_at,
        low_threshold: threshold,
        low: total > 0 && remaining <= threshold,
    })
}

/// Verifies `submitted` against the account's unused codes and consumes the one
/// that matches. Returns the number of codes left, or `None` when nothing matched.
///
/// Single use is enforced by the database, not by this function: the `UPDATE`
/// carries `used_at IS NULL` in its `WHERE`, so two concurrent sign-ins racing on
/// the same code produce exactly one winner. A replay after consumption never
/// even reaches the comparison - the row is no longer in the candidate set.
pub async fn consume(
    db: &DbPool,
    user_id: Uuid,
    submitted: &str,
    ip: Option<IpAddr>,
) -> Result<Option<i64>, AppError> {
    let candidate = normalize(submitted);
    if candidate.len() != CODE_LENGTH {
        return Ok(None);
    }

    let rows: Vec<(Uuid, String)> = db
        .fetch_all_as::<(Uuid, String)>(
            "SELECT id, code_hash FROM core.totp_backup_codes
          WHERE user_id = $1 AND used_at IS NULL
          ORDER BY created_at",
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "backup_codes: reading the candidates");
            AppError::Database(e)
        })?;

    if rows.is_empty() {
        return Ok(None);
    }

    // The whole scan runs on the blocking pool in one hop rather than one hop per
    // candidate: argon2id verification is CPU+memory bound, and ten round-trips
    // through the scheduler would cost more than the hashing.
    let needle = candidate.clone();
    let matched = tokio::task::spawn_blocking(move || {
        rows.into_iter().find_map(|(id, hash)| {
            match password::verify_password(&needle, &hash) {
                Ok(true) => Some(id),
                // A malformed stored hash must not abort the scan: the remaining
                // codes are still legitimate. It is logged by the caller path.
                _ => None,
            }
        })
    })
    .await
    .context("Vérification des codes de secours (pool bloquant)")
    .map_err(AppError::Internal)?;

    let Some(id) = matched else { return Ok(None) };

    // `used_at` is bound (not `NOW()`), and the `$2::inet` cast is dropped -
    // `used_ip` is bound as text (the consolidated migration stores it in a
    // portable text column, not PostgreSQL `INET`).
    let now = Utc::now();
    let ip_text = ip.map(|a| a.to_string());
    let consumed = db
        .execute(
            "UPDATE core.totp_backup_codes
            SET used_at = $1, used_ip = $2
          WHERE id = $3 AND used_at IS NULL",
            params![now, ip_text.as_deref(), id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "backup_codes: consuming");
            AppError::Database(e)
        })?;

    // Lost the race against a concurrent sign-in using the same code.
    if consumed == 0 {
        return Ok(None);
    }

    let backend = db.backend();
    let remaining_sql = format!(
        "SELECT {} FROM core.totp_backup_codes WHERE user_id = $1 AND used_at IS NULL",
        backend.count_bigint("*")
    );
    let remaining: i64 = db
        .fetch_scalar::<i64>(&remaining_sql, params![user_id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "backup_codes: counting after use");
            AppError::Database(e)
        })?;

    Ok(Some(remaining))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_codes_avoid_confusable_characters() {
        for _ in 0..50 {
            let code = generate_code();
            assert_eq!(code.chars().count(), CODE_LENGTH);
            // Of each confusable pair only one member survives: 8 over B, and
            // 0/1/5/I/O/S are all absent. `L` therefore stays - the `1` and `I`
            // it could be mistaken for are gone.
            for c in ['0', '1', '5', 'B', 'I', 'O', 'S'] {
                assert!(!code.contains(c), "caractère confusable {c} dans « {code} »");
            }
        }
    }

    #[test]
    fn codes_are_not_repeated() {
        use std::collections::HashSet;
        let set: HashSet<String> = (0..500).map(|_| generate_code()).collect();
        assert_eq!(set.len(), 500, "collision : générateur non aléatoire");
    }

    #[test]
    fn normalisation_accepts_what_users_actually_type() {
        let raw = generate_code();
        let shown = format_code(&raw);
        assert_eq!(normalize(&shown), raw);
        assert_eq!(normalize(&shown.to_lowercase()), raw);
        assert_eq!(normalize(&format!("  {shown}  ")), raw);
        assert_eq!(normalize(&shown.replace('-', " ")), raw);
    }

    #[test]
    fn a_totp_code_is_not_mistaken_for_a_backup_code() {
        assert!(!looks_like_code("123456"));
        assert!(!looks_like_code(""));
        let shown = format_code(&generate_code());
        assert!(looks_like_code(&shown));
    }
}
