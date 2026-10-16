//! A thin, dialect-aware builder for queries whose shape is decided at run time.
//!
//! # The gap this fills
//!
//! The [`crate::exec`] executor takes one finished SQL string plus a
//! `Vec<DbValue>`. That is enough for a statement the developer writes out in
//! full, but not for a search whose `WHERE` clause depends on which filters the
//! caller supplied, or for an `IN (...)` whose length is only known at run time.
//!
//! Before the runtime-engine switch those queries were built with
//! `sqlx::QueryBuilder<Postgres>` and `.push()` / `.push_bind()`. That type is
//! monomorphic over one backend and produces a `Query<'_, Postgres, _>`, so it
//! cannot go through the [`crate::DbPool`] enum at all. [`DbQueryBuilder`] is
//! its portable replacement: it accumulates SQL text and [`DbValue`] binds, and
//! hands both to the same runtime executor, which rewrites the placeholders for
//! the compiled-in engine (`crate::sql::prepare`) and encodes the binds.
//!
//! # Why not `sea-query`
//!
//! `sea-query` is the reference dynamic builder, but its sqlx bridge
//! (`sea-query-binder`) renders to `(String, sea_query::Values)` for
//! `sqlx::query_with`, which is still monomorphic per backend - the runtime
//! `match` over the three engines, and the value-encoding it drives, would
//! still have to live here (it is [`crate::exec`]'s `bind_all!`). It would also
//! add a second value enum next to [`DbValue`] and its own dependency tree. The
//! builder below reuses [`DbValue`], `sql::prepare` and [`crate::dialect`], so
//! it is a few hundred lines with no new dependency.
//!
//! # The one safety rule
//!
//! **Structure is text; data is a bind.** Everything pushed as text
//! ([`DbQueryBuilder::push`], [`DbQueryBuilder::push_order_by`]) is SQL the
//! developer authored - a `&'static str`, or a fragment built by
//! [`crate::dialect`] from `&'static str` identifiers. Every value that could
//! come from a request goes through [`DbQueryBuilder::push_bind`] /
//! [`DbQueryBuilder::push_in`] / [`DbQueryBuilder::push_limit_offset`], which
//! emit a numbered placeholder and record a [`DbValue`] - the value is never
//! turned into text and so can never be interpolated. This is the same
//! discipline `sql::prepare` enforces, and it is the site of the historical
//! app/Data SQL-injection: keeping user data off the text path is the whole
//! point.

use crate::dialect::Backend;
use crate::exec::{DbPool, DbRow, DbTx, FromAnyRow, ScalarAnyRow};
use crate::value::DbValue;

/// Builds a SQL statement whose shape is decided at run time, in the PostgreSQL
/// `$n` placeholder style that [`crate::sql::prepare`] consumes.
///
/// A builder is tied to one [`Backend`] because the dialect fragments it may be
/// fed (`dialect::ilike`, `dialect::json_text`, …) are already spelled for that
/// engine; execute it only against a pool of the same backend. In practice you
/// build it from `pool.backend()`.
///
/// ```ignore
/// let mut qb = DbQueryBuilder::new(pool.backend(), "SELECT c.* FROM contacts.contacts c");
/// qb.push(" WHERE c.owner_id = ").push_bind(owner_id);
/// if let Some(gid) = group_id {
///     qb.push(" AND c.group_id = ").push_bind(gid);
/// }
/// qb.push(" AND c.id").push_in(visible_ids);       // ` AND c.id IN ($2, $3, …)`
/// qb.push_order_by("c.display_name ASC");
/// qb.push_limit_offset(limit, offset);
/// let rows: Vec<Contact> = qb.fetch_all_as(pool).await?;
/// ```
#[derive(Debug, Clone)]
pub struct DbQueryBuilder {
    backend: Backend,
    sql: String,
    params: Vec<DbValue>,
}

impl DbQueryBuilder {
    /// Starts a builder from an opening SQL fragment (a `SELECT ... FROM ...`,
    /// say). The fragment is **structure**, so it must be developer-authored
    /// text with no request data in it. Bind every value with
    /// [`push_bind`](Self::push_bind) instead - and do not write `$n` by hand,
    /// the builder numbers placeholders for you.
    pub fn new(backend: Backend, initial: impl AsRef<str>) -> Self {
        DbQueryBuilder {
            backend,
            sql: initial.as_ref().to_owned(),
            params: Vec::new(),
        }
    }

