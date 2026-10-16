//! The runtime executor: one binary, three drivers, the engine chosen at
//! start-up.
//!
//! [`DbPool`] is an enum over the three concrete sqlx pools. Application code
//! never names an engine: it calls `db.fetch_one_as::<T>(sql, params![...])`
//! and this layer picks the driver, rewrites the placeholders through
//! [`crate::sql::prepare`], binds the [`DbValue`]s and decodes the result.
//!
//! sqlx underneath does **no** dialect translation - the SQL text is already
//! correct for the engine (that is the [`crate::dialect`] layer's job); sqlx
//! only carries it and encodes/decodes the parameters.
//!
//! # Where the per-engine concurrency discipline lives
//!
//! It lives here, invisibly to callers:
//!
//! * **SQLite is single-writer.** Every write ([`DbPool::execute`]) and every
//!   write transaction ([`DbPool::begin`]) takes a process-wide permit
//!   ([`SqliteHandle::write`], a `Semaphore` of one), so writers serialise
//!   instead of colliding. Reads do not take it and stay concurrent (WAL).
//! * **`SQLITE_BUSY`/`LOCKED` is retried** with bounded back-off in this layer,
//!   not in the modules.
//! * **`WAL` + a generous `busy_timeout`**, and MySQL's per-session
//!   `time_zone = '+00:00'` and a case-sensitive collation, are set in
//!   `after_connect` (see [`crate::pool`]).

use std::sync::Arc;
use std::time::Duration;

use sqlx::mysql::MySqlRow;
use sqlx::postgres::PgRow;
use sqlx::sqlite::SqliteRow;
use sqlx::{Decode, FromRow, MySql, Postgres, Row, Sqlite, Type};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::dialect::Backend;
use crate::schema::SchemaPrefix;
use crate::sql;
use crate::value::DbValue;

/// A connection pool for whichever engine the process was configured with,
/// together with the optional schema-name prefix ([`SchemaPrefix`]) applied to
/// every statement and every migration. The prefix is set once, at
/// [`crate::pool::connect`], and lives for the life of the pool.
#[derive(Clone)]
pub struct DbPool {
    kind: PoolKind,
    prefix: SchemaPrefix,
}

/// The concrete sqlx pool behind a [`DbPool`], one variant per engine.
#[derive(Clone)]
pub(crate) enum PoolKind {
    Pg(sqlx::PgPool),
    My(sqlx::MySqlPool),
    Sq(SqliteHandle),
}

impl DbPool {
    /// The concrete pool behind this handle - used by [`crate::pool::MigratorSet`]
    /// to hand each engine's migrator its own driver pool.
    pub(crate) fn kind(&self) -> &PoolKind {
        &self.kind
    }

    /// Wraps a PostgreSQL pool with its schema prefix (called from
    /// [`crate::pool`]).
    pub(crate) fn from_pg(pool: sqlx::PgPool, prefix: SchemaPrefix) -> Self {
        DbPool { kind: PoolKind::Pg(pool), prefix }
    }

    /// Wraps a MySQL/MariaDB pool with its schema prefix.
    pub(crate) fn from_mysql(pool: sqlx::MySqlPool, prefix: SchemaPrefix) -> Self {
        DbPool { kind: PoolKind::My(pool), prefix }
    }

    /// Wraps a SQLite handle with its schema prefix.
    pub(crate) fn from_sqlite(handle: SqliteHandle, prefix: SchemaPrefix) -> Self {
        DbPool { kind: PoolKind::Sq(handle), prefix }
    }

    /// The schema prefix this pool applies. Read by [`crate::pool::MigratorSet`]
    /// so a module's migrations land in the prefixed schema too.
    pub fn schema_prefix(&self) -> &SchemaPrefix {
        &self.prefix
    }

    /// The underlying PostgreSQL pool, or `None` on MySQL/SQLite. For the few
    /// irreducibly PostgreSQL-only fast paths a caller keeps (`LISTEN`/`NOTIFY`
    /// listeners, `pg_dump`-style logical dumps); every portable operation goes
    /// through the engine-agnostic methods instead. Cheap to clone when an owned
    /// `PgPool` is needed (it is an `Arc` inside).
    pub fn as_pg(&self) -> Option<&sqlx::PgPool> {
        match &self.kind {
            PoolKind::Pg(p) => Some(p),
            _ => None,
        }
    }

