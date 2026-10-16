//! Regression tests for the MySQL/MariaDB schema-prefix rename: a failure half
//! way through must put every table back (never drop a database that still
//! holds data), and a target namespace that already exists - possibly another
//! instance's - must be refused before anything moves.
//!
//! Guarded by `KUBUNO_MYSQL_TEST_URL` (a URL whose user may CREATE/DROP
//! databases); skipped when it is not set.

use kubuno_db::{connect, params, rename_schema_prefix, AdminError, DbPool, DbSettings};

fn mysql_url() -> Option<String> {
    std::env::var("KUBUNO_MYSQL_TEST_URL").ok().filter(|u| !u.trim().is_empty())
}

fn settings(url: &str) -> DbSettings {
    serde_json::from_value(serde_json::json!({
        "engine": "mysql",
        "url": url,
        "max_connections": 2,
        "min_connections": 0,
        "connect_timeout": 15,
        "run_migrations": false,
    }))
    .expect("DbSettings")
}

/// A fresh, unique, valid prefix (`[a-z0-9_]`).
fn prefix(letter: char) -> String {
    format!("{letter}{}_", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

async fn db_exists(pool: &DbPool, db: &str) -> bool {
    pool.fetch_scalar::<i64>(
        "SELECT CAST(COUNT(*) AS SIGNED) FROM information_schema.schemata WHERE schema_name = $1",
        params![db],
    )
    .await
    .expect("schemata")
        > 0
}

async fn rows(pool: &DbPool, db: &str, table: &str) -> i64 {
    pool.fetch_scalar::<i64>(&format!("SELECT CAST(COUNT(*) AS SIGNED) FROM `{db}`.`{table}`"), params![])
        .await
        .unwrap_or(-1)
}

async fn seed_table(pool: &DbPool, db: &str, table: &str, n: i64) {
    pool.execute(&format!("CREATE TABLE `{db}`.`{table}` (id BIGINT PRIMARY KEY, v VARCHAR(20))"), params![])
        .await
        .expect("create table");
    for i in 0..n {
        pool.execute(&format!("INSERT INTO `{db}`.`{table}` (id, v) VALUES ($1, $2)"), params![i, format!("v{i}")])
            .await
            .expect("insert");
    }
}

async fn cleanup(pool: &DbPool, dbs: &[String]) {
    for db in dbs {
        let _ = pool.execute(&format!("DROP DATABASE IF EXISTS `{db}`"), params![]).await;
    }
}

/// A table carrying a trigger cannot be moved to another database by
/// `RENAME TABLE` ("Trigger in wrong schema"), which makes the move fail after
/// the tables sorted before it have already moved. Every table must come back
/// with its rows, and no half-built target may remain.
#[tokio::test]
async fn failed_mysql_rename_puts_every_table_back() {
    let Some(url) = mysql_url() else {
        eprintln!("KUBUNO_MYSQL_TEST_URL non défini - test ignoré");
        return;
    };
    let admin = connect(&settings(&url), "mysql").await.expect("admin connect");
    let (old, new) = (prefix('p'), prefix('q'));
    let (core_old, notes_old) = (format!("{old}core"), format!("{old}notes"));
    let all = [core_old.clone(), notes_old.clone(), format!("{new}core"), format!("{new}notes")];

    for db in [&core_old, &notes_old] {
        admin.execute(&format!("CREATE DATABASE `{db}`"), params![]).await.expect("create db");
    }
    seed_table(&admin, &core_old, "users", 4).await;
    seed_table(&admin, &notes_old, "a_labels", 3).await;
    seed_table(&admin, &notes_old, "b_notes", 5).await;
    seed_table(&admin, &notes_old, "z_audit", 2).await;
    admin
        .execute(
            &format!(
                "CREATE TRIGGER `{notes_old}`.`z_audit_bi` BEFORE INSERT ON `{notes_old}`.`z_audit` \
                 FOR EACH ROW SET NEW.v = NEW.v"
            ),
            params![],
        )
        .await
        .expect("create trigger");

    let outcome = rename_schema_prefix(&admin, &old, &new).await;
    assert!(outcome.is_err(), "the move of a table with a trigger must fail: {outcome:?}");

    assert_eq!(rows(&admin, &core_old, "users").await, 4, "core tables back in place");
    assert_eq!(rows(&admin, &notes_old, "a_labels").await, 3, "moved table put back, not dropped");
    assert_eq!(rows(&admin, &notes_old, "b_notes").await, 5, "moved table put back, not dropped");
    assert_eq!(rows(&admin, &notes_old, "z_audit").await, 2, "failing table untouched");
    assert!(!db_exists(&admin, &format!("{new}core")).await, "no leftover target");
    assert!(!db_exists(&admin, &format!("{new}notes")).await, "no leftover target");

    cleanup(&admin, &all).await;
}

/// A target that already exists (here: another instance's `notes`) is refused
/// before anything moves, and neither side is touched.
#[tokio::test]
async fn mysql_rename_refuses_an_existing_target() {
    let Some(url) = mysql_url() else {
        eprintln!("KUBUNO_MYSQL_TEST_URL non défini - test ignoré");
        return;
    };
    let admin = connect(&settings(&url), "mysql").await.expect("admin connect");
    let (old, new) = (prefix('r'), prefix('s'));
    let (mine, theirs) = (format!("{old}notes"), format!("{new}notes"));

    for db in [&mine, &theirs] {
        admin.execute(&format!("CREATE DATABASE `{db}`"), params![]).await.expect("create db");
    }
    seed_table(&admin, &mine, "notes", 3).await;
    seed_table(&admin, &theirs, "other_instance", 7).await;

    let outcome = rename_schema_prefix(&admin, &old, &new).await;
    assert!(matches!(outcome, Err(AdminError::TargetExists(ref t)) if *t == theirs), "{outcome:?}");

    assert_eq!(rows(&admin, &mine, "notes").await, 3);
    assert_eq!(rows(&admin, &theirs, "other_instance").await, 7, "the other instance is intact");
    assert_eq!(rows(&admin, &theirs, "notes").await, -1, "nothing was moved into it");

    cleanup(&admin, &[mine, theirs]).await;
}
