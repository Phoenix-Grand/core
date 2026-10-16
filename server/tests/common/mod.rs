//! Shared test helpers: connection to a DEDICATED test database.
//!
//! The tests never touch the running instance's database. They need
//! `KUBUNO_TEST_DATABASE_URL` (or `DATABASE_URL`) pointing at a throwaway
//! database - locally:
//!
//! ```text
//! sudo -u postgres psql -c "CREATE ROLE kubuno_test LOGIN PASSWORD 'kubuno_test'"
//! sudo -u postgres psql -c "CREATE DATABASE kubuno_test OWNER kubuno_test"
//! sudo -u postgres psql -d kubuno_test -c 'CREATE EXTENSION "uuid-ossp"; CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent; CREATE EXTENSION citext;'
//! KUBUNO_TEST_DATABASE_URL=postgres://kubuno_test:kubuno_test@127.0.0.1:5432/kubuno_test cargo test
//! ```
//!
//! Without that variable the tests print a notice and pass - CI without a
//! PostgreSQL must not turn red on a missing fixture.
#![allow(dead_code)]

use kubuno_db::{connect, DbPool, DbSettings};

const SCHEMA: &str = "core";

pub fn test_database_url() -> Option<String> {
    std::env::var("KUBUNO_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
        .filter(|u| !u.trim().is_empty())
}

/// Builds a PostgreSQL `DbSettings` from the test URL. The section is normally
/// deserialized from config; `connect_timeout` is seconds.
fn settings(url: &str) -> DbSettings {
    let base = serde_json::json!({
        "engine": "postgres",
        "url": url,
        "max_connections": 8,
        "min_connections": 0,
        "connect_timeout": 10,
        "run_migrations": false,
    });
    serde_json::from_value(base).expect("DbSettings")
}

/// Connects and applies the migrations. `None` = no test database configured.
pub async fn test_pool() -> Option<DbPool> {
    let url = match test_database_url() {
        Some(u) => u,
        None => {
            eprintln!("KUBUNO_TEST_DATABASE_URL absent - test ignoré");
            return None;
        }
    };

    let pool = connect(&settings(&url), SCHEMA)
        .await
        .expect("connexion à la base de test");

    kubuno_core::database::migrations::run(&pool)
        .await
        .expect("migrations sur la base de test");

    Some(pool)
}

/// Waits until `cond` holds, polling every 100 ms. Returns false on timeout.
pub async fn wait_until<F, Fut>(timeout: std::time::Duration, mut cond: F) -> bool
where
    F:   FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if cond().await {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
