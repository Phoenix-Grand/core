//! Real proof of the #3 engine switch on the actual `core` schema: migrate a
//! freshly-seeded core onto another engine and copy every table across, then
//! read a custom row back on the target.
//!
//! This exercises exactly what `handlers::admin::db_switch::migrate_core_database`
//! does under the hood - `database::migrations::run` on the target followed by
//! `kubuno_db::copy_schema` - so a green run here is a green core switch.
//!
//! SQLite → SQLite always runs (embedded). PostgreSQL → SQLite runs when
//! `KUBUNO_PG_TEST_URL` is set, otherwise it prints a notice and is skipped.

use kubuno_core::database::migrations;
use kubuno_db::{connect, copy_schema, params, DbPool, DbSettings};

struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("kubuno-coreswitch-{}", uuid::Uuid::new_v4()));
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
        "engine": engine, "max_connections": 4, "min_connections": 0,
        "connect_timeout": 15, "run_migrations": false,
    });
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    serde_json::from_value(base).expect("DbSettings")
}

async fn sqlite_core(dir: &str, schema: &'static str) -> DbPool {
    connect(&settings("sqlite", serde_json::json!({ "path": dir })), schema).await.expect("sqlite connect")
}

/// Wipes and re-migrates a PostgreSQL `core` schema on the shared test server.
async fn fresh_pg_core() -> Option<DbPool> {
    let url = std::env::var("KUBUNO_PG_TEST_URL").ok().filter(|u| !u.trim().is_empty())?;
    let pool = connect(&settings("postgres", serde_json::json!({ "url": url })), "core")
        .await
        .expect("pg connect");
    pool.execute("DROP SCHEMA IF EXISTS core CASCADE", params![]).await.expect("drop");
    pool.execute("CREATE SCHEMA core", params![]).await.expect("create");
    migrations::run(&pool).await.expect("pg core migrations");
    Some(pool)
}

const CUSTOM_KEY: &str = "instance.color_primary";

/// Copies a freshly-migrated `core` from `src` onto `dst` and proves a specific
/// row survived and the settings count matches.
async fn assert_core_copies(src: &DbPool, dst: &DbPool) {
    // A distinctive value on the source, so we can tell a real copy from an
    // identical seed.
    src.execute(
        "UPDATE core.settings SET value = $1 WHERE key = $2",
        params![serde_json::json!("#abcdef"), CUSTOM_KEY],
    )
    .await
    .expect("mark source");

    let src_settings: i64 = src
        .fetch_scalar("SELECT COUNT(*) FROM core.settings", params![])
        .await
        .expect("count source settings");
    assert!(src_settings > 0, "the migrations seed core.settings");

    let report = copy_schema(src, "core", dst, "core", &mut |_, _| {})
        .await
        .expect("copy core schema across engines");
    assert!(report.total_rows >= src_settings, "copied at least the settings rows");

    let dst_settings: i64 = dst
        .fetch_scalar("SELECT COUNT(*) FROM core.settings", params![])
        .await
        .expect("count target settings");
    assert_eq!(dst_settings, src_settings, "settings row count matches after copy");

    // The distinctive value landed on the target.
    let value: serde_json::Value = dst
        .fetch_scalar("SELECT value FROM core.settings WHERE key = $1", params![CUSTOM_KEY])
        .await
        .expect("read copied value");
    let text = value.as_str().or_else(|| value.get(0).and_then(|v| v.as_str()));
    // The value column is JSON; on some engines it round-trips as a JSON string.
    assert!(
        value == serde_json::json!("#abcdef") || text == Some("#abcdef"),
        "the custom value copied across, got {value:?}"
    );
}

#[tokio::test]
async fn core_switch_sqlite_to_sqlite() {
    let src_dir = TempDir::new();
    let dst_dir = TempDir::new();
    let src = sqlite_core(src_dir.str(), "core").await;
    migrations::run(&src).await.expect("src migrations");
    let dst = sqlite_core(dst_dir.str(), "core").await;
    migrations::run(&dst).await.expect("dst migrations");
    assert_core_copies(&src, &dst).await;
}

