//! On MySQL/MariaDB a schema is a database, and the pool's connections use it as
//! their default database. `connect` must therefore work onto a namespace that
//! does not exist yet (an engine switch onto an empty server): it creates the
//! database before opening the pool, instead of failing with 1049 "Unknown
//! database".
//!
//! Guarded by `KUBUNO_MYSQL_TEST_URL` (a URL whose user may CREATE/DROP
//! databases); skipped when it is not set.

use kubuno_db::{connect, params, DbSettings};

fn mysql_url() -> Option<String> {
    std::env::var("KUBUNO_MYSQL_TEST_URL").ok().filter(|u| !u.trim().is_empty())
}

fn settings(url: &str, prefix: &str) -> DbSettings {
    serde_json::from_value(serde_json::json!({
        "engine": "mysql",
        "url": url,
        "schema_prefix": prefix,
        "max_connections": 2,
        "min_connections": 0,
        "connect_timeout": 15,
        "run_migrations": false,
    }))
    .expect("DbSettings")
}

#[tokio::test]
async fn mysql_connect_creates_a_missing_namespace() {
    let Some(url) = mysql_url() else {
        eprintln!("KUBUNO_MYSQL_TEST_URL not set - test skipped");
        return;
    };
    // A unique prefix, so the namespace `<prefix>core` cannot pre-exist.
    let prefix = format!("t{}_", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let eff = format!("{prefix}core");

    let pool = connect(&settings(&url, &prefix), "core")
        .await
        .expect("connect must create the missing namespace instead of failing");

    let current: Option<String> = pool
        .fetch_scalar("SELECT DATABASE()", params![])
        .await
        .expect("select database()");
    let exists: i64 = pool
        .fetch_scalar(
            "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = $1",
            params![eff.clone()],
        )
        .await
        .expect("schemata lookup");

    let _ = pool.execute(&format!("DROP DATABASE IF EXISTS `{eff}`"), params![]).await;

    assert_eq!(exists, 1, "the namespace database was not created");
    assert_eq!(current.as_deref(), Some(eff.as_str()), "the pool must default to the namespace");
}
