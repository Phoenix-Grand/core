//! Real, cross-engine integration tests for the administrative schema
//! operations: renaming the schema prefix in place and copying a whole schema's
//! data from one engine to another.
//!
//! SQLite is embedded, so its cases always run. PostgreSQL runs only when
//! `KUBUNO_PG_TEST_URL` is set and MySQL only when `KUBUNO_MYSQL_TEST_URL` is -
//! otherwise the case prints a notice and is skipped, so CI without a server
//! stays green.

use kubuno_db::{connect, copy_schema, params, rename_schema_prefix, Backend, DbPool, DbSettings};

const JWT: &str = "integration-test-secret-long-enough-0123456789";

struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("kubuno-schadm-{}", uuid::Uuid::new_v4()));
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

async fn pg_pool(schema: &'static str) -> Option<DbPool> {
    let url = std::env::var("KUBUNO_PG_TEST_URL").ok().filter(|u| !u.trim().is_empty())?;
    let s = settings("postgres", serde_json::json!({ "url": url }));
    Some(connect(&s, schema).await.expect("pg connect"))
}

async fn sqlite_pool(dir: &str, schema: &'static str) -> DbPool {
    let s = settings("sqlite", serde_json::json!({ "path": dir }));
    connect(&s, schema).await.expect("sqlite connect")
}