    /// The engine this builder targets.
    pub fn backend(&self) -> Backend {
        self.backend
    }

    /// Appends a **structural** SQL fragment verbatim: a keyword, a column
    /// list, a parenthesis, or a fragment returned by [`crate::dialect`].
    ///
    /// Never pass request data here - it would land on the SQL text path and
    /// re-open the injection this crate exists to close. Use
    /// [`push_bind`](Self::push_bind) for values.
    pub fn push(&mut self, fragment: impl AsRef<str>) -> &mut Self {
        self.sql.push_str(fragment.as_ref());
        self
    }

    /// Emits the next `$n` placeholder and records `value` as its bind. This is
    /// the only channel for data. Chains with [`push`](Self::push), so the call
    /// site reads like the old `qb.push(" AND a = ").push_bind(v)`.
    pub fn push_bind(&mut self, value: impl Into<DbValue>) -> &mut Self {
        self.params.push(value.into());
        self.write_placeholder(self.params.len());
        self
    }

    /// Records `value` as the next bind and returns its placeholder number,
    /// **without** writing `$n` into the SQL. The caller then writes the
    /// reference itself with [`push`](Self::push) - the escape hatch for
    /// interpolating a fragment produced by [`crate::dialect`] or a hand-built
    /// subquery that must name a specific placeholder (a recursive CTE whose
    /// anchor is `WHERE id = $n`, say). The number must still appear in
    /// ascending order in the final text, exactly once, like any other.
    pub fn bind_only(&mut self, value: impl Into<DbValue>) -> usize {
        self.params.push(value.into());
        self.params.len()
    }

    /// Appends ` IN (<placeholders>)` for a variadic list, binding each element.
    /// Reuses [`Backend::in_list`], so an **empty** list yields `IN (NULL)`,
    /// which matches nothing on all three engines - the caller does not need a
    /// special case for "no ids".
    ///
    /// ```ignore
    /// qb.push("c.id").push_in(ids);   // ` IN ($4, $5, $6)`  - or ` IN (NULL)` if empty
    /// ```
    pub fn push_in<V, I>(&mut self, values: I) -> &mut Self
    where
        I: IntoIterator<Item = V>,
        V: Into<DbValue>,
    {
        let start = self.params.len() + 1;
        let before = self.params.len();
        self.params.extend(values.into_iter().map(Into::into));
        let count = self.params.len() - before;
        // `in_list` renders the placeholders (or `NULL` when empty) in the local
        // spelling; it is identical across the three engines.
        self.sql.push_str(" IN (");
        self.sql.push_str(&self.backend.in_list(start, count));
        self.sql.push(')');
        self
    }

    /// Appends ` ORDER BY <clause>`. The clause is **structure**: it must be a
    /// `&'static str`, typically one the caller picked from a fixed whitelist of
    /// sortable columns. Never build it from request text.
    pub fn push_order_by(&mut self, clause: &'static str) -> &mut Self {
        self.sql.push_str(" ORDER BY ");
        self.sql.push_str(clause);
        self
    }

    /// Appends ` LIMIT $a OFFSET $b`, binding both as `i64`. Valid on the three
    /// engines. Pass a non-negative `limit`; clamp it to a sane page size before
    /// calling.
    pub fn push_limit_offset(&mut self, limit: i64, offset: i64) -> &mut Self {
        self.push(" LIMIT ").push_bind(limit).push(" OFFSET ").push_bind(offset);
        self
    }

    /// The SQL as accumulated, still in `$n` style (before per-engine placeholder
    /// rewriting). For assertions and logging; execution goes through the
    /// terminals below, which rewrite and bind.
    pub fn as_sql(&self) -> &str {
        &self.sql
    }

    /// How many binds have been recorded - i.e. the number of the last `$n`.
    pub fn bind_count(&self) -> usize {
        self.params.len()
    }

    /// Consumes the builder into `(sql, params)`, the pair the [`crate::exec`]
    /// methods take. An escape hatch for a call the terminals below do not cover.
    pub fn into_parts(self) -> (String, Vec<DbValue>) {
        (self.sql, self.params)
    }

    fn write_placeholder(&mut self, n: usize) {
        use std::fmt::Write as _;
        self.sql.push('$');
        // Cannot fail for a `String` sink.
        let _ = write!(self.sql, "{n}");
    }

    fn check_backend(&self, pool_backend: Backend) {
        debug_assert_eq!(
            self.backend, pool_backend,
            "DbQueryBuilder was built for {:?} but executed against a {:?} pool; \
             dialect fragments would be wrong",
            self.backend, pool_backend
        );
    }

