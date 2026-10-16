//! Getting a row back from a write, on an engine that may not have `RETURNING`.
//!
//! PostgreSQL and SQLite (3.35+) both support `RETURNING`. MySQL and MariaDB do
//! not - MariaDB has `INSERT ... RETURNING`, but not on `UPDATE`/`DELETE` and
//! not with `ON DUPLICATE KEY UPDATE`, so the whole family is treated here as
//! lacking it.
//!
//! # The prerequisite nobody can skip
//!
//! 295 Kubuno tables declare `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`.
//! Neither MySQL nor SQLite has such a default, and the only way the process
//! learns a DB-generated key is `RETURNING`, which MySQL lacks. So the id must
//! be generated in Rust ([`crate::new_id`]) and bound like any other column.
//!
//! # How the helpers work
//!
//! * PostgreSQL / SQLite: one statement, with `RETURNING` appended.
//! * MySQL: two statements - the write, and a re-`SELECT` by primary key. Both
//!   run on the [`DbTx`] you pass, so a concurrent session cannot slip between
//!   them.

use crate::exec::{DbRow, DbTx, ScalarAnyRow};
use crate::value::DbValue;

/// Insert a row and read back one column of it.
///
/// * `insert_sql` - the `INSERT`, **without** any `RETURNING` clause; it must
///   bind the primary key explicitly (see [`crate::new_id`]).
/// * `returning_col` - the column `RETURNING` would have named.
/// * `reselect_sql` / `reselect_params` - how to find that row again by primary
///   key, used on MySQL only.
pub async fn insert_returning_scalar<T: ScalarAnyRow>(
    tx: &mut DbTx,
    insert_sql: &str,
    insert_params: Vec<DbValue>,
    returning_col: &'static str,
    reselect_sql: &str,
    reselect_params: Vec<DbValue>,
) -> Result<T, sqlx::Error> {
    if tx.backend().supports_returning() {
        let sql = format!("{insert_sql} RETURNING {returning_col}");
        tx.fetch_optional_scalar(&sql, insert_params)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    } else {
        tx.execute(insert_sql, insert_params).await?;
        tx.fetch_optional_scalar(reselect_sql, reselect_params)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }
}

/// Insert a row and read the whole row back.
pub async fn insert_returning_row(
    tx: &mut DbTx,
    insert_sql: &str,
    insert_params: Vec<DbValue>,
    returning_cols: &'static str,
    reselect_sql: &str,
    reselect_params: Vec<DbValue>,
) -> Result<DbRow, sqlx::Error> {
    write_then_read(
        tx,
        insert_sql,
        insert_params,
        returning_cols,
        reselect_sql,
        reselect_params,
    )
    .await?
    .ok_or(sqlx::Error::RowNotFound)
}

/// Update a row and read the result back.
///
/// ### Limitation you must read
/// On MySQL the row is re-`SELECT`ed by **primary key** after the update. Do
/// not use this for a *guarded* update (`WHERE status = 'draft'`): the
/// re-select would find the row whether or not the guard matched, and MySQL's
/// `rows_affected` is 0 for an update that changed nothing, so it cannot tell
/// them apart either. Take the row with `SELECT ... FOR UPDATE` in a
/// transaction and decide in Rust.
pub async fn update_returning_row(
    tx: &mut DbTx,
    update_sql: &str,
    update_params: Vec<DbValue>,
    returning_cols: &'static str,
    reselect_sql: &str,
    reselect_params: Vec<DbValue>,
) -> Result<Option<DbRow>, sqlx::Error> {
    write_then_read(
        tx,
        update_sql,
        update_params,
        returning_cols,
        reselect_sql,
        reselect_params,
    )
    .await
}

/// Delete a row and read what was deleted. On MySQL the re-`SELECT` happens
/// **before** the delete, so both must be in the transaction passed.
pub async fn delete_returning_row(
    tx: &mut DbTx,
    delete_sql: &str,
    delete_params: Vec<DbValue>,
    returning_cols: &'static str,
    reselect_sql: &str,
    reselect_params: Vec<DbValue>,
) -> Result<Option<DbRow>, sqlx::Error> {
    if tx.backend().supports_returning() {
        let sql = format!("{delete_sql} RETURNING {returning_cols}");
        let _ = (reselect_sql, reselect_params);
        return tx.fetch_optional_row(&sql, delete_params).await;
    }
    let existing = tx.fetch_optional_row(reselect_sql, reselect_params).await?;
    tx.execute(delete_sql, delete_params).await?;
    Ok(existing)
}

async fn write_then_read(
    tx: &mut DbTx,
    write_sql: &str,
    write_params: Vec<DbValue>,
    returning_cols: &'static str,
    reselect_sql: &str,
    reselect_params: Vec<DbValue>,
) -> Result<Option<DbRow>, sqlx::Error> {
    if tx.backend().supports_returning() {
        let sql = format!("{write_sql} RETURNING {returning_cols}");
        let _ = (reselect_sql, reselect_params);
        return tx.fetch_optional_row(&sql, write_params).await;
    }
    tx.execute(write_sql, write_params).await?;
    tx.fetch_optional_row(reselect_sql, reselect_params).await
}

/// The common `WHERE id = $1` re-select, written the same way everywhere.
/// Both parameters are `&'static str`: identifiers, never data.
pub fn reselect_by_id(table: &'static str, cols: &'static str) -> String {
    format!("SELECT {cols} FROM {table} WHERE id = $1")
}

/// Asserts at test time that a write statement carries no literal `RETURNING` -
/// the helpers append it themselves.
pub fn debug_assert_no_returning(sql: &str) {
    debug_assert!(
        !sql.to_ascii_lowercase().contains("returning"),
        "pass the statement without its RETURNING clause; the helper appends it: {sql}"
    );
    let _ = crate::sql::lint(sql);
}
