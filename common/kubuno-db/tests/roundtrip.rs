//! Exercises the foundation itself against a real server of each engine, from
//! a single compiled binary - the proof that the engine is a run-time choice.
//!
//! * SQLite always runs (a temp file, no server).
//! * PostgreSQL runs when `KUBUNO_PG_TEST_URL` points at a throwaway database.
//! * MySQL/MariaDB runs when `KUBUNO_MYSQL_TEST_URL` does.
//!
//! ```sh
//! KUBUNO_PG_TEST_URL=postgres://u:p@localhost:5433/kbdbtest \
//! KUBUNO_MYSQL_TEST_URL=mysql://u:p@localhost:3307/kbdbtest \
//!   cargo test -p kubuno-db --test roundtrip
//! ```
//!
//! The same binary carries all three drivers; each engine's suite is one test.
//! PostgreSQL and MySQL SKIP when their server is absent rather than fail, so
//! the suite is green in a CI runner that only has SQLite.

use chrono::{DateTime, Utc};
use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool, DbSettings};
use uuid::Uuid;

const SCHEMA: &str = "kbdbtest";

fn base_settings(engine: &str) -> DbSettings {
    DbSettings {
        engine: engine.to_string(),
        url: None,
        host: None,
        port: None,
        user: None,
        password: None,
        database: None,
        path: None,
        schema_prefix: None,
        max_connections: 4,
        min_connections: 0,
        connect_timeout: std::time::Duration::from_secs(10),
        run_migrations: false,
    }
}

/// One writer at a time: the PostgreSQL and MySQL suites may share a server.
static EXCLUSIVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The table this test writes into. `&'static str` is what the dialect helpers
/// take; a const gives it to us.
const TABLE: &str = "kbdbtest.items";

/// A fixed whole-second instant: every engine stores it without sub-second
/// rounding, so the round-trip can assert exact equality.
fn fixed_instant() -> DateTime<Utc> {
    DateTime::from_timestamp(1_700_000_000, 0).expect("valid timestamp")
}

#[derive(Debug, sqlx::FromRow, PartialEq)]
struct Item {
    id: Uuid,
    payload: serde_json::Value,
    created: DateTime<Utc>,
    body: Vec<u8>,
    n: i64,
}

async fn fresh_pool(settings: DbSettings) -> (DbPool, impl Sized) {
    let guard = EXCLUSIVE.lock().await;
    let pool = kubuno_db::connect(&settings, SCHEMA)
        .await
        .expect("connect");
    let b = pool.backend();

    // A clean table each run; the engine-specific column types come from the
    // dialect layer, exactly as a migration would spell them.
    pool.execute(&format!("DROP TABLE IF EXISTS {TABLE}"), params![])
        .await
        .expect("drop");
    let ddl = format!(
        "CREATE TABLE {TABLE} (\
             id {uuid} PRIMARY KEY, \
             payload {json} NOT NULL, \
             created {ts} NOT NULL, \
             body {bytes} NOT NULL, \
             n BIGINT NOT NULL)",
        uuid = b.col_uuid(),
        json = b.col_json(),
        ts = b.col_timestamptz(),
        bytes = b.col_bytes(),
    );
    pool.execute(&ddl, params![]).await.expect("create table");

    (pool, guard)
}

/// Everything the foundation has to get right on every engine, in one pass.
async fn full_suite(pool: &DbPool) {
    let b = pool.backend();

    // ── a Uuid, a JSON value, a timestamp, a blob and a bigint survive a
    //    round trip through DbValue and back through FromRow ──
    let id = Uuid::new_v4();
    let payload = serde_json::json!({ "kind": "vault", "count": 3 });
    let created = fixed_instant();
    let body = vec![0xDE_u8, 0xAD, 0xBE, 0xEF];

    pool.execute(
        &format!(
            "INSERT INTO {TABLE} (id, payload, created, body, n) \
             VALUES ($1, $2, $3, $4, $5)"
        ),
        params![id, payload.clone(), created, body.clone(), 42_i64],
    )
    .await
    .expect("insert");

    let got: Item = pool
        .fetch_one_as(
            &format!("SELECT id, payload, created, body, n FROM {TABLE} WHERE id = $1"),
            params![id],
        )
        .await
        .expect("read back");
    assert_eq!(
        got,
        Item {
            id,
            payload,
            created,
            body,
            n: 42,
        },
        "every value type must survive the round trip on {:?}",
        b
    );

    // ── the upsert helper bumps a counter on conflict and keeps one row ──
    let up = b.upsert(
        TABLE,
        &["id"],
        &[Assign::Expr {
            col: "n",
            expr: "{cur} + 1",
        }],
    );
    let insert = format!(
        "INSERT INTO {TABLE} (id, payload, created, body, n) \
         VALUES ($1, $2, $3, $4, $5){up}"
    );
    let second = fixed_instant();
    pool.execute(
        &insert,
        params![id, serde_json::json!({}), second, vec![0_u8], 1_i64],
    )
    .await
    .expect("upsert");

    let n: i64 = pool
        .fetch_scalar(&format!("SELECT n FROM {TABLE} WHERE id = $1"), params![id])
        .await
        .expect("counter");
    assert_eq!(n, 43, "the conflict branch must bump, not insert, on {:?}", b);

    let rows: i64 = pool
        .fetch_scalar(&format!("SELECT {} FROM {TABLE}", b.count_bigint("*")), params![])
        .await
        .expect("count");
    assert_eq!(rows, 1, "the upsert must not have added a row on {:?}", b);

    // ── the aggregates decode to i64/f64 on every engine ──
    let total: i64 = pool
        .fetch_scalar(
            &format!("SELECT {} FROM {TABLE}", b.sum_bigint("n")),
            params![],
        )
        .await
        .expect("sum");
    assert_eq!(total, 43, "sum_bigint must decode on {:?}", b);

    let avg: f64 = pool
        .fetch_scalar(
            &format!("SELECT {} FROM {TABLE}", b.avg_double("n")),
            params![],
        )
        .await
        .expect("avg");
    assert!((avg - 43.0).abs() < 1e-9, "avg_double must decode on {:?}", b);
}

#[tokio::test]
async fn sqlite_from_the_one_binary() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut s = base_settings("sqlite");
    s.path = Some(dir.path().to_string_lossy().into_owned());
    let (pool, _keep) = fresh_pool(s).await;
    full_suite(&pool).await;
}

#[tokio::test]
async fn postgres_from_the_one_binary() {
    let Ok(url) = std::env::var("KUBUNO_PG_TEST_URL") else {
        eprintln!("skipping: KUBUNO_PG_TEST_URL not set");
        return;
    };
    let mut s = base_settings("postgres");
    s.url = Some(url);
    let (pool, _keep) = fresh_pool(s).await;
    full_suite(&pool).await;
}

#[tokio::test]
async fn mysql_from_the_one_binary() {
    let Ok(url) = std::env::var("KUBUNO_MYSQL_TEST_URL") else {
        eprintln!("skipping: KUBUNO_MYSQL_TEST_URL not set");
        return;
    };
    let mut s = base_settings("mysql");
    s.url = Some(url);
    let (pool, _keep) = fresh_pool(s).await;
    full_suite(&pool).await;
}
