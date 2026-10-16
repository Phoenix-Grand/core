//! Connecting, the per-engine session policy, and what "a schema" means.
//!
//! The engine is chosen at run time from [`DbSettings::engine`], so [`connect`]
//! opens one of three concrete pools and hands back a [`DbPool`] enum. All
//! three drivers are compiled into the binary.
//!
//! `keestore.vaults` - a schema-qualified name - works on all three engines:
//!
//! * **PostgreSQL**: a real schema inside the database.
//! * **MySQL/MariaDB**: no schemas; a database *is* the namespace, so
//!   `keestore.vaults` is a table in the `keestore` database.
//! * **SQLite**: `ATTACH DATABASE '…/keestore.sqlite' AS keestore`, re-issued on
//!   every pooled connection.
//!
//! Per-engine session policy also lives here (see `after_connect`): SQLite gets
//! `WAL` + a generous `busy_timeout` + foreign keys; MySQL gets
//! `time_zone = '+00:00'` and a case-sensitive `utf8mb4` collation, so a UTC
//! timestamp round-trips and a `UNIQUE` key does not fold case.

use std::str::FromStr;
use std::time::Duration;

use serde::Deserialize;
use sqlx::Executor as _;

use crate::dialect::Backend;
use crate::exec::{DbPool, SqliteHandle};
use crate::schema::SchemaPrefix;

/// Anything that went wrong before the first query.
#[derive(Debug, thiserror::Error)]
pub enum SetupError {
    #[error("database settings: {0}")]
    Settings(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

/// The `[database]` section of a module's configuration.
///
/// A single `config.toml` can describe all three engines; `engine` selects
/// which fields matter.
///
/// `Debug` is written by hand so the password - the discrete field and the one a
/// connection URL may carry - never reaches a log through `?settings`.
#[derive(Clone, Deserialize)]
pub struct DbSettings {
    /// `"postgres"` (default), `"mysql"`/`"mariadb"`, or `"sqlite"`. This is the
    /// administrator's choice of engine.
    #[serde(default = "default_engine")]
    pub engine: String,

    /// A full connection URL. Takes priority over the discrete fields.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    /// PostgreSQL/MySQL: the database to connect to. Ignored by SQLite.
    #[serde(default)]
    pub database: Option<String>,
    /// SQLite only: the directory holding `<schema>.sqlite`. Defaults to `./data`.
    #[serde(default)]
    pub path: Option<String>,

    /// Optional schema-name prefix (WordPress-style), so several Kubuno instances
    /// can share one database server. Empty/absent means no prefix, and the
    /// behaviour is then byte-for-byte identical to before this existed. A
    /// non-empty value must match `^[a-z0-9_]{1,32}$`; it is validated when the
    /// pool is opened. See [`crate::schema::SchemaPrefix`].
    #[serde(default)]
    pub schema_prefix: Option<String>,

    #[serde(default = "default_max_connections")]
    pub max_connections: u32,
    #[serde(default)]
    pub min_connections: u32,
    #[serde(default = "default_connect_timeout", with = "duration_secs")]
    pub connect_timeout: Duration,
    #[serde(default = "default_true")]
    pub run_migrations: bool,
}

impl std::fmt::Debug for DbSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbSettings")
            .field("engine", &self.engine)
            .field("url", &self.url.as_deref().map(redact_url_password))
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("database", &self.database)
            .field("path", &self.path)
            .field("schema_prefix", &self.schema_prefix)
            .field("max_connections", &self.max_connections)
            .field("min_connections", &self.min_connections)
            .field("connect_timeout", &self.connect_timeout)
            .field("run_migrations", &self.run_migrations)
            .finish()
    }
}

