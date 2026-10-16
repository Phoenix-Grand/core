//! Which accounts used which application, counted where the core already knows.
//!
//! # Why the proxy is the only honest vantage point
//!
//! A module owns its own PostgreSQL schema and the core never reads it, so the
//! core cannot ask a module how much it was used - and a module that has to
//! *declare* its own attendance is a module that can forget to, or never
//! implement it. But every browser call to every module crosses
//! [`crate::modules::proxy`]: the account is resolved there (to forward
//! `X-Kubuno-User-Id`) and the module id is in the path. The two facts meet at
//! exactly one point in the whole system, and this is the counter placed at it.
//! No module cooperates; none can opt out; none can inflate its own figure.
//!
//! # What is counted, and what is deliberately not
//!
//! One number per `(day, module, account)`. **No URL, no path, no method, no IP
//! address, no payload** - see the preamble of migration `000123`, which states
//! the rule the schema enforces. The day is stamped in the instance's time zone
//! at the moment of the hit, so the counter cannot be resolved back into a
//! timetable, only into "this account used drive on Tuesday".
//!
//! # Cost on the request path: one hash-map insert
//!
//! [`UsageMeter::record`] takes a mutex, bumps an integer and returns. It never
//! awaits, never touches the database and never allocates for a key that is
//! already present. The database write is a *batch* upsert performed by
//! [`flusher`] on its own task, so a slow database delays the counter and never
//! the response the person is waiting for.
//!
//! Memory is bounded by [`MAX_PENDING`]: past that, hits for keys not already
//! being tracked are dropped and counted, because a metric must never be the
//! reason an instance runs out of memory. The drop is reported in the log at the
//! next flush rather than silently absorbed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use chrono::{NaiveDate, Utc};
use chrono_tz::Tz;
use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

/// How often the in-memory counters are consolidated into the table.
///
/// A minute: short enough that a core stopped abruptly loses at most a minute of
/// attendance (a rounding error on a daily counter), long enough that a busy
/// instance writes one batched statement per minute instead of one per request.
const FLUSH_INTERVAL: Duration = Duration::from_secs(60);

/// Ceiling on distinct `(day, module, account)` keys held between two flushes.
///
/// Reached only by an instance with tens of thousands of accounts active inside
/// the same minute; at ~64 bytes a key it caps this buffer at a few megabytes.
const MAX_PENDING: usize = 50_000;

/// Longest module id the column accepts (`VARCHAR(100)`).
///
/// A hit naming something longer is dropped rather than truncated: a truncated
/// id would silently merge two modules' figures, and the value only ever comes
/// from an id the registry already resolved, so this is a guard that should
/// never fire.
const MAX_MODULE_ID: usize = 100;

type Key = (NaiveDate, String, Uuid);

/// The counter, held once in [`crate::state::AppState`].
pub struct UsageMeter {
    pending: Mutex<HashMap<Key, i64>>,
    /// The zone the day is stamped in. Refreshed by the flusher, so an operator
    /// changing the instance's time zone moves the boundary within the minute
    /// instead of at the next restart.
    zone: RwLock<Tz>,
    /// Hits given up for want of room since the last report. Counted so the
    /// figure can say it is short instead of quietly being wrong.
    dropped: AtomicU64,
}

impl Default for UsageMeter {
    fn default() -> Self {
        Self::new()
    }
}

