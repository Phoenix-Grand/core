//! Round-trip of the portable backup on the engines that use it.
//!
//! The PostgreSQL backup is `COPY` text, restored by `psql`; MySQL and SQLite
//! use the portable NDJSON writer/loader ([`kubuno_core::backup::portable`]).
//! These tests dump a migrated `core` schema and load it back:
//!
//! * SQLite → SQLite always runs (embedded, two throwaway files).
//! * MySQL → MySQL runs when `KUBUNO_MYSQL_TEST_URL` is set.
//! * Cross-engine (SQLite ⇄ MySQL) runs when MySQL is configured: the two
//!   engines store the same shapes (UUID = 16 bytes, JSON = text, timestamp =
//!   string, boolean = integer), so a dump from one loads onto the other.
//!
//! The MySQL tests reset the shared `core` database, so run them single-threaded
//! (`--test-threads=1`) alongside `db_portability`.

use kubuno_core::backup::{dump, portable};
use kubuno_db::{connect, params, Backend, DbPool, DbSettings};

const SCHEMA: &str = "core";

fn settings(engine: &str, extra: serde_json::Value) -> DbSettings {
    let mut base = serde_json::json!({
        "engine": engine,
        "max_connections": 4,
        "min_connections": 0,
        "connect_timeout": 10,
        "run_migrations": false,
    });
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    serde_json::from_value(base).expect("DbSettings")
}

async fn sqlite_pool(dir: &std::path::Path) -> DbPool {
    let s = settings("sqlite", serde_json::json!({ "path": dir.to_str().unwrap() }));
    connect(&s, SCHEMA).await.expect("sqlite connect")
}

async fn maybe_mysql() -> Option<DbPool> {
    let url = std::env::var("KUBUNO_MYSQL_TEST_URL").ok().filter(|u| !u.trim().is_empty());
    match url {
        Some(url) => {
            let s = settings("mysql", serde_json::json!({ "url": url }));
            Some(connect(&s, SCHEMA).await.expect("mysql connect"))
        }
        None => {
            eprintln!("KUBUNO_MYSQL_TEST_URL absent - MySQL ignoré");
            None
        }
    }
}

/// Wipes and rebuilds the `core` schema, the same call the server makes at boot.
async fn setup(pool: &DbPool) {
    kubuno_db::pool::ensure_schema(pool, SCHEMA).await.expect("ensure schema");
    match pool.backend() {
        Backend::Postgres => {
            pool.execute("DROP SCHEMA IF EXISTS core CASCADE", params![]).await.expect("drop pg");
            pool.execute("CREATE SCHEMA core", params![]).await.expect("create pg");
        }
        Backend::MySql => {
            let p = pool.as_mysql().expect("mysql pool");
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'core'",
            )
            .fetch_all(p)
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
            assert!(remaining.is_empty(), "core tables left: {remaining:?}");
        }
        Backend::Sqlite => {}
    }
    kubuno_core::database::migrations::run(pool).await.expect("run migrations");
    kubuno_core::database::seed::ensure_instance_identity(pool).await;
}

async fn count(pool: &DbPool, table: &str) -> i64 {
    pool.fetch_scalar(
        &format!("SELECT {} FROM core.\"{}\"", pool.backend().count_bigint("*"), table),
        params![],
    )
    .await
    .unwrap_or_else(|e| panic!("count {table}: {e}"))
}

/// Inserts a distinctive settings row (JSON value), to prove custom data flows
/// through the dump - not only the migration seeds.
async fn insert_marker(pool: &DbPool, key: &str) {
    pool.execute(
        "INSERT INTO core.settings (\"key\", value) VALUES ($1, $2)",
        params![key, serde_json::json!({ "n": 42, "s": "café" })],
    )
    .await
    .expect("insert marker");
}