/// `scheme://user:secret@host/db` → `scheme://user:<redacted>@host/db`. A URL
/// without a password in its authority is returned unchanged.
fn redact_url_password(url: &str) -> String {
    let Some(scheme_end) = url.find("://").map(|i| i + 3) else {
        return url.to_string();
    };
    let rest = &url[scheme_end..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    // The userinfo ends at the LAST `@` of the authority: a password may hold one.
    let Some(at) = authority.rfind('@') else {
        return url.to_string();
    };
    let Some(colon) = authority[..at].find(':') else {
        return url.to_string();
    };
    format!(
        "{}{}:<redacted>{}",
        &url[..scheme_end],
        &authority[..colon],
        &rest[at..]
    )
}

fn default_engine() -> String {
    "postgres".to_string()
}
fn default_max_connections() -> u32 {
    10
}
fn default_connect_timeout() -> Duration {
    Duration::from_secs(10)
}
fn default_true() -> bool {
    true
}

impl DbSettings {
    /// The engine, parsed. Errors rather than defaulting silently on a typo.
    pub fn backend(&self) -> Result<Backend, SetupError> {
        Backend::parse(&self.engine)
            .ok_or_else(|| SetupError::Settings(format!("unknown database engine `{}`", self.engine)))
    }

    /// Where SQLite keeps this module's file. `eff_schema` is the effective
    /// (possibly prefixed) schema name, so several prefixed instances get
    /// distinct files (`kub_notes.sqlite` next to `notes.sqlite`).
    fn sqlite_file(&self, eff_schema: &str) -> String {
        if let Some(url) = &self.url {
            if let Some(rest) = url.strip_prefix("sqlite://") {
                return rest.to_string();
            }
        }
        let dir = self.path.as_deref().unwrap_or("./data");
        format!("{}/{eff_schema}.sqlite", dir.trim_end_matches('/'))
    }
}

/// `connect_timeout = 10` in TOML, a `Duration` in Rust.
pub mod duration_secs {
    use std::time::Duration;

    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Duration, D::Error> {
        Ok(Duration::from_secs(u64::deserialize(d)?))
    }
}

/// Opens the pool for the configured engine and makes `schema` usable.
///
/// When `settings.schema_prefix` is set the effective schema is
/// `<prefix><schema>` everywhere: the PostgreSQL `search_path`, the MySQL
/// connection database, the SQLite file and its `ATTACH` alias, the
/// `CREATE SCHEMA`/`CREATE DATABASE`, and - through the pool's [`SchemaPrefix`] -
/// every statement and migration. With no prefix (the default) the effective
/// schema is just `schema` and nothing changes.
pub async fn connect(settings: &DbSettings, schema: &'static str) -> Result<DbPool, SetupError> {
    let prefix = SchemaPrefix::new(settings.schema_prefix.as_deref()).map_err(SetupError::Settings)?;
    crate::search::apply_env_max_terms();
    let eff = prefix.schema(schema);
    let pool = match settings.backend()? {
        Backend::Postgres => open_pg(settings, &eff, prefix.clone()).await?,
        Backend::MySql => open_mysql(settings, &eff, prefix.clone()).await?,
        Backend::Sqlite => open_sqlite(settings, &eff, prefix.clone()).await?,
    };
    ensure_schema(&pool, &eff).await?;
    Ok(pool)
}

async fn open_pg(s: &DbSettings, eff_schema: &str, prefix: SchemaPrefix) -> Result<DbPool, SetupError> {
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

    let opts = if s.host.is_some() || s.user.is_some() {
        PgConnectOptions::new()
            .host(s.host.as_deref().unwrap_or("localhost"))
            .port(s.port.unwrap_or(5432))
            .username(s.user.as_deref().ok_or_else(|| missing("user"))?)
            .password(s.password.as_deref().ok_or_else(|| missing("password"))?)
            .database(s.database.as_deref().ok_or_else(|| missing("database"))?)
    } else {
        PgConnectOptions::from_str(s.url.as_deref().ok_or_else(|| missing("url"))?)
            .map_err(|e| SetupError::Settings(e.to_string()))?
    };

    // Put the module's schema on the search path, the way each module's
    // bootstrap used to before the foundation owned it. Two reasons it must
    // live here:
    //   * a migration written before multi-engine support spelled its tables
    //     unqualified (`CREATE TABLE foo`), trusting the search path -
    //     re-qualifying it to `<schema>.foo` would change its bytes and so its
    //     checksum, and an already migrated PostgreSQL instance would refuse to
    //     start. With the path set, those files stay byte-identical.
    //   * `public` stays on the path so an extension the core installs there
    //     (uuid-ossp, pg_trgm) resolves unqualified.
    // `after_connect` wants a `'static` statement (like the MySQL literals
    // below). `eff_schema` is only borrowed, so leak the one formatted string
    // once - a single bounded allocation for the life of the pool. The prefix
    // and schema are both validated bare identifiers, so nothing user-controlled
    // reaches this text.
    let set_path: &'static str =
        Box::leak(format!("SET search_path = {eff_schema}, public").into_boxed_str());
    let pool = PgPoolOptions::new()
        .max_connections(s.max_connections)
        .min_connections(s.min_connections)
        .acquire_timeout(s.connect_timeout)
        .after_connect(move |conn, _meta| {
            Box::pin(async move {
                conn.execute(set_path).await?;
                Ok(())
            })
        })
        .connect_with(opts)
        .await?;
    Ok(DbPool::from_pg(pool, prefix))
}

async fn open_mysql(s: &DbSettings, eff_schema: &str, prefix: SchemaPrefix) -> Result<DbPool, SetupError> {
    use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};

    let opts = if s.host.is_some() || s.user.is_some() {
        MySqlConnectOptions::new()
            .host(s.host.as_deref().unwrap_or("localhost"))
            .port(s.port.unwrap_or(3306))
            .username(s.user.as_deref().ok_or_else(|| missing("user"))?)
            .password(s.password.as_deref().ok_or_else(|| missing("password"))?)
    } else {
        MySqlConnectOptions::from_str(s.url.as_deref().ok_or_else(|| missing("url"))?)
            .map_err(|e| SetupError::Settings(e.to_string()))?
    };
    // On MySQL/MariaDB a database *is* the schema namespace, so the connection's
    // default database must be the effective (possibly prefixed) schema: the
    // unqualified DDL in the migrations lands there, and it is the database the
    // qualified `<schema>.table` names resolve to after prefix rewriting. This
    // overrides any database named in the URL/fields - that name is never the
    // namespace on MySQL.
    //
    // A connection whose default database does not exist is refused by the
    // server (1049 "Unknown database"), so the pool below could never open onto
    // a fresh namespace and `ensure_schema` would never get the chance to create
    // it - an engine switch onto an empty MySQL server failed right there. Create
    // the namespace first, over a one-off connection that keeps the configured
    // database (or none) as its default.
    create_mysql_namespace(&opts, eff_schema).await;
    let opts = opts.database(eff_schema);

    let pool = MySqlPoolOptions::new()
        .max_connections(s.max_connections)
        .min_connections(s.min_connections)
        .acquire_timeout(s.connect_timeout)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                // Every value Kubuno writes is UTC; without this a DATETIME
                // would be read back shifted by the server's local offset.
                conn.execute("SET time_zone = '+00:00'").await?;
                // Case- and accent-sensitive, so a UNIQUE key does not fold two
                // distinct values into one (the default utf8mb4_0900_ai_ci does).
                conn.execute("SET NAMES utf8mb4 COLLATE utf8mb4_bin").await?;
                // ANSI_QUOTES makes `"ident"` a quoted identifier (as on
                // PostgreSQL and SQLite) instead of a string literal. Kubuno's
                // SQL is written PostgreSQL-first, so every `"…"` already means
                // an identifier and every string uses `'…'`; turning this on
                // lets one query text run on all three engines and, in
                // particular, lets reserved words such as the settings `"key"`
                // column be quoted the same way everywhere. Appended to the
                // existing sql_mode so the server's other modes are preserved.
                conn.execute("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')")
                    .await?;
                Ok(())
            })
        })
        .connect_with(opts)
        .await?;
    Ok(DbPool::from_mysql(pool, prefix))
}