/// Wipes a PostgreSQL schema so a shared server starts each run clean.
async fn pg_drop_schema(pool: &DbPool, schema: &str) {
    let _ = pool
        .execute(&format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"), params![])
        .await;
    let _ = pool
        .execute(&format!("CREATE SCHEMA IF NOT EXISTS \"{schema}\""), params![])
        .await;
}

/// Creates the two demo tables (`authors` parent, `books` child) with the
/// richest types the engine offers, so the copy exercises uuid/bool/json/blob/
/// timestamp fidelity.
async fn create_demo_tables(pool: &DbPool, schema: &str) {
    let (authors, books) = match pool.backend() {
        Backend::Postgres => (
            format!(
                "CREATE TABLE \"{schema}\".\"authors\" (\
                    id uuid PRIMARY KEY, name text NOT NULL, active boolean NOT NULL, \
                    rank smallint, score double precision, tags jsonb, avatar bytea, \
                    born date, created timestamptz NOT NULL)"
            ),
            format!(
                "CREATE TABLE \"{schema}\".\"books\" (\
                    id uuid PRIMARY KEY, \
                    author_id uuid NOT NULL REFERENCES \"{schema}\".\"authors\"(id), \
                    title text NOT NULL, pages integer)"
            ),
        ),
        Backend::MySql => (
            format!(
                "CREATE TABLE `{schema}`.`authors` (\
                    id binary(16) PRIMARY KEY, name text, active tinyint(1) NOT NULL, \
                    `rank` smallint, score double, tags json, avatar blob, \
                    born date, created datetime(6) NOT NULL)"
            ),
            format!(
                "CREATE TABLE `{schema}`.`books` (\
                    id binary(16) PRIMARY KEY, author_id binary(16) NOT NULL, \
                    title text, pages int, \
                    FOREIGN KEY (author_id) REFERENCES `{schema}`.`authors`(id))"
            ),
        ),
        Backend::Sqlite => (
            format!(
                "CREATE TABLE \"{schema}\".\"authors\" (\
                    id BLOB PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL, \
                    rank INTEGER, score REAL, tags TEXT, avatar BLOB, \
                    born TEXT, created TEXT NOT NULL)"
            ),
            format!(
                "CREATE TABLE \"{schema}\".\"books\" (\
                    id BLOB PRIMARY KEY, \
                    author_id BLOB NOT NULL REFERENCES \"authors\"(id), \
                    title TEXT NOT NULL, pages INTEGER)"
            ),
        ),
    };
    pool.execute(&authors, params![]).await.expect("create authors");
    pool.execute(&books, params![]).await.expect("create books");
}

/// Inserts two authors and three books. Binding is engine-agnostic: the same
/// typed values encode correctly for each driver.
async fn seed(pool: &DbPool, schema: &str) -> (uuid::Uuid, uuid::Uuid) {
    let a1 = uuid::Uuid::new_v4();
    let a2 = uuid::Uuid::new_v4();
    let now = chrono::Utc::now();
    let day = chrono::NaiveDate::from_ymd_opt(1990, 5, 20).unwrap();
    for (id, name, active, rank, tags) in [
        (a1, "Ada", true, 1_i16, serde_json::json!(["x", "y"])),
        (a2, "Alan", false, 2_i16, serde_json::json!({ "k": 3 })),
    ] {
        let sql = format!(
            "INSERT INTO \"{schema}\".\"authors\" \
                (id, name, active, \"rank\", score, tags, avatar, born, created) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)"
        );
        pool.execute(
            &sql,
            params![id, name, active, rank, 3.5_f64, tags, vec![1u8, 2, 3], day, now],
        )
        .await
        .expect("insert author");
    }
    for (title, author, pages) in [("Book A", a1, 100_i32), ("Book B", a1, 200), ("Book C", a2, 300)] {
        let sql = format!(
            "INSERT INTO \"{schema}\".\"books\" (id, author_id, title, pages) VALUES ($1,$2,$3,$4)"
        );
        pool.execute(&sql, params![uuid::Uuid::new_v4(), author, title, pages])
            .await
            .expect("insert book");
    }
    (a1, a2)
}

async fn count(pool: &DbPool, schema: &str, table: &str) -> i64 {
    pool.fetch_scalar::<i64>(&format!("SELECT COUNT(*) FROM \"{schema}\".\"{table}\""), params![])
        .await
        .expect("count")
}

/// The whole copy flow between two pools: seed the source, copy into the empty
/// destination, and prove the counts and a scalar landed.
async fn run_copy(src: &DbPool, src_schema: &str, dst: &DbPool, dst_schema: &str) {
    seed(src, src_schema).await;
    assert_eq!(count(src, src_schema, "authors").await, 2);
    assert_eq!(count(src, src_schema, "books").await, 3);

    let mut steps = Vec::new();
    let report = copy_schema(src, src_schema, dst, dst_schema, &mut |t, total| {
        steps.push((t.to_string(), total));
    })
    .await
    .expect("copy_schema");

    assert_eq!(report.total_rows, 5, "2 authors + 3 books");
    assert!(steps.iter().any(|(t, _)| t == "authors"));
    assert_eq!(count(dst, dst_schema, "authors").await, 2, "authors copied");
    assert_eq!(count(dst, dst_schema, "books").await, 3, "books copied");

    // A scalar the copy carried, read back on the destination.
    let title: String = dst
        .fetch_scalar(
            &format!("SELECT title FROM \"{dst_schema}\".\"books\" WHERE pages = $1"),
            params![200_i32],
        )
        .await
        .expect("select copied title");
    assert_eq!(title, "Book B");

    // Re-running is idempotent (destination emptied first, counts still match).
    copy_schema(src, src_schema, dst, dst_schema, &mut |_, _| {})
        .await
        .expect("second copy_schema");
    assert_eq!(count(dst, dst_schema, "authors").await, 2, "still 2 after re-copy");
}

// ── SQLite → SQLite (always runs) ────────────────────────────────────────────

#[tokio::test]
async fn copy_sqlite_to_sqlite() {
    let dir = TempDir::new();
    let src = sqlite_pool(dir.str(), "srcs").await;
    let dst = sqlite_pool(dir.str(), "dsts").await;
    create_demo_tables(&src, "srcs").await;
    create_demo_tables(&dst, "dsts").await;
    run_copy(&src, "srcs", &dst, "dsts").await;
}

#[tokio::test]
async fn sqlite_prefix_rename_is_a_noop() {
    let dir = TempDir::new();
    let pool = sqlite_pool(dir.str(), "core").await;
    let outcome = rename_schema_prefix(&pool, "", "kub_").await.expect("rename");
    assert!(outcome.noop, "SQLite has no server namespace to rename");
    assert!(outcome.renamed.is_empty());
}

// ── PostgreSQL (guarded) ─────────────────────────────────────────────────────

#[tokio::test]
async fn copy_pg_to_pg() {
    let Some(src) = pg_pool("coresrc").await else {
        eprintln!("KUBUNO_PG_TEST_URL non défini - copy_pg_to_pg ignoré");
        return;
    };
    let dst = pg_pool("coredst").await.expect("second pg pool");
    pg_drop_schema(&src, "coresrc").await;
    pg_drop_schema(&dst, "coredst").await;
    create_demo_tables(&src, "coresrc").await;
    create_demo_tables(&dst, "coredst").await;
    run_copy(&src, "coresrc", &dst, "coredst").await;
    pg_drop_schema(&src, "coresrc").await;
    pg_drop_schema(&dst, "coredst").await;
}

#[tokio::test]
async fn copy_pg_to_sqlite() {
    let Some(src) = pg_pool("coreport").await else {
        eprintln!("KUBUNO_PG_TEST_URL non défini - copy_pg_to_sqlite ignoré");
        return;
    };
    pg_drop_schema(&src, "coreport").await;
    create_demo_tables(&src, "coreport").await;

    let dir = TempDir::new();
    let dst = sqlite_pool(dir.str(), "portdst").await;
    create_demo_tables(&dst, "portdst").await;

    // A PostgreSQL source is richly typed, so uuid/bool/json/timestamp all copy
    // faithfully into SQLite's storage classes.
    run_copy(&src, "coreport", &dst, "portdst").await;
    pg_drop_schema(&src, "coreport").await;
}

#[tokio::test]
async fn pg_prefix_rename_moves_the_schema() {
    let Some(pool) = pg_pool("coresrc").await else {
        eprintln!("KUBUNO_PG_TEST_URL non défini - pg_prefix_rename ignoré");
        return;
    };
    // Build two prefixed schemas `pfxa_core` and `pfxa_notes`, then rename the
    // whole `pfxa_` family to `pfxb_` and check both moved.
    for s in ["pfxa_core", "pfxa_notes", "pfxb_core", "pfxb_notes"] {
        let _ = pool.execute(&format!("DROP SCHEMA IF EXISTS \"{s}\" CASCADE"), params![]).await;
    }
    for s in ["pfxa_core", "pfxa_notes"] {
        pool.execute(&format!("CREATE SCHEMA \"{s}\""), params![]).await.expect("create");
        pool.execute(&format!("CREATE TABLE \"{s}\".\"t\" (id int)"), params![])
            .await
            .expect("table");
    }

    let outcome = rename_schema_prefix(&pool, "pfxa_", "pfxb_").await.expect("rename");
    assert!(!outcome.noop);
    let mut renamed = outcome.renamed.clone();
    renamed.sort();
    assert_eq!(renamed, vec!["core".to_string(), "notes".to_string()]);

    // The old names are gone, the new ones exist and keep their table.
    for s in ["pfxa_core", "pfxa_notes"] {
        let n: i64 = pool
            .fetch_scalar(
                "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = $1",
                params![s],
            )
            .await
            .unwrap();
        assert_eq!(n, 0, "{s} must be gone");
    }
    for s in ["pfxb_core", "pfxb_notes"] {
        let n: i64 = pool
            .fetch_scalar(
                "SELECT COUNT(*) FROM information_schema.tables \
                   WHERE table_schema = $1 AND table_name = 't'",
                params![s],
            )
            .await
            .unwrap();
        assert_eq!(n, 1, "{s}.t must exist after rename");
    }

    for s in ["pfxa_core", "pfxa_notes", "pfxb_core", "pfxb_notes"] {
        let _ = pool.execute(&format!("DROP SCHEMA IF EXISTS \"{s}\" CASCADE"), params![]).await;
    }
}

// ── MySQL (guarded; provisioning a throwaway user needs a GRANT the sandbox
//    declines, so this is code-complete and runs where a URL is provided) ──────

#[tokio::test]
async fn copy_mysql_to_sqlite() {
    let url = std::env::var("KUBUNO_MYSQL_TEST_URL").ok().filter(|u| !u.trim().is_empty());
    let Some(url) = url else {
        eprintln!("KUBUNO_MYSQL_TEST_URL non défini - copy_mysql_to_sqlite ignoré");
        return;
    };
    let s = settings("mysql", serde_json::json!({ "url": url }));
    // A MySQL connection opens *against* a named database, so the throwaway
    // `srcmy` database must be created through an admin pool first (a MySQL
    // database *is* a schema). Cleaned up at the end.
    let admin = connect(&s, "mysql").await.expect("mysql admin connect");
    let _ = admin.execute("DROP DATABASE IF EXISTS `srcmy`", params![]).await;
    admin.execute("CREATE DATABASE `srcmy`", params![]).await.expect("create srcmy");

    let src = connect(&s, "srcmy").await.expect("mysql connect");
    let _ = src.execute("DROP TABLE IF EXISTS `srcmy`.`books`", params![]).await;
    let _ = src.execute("DROP TABLE IF EXISTS `srcmy`.`authors`", params![]).await;
    create_demo_tables(&src, "srcmy").await;

    let dir = TempDir::new();
    let dst = sqlite_pool(dir.str(), "mydst").await;
    create_demo_tables(&dst, "mydst").await;
    run_copy(&src, "srcmy", &dst, "mydst").await;
    let _ = JWT; // reserved for parity with the other suites

    let _ = admin.execute("DROP DATABASE IF EXISTS `srcmy`", params![]).await;
}

/// The MySQL/SQLite event outbox is engine plumbing, not data: a source that has
/// it (any MySQL or SQLite instance) must copy onto a destination that does not
/// (a PostgreSQL target never creates it) - a switch back used to fail there.
#[tokio::test]
async fn copy_leaves_the_event_outbox_behind() {
    let dir = TempDir::new();
    let src = sqlite_pool(dir.str(), "srco").await;
    let dst = sqlite_pool(dir.str(), "dsto").await;
    create_demo_tables(&src, "srco").await;
    create_demo_tables(&dst, "dsto").await;
    kubuno_db::events::ensure_outbox(&src, "srco").await.expect("outbox");
    kubuno_db::events::notify(&src, "srco", "kubuno_events", "{}").await.expect("an undelivered event");
    run_copy(&src, "srco", &dst, "dsto").await;
}

/// A PostgreSQL `inet` copies as the address the application wrote: a host keeps
/// no `/32` suffix (the `::text` cast used to add one), a network keeps its mask.
#[tokio::test]
async fn copy_pg_inet_keeps_the_display_form() {
    let Some(src) = pg_pool("srcinet").await else {
        eprintln!("KUBUNO_PG_TEST_URL not set - copy_pg_inet_keeps_the_display_form skipped");
        return;
    };
    pg_drop_schema(&src, "srcinet").await;
    src.execute(
        "CREATE TABLE \"srcinet\".\"hosts\" (id integer PRIMARY KEY, ip inet, net inet)",
        params![],
    )
    .await
    .expect("create");
    src.execute(
        "INSERT INTO \"srcinet\".\"hosts\" (id, ip, net) VALUES (1, '192.0.2.1', '10.0.0.0/8'), (2, NULL, '2001:db8::1')",
        params![],
    )
    .await
    .expect("seed");

    let dir = TempDir::new();
    let dst = sqlite_pool(dir.str(), "dstinet").await;
    dst.execute("CREATE TABLE \"dstinet\".\"hosts\" (id INTEGER PRIMARY KEY, ip TEXT, net TEXT)", params![])
        .await
        .expect("create dst");
    copy_schema(&src, "srcinet", &dst, "dstinet", &mut |_, _| {}).await.expect("copy");

    let rows: Vec<(i64, Option<String>, Option<String>)> = dst
        .fetch_all_as("SELECT id, ip, net FROM \"dstinet\".\"hosts\" ORDER BY id", params![])
        .await
        .expect("read back");
    let _ = src.execute("DROP SCHEMA IF EXISTS \"srcinet\" CASCADE", params![]).await;
    assert_eq!(
        rows,
        vec![
            (1, Some("192.0.2.1".to_string()), Some("10.0.0.0/8".to_string())),
            (2, None, Some("2001:db8::1".to_string())),
        ]
    );
}
