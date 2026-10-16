//! A portable change journal: the delta-sync primitive, lifted out of the
//! database and driven from Rust.
//!
//! Nine modules (calendar, tasks, notes, assistant, wiki, drive, mail,
//! contacts, chat) carry the same local-first pull layer, today expressed **in
//! the database** and tied to PostgreSQL:
//!
//! * a **`SEQUENCE`** per table plus a `BEFORE UPDATE` trigger that sets
//!   `change_seq := nextval(...)`;
//! * an `AFTER DELETE` trigger that writes a **tombstone** through an upsert;
//! * child tables that bump their sync parent with a *no-op* update
//!   (`UPDATE ... SET change_seq = change_seq`) whose only purpose is to fire
//!   the trigger.
//!
//! Neither MySQL nor SQLite has a sequence, and the no-op bump does not survive
//! MySQL at all (it changes nothing, so `ROW_COUNT()` is 0 and no trigger-less
//! emulation can observe it). Rather than translate the mechanism three times
//! in triggers, this module lifts it into an **application** primitive that is
//! identical on the three engines and driven at write time from Rust.
//!
//! # The contract
//!
//! * **[`next_seq`]** hands out a strictly increasing `i64` per *domain* (a
//!   logical table name), safe under concurrency, with no sequence and no
//!   trigger. It is backed by a single counter row incremented atomically.
//! * **[`record_tombstone`]** writes the tombstone of a deleted row, portably.
//! * **[`touch`]** is the explicit, portable replacement for the no-op parent
//!   bump: it assigns the parent a *fresh* seq, so the row genuinely changes on
//!   every engine.
//! * **[`changes_since`]** reads the delta from a cursor - live rows and
//!   tombstones unified and ordered - the shape every module's `delta.rs` needs.
//!
//! # How a module uses it (the diff from the trigger design)
//!
//! For an owned row the module already writes, it takes the seq first and binds
//! it into that same `INSERT`/`UPDATE`:
//!
//! ```ignore
//! let mut tx = pool.begin().await?;
//! let seq = journal::next_seq(&mut tx, "calendar.change_counter", "events").await?;
//! tx.execute(
//!     "UPDATE calendar.events SET title = $1, change_seq = $2 WHERE id = $3",
//!     params![title, seq, id],
//! ).await?;
//! tx.commit().await?;
//! ```
//!
//! On delete it takes a seq and records the tombstone in the same transaction:
//!
//! ```ignore
//! let seq = journal::next_seq(&mut tx, "calendar.change_counter", "events").await?;
//! tx.execute("DELETE FROM calendar.events WHERE id = $1", params![id]).await?;
//! journal::record_tombstone(&mut tx, "calendar.event_tombstones", id, owner_id, seq).await?;
//! ```
//!
//! Both the counter increment and the row write live on the same [`DbTx`], so
//! they commit or roll back together.
//!
//! # The tables a module creates
//!
//! One shared counter table per schema (rows keyed by domain), and one
//! tombstone table per synced entity. Written per engine with the [`dialect`]
//! column helpers; see the crate README for the full migration triplet.
//!
//! ```sql
//! -- PostgreSQL spelling (MySQL/SQLite: swap UUID/TIMESTAMPTZ per dialect::Backend)
//! CREATE TABLE calendar.change_counter (
//!     domain TEXT   NOT NULL PRIMARY KEY,
//!     n      BIGINT NOT NULL
//! );
//! CREATE TABLE calendar.event_tombstones (
//!     id         UUID        NOT NULL PRIMARY KEY,
//!     owner_id   UUID        NOT NULL,
//!     change_seq BIGINT      NOT NULL,
//!     deleted_at TIMESTAMPTZ NOT NULL
//! );
//! -- the live table gains a plain column, no default, no trigger:
//! ALTER TABLE calendar.events ADD COLUMN change_seq BIGINT NOT NULL DEFAULT 0;
//! CREATE INDEX idx_events_change_seq ON calendar.events(owner_id, change_seq);
//! ```
//!
//! [`dialect`]: crate::dialect

use uuid::Uuid;

use crate::dialect::{Assign, Backend, SqlType};
use crate::exec::{DbPool, DbTx};
use crate::{params, DbValue};