    // ── terminals on a pool ─────────────────────────────────────────────────
    //
    // These borrow `&self` and clone the binds, so a builder holding a shared
    // set of filters can be executed more than once (e.g. the list query and the
    // matching `COUNT(*)`), exactly as the old two-`QueryBuilder` pattern did.

    /// Runs the statement as a write, returning rows affected.
    pub async fn execute(&self, pool: &DbPool) -> Result<u64, sqlx::Error> {
        self.check_backend(pool.backend());
        pool.execute(&self.sql, self.params.clone()).await
    }

    /// Reads every matching row into `T`.
    pub async fn fetch_all_as<T: FromAnyRow>(&self, pool: &DbPool) -> Result<Vec<T>, sqlx::Error> {
        self.check_backend(pool.backend());
        pool.fetch_all_as::<T>(&self.sql, self.params.clone()).await
    }

    /// Reads the first matching row into `T`, if any.
    pub async fn fetch_optional_as<T: FromAnyRow>(
        &self,
        pool: &DbPool,
    ) -> Result<Option<T>, sqlx::Error> {
        self.check_backend(pool.backend());
        pool.fetch_optional_as::<T>(&self.sql, self.params.clone()).await
    }

    /// Reads exactly one row into `T`, erroring if there is none.
    pub async fn fetch_one_as<T: FromAnyRow>(&self, pool: &DbPool) -> Result<T, sqlx::Error> {
        self.check_backend(pool.backend());
        pool.fetch_one_as::<T>(&self.sql, self.params.clone()).await
    }

    /// Reads a single scalar column, if any row matches.
    pub async fn fetch_optional_scalar<T: ScalarAnyRow>(
        &self,
        pool: &DbPool,
    ) -> Result<Option<T>, sqlx::Error> {
        self.check_backend(pool.backend());
        pool.fetch_optional_scalar::<T>(&self.sql, self.params.clone()).await
    }

    /// Reads a single scalar column (a `COUNT(*)`, say), erroring if none.
    pub async fn fetch_scalar<T: ScalarAnyRow>(&self, pool: &DbPool) -> Result<T, sqlx::Error> {
        self.check_backend(pool.backend());
        pool.fetch_scalar::<T>(&self.sql, self.params.clone()).await
    }

    /// Reads one row without a target struct, for hand-mapped columns.
    pub async fn fetch_optional_row(&self, pool: &DbPool) -> Result<Option<DbRow>, sqlx::Error> {
        self.check_backend(pool.backend());
        pool.fetch_optional_row(&self.sql, self.params.clone()).await
    }

    // ── terminals on a transaction ──────────────────────────────────────────

    /// Runs the statement as a write on an open transaction.
    pub async fn tx_execute(&self, tx: &mut DbTx) -> Result<u64, sqlx::Error> {
        self.check_backend(tx.backend());
        tx.execute(&self.sql, self.params.clone()).await
    }

    /// Reads a single scalar column on an open transaction.
    pub async fn tx_fetch_optional_scalar<T: ScalarAnyRow>(
        &self,
        tx: &mut DbTx,
    ) -> Result<Option<T>, sqlx::Error> {
        self.check_backend(tx.backend());
        tx.fetch_optional_scalar::<T>(&self.sql, self.params.clone()).await
    }