impl UsageMeter {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            zone: RwLock::new(Tz::UTC),
            dropped: AtomicU64::new(0),
        }
    }

    /// Records one proxied call. Never blocks on anything but its own mutex.
    ///
    /// A poisoned mutex is treated as "do not count": attendance is advisory,
    /// and a panic here would take down a request that has nothing to do with
    /// statistics.
    pub fn record(&self, module_id: &str, user_id: Uuid) {
        if module_id.is_empty() || module_id.len() > MAX_MODULE_ID {
            return;
        }

        let zone = match self.zone.read() {
            Ok(z) => *z,
            Err(_) => Tz::UTC,
        };
        let day = Utc::now().with_timezone(&zone).date_naive();

        let Ok(mut pending) = self.pending.lock() else {
            return;
        };

        // One short String is copied per hit - the price of a borrowed key in a
        // map that outlives the request. It is nothing next to what it replaces:
        // a round trip to PostgreSQL on every call to every module.
        let key = (day, module_id.to_owned(), user_id);
        // Read the size BEFORE taking the mutable borrow: asking the map how
        // full it is inside a `match` on `get_mut` borrows it twice over.
        let has_room = pending.len() < MAX_PENDING;
        match pending.get_mut(&key) {
            Some(count) => *count += 1,
            // The ceiling only ever refuses a key that is NOT yet tracked, so a
            // full buffer keeps refining the counters it already holds instead
            // of freezing the whole measurement.
            None if has_room => {
                pending.insert(key, 1);
            }
            None => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Takes everything buffered, leaving the meter empty.
    fn drain(&self) -> Vec<(NaiveDate, String, Uuid, i64)> {
        let Ok(mut pending) = self.pending.lock() else {
            return Vec::new();
        };
        pending
            .drain()
            .map(|((day, module_id, user_id), hits)| (day, module_id, user_id, hits))
            .collect()
    }

    fn set_zone(&self, tz: Tz) {
        if let Ok(mut zone) = self.zone.write() {
            *zone = tz;
        }
    }
}

/// Consolidates the buffer into `core.module_usage_daily`.
///
/// One statement for the whole batch, and one that adds rather than overwrites:
/// two core processes behind the same database each flush their own share and
/// the day's figure is the sum, never the last writer's.
///
/// Accounts erased between the hit and the flush are filtered out in SQL rather
/// than allowed to fail the batch on the foreign key - losing a whole minute of
/// attendance because one account was purged would be a poor trade.
pub async fn flush(db: &DbPool, meter: &UsageMeter) {
    let batch = meter.drain();
    if batch.is_empty() {
        return;
    }
    let rows = batch.len();

    // The PostgreSQL original consolidated the whole batch with one
    // `INSERT ... SELECT FROM UNNEST(...)` statement, but `UNNEST` and array
    // parameters exist on no other engine. The portable form applies the same
    // add-not-overwrite merge one row at a time, inside a single transaction so
    // the batch still lands atomically. The `EXISTS` guard drops hits for
    // accounts erased between the hit and the flush rather than failing on the
    // foreign key. `updated_at` is stamped in Rust rather than with `NOW()`.
    let backend = db.backend();
    let now = Utc::now();
    let insert_sql = format!(
        "INSERT INTO core.module_usage_daily (day, module_id, user_id, hits, updated_at) \
         SELECT $1, $2, $3, $4, $5 \
          WHERE EXISTS (SELECT 1 FROM core.users u WHERE u.id = $6){}",
        backend.upsert(
            "core.module_usage_daily",
            &["day", "module_id", "user_id"],
            &[
                Assign::Expr { col: "hits", expr: "{cur} + {new}" },
                Assign::Incoming("updated_at"),
            ],
        )
    );

    let mut tx = match db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            tracing::error!(
                error = %e,
                lignes = rows,
                "Fréquentation des modules : consolidation échouée (lot abandonné)"
            );
            return;
        }
    };

    let mut affected: u64 = 0;
    for (day, module_id, user_id, count) in batch {
        // `user_id` fills both the inserted column ($3) and the EXISTS guard
        // ($6); placeholders are never reused, so it is bound twice.
        match tx
            .execute(
                &insert_sql,
                params![day, module_id, user_id, count, now, user_id],
            )
            .await
        {
            Ok(done) => affected += done,
            Err(e) => {
                // The batch is lost on purpose rather than retried: it is at
                // most a minute of an advisory counter, and a queue of failed
                // batches would grow without bound exactly when the database is
                // already unwell.
                tracing::error!(
                    error = %e,
                    lignes = rows,
                    "Fréquentation des modules : consolidation échouée (lot abandonné)"
                );
                let _ = tx.rollback().await;
                return;
            }
        }
    }

    match tx.commit().await {
        Ok(()) => {
            let dropped = meter.dropped.swap(0, Ordering::Relaxed);
            if dropped > 0 {
                tracing::warn!(
                    abandonnés = dropped,
                    plafond = MAX_PENDING,
                    "Fréquentation des modules : compteurs abandonnés faute de place"
                );
            }
            tracing::debug!(
                lignes = affected,
                "Fréquentation des modules consolidée"
            );
        }
        Err(e) => {
            tracing::error!(
                error = %e,
                lignes = rows,
                "Fréquentation des modules : consolidation échouée (lot abandonné)"
            );
        }
    }
}

/// The task that keeps the counter moving. Runs for the life of the process.
pub async fn flusher(db: DbPool, meter: std::sync::Arc<UsageMeter>) {
    // Before the first hit is ever recorded, so no counter is stamped with a
    // fallback zone the instance never chose.
    meter.set_zone(crate::settings::intl::instance_timezone(&db).await);

    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        meter.set_zone(crate::settings::intl::instance_timezone(&db).await);
        flush(&db, &meter).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_hits_collapse_into_one_key() {
        let meter = UsageMeter::new();
        let user = Uuid::new_v4();
        for _ in 0..10 {
            meter.record("drive", user);
        }
        let batch = meter.drain();
        assert_eq!(batch.len(), 1, "dix appels ne font qu'une ligne");
        assert_eq!(batch[0].3, 10);
    }

    #[test]
    fn two_accounts_on_one_module_are_two_rows() {
        let meter = UsageMeter::new();
        meter.record("drive", Uuid::new_v4());
        meter.record("drive", Uuid::new_v4());
        assert_eq!(meter.drain().len(), 2);
    }

    /// A module id the column could not hold is never counted: truncating would
    /// merge two modules' attendance under one name.
    #[test]
    fn an_impossible_module_id_is_not_counted() {
        let meter = UsageMeter::new();
        meter.record("", Uuid::new_v4());
        meter.record(&"x".repeat(MAX_MODULE_ID + 1), Uuid::new_v4());
        assert!(meter.drain().is_empty());
    }

    /// Draining leaves the meter empty, or a flush would double-count every
    /// figure it just wrote.
    #[test]
    fn draining_empties_the_meter() {
        let meter = UsageMeter::new();
        meter.record("calendar", Uuid::new_v4());
        assert_eq!(meter.drain().len(), 1);
        assert!(meter.drain().is_empty());
    }
}
