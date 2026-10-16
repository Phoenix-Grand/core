//! Proves schema-name prefixing end to end: with `schema_prefix = "kub_"` a
//! module's schema `notes` becomes `kub_notes` everywhere, its migrations create
//! their tables there, and the module's own **literal** `notes.` SQL reaches
//! `kub_notes.` unchanged in the module source.
//!
//! The migrations under `tests/prefix_migrations` mirror the real per-engine
//! spelling: PostgreSQL and MySQL DDL is unqualified (it leans on the prefixed
//! search_path / connection database), while the SQLite DDL is schema-qualified
//! (`CREATE TABLE notes.widgets`), so the migrator's prefix rewrite is exercised.
//!
//! * SQLite always runs (a temp file, no server).
//! * PostgreSQL runs when `KUBUNO_PG_TEST_URL` is set (the role must be able to
//!   `CREATE SCHEMA kub_notes` in that database).
//! * MySQL/MariaDB runs when `KUBUNO_MYSQL_TEST_URL` is set AND the `kub_notes`
//!   database already exists with a grant for the role (MySQL has no schemas, so
//!   the prefixed schema is a whole database, and narrow-grant roles cannot
//!   create it themselves):
//!
//!   ```sh
//!   sudo mysql -e "CREATE DATABASE IF NOT EXISTS \`kub_notes\`;
//!                  GRANT ALL ON \`kub_notes\`.* TO 'kubuno_test'@'%';"
//!   ```

use kubuno_db::{params, DbPool, DbSettings};

/// The module schema under test - the `notes` cobaye from the task.
const SCHEMA: &str = "notes";
const PREFIX: &str = "kub_";

/// Migrations are serialised: the PostgreSQL and MySQL suites may share a server.
static EXCLUSIVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn prefixed_settings(engine: &str) -> DbSettings {
    DbSettings {
        engine: engine.to_string(),
        url: None,
        host: None,
        port: None,
        user: None,
        password: None,
        database: None,
        path: None,
        schema_prefix: Some(PREFIX.to_string()),
        max_connections: 4,
        min_connections: 0,
        connect_timeout: std::time::Duration::from_secs(10),
        run_migrations: true,
    }
}

async fn migrated_pool(settings: DbSettings) -> (DbPool, impl Sized) {
    let guard = EXCLUSIVE.lock().await;
    let pool = kubuno_db::connect(&settings, SCHEMA).await.expect("connect");
    kubuno_db::migrations!(
        "tests/prefix_migrations/postgres",
        "tests/prefix_migrations/mysql",
        "tests/prefix_migrations/sqlite",
    )
    .run(&pool, SCHEMA)
    .await
    .expect("migrations");
    (pool, guard)
}

/// The module-style round-trip: every statement is written with the LITERAL
/// `notes.` qualifier, exactly as a module's source does; prefix rewriting is
/// what makes it reach `kub_notes.`.
async fn round_trip(pool: &DbPool) {
    // Rerun-safe: the prefixed schema persists between runs on a server engine.
    pool.execute("DELETE FROM notes.widgets", params![])
        .await
        .expect("clear widgets");
    pool.execute(
        "INSERT INTO notes.widgets (id, name) VALUES ($1, $2)",
        params![1_i32, "sprocket"],
    )
    .await
    .expect("insert widget");

    let name: String = pool
        .fetch_scalar("SELECT name FROM notes.widgets WHERE id = $1", params![1_i32])
        .await
        .expect("read widget back");
    assert_eq!(name, "sprocket", "the literal `notes.` query reached the prefixed table");
}

#[tokio::test]
async fn sqlite_prefix_round_trip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut s = prefixed_settings("sqlite");
    s.path = Some(dir.path().to_string_lossy().into_owned());
    let (pool, _keep) = migrated_pool(s).await;

    round_trip(&pool).await;

    // The file is named for the prefixed schema, and the unprefixed one is absent
    // - two prefixed instances get distinct files.
    assert!(dir.path().join("kub_notes.sqlite").exists(), "kub_notes.sqlite exists");
    assert!(!dir.path().join("notes.sqlite").exists(), "no unprefixed notes.sqlite");
}

#[tokio::test]
async fn postgres_prefix_round_trip() {
    let Ok(url) = std::env::var("KUBUNO_PG_TEST_URL") else {
        eprintln!("skipping: KUBUNO_PG_TEST_URL not set");
        return;
    };
    let mut s = prefixed_settings("postgres");
    s.url = Some(url);
    let (pool, _keep) = migrated_pool(s).await;

    round_trip(&pool).await;

    // The table lives in the prefixed schema, and not in the bare one.
    let in_prefixed: i64 = pool
        .fetch_scalar(
            "SELECT count(*) FROM information_schema.tables \
             WHERE table_schema = $1 AND table_name = $2",
            params!["kub_notes", "widgets"],
        )
        .await
        .expect("count in kub_notes");
    assert_eq!(in_prefixed, 1, "widgets is in schema kub_notes");
}

#[tokio::test]
async fn mysql_prefix_round_trip() {
    let Ok(url) = std::env::var("KUBUNO_MYSQL_TEST_URL") else {
        eprintln!("skipping: KUBUNO_MYSQL_TEST_URL not set");
        return;
    };
    let mut s = prefixed_settings("mysql");
    // The database in the URL is ignored on MySQL: the connection targets the
    // effective schema `kub_notes` (which must already exist, see the header).
    s.url = Some(url);
    let (pool, _keep) = migrated_pool(s).await;

    round_trip(&pool).await;

    let in_prefixed: i64 = pool
        .fetch_scalar(
            "SELECT count(*) FROM information_schema.tables \
             WHERE table_schema = $1 AND table_name = $2",
            params!["kub_notes", "widgets"],
        )
        .await
        .expect("count in kub_notes");
    assert_eq!(in_prefixed, 1, "widgets is in database kub_notes");
}