/// `CREATE DATABASE IF NOT EXISTS` for a MySQL/MariaDB namespace, issued before
/// any pool is opened onto it. Best-effort: when the role may not create
/// databases (an administrator pre-created it) or the server is unreachable, the
/// pool's own connection reports the real problem right after.
async fn create_mysql_namespace(opts: &sqlx::mysql::MySqlConnectOptions, eff_schema: &str) {
    use sqlx::Connection as _;
    match sqlx::mysql::MySqlConnection::connect_with(opts).await {
        Ok(mut conn) => {
            // `eff_schema` is a validated bare identifier (prefix + known schema).
            let sql = format!("CREATE DATABASE IF NOT EXISTS `{eff_schema}`");
            if let Err(e) = conn.execute(sqlx::AssertSqlSafe(sql)).await {
                tracing::debug!(schema = eff_schema, error = %e, "MySQL namespace not created up front");
            }
            let _ = conn.close().await;
        }
        Err(e) => {
            tracing::debug!(schema = eff_schema, error = %e, "MySQL bootstrap connection failed");
        }
    }
}

async fn open_sqlite(s: &DbSettings, eff_schema: &str, prefix: SchemaPrefix) -> Result<DbPool, SetupError> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    let file = s.sqlite_file(eff_schema);
    if let Some(dir) = std::path::Path::new(&file).parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir)
                .map_err(|e| SetupError::Settings(format!("{}: {e}", dir.display())))?;
        }
    }
    // A path is not a SQL literal: a single quote in it would close the ATTACH
    // string. Doubling it is SQLite's own escape. The alias is the effective
    // (possibly prefixed) schema, so qualified `<schema>.table` names resolve to
    // it after prefix rewriting; `eff_schema` is a validated bare identifier.
    let attach = format!("ATTACH DATABASE '{}' AS {eff_schema}", file.replace('\'', "''"));
    let wal = format!("PRAGMA {eff_schema}.journal_mode = WAL");

    // `main` is a private temporary database (empty filename), never `:memory:`:
    // SQLite propagates SQLITE_OPEN_MEMORY to every ATTACHed database, which
    // would silently turn the module's file into a per-connection in-memory one.
    let opts = SqliteConnectOptions::new()
        .filename("")
        .create_if_missing(true)
        .foreign_keys(true)
        // Generous: the app-level single-writer gate keeps real contention low,
        // this covers checkpoints and the occasional overlap.
        .busy_timeout(Duration::from_secs(10));

    let pool = SqlitePoolOptions::new()
        .max_connections(s.max_connections)
        .min_connections(s.min_connections)
        .acquire_timeout(s.connect_timeout)
        .after_connect(move |conn, _meta| {
            let attach = attach.clone();
            let wal = wal.clone();
            Box::pin(async move {
                conn.execute(sqlx::AssertSqlSafe(attach)).await?;
                // Qualified: the pragma must reach the module's file, not `main`.
                conn.execute(sqlx::AssertSqlSafe(wal)).await?;
                conn.execute("PRAGMA synchronous = NORMAL").await?;
                Ok(())
            })
        })
        .connect_with(opts)
        .await?;
    Ok(DbPool::from_sqlite(SqliteHandle::new(pool), prefix))
}

