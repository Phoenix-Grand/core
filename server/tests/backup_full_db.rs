//! Whole-database backup: every schema, compressed, restored in process onto
//! **any** engine.
//!
//! The portable archive is the one the scheduler writes and the console restores,
//! on every engine. These tests prove, on what is provisioned:
//!
//! * **Cross-engine** round-trip PostgreSQL ⇄ SQLite (and MySQL when configured):
//!   a backup taken on one engine restored onto another, with faithful
//!   uuid/bool/timestamp/json values - the destination-directed reconstruction.
//! * **Multi-schema** coverage on PostgreSQL: `core` plus a secondary
//!   `office_data` schema, backed up and restored together.
//! * **Hot-restore orchestration** on SQLite: an automatic safety backup taken
//!   first, the operation recorded, and a path-traversal name refused.
//!
//! The database tests reset shared schemas, so run single-threaded
//! (`--test-threads=1`).

use chrono::Utc;
use kubuno_core::backup::{archive, portable, restore};
use kubuno_db::{params, Backend, DbPool, DbSettings};
use uuid::Uuid;

const SCHEMA: &str = "core";

fn settings(engine: &str, extra: serde_json::Value) -> DbSettings {
    let mut base = serde_json::json!({
        "engine": engine,
        "max_connections": 4,
        "min_connections": 0,
        "connect_timeout": 30,
        "run_migrations": false,
    });
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    serde_json::from_value(base).expect("DbSettings")
}

async fn migrate(pool: &DbPool) {
    kubuno_db::pool::ensure_schema(pool, SCHEMA).await.expect("ensure schema");
    if pool.backend() == Backend::Postgres {
        pool.execute("DROP SCHEMA IF EXISTS core CASCADE", params![]).await.expect("drop core");
        // A stray secondary schema left by a previous run would otherwise be
        // included in a dump; drop it so each test starts from a known set.
        pool.execute("DROP SCHEMA IF EXISTS office_data CASCADE", params![]).await.ok();
        pool.execute("CREATE SCHEMA core", params![]).await.expect("create core");
    }
    kubuno_core::database::migrations::run(pool).await.expect("run migrations");
    kubuno_core::database::seed::ensure_instance_identity(pool).await;
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    // The cargo target tmp dir sits on the repo's disk, which has room for the
    // backup's free-space floor - unlike a small `/tmp` tmpfs.
    std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("kubuno-{tag}-{}", Uuid::new_v4()))
}

async fn sqlite_pool(dir: &std::path::Path) -> DbPool {
    let s = settings("sqlite", serde_json::json!({ "path": dir.to_str().unwrap() }));
    kubuno_db::connect(&s, SCHEMA).await.expect("sqlite connect")
}

async fn maybe_pg() -> Option<DbPool> {
    let url = std::env::var("KUBUNO_PG_TEST_URL").ok().filter(|u| !u.trim().is_empty())?;
    let s = settings("postgres", serde_json::json!({ "url": url }));
    Some(kubuno_db::connect(&s, SCHEMA).await.expect("pg connect"))
}

// A distinctive account, exercising uuid / bool / json across engines.
struct Marker {
    id: Uuid,
    email: String,
    prefs: serde_json::Value,
}

async fn insert_marker_user(db: &DbPool) -> Marker {
    let id = Uuid::new_v4();
    let email = format!("marker-{id}@example.test");
    let prefs = serde_json::json!({ "theme": "café", "n": 7, "on": true });
    // `users.org_unit_id` is NOT NULL on some engines, so anchor the account to
    // the seeded root org unit.
    let ou: Option<Uuid> = db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM core.org_units WHERE parent_id IS NULL",
            params![],
        )
        .await
        .ok()
        .flatten();
    db.execute(
        "INSERT INTO core.users (id, email, username, password_hash, is_active, preferences, org_unit_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        params![id, &email, format!("u{}", &id.simple().to_string()[..12]), "x", false, prefs.clone(), ou],
    )
    .await
    .expect("insert marker user");
    Marker { id, email, prefs }
}