/// One entry of a delta pull: a live row that changed, or a tombstone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    /// The row's primary key.
    pub id: Uuid,
    /// The monotonic sequence at which this change happened - the value a
    /// client passes back as its next cursor.
    pub change_seq: i64,
    /// `true` for a tombstone (the row was deleted), `false` for a live row.
    pub deleted: bool,
}

/// The row shape read back from the delta union. Private: callers get
/// [`Change`]. `is_deleted` is a cast integer so it decodes as `i64` on every
/// engine (a bare `0`/`1` literal is `int4` on PostgreSQL and would not decode
/// into `i64`).
#[derive(sqlx::FromRow)]
struct ChangeRow {
    id: Uuid,
    change_seq: i64,
    is_deleted: i64,
}

/// Hands out the next monotonic sequence for `domain`, incrementing the counter
/// atomically inside the caller's transaction.
///
/// `counter_table` is the schema-qualified counter table (e.g.
/// `"calendar.change_counter"`); `domain` is the logical table the sequence
/// belongs to (e.g. `"events"`). Both come from a module's own call sites as
/// literals, never from a request.
///
/// The counter row is created on first use, so no seeding migration is needed.
///
/// # Why it is race-free on the three engines
///
/// * **PostgreSQL / SQLite**: a single `INSERT ... ON CONFLICT DO UPDATE SET
///   n = n + 1 RETURNING n`. The `DO UPDATE` takes a row lock, so two
///   concurrent transactions serialise on it and each reads back a distinct `n`.
/// * **MySQL**: it has no `RETURNING`, so the increment and the read-back are
///   two statements - but they run on the same [`DbTx`], and the
///   `ON DUPLICATE KEY UPDATE` holds an exclusive lock on the row until the
///   transaction ends, so no other session can slip between them.
/// * **SQLite**: additionally, every write transaction already holds the
///   process-wide single-writer permit (see [`crate::exec`]), so writers never
///   even overlap.
pub async fn next_seq(
    tx: &mut DbTx,
    counter_table: &str,
    domain: &str,
) -> Result<i64, sqlx::Error> {
    let backend = tx.backend();
    let base = base_name(counter_table);
    let bump = match backend {
        // `{base}.n` names the target row of the upsert; PostgreSQL and SQLite
        // both accept the (unqualified) table name as its implicit alias.
        Backend::Postgres | Backend::Sqlite => {
            format!(" ON CONFLICT (domain) DO UPDATE SET n = {base}.n + 1")
        }
        Backend::MySql => " ON DUPLICATE KEY UPDATE n = n + 1".to_string(),
    };
    let insert = format!("INSERT INTO {counter_table} (domain, n) VALUES ($1, 1){bump}");

    if backend.supports_returning() {
        let sql = format!("{insert}{}", backend.returning("n"));
        tx.fetch_optional_scalar::<i64>(&sql, params![domain])
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    } else {
        tx.execute(&insert, params![domain]).await?;
        let select = format!("SELECT n FROM {counter_table} WHERE domain = $1");
        tx.fetch_optional_scalar::<i64>(&select, params![domain])
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }
}

/// [`next_seq`] on a pool, wrapping its own transaction. The transaction is
/// what makes the two-statement MySQL path atomic, so this is always safe to
/// call outside one - but a module that also writes a row should share a single
/// transaction with [`next_seq`] instead, so the seq and the row commit as one.
pub async fn next_seq_on_pool(pool: &DbPool, counter_table: &str, domain: &str) -> Result<i64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let n = next_seq(&mut tx, counter_table, domain).await?;
    tx.commit().await?;
    Ok(n)
}

/// Records the tombstone of a deleted row, portably.
///
/// `tombstone_table` is schema-qualified (e.g. `"calendar.event_tombstones"`).
/// `seq` is a value obtained from [`next_seq`] in the *same* transaction as the
/// `DELETE`, so the deletion is ordered against every other change in its domain.
///
/// The write is an upsert on the primary key: re-deleting an id that was
/// re-created simply refreshes its `change_seq` and `deleted_at`, matching the
/// PostgreSQL trigger it replaces.
pub async fn record_tombstone(
    tx: &mut DbTx,
    tombstone_table: &str,
    id: Uuid,
    owner_id: Uuid,
    seq: i64,
) -> Result<(), sqlx::Error> {
    // Only `Incoming` assignments, so `upsert`'s table argument is never
    // interpolated - an empty `&'static str` is correct here.
    let clause = tx.backend().upsert(
        "",
        &["id"],
        &[Assign::Incoming("change_seq"), Assign::Incoming("deleted_at")],
    );
    let sql = format!(
        "INSERT INTO {tombstone_table} (id, owner_id, change_seq, deleted_at) \
         VALUES ($1, $2, $3, $4){clause}"
    );
    tx.execute(&sql, params![id, owner_id, seq, chrono::Utc::now()])
        .await?;
    Ok(())
}