fn missing(field: &str) -> SetupError {
    SetupError::Settings(format!("`database.{field}` is required (or give `database.url`)"))
}

/// `CREATE SCHEMA IF NOT EXISTS`, in the local sense of "schema". `eff_schema` is
/// the effective (possibly prefixed) name - the same `<prefix><schema>` the pool
/// was opened against.
pub async fn ensure_schema(pool: &DbPool, eff_schema: &str) -> Result<(), sqlx::Error> {
    use crate::params;
    match pool.backend() {
        Backend::Postgres => {
            pool.execute(&format!("CREATE SCHEMA IF NOT EXISTS {eff_schema}"), params![])
                .await?;
        }
        Backend::MySql => {
            pool.execute(&format!("CREATE DATABASE IF NOT EXISTS `{eff_schema}`"), params![])
                .await?;
        }
        // The ATTACH in `after_connect` already created the file.
        Backend::Sqlite => {}
    }
    Ok(())
}

/// The migration directories of a module, resolved at compile time. Build it
/// with [`crate::migrations!`] and [`run`](Self::run) the set that matches the
/// pool.
///
/// The MySQL protocol is spoken by two servers that do not accept exactly the
/// same DDL: Oracle MySQL and MariaDB. `mysql` is the one set both run; where a
/// migration cannot be written for both, a **flavour variant** - a file with the
/// same name in `migrations/mysql-mariadb/` or `migrations/mysql-oracle/` -
/// replaces it on that flavour only (see [`MySqlVariants`]).
pub struct MigratorSet {
    pub postgres: sqlx::migrate::Migrator,
    pub mysql: sqlx::migrate::Migrator,
    pub sqlite: sqlx::migrate::Migrator,
    /// Per-flavour replacements of `mysql` files. Empty for most modules.
    pub mysql_variants: MySqlVariants,
}

/// Which server answers on the MySQL protocol.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MySqlFlavor {
    /// MariaDB (any version): `VERSION()` contains `MariaDB`.
    MariaDb,
    /// Oracle MySQL (and anything else speaking the protocol).
    Oracle,
}

impl MySqlFlavor {
    /// Classifies a `SELECT VERSION()` string (`8.4.6`, `12.3.3-MariaDB`,
    /// `5.5.5-10.11.8-MariaDB-log`, …).
    pub fn from_version(version: &str) -> Self {
        if version.to_ascii_lowercase().contains("mariadb") {
            Self::MariaDb
        } else {
            Self::Oracle
        }
    }