#[tokio::test]
async fn core_switch_pg_to_sqlite() {
    let Some(src) = fresh_pg_core().await else {
        eprintln!("KUBUNO_PG_TEST_URL non défini - core_switch_pg_to_sqlite ignoré");
        return;
    };
    let dst_dir = TempDir::new();
    let dst = sqlite_core(dst_dir.str(), "core").await;
    migrations::run(&dst).await.expect("dst migrations");
    assert_core_copies(&src, &dst).await;
    let _ = src.execute("DROP SCHEMA IF EXISTS core CASCADE", params![]).await;
}

/// SQLite → Oracle MySQL/MariaDB, onto a namespace that does not exist yet:
/// the target database must be created by `connect`, the MySQL-family core
/// migrations must apply on the server (Oracle MySQL refuses a few MariaDB-only
/// constructs, rewritten at run time), and every row must copy across. Runs when
/// `KUBUNO_MYSQL_TEST_URL` names a user that may CREATE/DROP databases.
#[tokio::test]
async fn core_switch_sqlite_to_fresh_mysql() {
    let Some(url) = std::env::var("KUBUNO_MYSQL_TEST_URL").ok().filter(|u| !u.trim().is_empty()) else {
        eprintln!("KUBUNO_MYSQL_TEST_URL not set - core_switch_sqlite_to_fresh_mysql skipped");
        return;
    };
    let src_dir = TempDir::new();
    let src = sqlite_core(src_dir.str(), "core").await;
    migrations::run(&src).await.expect("src migrations");
    src.execute(
        "UPDATE core.settings SET value = $1 WHERE key = $2",
        params![serde_json::json!("#abcdef"), CUSTOM_KEY],
    )
    .await
    .expect("mark source");

    // A unique prefix: the target namespace `<prefix>core` cannot pre-exist.
    let prefix = format!("t{}_", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let eff = format!("{prefix}core");
    let dst = connect(
        &settings("mysql", serde_json::json!({ "url": url, "schema_prefix": prefix })),
        "core",
    )
    .await
    .expect("mysql connect onto a missing namespace");

    let migrated = migrations::run(&dst).await.map_err(|e| format!("{e:#}"));
    let copied = match &migrated {
        Ok(()) => Some(copy_schema(&src, "core", &dst, &eff, &mut |_, _| {}).await),
        Err(_) => None,
    };
    let value: Option<serde_json::Value> = dst
        .fetch_optional_scalar("SELECT value FROM core.settings WHERE \"key\" = $1", params![CUSTOM_KEY])
        .await
        .ok()
        .flatten();
    // The closure constraints must match PostgreSQL: an open alert is legal, a
    // resolved one needs its closing timestamp (the consolidated schema once
    // reduced this to `status IN ('resolved', 'ignored')`).
    let alert = |status: &'static str, closed: bool| {
        let dst = dst.clone();
        async move {
            let closed_at = if closed { Some(chrono::Utc::now()) } else { None };
            dst.execute(
                "INSERT INTO core.alerts (id, source, kind, severity, status, title, dedup_key, closed_at) \
                 VALUES ($1, 'test', 'probe', 'info', $2, 't', $3, $4)",
                params![uuid::Uuid::new_v4(), status, uuid::Uuid::new_v4().to_string(), closed_at],
            )
            .await
        }
    };
    // The UUID keys PostgreSQL defaults with uuid_generate_v4() must default on
    // MySQL too: the core inserts refresh tokens, alerts, jobs… without an id.
    let missing_defaults: i64 = dst
        .fetch_scalar(
            "SELECT COUNT(*) FROM information_schema.columns \
              WHERE table_schema = DATABASE() AND column_name = 'id' AND column_default IS NULL \
                AND extra NOT LIKE '%DEFAULT_GENERATED%' \
                AND table_name IN ('refresh_tokens', 'alerts', 'jobs', 'users', 'devices')",
            params![],
        )
        .await
        .unwrap_or(-1);
    let open_ok = alert("new", false).await;
    let resolved_ok = alert("resolved", true).await;
    let incoherent = alert("resolved", false).await;

    let _ = dst.execute(&format!("DROP DATABASE IF EXISTS `{eff}`"), params![]).await;

    migrated.expect("core migrations apply on the MySQL server");
    assert_eq!(missing_defaults, 0, "UUID keys keep their default on MySQL");
    open_ok.expect("an open alert is accepted");
    resolved_ok.expect("a resolved alert with closed_at is accepted");
    assert!(incoherent.is_err(), "a resolved alert without closed_at must be refused");
    let report = copied.expect("copy ran").expect("copy core schema onto MySQL");
    assert!(report.total_rows > 0, "rows were copied");
    let value = value.expect("the custom setting reached MySQL");
    let text = value.as_str().or_else(|| value.get(0).and_then(|v| v.as_str()));
    assert!(
        value == serde_json::json!("#abcdef") || text == Some("#abcdef"),
        "the custom value copied across, got {value:?}"
    );
}

