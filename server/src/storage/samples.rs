//! The daily sample the storage trend is drawn from.
//!
//! ## Why a stored sample rather than a derived series
//!
//! Every other trend in the console is counted from an events table: sign-ups
//! are rows of `core.users` grouped by `created_at`. Consumption has no such
//! table - `core.users.used_bytes` is a **level**, overwritten in place by
//! whichever module stored the bytes. A level that is only ever overwritten has
//! no past to reconstruct, so the past has to be written down as it happens.
//!
//! ## One row per day, upserted
//!
//! The sampler runs from the alert-centre pass, i.e. every few minutes. It
//! refines the row for the day it is in rather than appending: a core restarted
//! five times in an afternoon still leaves exactly one point on the curve, and
//! two core processes sampling at once settle on the same row instead of
//! racing. The value kept for a day is therefore its **last** reading, which is
//! the honest one - a curve of daily maxima would report peaks the instance was
//! never at when somebody looked.
//!
//! ## Gaps are left as gaps
//!
//! A core that was switched off for a week writes no points for that week. The
//! console draws what was measured and nothing else: interpolating the missing
//! days would put growth on a chart that nobody observed, in the one place an
//! operator goes to decide whether to buy a disk.

use kubuno_db::dialect::{Assign, SqlType};
use kubuno_db::{params, DbPool};

use crate::errors::AppError;

/// Writes (or refreshes) today's point.
///
/// Never fails the caller's own work: the alert scan calls it and logs the
/// error, because a missing point on a curve is not worth losing an alert over.
pub async fn capture(db: &DbPool) -> Result<(), AppError> {
    let backend = db.backend();

    // Compute the day's aggregates portably. The former `COUNT(*) FILTER (WHERE
    // ...)` is spelled as a `SUM(CASE ...)` so every engine can run it, and the
    // widths are made explicit with an engine-aware cast to BIGINT.
    let agg_sql = format!(
        "SELECT {used}, {quota}, {accounts}, {over_quota} FROM core.users",
        used = backend.sum_bigint("used_bytes"),
        quota = backend.sum_bigint("quota_bytes"),
        accounts = backend.count_bigint("*"),
        over_quota = backend.cast(
            "COALESCE(SUM(CASE WHEN quota_bytes > 0 AND used_bytes >= quota_bytes THEN 1 ELSE 0 END), 0)",
            SqlType::BigInt,
        ),
    );

    let (used_bytes, quota_bytes, accounts, over_quota): (i64, i64, i64, i64) = db
        .fetch_one_as(&agg_sql, params![])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storage: daily sample aggregates not computed");
            AppError::Database(e)
        })?;

    // One row per day, upserted on `day`. The date and capture instant are
    // computed in Rust rather than with `CURRENT_DATE`/`NOW()`.
    let today = chrono::Utc::now().date_naive();
    let now = chrono::Utc::now();
    let upsert = backend.upsert(
        "core.storage_samples",
        &["day"],
        &[
            Assign::Incoming("used_bytes"),
            Assign::Incoming("quota_bytes"),
            Assign::Incoming("accounts"),
            Assign::Incoming("over_quota"),
            Assign::Incoming("captured_at"),
        ],
    );
    let insert_sql = format!(
        "INSERT INTO core.storage_samples (day, used_bytes, quota_bytes, accounts, over_quota, captured_at) \
         VALUES ($1, $2, $3, $4, $5, $6){upsert}"
    );

    db.execute(
        &insert_sql,
        params![today, used_bytes, quota_bytes, accounts, over_quota, now],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "storage: daily sample not recorded");
        AppError::Database(e)
    })?;

    Ok(())
}