    /// Asks the server. An error is returned rather than guessed: running the
    /// other flavour's variant would fail half-way through a migration.
    pub async fn detect(pool: &sqlx::MySqlPool) -> Result<Self, sqlx::Error> {
        let v: String = sqlx::query_scalar("SELECT VERSION()").fetch_one(pool).await?;
        Ok(Self::from_version(&v))
    }

    /// The variant directory name, next to `migrations/mysql`.
    pub fn variant_dir(self) -> &'static str {
        match self {
            Self::MariaDb => MARIADB_VARIANT_DIR,
            Self::Oracle => ORACLE_VARIANT_DIR,
        }
    }
}

/// `migrations/mysql-mariadb/`: files used instead of their `mysql` namesake on MariaDB.
pub const MARIADB_VARIANT_DIR: &str = "mysql-mariadb";
/// `migrations/mysql-oracle/`: files used instead of their `mysql` namesake on Oracle MySQL.
pub const ORACLE_VARIANT_DIR: &str = "mysql-oracle";

/// Flavour variants of a module's `mysql` migrations.
///
/// The rule:
///
/// * Write **one** `mysql` migration that runs on both MariaDB and Oracle MySQL
///   whenever the two dialects allow it (they almost always do).
/// * When they do not, keep the `mysql` file for the flavour it works on and add
///   a file with **the same name** (same version, same `.up`/`.down` suffix)
///   under `mysql-mariadb/` or `mysql-oracle/`. It replaces the `mysql` file on
///   that flavour only; the other flavour keeps running the `mysql` file.
/// * A variant must **translate** its base, never do something else: it is
///   recorded in `_sqlx_migrations` under the **base file's** version,
///   description and checksum. The bookkeeping is therefore identical on both
///   flavours - a database dumped from MariaDB into MySQL (or back) keeps
///   validating, and adding or fixing a variant later never makes an install
///   that already applied the base look modified.
/// * A variant without a base file of the same version and kind is an error at
///   run time (and in [`MigratorSet::check`]), as are two variants of one file.
/// * Released files stay immutable, base and variants alike, exactly as before:
///   the checksum of the base still guards an install against an edited base.
#[derive(Debug, Default)]
pub struct MySqlVariants {
    /// Files from `migrations/mysql-mariadb/`.
    pub mariadb: Option<sqlx::migrate::Migrator>,
    /// Files from `migrations/mysql-oracle/`.
    pub oracle: Option<sqlx::migrate::Migrator>,
}

impl MySqlVariants {
    fn for_flavor_mut(&mut self, flavor: MySqlFlavor) -> Option<&mut sqlx::migrate::Migrator> {
        match flavor {
            MySqlFlavor::MariaDb => self.mariadb.as_mut(),
            MySqlFlavor::Oracle => self.oracle.as_mut(),
        }
    }

    fn for_flavor(&self, flavor: MySqlFlavor) -> Option<&sqlx::migrate::Migrator> {
        match flavor {
            MySqlFlavor::MariaDb => self.mariadb.as_ref(),
            MySqlFlavor::Oracle => self.oracle.as_ref(),
        }
    }
}

impl MigratorSet {
    /// Loads the same layout [`crate::migrations!`] embeds, from disk at run
    /// time: `<root>/{postgres,mysql,sqlite}` and, when present,
    /// `<root>/mysql-mariadb` and `<root>/mysql-oracle`. Meant for tests and
    /// tooling (a module embeds its migrations with the macro).
    pub async fn from_dir(root: impl AsRef<std::path::Path>) -> Result<Self, sqlx::migrate::MigrateError> {
        use sqlx::migrate::Migrator;
        let root = root.as_ref();
        async fn opt(dir: std::path::PathBuf) -> Result<Option<Migrator>, sqlx::migrate::MigrateError> {
            if dir.is_dir() {
                Ok(Some(Migrator::new(dir).await?))
            } else {
                Ok(None)
            }
        }
        Ok(Self {
            postgres: Migrator::new(root.join("postgres")).await?,
            mysql: Migrator::new(root.join("mysql")).await?,
            sqlite: Migrator::new(root.join("sqlite")).await?,
            mysql_variants: MySqlVariants {
                mariadb: opt(root.join(MARIADB_VARIANT_DIR)).await?,
                oracle: opt(root.join(ORACLE_VARIANT_DIR)).await?,
            },
        })
    }

