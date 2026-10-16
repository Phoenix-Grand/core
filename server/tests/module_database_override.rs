//! Per-module database override: storing an override, resolving the credentials
//! a module should start with, and proving a module started on the override's
//! engine can create its schema and round-trip data there.
//!
//! SQLite is embedded, so it always runs. PostgreSQL and MySQL/MariaDB run only
//! when `KUBUNO_PG_TEST_URL` / `KUBUNO_MYSQL_TEST_URL` are set; otherwise they
//! print a notice and are skipped (CI without a server must not turn red).

use kubuno_core::modules::db_config::{self, encrypt_password};
use kubuno_db::{connect, params, Backend, DbPool, DbSettings};

const SCHEMA: &str = "core";
const JWT: &str = "integration-test-jwt-secret-long-enough-0123456789";

/// A throwaway directory, removed on drop (no `tempfile` dependency needed).
struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("kubuno-mdbovr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).expect("tmp dir");
        TempDir(p)
    }
    fn str(&self) -> &str {
        self.0.to_str().expect("utf8 path")
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn settings(engine: &str, extra: serde_json::Value) -> DbSettings {
    let mut base = serde_json::json!({
        "engine": engine,
        "max_connections": 4,
        "min_connections": 0,
        "connect_timeout": 10,
        "run_migrations": false,
    });
    base.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(base).expect("DbSettings")
}

async fn sqlite_pool(dir: &std::path::Path) -> DbPool {
    let s = settings("sqlite", serde_json::json!({ "path": dir.to_str().unwrap() }));
    connect(&s, SCHEMA).await.expect("sqlite connect")
}

async fn maybe_pool(engine: &str, env: &str) -> Option<DbPool> {
    let url = std::env::var(env).ok().filter(|u| !u.trim().is_empty())?;
    let s = settings(engine, serde_json::json!({ "url": url }));
    match connect(&s, SCHEMA).await {
        Ok(p) => Some(p),
        Err(e) => panic!("{engine} connect ({env}) échoué: {e}"),
    }
}

/// Brings the pool to the complete `core` schema, wiping any prior state on a
/// shared server so the migrations run from scratch.
async fn setup(pool: &DbPool) {
    kubuno_db::pool::ensure_schema(pool, SCHEMA).await.expect("ensure schema");
    match pool.backend() {
        Backend::Postgres => {
            pool.execute("DROP SCHEMA IF EXISTS core CASCADE", params![]).await.expect("drop pg");
            pool.execute("CREATE SCHEMA core", params![]).await.expect("recreate pg");
        }
        Backend::MySql => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'core'",
            )
            .fetch_all(pool.as_mysql().expect("mysql pool"))
            .await
            .expect("list core tables");
            let mut remaining: Vec<String> = rows.into_iter().map(|(t,)| t).collect();
            for _ in 0..16 {
                if remaining.is_empty() {
                    break;
                }
                let mut still = Vec::new();
                for t in &remaining {
                    if pool.execute(&format!("DROP TABLE IF EXISTS `{t}`"), params![]).await.is_err() {
                        still.push(t.clone());
                    }
                }
                remaining = still;
            }
        }
        Backend::Sqlite => {}
    }
    kubuno_core::database::migrations::run(pool).await.expect("run core migrations");
}

/// Inserts a bare module row so the override's foreign key is satisfied.
async fn insert_module(pool: &DbPool, id: &str) {
    pool.execute(
        "INSERT INTO core.modules (id, display_name, version) VALUES ($1, $2, $3)",
        params![id, "Test Module", "1.0.0"],
    )
    .await
    .expect("insert module");
}

/// Inserts (or, if present, would need deleting first - tests use fresh ids) an
/// override row.
#[allow(clippy::too_many_arguments)]
async fn insert_override(
    pool: &DbPool,
    module_id: &str,
    engine: &str,
    host: &str,
    port: i32,
    user: &str,
    password_plain: &str,
    db_name: &str,
    db_path: &str,
    schema_prefix: Option<&str>,
    enabled: bool,
) {
    let enc = encrypt_password(JWT, password_plain).expect("encrypt");
    pool.execute(
        "INSERT INTO core.module_databases \
            (module_id, engine, host, port, db_user, password_enc, db_name, db_path, schema_prefix, enabled) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        params![module_id, engine, host, port, user, enc, db_name, db_path, schema_prefix, enabled],
    )
    .await
    .expect("insert override");
}