    /// The underlying MySQL/MariaDB pool, or `None` on PostgreSQL/SQLite. Same
    /// escape hatch as [`Self::as_pg`], for the rare MySQL-only path (e.g. a
    /// portability test that lists `information_schema` tables directly).
    pub fn as_mysql(&self) -> Option<&sqlx::MySqlPool> {
        match &self.kind {
            PoolKind::My(p) => Some(p),
            _ => None,
        }
    }
}

/// SQLite's pool plus the single-writer gate. Cloneable: every clone shares the
/// same `Semaphore`, so the gate is process-wide.
#[derive(Clone)]
pub struct SqliteHandle {
    pub(crate) pool: sqlx::SqlitePool,
    pub(crate) write: Arc<Semaphore>,
}

impl SqliteHandle {
    pub(crate) fn new(pool: sqlx::SqlitePool) -> Self {
        SqliteHandle {
            pool,
            write: Arc::new(Semaphore::new(1)),
        }
    }
}

/// Binds every [`DbValue`] onto a sqlx query, in order. A macro rather than a
/// generic function so it monomorphises at each concrete call site and never
/// forces the viral `Encode<DB>` bounds up into callers.
macro_rules! bind_all {
    ($q:expr, $params:expr) => {{
        let mut q = $q;
        for v in $params {
            q = match v {
                // An untyped NULL. A typed `None` (below) is preferred.
                DbValue::Null => q.bind(None::<i64>),
                DbValue::Bool(o) => q.bind(o),
                DbValue::I16(o) => q.bind(o),
                DbValue::I32(o) => q.bind(o),
                DbValue::I64(o) => q.bind(o),
                DbValue::F32(o) => q.bind(o),
                DbValue::F64(o) => q.bind(o),
                DbValue::Text(o) => q.bind(o),
                DbValue::Blob(o) => q.bind(o),
                DbValue::Uuid(o) => q.bind(o),
                DbValue::Json(o) => q.bind(o),
                DbValue::DateTimeUtc(o) => q.bind(o),
                DbValue::NaiveDate(o) => q.bind(o),
            };
        }
        q
    }};
}

/// A row read back without a target struct - for the [`crate::returning`]
/// helpers and any place that maps columns by hand.
pub enum DbRow {
    Pg(PgRow),
    My(MySqlRow),
    Sq(SqliteRow),
}

impl DbRow {
    /// Decode a column by name. `T` must decode on the three engines; owned
    /// types (`Uuid`, `i64`, `String`, `DateTime<Utc>`, `Option<_>`…) do.
    pub fn try_get<'r, T>(&'r self, col: &str) -> Result<T, sqlx::Error>
    where
        T: Decode<'r, Postgres> + Type<Postgres>,
        T: Decode<'r, MySql> + Type<MySql>,
        T: Decode<'r, Sqlite> + Type<Sqlite>,
    {
        match self {
            DbRow::Pg(r) => r.try_get(col),
            DbRow::My(r) => r.try_get(col),
            DbRow::Sq(r) => r.try_get(col),
        }
    }
}

/// The bound on a struct decodable from any of the three engines' rows. Written
/// once here so a module's struct only needs `#[derive(sqlx::FromRow)]`.
pub trait FromAnyRow:
    Send
    + Unpin
    + for<'r> FromRow<'r, PgRow>
    + for<'r> FromRow<'r, MySqlRow>
    + for<'r> FromRow<'r, SqliteRow>
{
}
impl<T> FromAnyRow for T where
    T: Send
        + Unpin
        + for<'r> FromRow<'r, PgRow>
        + for<'r> FromRow<'r, MySqlRow>
        + for<'r> FromRow<'r, SqliteRow>
{
}

/// The bound on a single-column scalar decodable from any of the three engines.
pub trait ScalarAnyRow:
    Send
    + Unpin
    + for<'r> Decode<'r, Postgres>
    + Type<Postgres>
    + for<'r> Decode<'r, MySql>
    + Type<MySql>
    + for<'r> Decode<'r, Sqlite>
    + Type<Sqlite>
{
}
impl<T> ScalarAnyRow for T where
    T: Send
        + Unpin
        + for<'r> Decode<'r, Postgres>
        + Type<Postgres>
        + for<'r> Decode<'r, MySql>
        + Type<MySql>
        + for<'r> Decode<'r, Sqlite>
        + Type<Sqlite>
{
}

impl DbPool {
    /// Which engine this pool talks to.
    pub fn backend(&self) -> Backend {
        match &self.kind {
            PoolKind::Pg(_) => Backend::Postgres,
            PoolKind::My(_) => Backend::MySql,
            PoolKind::Sq(_) => Backend::Sqlite,
        }
    }

