//! The rules catalogue a module declares at registration must work on every
//! engine: registering, then re-registering with fewer entries (which purges the
//! vanished ones a rule does not use), then re-evaluating orphans. On MySQL this
//! used to fail on an unquoted `key`, a PostgreSQL-only `LATERAL
//! jsonb_array_elements` and `<> NOT EXISTS (…)` - and since it runs inside the
//! registration transaction, no module could register on MySQL at all.
//!
//! SQLite always runs; MySQL runs when `KUBUNO_MYSQL_TEST_URL` names a user that
//! may CREATE/DROP databases; PostgreSQL when `KUBUNO_PG_TEST_URL` is set.

use kubuno_core::database::migrations;
use kubuno_core::rules::catalog::{self, ActionDef, TriggerDef};
use kubuno_db::{connect, params, DbPool, DbSettings};

fn settings(engine: &str, extra: serde_json::Value) -> DbSettings {
    let mut base = serde_json::json!({
        "engine": engine, "max_connections": 2, "min_connections": 0,
        "connect_timeout": 15, "run_migrations": false,
    });
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    serde_json::from_value(base).expect("DbSettings")
}

fn trigger(key: &str) -> TriggerDef {
    serde_json::from_value(serde_json::json!({
        "key": key, "event_type": format!("probe.{key}"), "label": key,
    }))
    .expect("trigger")
}

fn action(key: &str) -> ActionDef {
    serde_json::from_value(serde_json::json!({
        "key": key, "label": key, "endpoint": "/internal/probe",
    }))
    .expect("action")
}

async fn count(db: &DbPool, table: &str) -> i64 {
    db.fetch_scalar(&format!("SELECT COUNT(*) FROM core.{table} WHERE module_id = 'probe'"), params![])
        .await
        .expect("count")
}

async fn exercise(db: &DbPool) {
    db.execute(
        "INSERT INTO core.modules (id, display_name, version) VALUES ('probe', 'Probe', '0.0.1')",
        params![],
    )
    .await
    .expect("module row");

    let mut tx = db.begin().await.expect("begin");
    catalog::register_module(&mut tx, "probe", &[trigger("one"), trigger("two")], &[action("act")])
        .await
        .expect("first registration");
    tx.commit().await.expect("commit");
    assert_eq!((count(db, "rule_triggers").await, count(db, "rule_actions").await), (2, 1));

    // Re-registration without `two` nor `act`: neither is used by a rule, so both go.
    let mut tx = db.begin().await.expect("begin");
    catalog::register_module(&mut tx, "probe", &[trigger("one")], &[])
        .await
        .expect("re-registration purges the vanished entries");
    tx.commit().await.expect("commit");
    assert_eq!((count(db, "rule_triggers").await, count(db, "rule_actions").await), (1, 0));

    // The module goes away: its entry is flagged, not deleted.
    db.execute("DELETE FROM core.modules WHERE id = 'probe'", params![]).await.expect("uninstall");
    catalog::refresh_orphans(db).await.expect("orphan re-evaluation");
    // The privilege catalogue runs the same re-evaluation at registration.
    kubuno_core::authz::catalog::refresh_orphans(db).await.expect("privilege orphan re-evaluation");
    let orphans: i64 = db
        .fetch_scalar(
            "SELECT COUNT(*) FROM core.rule_triggers WHERE module_id = 'probe' AND is_orphan = TRUE",
            params![],
        )
        .await
        .expect("orphans");
    assert_eq!(orphans, 1);
}

#[tokio::test]
async fn module_catalogue_registers_on_sqlite() {
    let dir = std::env::temp_dir().join(format!("kubuno-rulescat-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("tmp dir");
    let db = connect(&settings("sqlite", serde_json::json!({ "path": dir.to_str().unwrap() })), "core")
        .await
        .expect("sqlite");
    migrations::run(&db).await.expect("migrations");
    exercise(&db).await;
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn module_catalogue_registers_on_mysql() {
    let Some(url) = std::env::var("KUBUNO_MYSQL_TEST_URL").ok().filter(|u| !u.trim().is_empty()) else {
        eprintln!("KUBUNO_MYSQL_TEST_URL not set - module_catalogue_registers_on_mysql skipped");
        return;
    };
    let prefix = format!("t{}_", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let db = connect(&settings("mysql", serde_json::json!({ "url": url, "schema_prefix": prefix })), "core")
        .await
        .expect("mysql");
    let migrated = migrations::run(&db).await.map_err(|e| format!("{e:#}"));
    if migrated.is_ok() {
        exercise(&db).await;
    }
    let _ = db.execute(&format!("DROP DATABASE IF EXISTS `{prefix}core`"), params![]).await;
    migrated.expect("migrations");
}

#[tokio::test]
async fn module_catalogue_registers_on_postgres() {
    let Some(url) = std::env::var("KUBUNO_PG_TEST_URL").ok().filter(|u| !u.trim().is_empty()) else {
        eprintln!("KUBUNO_PG_TEST_URL not set - module_catalogue_registers_on_postgres skipped");
        return;
    };
    // Unprefixed `core` on a throwaway database, wiped first (as the other
    // PostgreSQL-guarded tests do).
    let db = connect(&settings("postgres", serde_json::json!({ "url": url })), "core").await.expect("pg");
    db.execute("DROP SCHEMA IF EXISTS core CASCADE", params![]).await.expect("drop");
    db.execute("CREATE SCHEMA core", params![]).await.expect("create");
    migrations::run(&db).await.expect("migrations");
    exercise(&db).await;
    let _ = db.execute("DROP SCHEMA IF EXISTS core CASCADE", params![]).await;
}
