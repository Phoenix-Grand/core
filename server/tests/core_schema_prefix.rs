//! Proves the schema-name prefix reaches the core's OWN schema now that the
//! core runs on `kubuno-db`. With `schema_prefix = "kub_"` the core's `core`
//! namespace becomes `kub_core`: a table created with a literal `core.` name
//! lands in `kub_core`, and a literal `core.` query is rewritten to `kub_core.`
//! unchanged - exactly what core code (and its migrations) rely on. It is the
//! core-side counterpart to `kubuno-db`'s module-side `schema_prefix` test, and
//! confirms the same `kubuno_db::connect(cfg, "core")` boot path the running
//! instance and the installer's `to_db_settings()` now share.
//!
//! PostgreSQL only, and only when `KUBUNO_PG_TEST_URL` is set (the role must be
//! able to `CREATE SCHEMA kub_core`); otherwise it is skipped. It intentionally
//! exercises the prefix mechanism directly rather than the full core migration
//! set, so it stays deterministic on a shared test database (the migration set
//! includes a guarded cross-module data step that a leftover unprefixed sibling
//! schema on the same server could otherwise perturb).

use kubuno_db::{connect, params, DbPool, DbSettings};

const SCHEMA: &str = "core";
const PREFIX: &str = "kub_";

fn prefixed_pg_settings(url: &str) -> DbSettings {
    let base = serde_json::json!({
        "engine": "postgres",
        "url": url,
        "schema_prefix": PREFIX,
        "max_connections": 4,
        "min_connections": 0,
        "connect_timeout": 10,
        "run_migrations": false,
    });
    serde_json::from_value(base).expect("DbSettings")
}

#[tokio::test]
async fn postgres_core_schema_is_prefixed() {
    let Ok(url) = std::env::var("KUBUNO_PG_TEST_URL") else {
        eprintln!("skipping: KUBUNO_PG_TEST_URL not set");
        return;
    };

    let settings = prefixed_pg_settings(&url);
    // `connect` creates `kub_core` and pins the search_path to it.
    let pool: DbPool = connect(&settings, SCHEMA).await.expect("connect prefixed core");

    // Rerun-safe: start from a clean probe table inside the prefixed schema.
    pool.execute("DROP TABLE IF EXISTS core.prefix_probe", params![])
        .await
        .expect("drop probe");
    // A literal `core.` DDL, exactly as a core migration writes it.
    pool.execute(
        "CREATE TABLE core.prefix_probe (id INT PRIMARY KEY, note TEXT NOT NULL)",
        params![],
    )
    .await
    .expect("create core.prefix_probe");

    // The table materialised in `kub_core`, not the bare `core`.
    let in_prefixed: i64 = pool
        .fetch_scalar(
            "SELECT count(*) FROM information_schema.tables \
             WHERE table_schema = $1 AND table_name = $2",
            params!["kub_core", "prefix_probe"],
        )
        .await
        .expect("count prefix_probe in kub_core");
    assert_eq!(in_prefixed, 1, "core table lives in schema kub_core");

    let in_bare: i64 = pool
        .fetch_scalar(
            "SELECT count(*) FROM information_schema.tables \
             WHERE table_schema = $1 AND table_name = $2",
            params!["core", "prefix_probe"],
        )
        .await
        .expect("count prefix_probe in bare core");
    assert_eq!(in_bare, 0, "the probe is NOT in the unprefixed core schema");

    // A literal `core.` read/write round-trips through the prefixed schema.
    pool.execute(
        "INSERT INTO core.prefix_probe (id, note) VALUES ($1, $2)",
        params![1_i32, "prefixed"],
    )
    .await
    .expect("insert into core.prefix_probe");
    let note: String = pool
        .fetch_scalar("SELECT note FROM core.prefix_probe WHERE id = $1", params![1_i32])
        .await
        .expect("read note back");
    assert_eq!(note, "prefixed", "literal core. query reached kub_core.prefix_probe");

    // Leave the probe table behind cleaned up; the schema is shared.
    pool.execute("DROP TABLE IF EXISTS core.prefix_probe", params![])
        .await
        .expect("cleanup probe");
}
