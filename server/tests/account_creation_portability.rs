//! Account creation on every engine: what the admin console, public sign-up and
//! the directory provisioner write when an account is created.
//!
//! Two regressions are pinned here, both invisible on PostgreSQL:
//!
//! * **Password history trim.** `password_policy::remember` keeps the newest N
//!   hashes with `DELETE ... WHERE id NOT IN (SELECT ... LIMIT n)`. MySQL and
//!   MariaDB reject a `LIMIT` inside an `IN (...)` subquery (error 1235), so
//!   every account creation and password change failed there with a 500.
//! * **Unit of an account created without one.** `core.users.org_unit_id` is
//!   `NOT NULL` everywhere, but only PostgreSQL has the trigger that places a
//!   NULL at the root. The admin console bound the optional `org_unit_id` as is,
//!   so creating an account without naming a unit failed on MySQL/MariaDB and
//!   SQLite.
//!
//! SQLite is embedded and always runs. PostgreSQL and MySQL/MariaDB run when
//! `KUBUNO_PG_TEST_URL` / `KUBUNO_MYSQL_TEST_URL` are set; each run works in a
//! fresh, uniquely prefixed namespace (`t<random>_core`) that it drops at the
//! end, so a shared server is never touched outside it. The MySQL URL's user
//! must be allowed to create and drop databases.

use kubuno_core::database::seed;
use kubuno_core::settings::password_policy;
use kubuno_db::{connect, params, Backend, DbPool, DbSettings};
use uuid::Uuid;

const SCHEMA: &str = "core";

fn settings(engine: &str, extra: serde_json::Value) -> DbSettings {
    let mut base = serde_json::json!({
        "engine": engine,
        "max_connections": 4,
        "min_connections": 0,
        "connect_timeout": 15,
        "run_migrations": false,
    });
    base.as_object_mut()
        .expect("object")
        .extend(extra.as_object().expect("object").clone());
    serde_json::from_value(base).expect("DbSettings")
}

/// A server pool in a fresh namespace, or `None` when the variable is unset.
async fn server_pool(engine: &str, env: &str) -> Option<(DbPool, String)> {
    let Some(url) = std::env::var(env).ok().filter(|u| !u.trim().is_empty()) else {
        eprintln!("{env} not set - {engine} skipped");
        return None;
    };
    let prefix = format!("t{}_", &Uuid::new_v4().simple().to_string()[..10]);
    let s = settings(engine, serde_json::json!({ "url": url, "schema_prefix": prefix }));
    let pool = connect(&s, SCHEMA)
        .await
        .unwrap_or_else(|e| panic!("{engine} connect ({env}) failed: {e}"));
    Some((pool, format!("{prefix}{SCHEMA}")))
}

async fn drop_namespace(pool: &DbPool, namespace: &str) {
    let sql = match pool.backend() {
        Backend::Postgres => format!("DROP SCHEMA IF EXISTS \"{namespace}\" CASCADE"),
        Backend::MySql => format!("DROP DATABASE IF EXISTS `{namespace}`"),
        Backend::Sqlite => return,
    };
    if let Err(e) = pool.execute(&sql, params![]).await {
        eprintln!("cleanup of {namespace} failed: {e}");
    }
}

async fn migrate(pool: &DbPool) {
    kubuno_db::pool::ensure_schema(pool, SCHEMA)
        .await
        .expect("ensure schema");
    kubuno_core::database::migrations::run(pool)
        .await
        .expect("run core migrations");
}

/// The root unit, created when the engine's migrations seed none.
async fn root_unit(pool: &DbPool) -> Uuid {
    if let Some(root) = seed::root_org_unit(pool).await {
        return root;
    }
    let id = kubuno_db::new_id();
    pool.execute(
        "INSERT INTO core.org_units (id, name, parent_id) VALUES ($1, $2, NULL)",
        params![id, "Root"],
    )
    .await
    .expect("insert root unit");
    id
}