/// SQLite carries PostgreSQL's closure constraints after its migrations (the
/// consolidated schema once reduced them to a plain `status IN ('resolved',
/// 'ignored')`), and the rebuilt `alerts` table is still the parent of
/// `alert_events`: the cascade on delete keeps working.
#[tokio::test]
async fn sqlite_core_alert_constraints_match_postgres() {
    let dir = TempDir::new();
    let db = sqlite_core(dir.str(), "core").await;
    migrations::run(&db).await.expect("migrations");

    let insert = |status: &'static str, closed: bool| {
        let db = db.clone();
        async move {
            let id = uuid::Uuid::new_v4();
            let closed_at = if closed { Some(chrono::Utc::now()) } else { None };
            db.execute(
                "INSERT INTO core.alerts (id, source, kind, severity, status, title, dedup_key, closed_at) \
                 VALUES ($1, 'test', 'probe', 'info', $2, 't', $3, $4)",
                params![id, status, id.to_string(), closed_at],
            )
            .await
            .map(|_| id)
        }
    };
    let open = insert("new", false).await.expect("an open alert is accepted");
    insert("resolved", true).await.expect("a resolved alert with closed_at is accepted");
    assert!(insert("resolved", false).await.is_err(), "a resolved alert without closed_at is refused");

    db.execute(
        "INSERT INTO core.alert_events (alert_id, kind, actor_label) VALUES ($1, 'created', 'test')",
        params![open],
    )
    .await
    .expect("alert_events still references alerts");
    db.execute("DELETE FROM core.alerts WHERE id = $1", params![open]).await.expect("delete");
    let events: i64 = db
        .fetch_scalar("SELECT COUNT(*) FROM core.alert_events WHERE alert_id = $1", params![open])
        .await
        .expect("count");
    assert_eq!(events, 0, "deleting an alert still cascades to its events");
}

/// PostgreSQL → Oracle MySQL/MariaDB on the real `core` schema, onto a fresh
/// namespace: the scenario of an operator moving an instance off PostgreSQL.
/// Runs when both `KUBUNO_PG_TEST_URL` and `KUBUNO_MYSQL_TEST_URL` are set.
#[tokio::test]
async fn core_switch_pg_to_fresh_mysql() {
    let Some(url) = std::env::var("KUBUNO_MYSQL_TEST_URL").ok().filter(|u| !u.trim().is_empty()) else {
        eprintln!("KUBUNO_MYSQL_TEST_URL not set - core_switch_pg_to_fresh_mysql skipped");
        return;
    };
    let Some(src) = fresh_pg_core().await else {
        eprintln!("KUBUNO_PG_TEST_URL not set - core_switch_pg_to_fresh_mysql skipped");
        return;
    };
    let prefix = format!("t{}_", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let eff = format!("{prefix}core");
    let dst = connect(
        &settings("mysql", serde_json::json!({ "url": url, "schema_prefix": prefix })),
        "core",
    )
    .await
    .expect("mysql connect");
    let migrated = migrations::run(&dst).await.map_err(|e| format!("{e:#}"));
    let outcome = match &migrated {
        Ok(()) => Some(copy_schema(&src, "core", &dst, &eff, &mut |_, _| {}).await.map_err(|e| e.to_string())),
        Err(_) => None,
    };
    let _ = dst.execute(&format!("DROP DATABASE IF EXISTS `{eff}`"), params![]).await;
    let _ = src.execute("DROP SCHEMA IF EXISTS core CASCADE", params![]).await;

    migrated.expect("core migrations apply on the MySQL server");
    let report = outcome.expect("copy ran").expect("PostgreSQL core copies onto MySQL");
    assert!(report.total_rows > 0);
}