/// The whole flow, driven on whichever engine the pool speaks. `main_db` is a
/// stand-in for the core's own configuration (its only role is the inherited
/// fallback), so a fixed SQLite one is enough.
async fn run_flow(pool: &DbPool) {
    setup(pool).await;
    let main_dir = TempDir::new();
    let main_db = settings("sqlite", serde_json::json!({ "path": main_dir.str() }));

    // ── 1. No row → inherit ────────────────────────────────────────────────
    insert_module(pool, "testmod").await;
    let r = db_config::resolve(pool, &main_db, JWT, "testmod").await.expect("resolve inherit");
    assert!(!r.overridden, "no override row must inherit");
    assert_eq!(r.credentials.engine, "sqlite", "inherits the main engine");

    // ── 2. An enabled SQLite override → resolved, and a module could migrate
    //       onto it. This is the real proof: we take the resolved credentials,
    //       open them exactly as the module would, and round-trip a row. ──────
    let target = TempDir::new();
    insert_override(
        pool, "testmod", "sqlite", "", 0, "", "",
        "", target.str(), None, true,
    )
    .await;

    let r = db_config::resolve(pool, &main_db, JWT, "testmod").await.expect("resolve override");
    assert!(r.overridden, "an enabled override must win");
    assert_eq!(r.credentials.engine, "sqlite");
    assert_eq!(r.credentials.path, target.str());
    assert!(r.schema_prefix.is_none());

    // Open the resolved target the way a module does, create its schema and a
    // table, and read a row back - proving the override engine actually works.
    let module_settings = settings(
        &r.credentials.engine,
        serde_json::json!({ "path": r.credentials.path }),
    );
    let module_pool = connect(&module_settings, "testmod").await.expect("connect to override target");
    kubuno_db::pool::ensure_schema(&module_pool, "testmod").await.expect("ensure module schema");
    module_pool
        .execute("CREATE TABLE IF NOT EXISTS testmod.items (id INTEGER PRIMARY KEY, name TEXT)", params![])
        .await
        .expect("create table on target");
    module_pool
        .execute("INSERT INTO testmod.items (id, name) VALUES ($1, $2)", params![1_i32, "hello"])
        .await
        .expect("insert on target");
    let got: Option<String> = module_pool
        .fetch_optional_scalar::<String>("SELECT name FROM testmod.items WHERE id = $1", params![1_i32])
        .await
        .expect("select on target");
    assert_eq!(got.as_deref(), Some("hello"), "the module round-trips on its own database");

    // ── 3. Disabling the override → inherit again ───────────────────────────
    pool.execute(
        "UPDATE core.module_databases SET enabled = $1 WHERE module_id = $2",
        params![false, "testmod"],
    )
    .await
    .expect("disable override");
    let r = db_config::resolve(pool, &main_db, JWT, "testmod").await.expect("resolve disabled");
    assert!(!r.overridden, "a disabled override inherits");

    // ── 4. A server override carries its decrypted password and default port ─
    insert_module(pool, "srvmod").await;
    insert_override(
        pool, "srvmod", "postgres", "db.example", 0, "kube", "s3cr3t", "kubedb", "", Some("kub_"), true,
    )
    .await;
    let r = db_config::resolve(pool, &main_db, JWT, "srvmod").await.expect("resolve server");
    assert!(r.overridden);
    assert_eq!(r.credentials.engine, "postgres");
    assert_eq!(r.credentials.host, "db.example");
    assert_eq!(r.credentials.port, 5432, "port 0 → engine default");
    assert_eq!(r.credentials.user, "kube");
    assert_eq!(r.credentials.password, "s3cr3t", "password decrypted for the child process");
    assert_eq!(r.credentials.database, "kubedb");
    assert_eq!(r.schema_prefix.as_deref(), Some("kub_"));
}

#[tokio::test]
async fn sqlite_override_flow() {
    let dir = TempDir::new();
    let pool = sqlite_pool(&dir.0).await;
    run_flow(&pool).await;
}

#[tokio::test]
async fn postgres_override_flow() {
    if let Some(pool) = maybe_pool("postgres", "KUBUNO_PG_TEST_URL").await {
        run_flow(&pool).await;
    }
}

#[tokio::test]
async fn mysql_override_flow() {
    if let Some(pool) = maybe_pool("mysql", "KUBUNO_MYSQL_TEST_URL").await {
        run_flow(&pool).await;
    }
}