    fn prepare(&self, sql: &str) -> Result<String, sqlx::Error> {
        let placeholders = sql::prepare(sql, self.backend()).map_err(sql::into_sqlx_error)?;
        // Apply the schema prefix last. When none is set this is a no-op that
        // returns the string borrowed and unchanged, so the default path costs
        // exactly what it did before prefixing existed.
        Ok(self.prefix.rewrite(&placeholders).into_owned())
    }

    // ── writes ────────────────────────────────────────────────────────────────

    /// Runs a write and returns the number of rows affected.
    ///
    /// On SQLite this takes the single-writer permit and retries on a transient
    /// `BUSY`/`LOCKED`.
    pub async fn execute(&self, sql: &str, params: Vec<DbValue>) -> Result<u64, sqlx::Error> {
        let prepared = self.prepare(sql)?;
        match &self.kind {
            PoolKind::Pg(p) => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .execute(p)
                .await?
                .rows_affected()),
            PoolKind::My(p) => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .execute(p)
                .await?
                .rows_affected()),
            PoolKind::Sq(h) => {
                let _permit = h.write.acquire().await.expect("write semaphore never closes");
                with_sqlite_retry(|| {
                    let sql = prepared.clone();
                    let params = params.clone();
                    let pool = h.pool.clone();
                    async move {
                        Ok(bind_all!(sqlx::query(safe(sql)), params)
                            .execute(&pool)
                            .await?
                            .rows_affected())
                    }
                })
                .await
            }
        }
    }

    // ── reads into a struct ─────────────────────────────────────────────────────

    pub async fn fetch_all_as<T: FromAnyRow>(
        &self,
        sql: &str,
        params: Vec<DbValue>,
    ) -> Result<Vec<T>, sqlx::Error> {
        let prepared = self.prepare(sql)?;
        match &self.kind {
            PoolKind::Pg(p) => bind_all!(sqlx::query_as::<_, T>(safe(prepared)), params)
                .fetch_all(p)
                .await,
            PoolKind::My(p) => bind_all!(sqlx::query_as::<_, T>(safe(prepared)), params)
                .fetch_all(p)
                .await,
            PoolKind::Sq(h) => {
                with_sqlite_retry(|| {
                    let sql = prepared.clone();
                    let params = params.clone();
                    let pool = h.pool.clone();
                    async move {
                        bind_all!(sqlx::query_as::<_, T>(safe(sql)), params)
                            .fetch_all(&pool)
                            .await
                    }
                })
                .await
            }
        }
    }

    pub async fn fetch_optional_as<T: FromAnyRow>(
        &self,
        sql: &str,
        params: Vec<DbValue>,
    ) -> Result<Option<T>, sqlx::Error> {
        let prepared = self.prepare(sql)?;
        match &self.kind {
            PoolKind::Pg(p) => bind_all!(sqlx::query_as::<_, T>(safe(prepared)), params)
                .fetch_optional(p)
                .await,
            PoolKind::My(p) => bind_all!(sqlx::query_as::<_, T>(safe(prepared)), params)
                .fetch_optional(p)
                .await,
            PoolKind::Sq(h) => {
                with_sqlite_retry(|| {
                    let sql = prepared.clone();
                    let params = params.clone();
                    let pool = h.pool.clone();
                    async move {
                        bind_all!(sqlx::query_as::<_, T>(safe(sql)), params)
                            .fetch_optional(&pool)
                            .await
                    }
                })
                .await
            }
        }
    }

    pub async fn fetch_one_as<T: FromAnyRow>(
        &self,
        sql: &str,
        params: Vec<DbValue>,
    ) -> Result<T, sqlx::Error> {
        self.fetch_optional_as(sql, params)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    // ── reads of a single scalar ────────────────────────────────────────────────

    pub async fn fetch_optional_scalar<T: ScalarAnyRow>(
        &self,
        sql: &str,
        params: Vec<DbValue>,
    ) -> Result<Option<T>, sqlx::Error> {
        let prepared = self.prepare(sql)?;
        match &self.kind {
            PoolKind::Pg(p) => bind_all!(sqlx::query_scalar::<_, T>(safe(prepared)), params)
                .fetch_optional(p)
                .await,
            PoolKind::My(p) => bind_all!(sqlx::query_scalar::<_, T>(safe(prepared)), params)
                .fetch_optional(p)
                .await,
            PoolKind::Sq(h) => {
                with_sqlite_retry(|| {
                    let sql = prepared.clone();
                    let params = params.clone();
                    let pool = h.pool.clone();
                    async move {
                        bind_all!(sqlx::query_scalar::<_, T>(safe(sql)), params)
                            .fetch_optional(&pool)
                            .await
                    }
                })
                .await
            }
        }
    }

    pub async fn fetch_scalar<T: ScalarAnyRow>(
        &self,
        sql: &str,
        params: Vec<DbValue>,
    ) -> Result<T, sqlx::Error> {
        self.fetch_optional_scalar(sql, params)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    // ── a row without a struct ──────────────────────────────────────────────────

    pub async fn fetch_optional_row(
        &self,
        sql: &str,
        params: Vec<DbValue>,
    ) -> Result<Option<DbRow>, sqlx::Error> {
        let prepared = self.prepare(sql)?;
        match &self.kind {
            PoolKind::Pg(p) => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .fetch_optional(p)
                .await?
                .map(DbRow::Pg)),
            PoolKind::My(p) => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .fetch_optional(p)
                .await?
                .map(DbRow::My)),
            PoolKind::Sq(h) => {
                with_sqlite_retry(|| {
                    let sql = prepared.clone();
                    let params = params.clone();
                    let pool = h.pool.clone();
                    async move {
                        Ok(bind_all!(sqlx::query(safe(sql)), params)
                            .fetch_optional(&pool)
                            .await?
                            .map(DbRow::Sq))
                    }
                })
                .await
            }
        }
    }

    /// Every row of a query, without a target struct - for callers that map
    /// columns by name at run time (the portable backup writer). On SQLite this
    /// retries a transient `BUSY`/`LOCKED`.
    pub async fn fetch_all_row(
        &self,
        sql: &str,
        params: Vec<DbValue>,
    ) -> Result<Vec<DbRow>, sqlx::Error> {
        let prepared = self.prepare(sql)?;
        match &self.kind {
            PoolKind::Pg(p) => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .fetch_all(p)
                .await?
                .into_iter()
                .map(DbRow::Pg)
                .collect()),
            PoolKind::My(p) => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .fetch_all(p)
                .await?
                .into_iter()
                .map(DbRow::My)
                .collect()),
            PoolKind::Sq(h) => {
                with_sqlite_retry(|| {
                    let sql = prepared.clone();
                    let params = params.clone();
                    let pool = h.pool.clone();
                    async move {
                        Ok(bind_all!(sqlx::query(safe(sql)), params)
                            .fetch_all(&pool)
                            .await?
                            .into_iter()
                            .map(DbRow::Sq)
                            .collect())
                    }
                })
                .await
            }
        }
    }

    // ── transactions ────────────────────────────────────────────────────────────

    /// Begins a transaction. On SQLite this takes the single-writer permit for
    /// the transaction's whole life, so write transactions serialise; it is
    /// released on commit, rollback or drop.
    pub async fn begin(&self) -> Result<DbTx, sqlx::Error> {
        let kind = match &self.kind {
            PoolKind::Pg(p) => TxKind::Pg(p.begin().await?),
            PoolKind::My(p) => TxKind::My(p.begin().await?),
            PoolKind::Sq(h) => {
                let permit = h
                    .write
                    .clone()
                    .acquire_owned()
                    .await
                    .expect("write semaphore never closes");
                let tx = h.pool.begin().await?;
                TxKind::Sq { tx, _write: permit }
            }
        };
        // The transaction inherits the pool's schema prefix, so statements issued
        // through it are rewritten the same way.
        Ok(DbTx { kind, prefix: self.prefix.clone() })
    }
}