    /// Verifies that every flavour variant replaces an existing `mysql` file.
    /// Call it from a module's unit test to catch a misnamed variant at build
    /// time rather than at the first start on that flavour.
    pub fn check(&self) -> Result<(), sqlx::migrate::MigrateError> {
        for flavor in [MySqlFlavor::MariaDb, MySqlFlavor::Oracle] {
            self.mysql_migrations(flavor)?;
        }
        Ok(())
    }

    /// The MySQL-family migrations exactly as they run on `flavor`: the `mysql`
    /// set with that flavour's variants substituted, each keeping its base's
    /// version, description and checksum.
    pub fn mysql_migrations(
        &self,
        flavor: MySqlFlavor,
    ) -> Result<Vec<sqlx::migrate::Migration>, sqlx::migrate::MigrateError> {
        let variants = self.mysql_variants.for_flavor(flavor).map(|m| &m.migrations[..]);
        substitute_variants(&self.mysql.migrations, variants.unwrap_or(&[]), flavor)
    }

    /// Runs the migrations for the pool's engine, keeping `_sqlx_migrations`
    /// inside the module's own namespace (the same table PostgreSQL already
    /// used through its search_path - so an applied migration is not re-run).
    /// On the MySQL protocol the server's flavour is detected first and its
    /// variants substituted.
    pub async fn run(
        mut self,
        pool: &DbPool,
        schema: &'static str,
    ) -> Result<(), sqlx::migrate::MigrateError> {
        use crate::exec::PoolKind;
        let prefix = pool.schema_prefix().clone();
        let eff = prefix.schema(schema);
        let table = format!("{eff}._sqlx_migrations");
        match pool.kind() {
            PoolKind::Pg(p) => {
                apply_prefix_to_migrator(&mut self.postgres, &prefix);
                self.postgres.dangerous_set_table_name(table);
                self.postgres.run(p).await
            }
            PoolKind::My(p) => {
                let flavor = MySqlFlavor::detect(p).await.map_err(sqlx::migrate::MigrateError::Execute)?;
                // Prefix first, on the base and on the variants alike, so a
                // prefixed instance records the checksum of its prefixed BASE
                // whatever the flavour.
                apply_prefix_to_migrator(&mut self.mysql, &prefix);
                if let Some(v) = self.mysql_variants.for_flavor_mut(flavor) {
                    apply_prefix_to_migrator(v, &prefix);
                }
                let resolved = self.mysql_migrations(flavor)?;
                let substituted = resolved
                    .iter()
                    .zip(self.mysql.migrations.iter())
                    .filter(|(r, b)| r.sql.as_str() != b.sql.as_str())
                    .count();
                if substituted > 0 {
                    tracing::info!(schema, ?flavor, substituted, "MySQL flavour variants in use");
                }
                self.mysql.migrations = std::borrow::Cow::Owned(resolved);
                self.mysql.dangerous_set_table_name(table);
                self.mysql.run(p).await
            }
            PoolKind::Sq(h) => {
                apply_prefix_to_migrator(&mut self.sqlite, &prefix);
                self.sqlite.dangerous_set_table_name(table);
                self.sqlite.run(&h.pool).await
            }
        }
    }
}

/// Puts each variant in place of its base (same version, same migration type),
/// keeping the base's version, description and checksum. See [`MySqlVariants`].
fn substitute_variants(
    base: &[sqlx::migrate::Migration],
    variants: &[sqlx::migrate::Migration],
    flavor: MySqlFlavor,
) -> Result<Vec<sqlx::migrate::Migration>, sqlx::migrate::MigrateError> {
    use sqlx::migrate::{MigrateError, Migration};
    let mut out: Vec<Migration> = base.to_vec();
    let mut used = std::collections::HashSet::new();
    for v in variants {
        let key = (v.version, v.migration_type.is_down_migration(), v.migration_type.is_up_migration());
        if !used.insert(key) {
            return Err(MigrateError::Source(
                format!(
                    "{}: two variants of migration {} ({})",
                    flavor.variant_dir(),
                    v.version,
                    v.migration_type.label()
                )
                .into(),
            ));
        }
        let Some(slot) = out
            .iter_mut()
            .find(|b| b.version == v.version && b.migration_type == v.migration_type)
        else {
            return Err(MigrateError::Source(
                format!(
                    "{}: migration {} ({}) has no namesake in migrations/mysql - a variant only \
                     replaces an existing file, it never adds a version",
                    flavor.variant_dir(),
                    v.version,
                    v.migration_type.label()
                )
                .into(),
            ));
        };
        let mut m = Migration::new(
            slot.version,
            slot.description.clone(),
            slot.migration_type,
            v.sql.clone(),
            v.no_tx,
        );
        m.checksum = slot.checksum.clone();
        *slot = m;
    }
    Ok(out)
}