    /// Reads one row without a target struct on an open transaction.
    pub async fn tx_fetch_optional_row(&self, tx: &mut DbTx) -> Result<Option<DbRow>, sqlx::Error> {
        self.check_backend(tx.backend());
        tx.fetch_optional_row(&self.sql, self.params.clone()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql;

    /// Builds one representative dynamic search: a fixed base, an always-on
    /// owner filter, two optional filters, a variadic `IN`, then a dynamic
    /// `ORDER BY` and `LIMIT`/`OFFSET`. Mirrors the real contacts/mail shape.
    fn sample(backend: Backend, starred: Option<bool>, ids: &[i64]) -> DbQueryBuilder {
        let mut qb = DbQueryBuilder::new(backend, "SELECT c.* FROM contacts.contacts c");
        qb.push(" WHERE c.owner_id = ").push_bind(42i64);
        if let Some(s) = starred {
            qb.push(" AND c.is_starred = ").push_bind(s);
        }
        qb.push(" AND c.id").push_in(ids.iter().copied());
        qb.push_order_by("c.display_name ASC");
        qb.push_limit_offset(50, 0);
        qb
    }

    #[test]
    fn numbers_placeholders_in_order() {
        // owner($1), starred($2), two ids($3,$4), limit($5), offset($6).
        let qb = sample(Backend::Postgres, Some(true), &[7, 8]);
        assert_eq!(
            qb.as_sql(),
            "SELECT c.* FROM contacts.contacts c \
             WHERE c.owner_id = $1 AND c.is_starred = $2 AND c.id IN ($3, $4) \
             ORDER BY c.display_name ASC LIMIT $5 OFFSET $6"
        );
        assert_eq!(qb.bind_count(), 6);
    }

    #[test]
    fn optional_filter_shifts_later_numbers() {
        // Drop the starred filter: ids become $2,$3, limit/offset $4/$5.
        let qb = sample(Backend::Postgres, None, &[7, 8]);
        assert_eq!(
            qb.as_sql(),
            "SELECT c.* FROM contacts.contacts c \
             WHERE c.owner_id = $1 AND c.id IN ($2, $3) \
             ORDER BY c.display_name ASC LIMIT $4 OFFSET $5"
        );
        assert_eq!(qb.bind_count(), 5);
    }

    #[test]
    fn empty_in_list_matches_nothing() {
        let qb = sample(Backend::Postgres, None, &[]);
        assert!(qb.as_sql().contains("c.id IN (NULL)"), "{}", qb.as_sql());
    }

    #[test]
    fn postgres_keeps_dollar_n_mysql_and_sqlite_get_question_marks() {
        // The builder always emits `$n`; `sql::prepare` rewrites per engine at
        // execution. This asserts the dialect-visible result of that rewrite.
        let pg = sample(Backend::Postgres, Some(true), &[7, 8]);
        let prepared_pg = sql::prepare(pg.as_sql(), Backend::Postgres).unwrap();
        assert!(prepared_pg.contains("$1") && prepared_pg.contains("$6"));
        assert!(!prepared_pg.contains('?'));

        for backend in [Backend::MySql, Backend::Sqlite] {
            let qb = sample(backend, Some(true), &[7, 8]);
            let prepared = sql::prepare(qb.as_sql(), backend).unwrap();
            assert_eq!(prepared.matches('?').count(), 6, "{backend:?}: {prepared}");
            assert!(!prepared.contains('$'), "{backend:?}: {prepared}");
        }
    }

    #[test]
    fn every_built_query_survives_prepare_on_all_engines() {
        for backend in [Backend::Postgres, Backend::MySql, Backend::Sqlite] {
            for starred in [None, Some(true)] {
                for ids in [vec![], vec![1i64], vec![1i64, 2, 3]] {
                    let qb = sample(backend, starred, &ids);
                    assert!(
                        sql::prepare(qb.as_sql(), backend).is_ok(),
                        "{backend:?} starred={starred:?} ids={ids:?}: {}",
                        qb.as_sql()
                    );
                }
            }
        }
    }

    #[test]
    fn values_never_reach_the_text() {
        // A hostile string is bound, so it must appear in params, never in SQL.
        let mut qb = DbQueryBuilder::new(Backend::Postgres, "SELECT 1 WHERE name = ");
        qb.push_bind("Robert'); DROP TABLE students;--");
        let (sql, params) = qb.into_parts();
        assert_eq!(sql, "SELECT 1 WHERE name = $1");
        assert!(!sql.contains("DROP"), "user data leaked into text: {sql}");
        assert_eq!(params.len(), 1);
        assert_eq!(params[0], DbValue::Text(Some("Robert'); DROP TABLE students;--".into())));
    }
}

/// Executes builder output against a real engine. SQLite runs unconditionally
/// on a temp file; MySQL/MariaDB runs only when `KUBUNO_QB_MYSQL_URL` points at
/// a throwaway server, and is skipped (loudly) otherwise. Both prove the same
/// thing: a dynamically shaped query built here binds correctly end to end.
#[cfg(test)]
mod exec_tests {
    use super::*;
    use crate::pool::{connect, DbSettings};
    use std::time::Duration;

    #[derive(Debug, sqlx::FromRow, PartialEq)]
    struct Item {
        id: i64,
        name: String,
    }

    /// Seeds four rows and runs one dynamic query with an optional `starred`
    /// filter, a variadic `IN`, an `ORDER BY` and a `LIMIT`, asserting the
    /// bound values selected the right rows. `schema` is the namespace the
    /// pool attached/created.
    async fn seed_and_query(pool: &DbPool, schema: &str) {
        let table = format!("{schema}.items");
        pool.execute(
            &format!(
                "CREATE TABLE {table} \
                 (id BIGINT PRIMARY KEY, owner_id BIGINT NOT NULL, \
                  name VARCHAR(64) NOT NULL, starred BOOLEAN NOT NULL)"
            ),
            crate::params![],
        )
        .await
        .expect("create table");

        // (id, owner, name, starred)
        let rows = [
            (1i64, 10i64, "alpha", true),
            (2, 10, "bravo", false),
            (3, 10, "charlie", true),
            (4, 99, "other", true), // different owner: must never match below
        ];
        for (id, owner, name, starred) in rows {
            pool.execute(
                &format!(
                    "INSERT INTO {table} (id, owner_id, name, starred) VALUES ($1, $2, $3, $4)"
                ),
                crate::params![id, owner, name, starred],
            )
            .await
            .expect("insert");
        }

        // Dynamic query: owner 10, starred only, id in {1,2,3}, newest name first,
        // limited. Only rows 1 and 3 qualify (2 is not starred, 4 is owner 99).
        let mut qb =
            DbQueryBuilder::new(pool.backend(), format!("SELECT id, name FROM {table}"));
        qb.push(" WHERE owner_id = ").push_bind(10i64);
        let starred_filter = Some(true);
        if let Some(s) = starred_filter {
            qb.push(" AND starred = ").push_bind(s);
        }
        qb.push(" AND id").push_in([1i64, 2, 3]);
        qb.push_order_by("name DESC");
        qb.push_limit_offset(10, 0);

        let found: Vec<Item> = qb.fetch_all_as(pool).await.expect("fetch");
        assert_eq!(
            found,
            vec![
                Item { id: 3, name: "charlie".into() },
                Item { id: 1, name: "alpha".into() },
            ],
            "dynamic filters + IN + ORDER selected the wrong rows on {:?}",
            pool.backend()
        );

        // Empty IN must match nothing, not error and not match all.
        let mut none =
            DbQueryBuilder::new(pool.backend(), format!("SELECT id, name FROM {table}"));
        none.push(" WHERE owner_id = ").push_bind(10i64).push(" AND id");
        none.push_in(Vec::<i64>::new());
        let empty: Vec<Item> = none.fetch_all_as(pool).await.expect("fetch empty");
        assert!(empty.is_empty(), "empty IN matched rows on {:?}", pool.backend());
    }

    fn sqlite_settings(dir: &str) -> DbSettings {
        DbSettings {
            engine: "sqlite".into(),
            url: None,
            host: None,
            port: None,
            user: None,
            password: None,
            database: None,
            path: Some(dir.into()),
            schema_prefix: None,
            max_connections: 1,
            min_connections: 0,
            connect_timeout: Duration::from_secs(10),
            run_migrations: false,
        }
    }

    #[tokio::test]
    async fn runs_against_sqlite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = connect(&sqlite_settings(&dir.path().to_string_lossy()), "qb")
            .await
            .expect("connect sqlite");
        seed_and_query(&pool, "qb").await;
    }

    /// Runs only when a throwaway server URL is provided, and **fails** rather
    /// than skips if the connection or schema setup breaks - a test that
    /// silently does nothing is worse than none.
    #[tokio::test]
    async fn runs_against_mysql_when_configured() {
        let Ok(url) = std::env::var("KUBUNO_QB_MYSQL_URL") else {
            eprintln!("KUBUNO_QB_MYSQL_URL unset - skipping the MySQL/MariaDB round-trip");
            return;
        };
        let settings = DbSettings {
            engine: "mysql".into(),
            url: Some(url),
            host: None,
            port: None,
            user: None,
            password: None,
            database: None,
            path: None,
            schema_prefix: None,
            max_connections: 2,
            min_connections: 0,
            connect_timeout: Duration::from_secs(10),
            run_migrations: false,
        };
        let pool = connect(&settings, "qb").await.expect("connect mysql");
        // The URL already selects database `qb`; make sure the table is fresh.
        pool.execute("DROP TABLE IF EXISTS qb.items", crate::params![])
            .await
            .expect("drop");
        seed_and_query(&pool, "qb").await;
        pool.execute("DROP TABLE IF EXISTS qb.items", crate::params![])
            .await
            .expect("cleanup");
    }
}