/// An open transaction on whichever engine is in use, carrying the same schema
/// prefix as the pool it began from.
pub struct DbTx {
    kind: TxKind,
    prefix: SchemaPrefix,
}

/// The concrete sqlx transaction behind a [`DbTx`], one variant per engine.
enum TxKind {
    Pg(sqlx::Transaction<'static, Postgres>),
    My(sqlx::Transaction<'static, MySql>),
    Sq {
        tx: sqlx::Transaction<'static, Sqlite>,
        // Held for the transaction's whole life so SQLite writers serialise.
        _write: OwnedSemaphorePermit,
    },
}

impl DbTx {
    pub fn backend(&self) -> Backend {
        match &self.kind {
            TxKind::Pg(_) => Backend::Postgres,
            TxKind::My(_) => Backend::MySql,
            TxKind::Sq { .. } => Backend::Sqlite,
        }
    }

    fn prepare(&self, sql: &str) -> Result<String, sqlx::Error> {
        let placeholders = sql::prepare(sql, self.backend()).map_err(sql::into_sqlx_error)?;
        // Apply the schema prefix last. When none is set this is a no-op that
        // returns the string borrowed and unchanged, so the default path costs
        // exactly what it did before prefixing existed.
        Ok(self.prefix.rewrite(&placeholders).into_owned())
    }

    pub async fn execute(&mut self, sql: &str, params: Vec<DbValue>) -> Result<u64, sqlx::Error> {
        let prepared = self.prepare(sql)?;
        match &mut self.kind {
            TxKind::Pg(tx) => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .execute(&mut **tx)
                .await?
                .rows_affected()),
            TxKind::My(tx) => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .execute(&mut **tx)
                .await?
                .rows_affected()),
            TxKind::Sq { tx, .. } => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .execute(&mut **tx)
                .await?
                .rows_affected()),
        }
    }

    pub async fn fetch_optional_scalar<T: ScalarAnyRow>(
        &mut self,
        sql: &str,
        params: Vec<DbValue>,
    ) -> Result<Option<T>, sqlx::Error> {
        let prepared = self.prepare(sql)?;
        match &mut self.kind {
            TxKind::Pg(tx) => bind_all!(sqlx::query_scalar::<_, T>(safe(prepared)), params)
                .fetch_optional(&mut **tx)
                .await,
            TxKind::My(tx) => bind_all!(sqlx::query_scalar::<_, T>(safe(prepared)), params)
                .fetch_optional(&mut **tx)
                .await,
            TxKind::Sq { tx, .. } => bind_all!(sqlx::query_scalar::<_, T>(safe(prepared)), params)
                .fetch_optional(&mut **tx)
                .await,
        }
    }

    pub async fn fetch_optional_row(
        &mut self,
        sql: &str,
        params: Vec<DbValue>,
    ) -> Result<Option<DbRow>, sqlx::Error> {
        let prepared = self.prepare(sql)?;
        match &mut self.kind {
            TxKind::Pg(tx) => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .fetch_optional(&mut **tx)
                .await?
                .map(DbRow::Pg)),
            TxKind::My(tx) => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .fetch_optional(&mut **tx)
                .await?
                .map(DbRow::My)),
            TxKind::Sq { tx, .. } => Ok(bind_all!(sqlx::query(safe(prepared)), params)
                .fetch_optional(&mut **tx)
                .await?
                .map(DbRow::Sq)),
        }
    }

    pub async fn commit(self) -> Result<(), sqlx::Error> {
        match self.kind {
            TxKind::Pg(tx) => tx.commit().await,
            TxKind::My(tx) => tx.commit().await,
            TxKind::Sq { tx, _write } => {
                let r = tx.commit().await;
                drop(_write);
                r
            }
        }
    }

    pub async fn rollback(self) -> Result<(), sqlx::Error> {
        match self.kind {
            TxKind::Pg(tx) => tx.rollback().await,
            TxKind::My(tx) => tx.rollback().await,
            TxKind::Sq { tx, _write } => {
                let r = tx.rollback().await;
                drop(_write);
                r
            }
        }
    }
}

/// Wraps `AssertSqlSafe`: the text came out of [`crate::sql::prepare`], the only
/// place the platform builds SQL text at run time.
fn safe(sql: String) -> sqlx::AssertSqlSafe<String> {
    sqlx::AssertSqlSafe(sql)
}

/// Whether a sqlx error is a transient SQLite `BUSY` (5) or `LOCKED` (6).
fn is_sqlite_busy(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .and_then(|d| d.code())
        .map(|c| c == "5" || c == "6")
        .unwrap_or(false)
}

/// Retries a SQLite operation on `BUSY`/`LOCKED` with bounded exponential
/// back-off. `busy_timeout` handles most contention inside the driver; this
/// catches what still surfaces.
async fn with_sqlite_retry<F, Fut, T>(mut f: F) -> Result<T, sqlx::Error>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, sqlx::Error>>,
{
    let mut delay = Duration::from_millis(20);
    let mut attempts = 0u32;
    loop {
        match f().await {
            Err(e) if attempts < 6 && is_sqlite_busy(&e) => {
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_millis(500));
                attempts += 1;
            }
            other => return other,
        }
    }
}