/// Rewrites a migrator's SQL so a prefixed instance's DDL lands in the prefixed
/// schema.
///
/// It only changes anything where a migration spells a schema qualifier: the
/// consolidated SQLite migrations do (`CREATE TABLE notes.foo`,
/// `CREATE INDEX notes.idx ...`), and any PostgreSQL migration that references a
/// sibling schema (`core.users`) does too. Unqualified DDL - the PostgreSQL and
/// MySQL norm, which leans on the search_path / connection database - is left
/// untouched.
///
/// When no prefix is set this returns immediately, leaving the migrator exactly
/// as `sqlx::migrate!` compiled it: byte-identical SQL and therefore unchanged
/// checksums, so an already-migrated instance is never disturbed. A prefixed
/// instance is always a fresh database, so recomputing its checksums from the
/// rewritten text is safe and stable across runs.
fn apply_prefix_to_migrator(m: &mut sqlx::migrate::Migrator, prefix: &SchemaPrefix) {
    use sqlx::migrate::Migration;
    use sqlx::{AssertSqlSafe, SqlSafeStr};
    if prefix.is_empty() {
        return;
    }
    let rewritten: Vec<Migration> = m
        .iter()
        .map(|mig| {
            let sql = prefix.rewrite(mig.sql.as_str()).into_owned();
            Migration::new(
                mig.version,
                mig.description.clone(),
                mig.migration_type,
                AssertSqlSafe(sql).into_sql_str(),
                mig.no_tx,
            )
        })
        .collect();
    m.migrations = std::borrow::Cow::Owned(rewritten);
}

/// Builds a [`MigratorSet`] from the per-engine migration directories.
///
/// ```ignore
/// kubuno_db::migrations!(
///     "./migrations/postgres",
///     "./migrations/mysql",
///     "./migrations/sqlite",
/// )
/// .run(&pool, "keestore")
/// .await?;
/// ```
///
/// A module with MySQL flavour variants (see [`pool::MySqlVariants`](crate::pool::MySqlVariants))
/// names their directories after the three, in this order, each optional:
///
/// ```ignore
/// kubuno_db::migrations!(
///     "./migrations/postgres",
///     "./migrations/mysql",
///     "./migrations/sqlite",
///     mariadb = "./migrations/mysql-mariadb",
///     oracle_mysql = "./migrations/mysql-oracle",
/// )
/// ```
#[macro_export]
macro_rules! migrations {
    (
        $postgres:literal, $mysql:literal, $sqlite:literal
        $(, mariadb = $mariadb:literal)?
        $(, oracle_mysql = $oracle:literal)?
        $(,)?
    ) => {
        $crate::pool::MigratorSet {
            postgres: $crate::sqlx::migrate!($postgres),
            mysql: $crate::sqlx::migrate!($mysql),
            sqlite: $crate::sqlx::migrate!($sqlite),
            mysql_variants: $crate::pool::MySqlVariants {
                mariadb: $crate::__kubuno_opt_migrator!($($mariadb)?),
                oracle: $crate::__kubuno_opt_migrator!($($oracle)?),
            },
        }
    };
}

