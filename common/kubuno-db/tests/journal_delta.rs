//! Proves the [`kubuno_db::journal`] change-journal primitive against a real
//! server of each compiled-in engine.
//!
//! SQLite runs unconditionally, on a throwaway file under `/tmp`. MySQL/MariaDB
//! runs when `KUBUNO_DB_MYSQL_URL` names a **throwaway** database (a disposable
//! server on a non-standard port - never a shared one); when it is unset the
//! MySQL test prints why it did nothing rather than failing, since a server may
//! not be mountable in every environment.
//!
//! What is proven, on every engine reached:
//!
//! * a per-domain sequence that climbs strictly on insert / update / delete;
//! * concurrent increments that never collide and leave no gap (so two writers
//!   can never obtain the same seq);
//! * a tombstone written past the last live seq;
//! * `changes_since` returning the right live rows and tombstones, in order,
//!   and honouring the cursor.

use kubuno_db as db;
use kubuno_db::dialect::Backend;
use kubuno_db::{changes_since, new_id, next_seq, next_seq_on_pool, params, record_tombstone, touch, DbPool, DbSettings};
use std::time::Duration;
use uuid::Uuid;

const SCHEMA: &str = "jtest";

fn sqlite_settings(dir: &str) -> DbSettings {
    DbSettings {
        engine: "sqlite".to_string(),
        url: None,
        host: None,
        port: None,
        user: None,
        password: None,
        database: None,
        path: Some(dir.to_string()),
        schema_prefix: None,
        max_connections: 8,
        min_connections: 0,
        connect_timeout: Duration::from_secs(30),
        run_migrations: false,
    }
}

fn mysql_settings(url: String) -> DbSettings {
    DbSettings {
        engine: "mysql".to_string(),
        url: Some(url),
        host: None,
        port: None,
        user: None,
        password: None,
        database: None,
        path: None,
        schema_prefix: None,
        max_connections: 8,
        min_connections: 0,
        connect_timeout: Duration::from_secs(10),
        run_migrations: false,
    }
}

/// A SQLite pool on a fresh temporary directory under `/tmp` (per the test
/// contract), returned with the `TempDir` so it lives for the test.
async fn sqlite_pool() -> (DbPool, tempfile::TempDir) {
    let dir = tempfile::Builder::new()
        .prefix("kbdb-journal-")
        .tempdir_in("/tmp")
        .expect("tempdir in /tmp");
    let pool = db::connect(&sqlite_settings(&dir.path().to_string_lossy()), SCHEMA)
        .await
        .expect("connect sqlite");
    (pool, dir)
}

/// The three tables a module carrying this primitive creates, written per
/// engine. `domain` is `VARCHAR` (not `TEXT`) so MySQL can make it a primary key.
fn create_tables(b: Backend) -> Vec<String> {
    let uuid = b.col_uuid();
    let ts = b.col_timestamptz();
    vec![
        format!(
            "CREATE TABLE IF NOT EXISTS {SCHEMA}.change_counter (\
                 domain VARCHAR(190) NOT NULL PRIMARY KEY, n BIGINT NOT NULL)"
        ),
        format!(
            "CREATE TABLE IF NOT EXISTS {SCHEMA}.widgets (\
                 id {uuid} NOT NULL PRIMARY KEY, owner_id {uuid} NOT NULL, \
                 label VARCHAR(190) NOT NULL, change_seq BIGINT NOT NULL DEFAULT 0)"
        ),
        format!(
            "CREATE TABLE IF NOT EXISTS {SCHEMA}.widget_tombstones (\
                 id {uuid} NOT NULL PRIMARY KEY, owner_id {uuid} NOT NULL, \
                 change_seq BIGINT NOT NULL, deleted_at {ts} NOT NULL)"
        ),
    ]
}

async fn reset_tables(pool: &DbPool) {
    for t in ["widget_tombstones", "widgets", "change_counter"] {
        pool.execute(&format!("DROP TABLE IF EXISTS {SCHEMA}.{t}"), params![])
            .await
            .expect("drop");
    }
    for ddl in create_tables(pool.backend()) {
        pool.execute(&ddl, params![]).await.expect("create");
    }
}

const COUNTER: &str = "jtest.change_counter";
const WIDGETS: &str = "jtest.widgets";
const TOMBS: &str = "jtest.widget_tombstones";