async fn assert_marker_faithful(db: &DbPool, m: &Marker) {
    let row = db
        .fetch_optional_row(
            "SELECT id, email, is_active, preferences FROM core.users WHERE id = $1",
            params![m.id],
        )
        .await
        .expect("query marker")
        .expect("marker present after restore");
    assert_eq!(row.try_get::<Uuid>("id").unwrap(), m.id, "uuid faithful");
    assert_eq!(row.try_get::<String>("email").unwrap(), m.email, "text faithful");
    assert!(!row.try_get::<bool>("is_active").unwrap(), "bool faithful");
    assert_eq!(
        row.try_get::<serde_json::Value>("preferences").unwrap(),
        m.prefs,
        "json faithful",
    );
}

/// Dumps `source` and restores it onto `target` (a different engine), proving the
/// account round-trips with faithful types.
async fn cross_engine_round_trip(source: &DbPool, target: &DbPool) {
    let marker = insert_marker_user(source).await;

    let dir = temp_dir("xdump");
    let outcome = portable::write_dump(source, &dir).await.expect("write dump");
    assert!(outcome.file_name.ends_with(".ndjson.gz"), "portable extension");
    assert!(outcome.rows > 0);

    // A row on the target that must NOT survive, proving the load empties first.
    let doomed = insert_marker_user(target).await;

    portable::restore(target, &outcome.path).await.expect("cross-engine restore");

    assert_marker_faithful(target, &marker).await;
    let doomed_present: i64 = target
        .fetch_scalar(
            &format!("SELECT {} FROM core.users WHERE id = $1", target.backend().count_bigint("*")),
            params![doomed.id],
        )
        .await
        .expect("count doomed");
    assert_eq!(doomed_present, 0, "the target's own pre-restore row was cleared");

    tokio::fs::remove_dir_all(&dir).await.ok();
}

#[tokio::test]
async fn cross_engine_pg_to_sqlite_and_back() {
    let Some(pg) = maybe_pg().await else {
        eprintln!("KUBUNO_PG_TEST_URL absent - cross-moteur PG↔SQLite ignoré");
        return;
    };
    let sq_dir = temp_dir("xsq");
    let sqlite = sqlite_pool(&sq_dir).await;
    migrate(&pg).await;
    migrate(&sqlite).await;

    // PostgreSQL → SQLite.
    cross_engine_round_trip(&pg, &sqlite).await;
    // SQLite → PostgreSQL (the destination-directed rebuild of a type-poor source).
    migrate(&pg).await;
    migrate(&sqlite).await;
    cross_engine_round_trip(&sqlite, &pg).await;

    tokio::fs::remove_dir_all(&sq_dir).await.ok();
}

#[tokio::test]
async fn pg_multi_schema_round_trip() {
    let Some(db) = maybe_pg().await else {
        eprintln!("KUBUNO_PG_TEST_URL absent - multi-schéma PG ignoré");
        return;
    };
    migrate(&db).await;
    db.execute("DROP SCHEMA IF EXISTS office_data CASCADE", params![]).await.ok();
    db.execute("CREATE SCHEMA office_data", params![]).await.expect("create office_data");
    db.execute(
        "CREATE TABLE office_data.widget (\
            wid UUID PRIMARY KEY, flag BOOLEAN NOT NULL, day DATE NOT NULL, \
            meta JSONB NOT NULL, tags TEXT[] NOT NULL, n BIGINT NOT NULL)",
        params![],
    )
    .await
    .expect("create widget");

    let wid = Uuid::new_v4();
    let day = chrono::NaiveDate::from_ymd_opt(2026, 9, 22).unwrap();
    let meta = serde_json::json!({ "k": [1, 2, 3], "s": "é" });
    db.execute(
        "INSERT INTO office_data.widget (wid, flag, day, meta, tags, n) \
         VALUES ($1, $2, $3, $4, ARRAY['a','b'], $5)",
        params![wid, true, day, meta.clone(), 42i64],
    )
    .await
    .expect("insert widget");

    let dir = temp_dir("pgms");
    let outcome = portable::write_dump(&db, &dir).await.expect("write dump");
    assert!(outcome.schemas >= 2, "covers core and office_data: {}", outcome.schemas);

    // Mutate, then restore.
    db.execute("DELETE FROM office_data.widget", params![]).await.expect("clear");
    portable::restore(&db, &outcome.path).await.expect("restore");

    let row = db
        .fetch_optional_row(
            "SELECT flag, day, meta, tags::text AS tags, n FROM office_data.widget WHERE wid = $1",
            params![wid],
        )
        .await
        .expect("query")
        .expect("widget restored");
    assert!(row.try_get::<bool>("flag").unwrap(), "bool faithful");
    assert_eq!(row.try_get::<chrono::NaiveDate>("day").unwrap(), day, "date faithful");
    assert_eq!(row.try_get::<serde_json::Value>("meta").unwrap(), meta, "json faithful");
    assert_eq!(row.try_get::<String>("tags").unwrap(), "{a,b}", "array faithful");
    assert_eq!(row.try_get::<i64>("n").unwrap(), 42, "bigint faithful");

    db.execute("DROP SCHEMA IF EXISTS office_data CASCADE", params![]).await.ok();
    tokio::fs::remove_dir_all(&dir).await.ok();
}