/// `Some(migrate!(dir))` when a directory is named, `None` otherwise.
#[doc(hidden)]
#[macro_export]
macro_rules! __kubuno_opt_migrator {
    () => {
        ::core::option::Option::None
    };
    ($dir:literal) => {
        ::core::option::Option::Some($crate::sqlx::migrate!($dir))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_password_is_redacted() {
        assert_eq!(
            redact_url_password("postgres://kubuno:s3cr@t@db.local:5432/kubuno?sslmode=require"),
            "postgres://kubuno:<redacted>@db.local:5432/kubuno?sslmode=require"
        );
        assert_eq!(redact_url_password("mysql://root@localhost/k"), "mysql://root@localhost/k");
        assert_eq!(redact_url_password("sqlite:///var/lib/k/x.sqlite"), "sqlite:///var/lib/k/x.sqlite");
    }

    #[test]
    fn debug_never_prints_the_password() {
        let s: DbSettings = serde_json::from_value(serde_json::json!({
            "url": "postgres://u:topsecret@h/d",
            "password": "topsecret",
        }))
        .expect("settings");
        let dbg = format!("{s:?}");
        assert!(!dbg.contains("topsecret"), "{dbg}");
        assert!(dbg.contains("<redacted>"), "{dbg}");
    }

    fn mig(version: i64, kind: sqlx::migrate::MigrationType, sql: &'static str) -> sqlx::migrate::Migration {
        use sqlx::SqlSafeStr;
        sqlx::migrate::Migration::new(
            version,
            format!("m{version}").into(),
            kind,
            sqlx::AssertSqlSafe(sql).into_sql_str(),
            false,
        )
    }

    #[test]
    fn flavor_follows_the_version_string() {
        assert_eq!(MySqlFlavor::from_version("8.4.6"), MySqlFlavor::Oracle);
        assert_eq!(MySqlFlavor::from_version("12.3.3-MariaDB"), MySqlFlavor::MariaDb);
        assert_eq!(MySqlFlavor::from_version("5.5.5-10.11.8-MariaDB-log"), MySqlFlavor::MariaDb);
        assert_eq!(MySqlFlavor::Oracle.variant_dir(), "mysql-oracle");
        assert_eq!(MySqlFlavor::MariaDb.variant_dir(), "mysql-mariadb");
    }

    #[test]
    fn a_variant_replaces_its_base_sql_and_keeps_the_base_identity() {
        use sqlx::migrate::MigrationType::{ReversibleDown as Down, ReversibleUp as Up};
        let base = vec![mig(1, Up, "A"), mig(1, Down, "a"), mig(2, Up, "B STORED"), mig(2, Down, "b")];
        let variants = vec![mig(2, Up, "B VIRTUAL")];
        let out = substitute_variants(&base, &variants, MySqlFlavor::Oracle).expect("substitute");
        assert_eq!(out.len(), 4);
        assert_eq!(out[2].sql.as_str(), "B VIRTUAL");
        // Recorded exactly like the base: same version, description, checksum.
        assert_eq!(out[2].version, 2);
        assert_eq!(out[2].description, base[2].description);
        assert_eq!(out[2].checksum, base[2].checksum);
        assert_ne!(out[2].checksum, variants[0].checksum);
        // Everything else untouched.
        for i in [0, 1, 3] {
            assert_eq!(out[i].sql.as_str(), base[i].sql.as_str());
            assert_eq!(out[i].checksum, base[i].checksum);
        }
    }

    #[test]
    fn an_orphan_or_duplicate_variant_is_refused() {
        use sqlx::migrate::MigrationType::{ReversibleDown as Down, ReversibleUp as Up};
        let base = vec![mig(1, Up, "A"), mig(1, Down, "a")];
        // No version 3 in the base set.
        let err = substitute_variants(&base, &[mig(3, Up, "C")], MySqlFlavor::MariaDb).unwrap_err();
        assert!(err.to_string().contains("no namesake"), "{err}");
        // Same version, other kind (a down variant for an up-only base is fine
        // only when the base has that down file).
        let up_only = vec![mig(1, sqlx::migrate::MigrationType::Simple, "A")];
        assert!(substitute_variants(&up_only, &[mig(1, Up, "A2")], MySqlFlavor::Oracle).is_err());
        // Two variants of one file.
        let err = substitute_variants(&base, &[mig(1, Up, "x"), mig(1, Up, "y")], MySqlFlavor::Oracle)
            .unwrap_err();
        assert!(err.to_string().contains("two variants"), "{err}");
    }

    #[test]
    fn no_variant_leaves_the_base_byte_identical() {
        use sqlx::migrate::MigrationType::Simple;
        let base = vec![mig(1, Simple, "A"), mig(2, Simple, "B")];
        let out = substitute_variants(&base, &[], MySqlFlavor::MariaDb).expect("substitute");
        for (o, b) in out.iter().zip(&base) {
            assert_eq!(o.sql.as_str(), b.sql.as_str());
            assert_eq!(o.checksum, b.checksum);
        }
    }
}