/// Inserts an account the way the admin console does, with the unit resolved
/// through `seed::unit_for_new_account`.
async fn create_account(pool: &DbPool, requested_unit: Option<Uuid>) -> (Uuid, Option<Uuid>) {
    let unit = seed::unit_for_new_account(pool, requested_unit).await;
    let id = kubuno_db::new_id();
    let tag = id.simple().to_string();
    pool.execute(
        "INSERT INTO core.users (id, email, username, password_hash, role, quota_bytes, org_unit_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        params![
            id,
            format!("{tag}@example.test"),
            format!("u{}", &tag[..16]),
            "not-a-real-hash",
            "user",
            1_i64 << 30,
            unit
        ],
    )
    .await
    .expect("an account created without a unit must still be inserted");
    (id, unit)
}

async fn unit_of(pool: &DbPool, user: Uuid) -> Uuid {
    pool.fetch_scalar::<Uuid>("SELECT org_unit_id FROM core.users WHERE id = $1", params![user])
        .await
        .expect("read org_unit_id")
}

async fn history_count(pool: &DbPool, user: Uuid) -> i64 {
    pool.fetch_scalar::<i64>(
        "SELECT COUNT(*) FROM core.password_history WHERE user_id = $1",
        params![user],
    )
    .await
    .expect("count history")
}

async fn run_all(pool: &DbPool) {
    migrate(pool).await;
    let root = root_unit(pool).await;

    // ── An account created without a unit lands at the root ─────────────────
    let (user, resolved) = create_account(pool, None).await;
    assert_eq!(resolved, Some(root), "no unit named must resolve to the root");
    assert_eq!(unit_of(pool, user).await, root);

    // An explicit unit is kept as asked.
    let child = kubuno_db::new_id();
    pool.execute(
        "INSERT INTO core.org_units (id, name, parent_id) VALUES ($1, $2, $3)",
        params![child, format!("Unit {}", &child.simple().to_string()[..8]), root],
    )
    .await
    .expect("insert child unit");
    let (placed, _) = create_account(pool, Some(child)).await;
    assert_eq!(unit_of(pool, placed).await, child);

    // ── The password history is trimmed to the policy depth ─────────────────
    const DEPTH: usize = 3;
    for i in 0..5 {
        let mut tx = pool.begin().await.expect("begin");
        password_policy::remember(&mut tx, user, &format!("hash-{i}"), DEPTH)
            .await
            .expect("remember must succeed on every engine");
        tx.commit().await.expect("commit");
    }
    assert_eq!(history_count(pool, user).await, DEPTH as i64);
    let newest: i64 = pool
        .fetch_scalar::<i64>(
            "SELECT COUNT(*) FROM core.password_history WHERE user_id = $1 AND password_hash = $2",
            params![user, "hash-4"],
        )
        .await
        .expect("read newest");
    assert_eq!(newest, 1, "the newest hash must be kept");

    // Another account's history is left alone by the trim.
    let mut tx = pool.begin().await.expect("begin");
    password_policy::remember(&mut tx, placed, "other", DEPTH).await.expect("remember other");
    tx.commit().await.expect("commit");
    assert_eq!(history_count(pool, placed).await, 1);
    assert_eq!(history_count(pool, user).await, DEPTH as i64);

    // Depth 0 empties the history.
    let mut tx = pool.begin().await.expect("begin");
    password_policy::remember(&mut tx, placed, "again", 0).await.expect("remember depth 0");
    tx.commit().await.expect("commit");
    assert_eq!(history_count(pool, placed).await, 0);
}

#[tokio::test]
async fn sqlite_account_creation() {
    let dir = std::env::temp_dir().join(format!("kubuno-core-accounts-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let s = settings("sqlite", serde_json::json!({ "path": dir.to_str().expect("utf-8 path") }));
    let pool = connect(&s, SCHEMA).await.expect("sqlite connect");
    run_all(&pool).await;
    drop(pool);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn postgres_account_creation() {
    if let Some((pool, ns)) = server_pool("postgres", "KUBUNO_PG_TEST_URL").await {
        run_all(&pool).await;
        drop_namespace(&pool, &ns).await;
    }
}

#[tokio::test]
async fn mysql_account_creation() {
    if let Some((pool, ns)) = server_pool("mysql", "KUBUNO_MYSQL_TEST_URL").await {
        run_all(&pool).await;
        drop_namespace(&pool, &ns).await;
    }
}