/// Bumps a parent row to a fresh sequence - the explicit, portable replacement
/// for the trigger idiom `UPDATE ... SET change_seq = change_seq`.
///
/// That no-op update exists in the PostgreSQL design only to fire a `BEFORE
/// UPDATE` trigger from a child table's change; it does **not** survive MySQL,
/// where an update that changes nothing reports `rows_affected = 0` and no
/// trigger-less port can see it. [`touch`] assigns a genuinely new seq, so the
/// row really changes on all three engines and the parent shows up in the next
/// delta pull.
///
/// Returns the seq assigned, and how many rows matched (`0` if `key` is absent).
pub async fn touch(
    tx: &mut DbTx,
    live_table: &str,
    counter_table: &str,
    domain: &str,
    key_col: &str,
    key: Uuid,
) -> Result<(i64, u64), sqlx::Error> {
    let seq = next_seq(tx, counter_table, domain).await?;
    let sql = format!("UPDATE {live_table} SET change_seq = $1 WHERE {key_col} = $2");
    let affected = tx.execute(&sql, params![seq, key]).await?;
    Ok((seq, affected))
}

/// Reads the changes for one owner past `cursor`: live rows whose `change_seq`
/// moved, plus tombstones, unified and ordered by `change_seq`, capped at
/// `limit`.
///
/// This is the portable form of every module's `union_rows`. The caller reads
/// the full live rows for the non-deleted [`Change`]s by id, exactly as before.
///
/// `live_table` and `tombstone_table` are schema-qualified and come from the
/// module as literals. `owner_id` and `cursor` are bound twice (once per half of
/// the union): the placeholder rewriter forbids reusing a placeholder number, so
/// each half carries its own.
pub async fn changes_since(
    pool: &DbPool,
    live_table: &str,
    tombstone_table: &str,
    owner_id: Uuid,
    cursor: i64,
    limit: i64,
) -> Result<Vec<Change>, sqlx::Error> {
    let backend = pool.backend();
    // A cast so the marker decodes as `i64` on every engine.
    let live_flag = backend.cast("0", SqlType::BigInt);
    let tomb_flag = backend.cast("1", SqlType::BigInt);
    let sql = format!(
        "SELECT id, change_seq, {live_flag} AS is_deleted FROM {live_table} \
             WHERE owner_id = $1 AND change_seq > $2 \
         UNION ALL \
         SELECT id, change_seq, {tomb_flag} AS is_deleted FROM {tombstone_table} \
             WHERE owner_id = $3 AND change_seq > $4 \
         ORDER BY change_seq LIMIT $5"
    );
    let rows: Vec<ChangeRow> = pool
        .fetch_all_as(
            &sql,
            params![owner_id, cursor, owner_id, cursor, limit],
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| Change {
            id: r.id,
            change_seq: r.change_seq,
            deleted: r.is_deleted != 0,
        })
        .collect())
}

/// The bare table name of a possibly schema-qualified identifier
/// (`"calendar.change_counter"` → `"change_counter"`).
fn base_name(qualified: &str) -> &str {
    qualified.rsplit('.').next().unwrap_or(qualified)
}

/// Convenience to bind a fresh seq into an insert/update the module composes
/// itself: `params![.., journal::seq_param(seq), ..]`. Kept for symmetry; a
/// plain `seq` also converts via `DbValue::from`.
#[inline]
pub fn seq_param(seq: i64) -> DbValue {
    DbValue::I64(Some(seq))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_name_strips_the_schema() {
        assert_eq!(base_name("calendar.change_counter"), "change_counter");
        assert_eq!(base_name("change_counter"), "change_counter");
    }

    #[test]
    fn seq_param_is_an_i64() {
        assert_eq!(seq_param(5), DbValue::I64(Some(5)));
    }
}