async fn has_setting(pool: &DbPool, key: &str) -> bool {
    pool.fetch_scalar::<i64>(
        &format!(
            "SELECT {} FROM core.settings WHERE \"key\" = $1",
            pool.backend().count_bigint("*")
        ),
        params![key],
    )
    .await
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// Dumps `source`, loads it into `target`, and checks the target became the
/// source: same row counts, the source's marker present, the target's own
/// pre-restore marker gone.
async fn round_trip(source: &DbPool, target: &DbPool) {
    insert_marker(source, "backup.test.marker").await;
    let src_settings = count(source, "settings").await;
    let src_roles = count(source, "roles").await;

    let dump_dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("kubuno-dump-{}", uuid::Uuid::new_v4()));
    let outcome = dump::write_dump(source, &dump_dir).await.expect("write dump");
    assert!(outcome.rows > 0, "a dump with rows");
    assert!(outcome.file_name.ends_with(".ndjson.gz"), "portable extension: {}", outcome.file_name);
    assert!(dump::is_dump_file(&outcome.file_name), "recognised by retention");

    // A row that must NOT survive the restore, proving the load empties first.
    insert_marker(target, "backup.should.be.deleted").await;

    // The backup covers every schema of the source; when the target does not
    // hold a module schema the source had (e.g. a cross-engine target with only
    // `core` attached), that schema's rows are skipped, so `inserted` may be
    // fewer than `outcome.rows`. What must hold is that the covered data landed.
    let inserted = portable::restore(target, &outcome.path).await.expect("restore");
    assert!(inserted > 0, "rows were loaded");
    assert!(inserted <= outcome.rows, "no more than what was dumped");

    assert_eq!(count(target, "settings").await, src_settings, "settings count matches source");
    assert_eq!(count(target, "roles").await, src_roles, "roles count matches source");
    assert!(has_setting(target, "backup.test.marker").await, "source marker restored");
    assert!(!has_setting(target, "backup.should.be.deleted").await, "target's own row cleared");

    tokio::fs::remove_dir_all(&dump_dir).await.ok();
}

#[tokio::test]
async fn sqlite_same_engine_round_trip() {
    let dir_a = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("kubuno-sqa-{}", uuid::Uuid::new_v4()));
    let dir_b = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("kubuno-sqb-{}", uuid::Uuid::new_v4()));
    let a = sqlite_pool(&dir_a).await;
    let b = sqlite_pool(&dir_b).await;
    setup(&a).await;
    setup(&b).await;
    round_trip(&a, &b).await;
    tokio::fs::remove_dir_all(&dir_a).await.ok();
    tokio::fs::remove_dir_all(&dir_b).await.ok();
}

#[tokio::test]
async fn mysql_same_engine_round_trip() {
    let Some(db) = maybe_mysql().await else { return };
    setup(&db).await;
    insert_marker(&db, "backup.test.marker").await;
    let src_settings = count(&db, "settings").await;

    let dump_dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("kubuno-dump-{}", uuid::Uuid::new_v4()));
    let outcome = dump::write_dump(&db, &dump_dir).await.expect("write dump");
    assert!(outcome.file_name.ends_with(".ndjson.gz"));

    // A fresh migrated core, then restore into it.
    setup(&db).await;
    insert_marker(&db, "backup.should.be.deleted").await;
    let inserted = portable::restore(&db, &outcome.path).await.expect("restore");
    assert_eq!(inserted, outcome.rows);
    assert_eq!(count(&db, "settings").await, src_settings);
    assert!(has_setting(&db, "backup.test.marker").await);
    assert!(!has_setting(&db, "backup.should.be.deleted").await);
    tokio::fs::remove_dir_all(&dump_dir).await.ok();
}

#[tokio::test]
async fn cross_engine_sqlite_dump_restores_on_mysql() {
    let Some(mysql) = maybe_mysql().await else { return };
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("kubuno-xsq-{}", uuid::Uuid::new_v4()));
    let sqlite = sqlite_pool(&dir).await;
    setup(&sqlite).await;
    setup(&mysql).await;
    round_trip(&sqlite, &mysql).await;
    tokio::fs::remove_dir_all(&dir).await.ok();
}

#[tokio::test]
async fn cross_engine_mysql_dump_restores_on_sqlite() {
    let Some(mysql) = maybe_mysql().await else { return };
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("kubuno-xmy-{}", uuid::Uuid::new_v4()));
    let sqlite = sqlite_pool(&dir).await;
    setup(&mysql).await;
    setup(&sqlite).await;
    round_trip(&mysql, &sqlite).await;
    tokio::fs::remove_dir_all(&dir).await.ok();
}