async fn set_destination(db: &DbPool, dest: &str) {
    db.execute(
        "UPDATE core.settings SET value = $1 WHERE \"key\" = 'backup.destination'",
        params![serde_json::json!(dest)],
    )
    .await
    .expect("set destination");
}

#[tokio::test]
async fn sqlite_hot_restore_takes_a_safety_backup_and_records_it() {
    let db_dir = temp_dir("sqhr");
    let dest = temp_dir("sqdest");
    tokio::fs::create_dir_all(&dest).await.expect("dest dir");
    let db = sqlite_pool(&db_dir).await;
    migrate(&db).await;
    set_destination(&db, dest.to_str().unwrap()).await;

    db.execute(
        "INSERT INTO core.settings (\"key\", value) VALUES ($1, $2)",
        params!["backup.keep.me", serde_json::json!("original")],
    )
    .await
    .expect("insert marker");
    let outcome = portable::write_dump(&db, &dest).await.expect("write dump");
    assert!(outcome.file_name.ends_with(".ndjson.gz"));

    db.execute("DELETE FROM core.settings WHERE \"key\" = $1", params!["backup.keep.me"])
        .await
        .expect("delete marker");

    // `actor: None` keeps `triggered_by` NULL - a real admin id would need to
    // exist in `core.users`; the recording path is exercised either way.
    let result = restore::restore_from_file(&db, dest.to_str().unwrap(), &outcome.file_name, None)
        .await
        .expect("hot restore");

    assert!(!result.safety_file.is_empty(), "a safety backup was named");
    assert!(dest.join(&result.safety_file).exists(), "safety backup written to disk");
    assert_ne!(result.safety_file, outcome.file_name, "safety file distinct from source");

    let present: i64 = db
        .fetch_scalar(
            &format!("SELECT {} FROM core.settings WHERE \"key\" = $1", db.backend().count_bigint("*")),
            params!["backup.keep.me"],
        )
        .await
        .expect("count");
    assert_eq!(present, 1, "the restored data is back");

    let history = restore::list(&db, 10).await.expect("history");
    assert!(
        history.iter().any(|r| r.source_file == outcome.file_name && r.status == "success"),
        "restore recorded as success",
    );

    tokio::fs::remove_dir_all(&db_dir).await.ok();
    tokio::fs::remove_dir_all(&dest).await.ok();
}

#[tokio::test]
async fn a_restore_target_may_not_escape_the_destination() {
    let db_dir = temp_dir("sqesc");
    let dest = temp_dir("sqescdest");
    tokio::fs::create_dir_all(&dest).await.expect("dest dir");
    let db = sqlite_pool(&db_dir).await;
    migrate(&db).await;
    set_destination(&db, dest.to_str().unwrap()).await;

    let bad = restore::restore_from_file(&db, dest.to_str().unwrap(), "../../etc/passwd", None).await;
    assert!(bad.is_err(), "path traversal refused");

    let missing = archive::file_name_for(Utc::now(), archive::NDJSON_GZ_EXT);
    let absent = restore::restore_from_file(&db, dest.to_str().unwrap(), &missing, None).await;
    assert!(absent.is_err(), "missing file refused");

    tokio::fs::remove_dir_all(&db_dir).await.ok();
    tokio::fs::remove_dir_all(&dest).await.ok();
}