/// Insert / update / delete / pull, asserting the delta contract end to end.
async fn exercise_delta(pool: &DbPool) {
    reset_tables(pool).await;
    let owner = new_id();

    // Three inserts, each taking a seq and binding it into the same row write.
    let mut ids = Vec::new();
    let mut seqs = Vec::new();
    for i in 0..3 {
        let mut tx = pool.begin().await.expect("begin");
        let seq = next_seq(&mut tx, COUNTER, "widgets").await.expect("next_seq");
        let id = new_id();
        tx.execute(
            &format!("INSERT INTO {WIDGETS} (id, owner_id, label, change_seq) VALUES ($1, $2, $3, $4)"),
            params![id, owner, format!("w{i}"), seq],
        )
        .await
        .expect("insert");
        tx.commit().await.expect("commit");
        ids.push(id);
        seqs.push(seq);
    }
    assert_eq!(seqs, vec![1, 2, 3], "inserts take strictly increasing seqs");

    // Update the first widget: a fresh seq, above every insert.
    let mut tx = pool.begin().await.expect("begin");
    let upd_seq = next_seq(&mut tx, COUNTER, "widgets").await.expect("next_seq");
    tx.execute(
        &format!("UPDATE {WIDGETS} SET label = $1, change_seq = $2 WHERE id = $3"),
        params!["w0-updated", upd_seq, ids[0]],
    )
    .await
    .expect("update");
    tx.commit().await.expect("commit");
    assert_eq!(upd_seq, 4, "update seq climbs past the inserts");

    // Delete the second widget: a seq, then a tombstone, in one transaction.
    let mut tx = pool.begin().await.expect("begin");
    let del_seq = next_seq(&mut tx, COUNTER, "widgets").await.expect("next_seq");
    tx.execute(
        &format!("DELETE FROM {WIDGETS} WHERE id = $1"),
        params![ids[1]],
    )
    .await
    .expect("delete");
    record_tombstone(&mut tx, TOMBS, ids[1], owner, del_seq)
        .await
        .expect("tombstone");
    tx.commit().await.expect("commit");
    assert_eq!(del_seq, 5, "delete seq is above the last live seq");

    // Full pull from the start: widget2 (seq 3, live), widget0 (seq 4, live,
    // updated), widget1 (seq 5, tombstone), in seq order.
    let all = changes_since(pool, WIDGETS, TOMBS, owner, 0, 100)
        .await
        .expect("changes_since 0");
    let shape: Vec<(Uuid, i64, bool)> =
        all.iter().map(|c| (c.id, c.change_seq, c.deleted)).collect();
    assert_eq!(
        shape,
        vec![(ids[2], 3, false), (ids[0], 4, false), (ids[1], 5, true)],
        "delta is ordered by seq and unifies live rows with tombstones"
    );

    // Pull from a cursor past the untouched insert: only the update and the
    // tombstone remain.
    let tail = changes_since(pool, WIDGETS, TOMBS, owner, 3, 100)
        .await
        .expect("changes_since 3");
    let tail_shape: Vec<(Uuid, bool)> = tail.iter().map(|c| (c.id, c.deleted)).collect();
    assert_eq!(tail_shape, vec![(ids[0], false), (ids[1], true)], "cursor filters seq <= 3");

    // `touch`: bump a live parent to a fresh seq (the portable no-op-bump
    // replacement). widget2 is still live at seq 3; touching it lifts it above
    // the tombstone and returns exactly one matched row.
    let mut tx = pool.begin().await.expect("begin");
    let (touch_seq, matched) = touch(&mut tx, WIDGETS, COUNTER, "widgets", "id", ids[2])
        .await
        .expect("touch");
    tx.commit().await.expect("commit");
    assert_eq!(matched, 1, "touch matched the parent row");
    assert_eq!(touch_seq, 6, "touch takes the next seq");
    let after = changes_since(pool, WIDGETS, TOMBS, owner, 5, 100)
        .await
        .expect("changes_since after touch");
    assert_eq!(after.len(), 1);
    assert_eq!((after[0].id, after[0].change_seq, after[0].deleted), (ids[2], 6, false));
}

/// K tasks each take M sequences concurrently; the union must be exactly the
/// contiguous range `1..=K*M` - no duplicate (two writers never share a seq)
/// and no gap.
async fn exercise_concurrency(pool: &DbPool) {
    reset_tables(pool).await;
    const K: usize = 8;
    const M: usize = 25;

    let mut handles = Vec::new();
    for _ in 0..K {
        let p = pool.clone();
        handles.push(tokio::spawn(async move {
            let mut mine = Vec::with_capacity(M);
            for _ in 0..M {
                mine.push(next_seq_on_pool(&p, COUNTER, "widgets").await.expect("next_seq"));
            }
            mine
        }));
    }

    let mut all = Vec::new();
    for h in handles {
        all.extend(h.await.expect("join"));
    }
    all.sort_unstable();
    let expected: Vec<i64> = (1..=(K * M) as i64).collect();
    assert_eq!(all.len(), K * M);
    assert_eq!(all, expected, "concurrent increments are unique, monotonic and gapless");
}

/// One SQLite test rather than several: each `#[tokio::test]` spins up its own
/// multi-thread runtime, and several racing to open pools at once starved the
/// connect and timed out - a harness artifact, not a primitive fault. Running
/// the delta contract and the concurrency proof in sequence on one pool avoids
/// it; the concurrency proof still spawns real parallel tasks inside.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_delta_contract_and_concurrency() {
    let (pool, _dir) = sqlite_pool().await;
    exercise_delta(&pool).await;
    exercise_concurrency(&pool).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mysql_delta_and_concurrency() {
    let Ok(url) = std::env::var("KUBUNO_DB_MYSQL_URL") else {
        eprintln!(
            "SKIP mysql_delta_and_concurrency: set KUBUNO_DB_MYSQL_URL to a throwaway \
             MySQL/MariaDB database to run it"
        );
        return;
    };
    let pool = db::connect(&mysql_settings(url), SCHEMA).await.expect("connect mysql");
    exercise_delta(&pool).await;
    exercise_concurrency(&pool).await;
}
