//! Portability of the two pieces a non-PostgreSQL deployment could not do
//! before: the background-job queue and the event bus.
//!
//! * **Job queue** ([`kubuno_core::jobs::portable`]) - enqueue, the
//!   `rows_affected`-checked claim (the portable replacement for `FOR UPDATE
//!   SKIP LOCKED`), dedup scheduling, retry/give-up and stalled recovery.
//! * **Event bus** ([`kubuno_core::database::outbox`]) - an event written to
//!   `core.kubuno_event_outbox` by `kubuno_db::events::notify` is drained by the
//!   poller onto the in-process `EventBus`, exactly once.
//!
//! SQLite is embedded, so it always runs. PostgreSQL and MySQL/MariaDB run only
//! when `KUBUNO_PG_TEST_URL` / `KUBUNO_MYSQL_TEST_URL` are set; otherwise they
//! print a notice and are skipped (CI without a server must not turn red).

use std::time::Duration;

use chrono::{DateTime, Utc};
use kubuno_core::database::outbox::OutboxPoller;
use kubuno_core::events::{AppEvent, EventBus};
use kubuno_core::jobs::portable;
use kubuno_core::jobs::queue::{FailOutcome, NewJob};
use kubuno_core::jobs::Job;
use kubuno_db::{connect, params, Backend, DbPool, DbSettings};
use std::sync::Arc;
use uuid::Uuid;

const SCHEMA: &str = "core";

/// Builds a `DbSettings` from JSON (the section is normally deserialized from
/// config; `connect_timeout` is seconds).
fn settings(engine: &str, extra: serde_json::Value) -> DbSettings {
    let mut base = serde_json::json!({
        "engine": engine,
        "max_connections": 4,
        "min_connections": 0,
        "connect_timeout": 10,
        "run_migrations": false,
    });
    base.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(base).expect("DbSettings")
}

async fn sqlite_pool(dir: &std::path::Path) -> DbPool {
    let s = settings(
        "sqlite",
        serde_json::json!({ "path": dir.to_str().unwrap() }),
    );
    connect(&s, SCHEMA).await.expect("sqlite connect")
}

async fn maybe_pool(engine: &str, env: &str) -> Option<DbPool> {
    let url = std::env::var(env).ok().filter(|u| !u.trim().is_empty());
    match url {
        Some(url) => {
            let s = settings(engine, serde_json::json!({ "url": url }));
            match connect(&s, SCHEMA).await {
                Ok(p) => Some(p),
                Err(e) => panic!("{engine} connect ({env}) échoué: {e}"),
            }
        }
        None => {
            eprintln!("{env} absent - {engine} ignoré");
            None
        }
    }
}

/// Wipes the `core` namespace so the full migration set can run from scratch on
/// a shared server. PostgreSQL drops and recreates the schema (the migrator
/// wants it to exist before it makes `core._sqlx_migrations`); MySQL drops every
/// table it holds (FK checks off, out-of-order); SQLite uses a fresh file per
/// test, so there is nothing to reset.
async fn reset_schema(pool: &DbPool) {
    match pool.backend() {
        Backend::Postgres => {
            pool.execute("DROP SCHEMA IF EXISTS core CASCADE", params![])
                .await
                .expect("drop schema pg");
            pool.execute("CREATE SCHEMA core", params![])
                .await
                .expect("recreate schema pg");
        }
        Backend::MySql => {
            let p = pool.as_mysql().expect("mysql pool");
            // Session variables (SET FOREIGN_KEY_CHECKS=0) would not span the
            // pool's separate connections, so drop the tables in dependency
            // order the robust way: repeated passes, each dropping whatever no
            // longer has a dependant, until none remain.
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'core'",
            )
            .fetch_all(p)
            .await
            .expect("list core tables");
            let mut remaining: Vec<String> = rows.into_iter().map(|(t,)| t).collect();
            for _ in 0..16 {
                if remaining.is_empty() {
                    break;
                }
                let mut still = Vec::new();
                for t in &remaining {
                    if pool
                        .execute(&format!("DROP TABLE IF EXISTS `{t}`"), params![])
                        .await
                        .is_err()
                    {
                        still.push(t.clone());
                    }
                }
                remaining = still;
            }
            assert!(remaining.is_empty(), "core tables left after reset: {remaining:?}");
        }
        Backend::Sqlite => {}
    }
}

/// Brings the pool to the COMPLETE `core` schema by running the real migrator
/// (`kubuno_db::migrations!` over the 3 dialect directories), the same call the
/// server makes at boot. This exercises every consolidated MySQL/SQLite table
/// against a live engine, not just the two the queue/outbox tests drive.
async fn setup(pool: &DbPool) {
    kubuno_db::pool::ensure_schema(pool, SCHEMA)
        .await
        .expect("ensure schema");
    reset_schema(pool).await;
    kubuno_core::database::migrations::run(pool)
        .await
        .expect("run full core migrations");
    // The instance identity is minted in Rust after migrations on every engine
    // (PostgreSQL's migration seed makes this a no-op there).
    kubuno_core::database::seed::ensure_instance_identity(pool).await;
    // The event outbox is created at runtime (not by a migration) on engines
    // that have no LISTEN/NOTIFY; PostgreSQL uses pg_notify and needs none.
    if pool.backend() != Backend::Postgres {
        kubuno_db::events::ensure_outbox(pool, SCHEMA)
            .await
            .expect("ensure outbox");
    }
}

// ── Representative round-trips across the migrated schema ────────────────────

#[derive(sqlx::FromRow)]
struct UserRow {
    role: String,
    is_active: bool,
    #[sqlx(json)]
    preferences: serde_json::Value,
}

#[derive(sqlx::FromRow)]
struct TokenRow {
    is_legacy: bool,
    #[sqlx(json)]
    scopes: Vec<String>,
}

/// Drives one row through each of the main subsystems (org tree, users,
/// sessions, API tokens, modules, roles, rules, settings, audit) on whichever
/// engine the pool speaks, asserting UUID/BLOB keys, JSON columns, booleans,
/// enum CHECKs, timestamps and the BIGSERIAL/AUTO_INCREMENT read-back all
/// round-trip. Every identifier is random, so a shared server never collides.
async fn schema_round_trips(pool: &DbPool) {
    // A root org unit (parent_id NULL): reuse the one the PostgreSQL seed
    // migrations create, or make one where the schema carries no seed data yet.
    // Only ever one, so PostgreSQL's single-root partial UNIQUE is respected.
    let root: Uuid = match pool
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM core.org_units WHERE parent_id IS NULL",
            params![],
        )
        .await
        .expect("query root org unit")
    {
        Some(id) => id,
        None => {
            let id = Uuid::new_v4();
            pool.execute(
                "INSERT INTO core.org_units (id, name) VALUES ($1, $2)",
                params![id, "Root"],
            )
            .await
            .expect("insert root org_unit");
            id
        }
    };
    let ou = Uuid::new_v4();
    pool.execute(
        "INSERT INTO core.org_units (id, name, parent_id) VALUES ($1, $2, $3)",
        params![ou, format!("ou-{ou}"), root],
    )
    .await
    .expect("insert org_unit");

    // users: UUID pk, JSON preferences, enum-checked role, boolean, timestamps.
    let uid = Uuid::new_v4();
    pool.execute(
        "INSERT INTO core.users (id, email, username, password_hash, role, preferences, org_unit_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        params![
            uid,
            format!("u-{uid}@example.test"),
            format!("user-{uid}"),
            "argon2-hash",
            "admin",
            serde_json::json!({"theme": "dark", "count": 3}),
            ou
        ],
    )
    .await
    .expect("insert user");

    let u: UserRow = pool
        .fetch_one_as(
            "SELECT role, is_active, preferences FROM core.users WHERE id = $1",
            params![uid],
        )
        .await
        .expect("select user");
    assert_eq!(u.role, "admin", "enum-checked role round-trips");
    assert!(u.is_active, "boolean default TRUE round-trips");
    assert_eq!(u.preferences["count"], serde_json::json!(3), "JSON round-trips");

    // refresh_tokens (a session): FK to users, a real timestamp.
    let rt = Uuid::new_v4();
    let expires: DateTime<Utc> = Utc::now() + chrono::Duration::days(1);
    pool.execute(
        "INSERT INTO core.refresh_tokens (id, user_id, token_hash, expires_at) \
         VALUES ($1, $2, $3, $4)",
        params![rt, uid, format!("hash-{rt}"), expires],
    )
    .await
    .expect("insert refresh_token");

    // api_tokens: a JSON array column that the PostgreSQL CHECK
    // (jsonb_array_length(scopes) > 0) validates - proof the JSON binds right.
    let tid = Uuid::new_v4();
    pool.execute(
        "INSERT INTO core.api_tokens (id, user_id, name, token_hash, scopes) \
         VALUES ($1, $2, $3, $4, $5)",
        params![
            tid,
            uid,
            "ci-token",
            format!("th-{tid}"),
            vec!["core.mcp.execute".to_string(), "core.module_admin.execute".to_string()]
        ],
    )
    .await
    .expect("insert api_token");
    let tok: TokenRow = pool
        .fetch_one_as(
            "SELECT is_legacy, scopes FROM core.api_tokens WHERE id = $1",
            params![tid],
        )
        .await
        .expect("select api_token");
    assert!(!tok.is_legacy, "boolean default FALSE round-trips");
    assert_eq!(tok.scopes.len(), 2, "JSON array column round-trips");

    // modules: JSON dependencies array.
    let mid = format!("mod-{}", Uuid::new_v4());
    pool.execute(
        "INSERT INTO core.modules (id, display_name, version, dependencies) \
         VALUES ($1, $2, $3, $4)",
        params![
            mid.clone(),
            "Test Module",
            "1.0.0",
            vec!["core".to_string()]
        ],
    )
    .await
    .expect("insert module");

    // roles: unique slug (migrations seed a handful).
    let role_id = Uuid::new_v4();
    pool.execute(
        "INSERT INTO core.roles (id, slug, name) VALUES ($1, $2, $3)",
        params![role_id, format!("role-{role_id}"), "Test Role"],
    )
    .await
    .expect("insert role");

    // `key` is a reserved word on MySQL/MariaDB (but a plain identifier on
    // PostgreSQL and SQLite); back-tick it only there.
    let key_col = if pool.backend() == Backend::MySql {
        "`key`"
    } else {
        "key"
    };

    // rules: JSON conditions/actions carry their table defaults; trigger_key is
    // an FK to rule_triggers, so seed a trigger first (a real install's triggers
    // are declared by modules; the schema itself ships none).
    let trigger_key = format!("test.trigger.{}", Uuid::new_v4());
    pool.execute(
        &format!(
            "INSERT INTO core.rule_triggers ({key_col}, module_id, event_type, label) \
             VALUES ($1, $2, $3, $4)"
        ),
        params![trigger_key.clone(), "core", "auth.login.failed", "Test trigger"],
    )
    .await
    .expect("insert rule_trigger");
    let rule_id = Uuid::new_v4();
    pool.execute(
        "INSERT INTO core.rules (id, name, trigger_key) VALUES ($1, $2, $3)",
        params![rule_id, format!("rule-{rule_id}"), trigger_key],
    )
    .await
    .expect("insert rule");

    // settings + setting_values: JSON value and the composite PK. The value is
    // written at USER scope (scope_id = the user) rather than instance scope, so
    // it never collides with the row PostgreSQL's settings_value_redirect
    // trigger mirrors for the instance scope.
    let skey = format!("test.setting.{}", Uuid::new_v4());
    pool.execute(
        &format!("INSERT INTO core.settings ({key_col}, value) VALUES ($1, $2)"),
        params![skey.clone(), serde_json::json!({"enabled": true})],
    )
    .await
    .expect("insert setting");
    pool.execute(
        &format!(
            "INSERT INTO core.setting_values ({key_col}, scope_type, scope_id, value) \
             VALUES ($1, $2, $3, $4)"
        ),
        params![skey.clone(), "user", uid, serde_json::json!(42)],
    )
    .await
    .expect("insert setting_value");

    // admin_audit: BIGSERIAL / AUTO_INCREMENT id, read back by re-select (the
    // portable stand-in for RETURNING).
    let action = format!("test.action.{}", Uuid::new_v4());
    pool.execute(
        "INSERT INTO core.admin_audit (actor_label, action) VALUES ($1, $2)",
        params![format!("actor-{uid}"), action.clone()],
    )
    .await
    .expect("insert admin_audit");
    let audit_id: i64 = pool
        .fetch_scalar(
            "SELECT id FROM core.admin_audit WHERE action = $1",
            params![action],
        )
        .await
        .expect("select admin_audit id");
    assert!(audit_id > 0, "auto-increment id assigned");
}

// ── Chantier C: the portable job queue ──────────────────────────────────────

async fn exercise_jobs(pool: &DbPool) {
    let types = vec!["report".to_string()];

    // Enqueue two runnable jobs.
    let a = portable::enqueue(pool, NewJob::new("report").payload(serde_json::json!({"n": 1})))
        .await
        .unwrap();
    let _b = portable::enqueue(pool, NewJob::new("report").payload(serde_json::json!({"n": 2})))
        .await
        .unwrap();

    // Claim once: exactly one row flips to running, ordered oldest-first.
    let j1: Job = portable::claim(pool, &types).await.unwrap().expect("claim 1");
    assert_eq!(j1.id, a, "oldest job claimed first");
    assert_eq!(j1.attempts, 1, "attempt counted at claim");
    assert_eq!(j1.payload, serde_json::json!({"n": 1}), "payload round-trips");

    // The claimed row is no longer pending: a second claim gets the other one,
    // never the same row twice.
    let j2: Job = portable::claim(pool, &types).await.unwrap().expect("claim 2");
    assert_ne!(j2.id, j1.id, "no row is claimed twice");

    // Nothing runnable left.
    assert!(portable::claim(pool, &types).await.unwrap().is_none());

    // Complete one, fail the other with retries until it gives up.
    portable::complete(pool, j1.id).await.unwrap();

    let mut running = j2.clone();
    // attempts=1, max=3 → two retries then give up.
    match portable::fail(pool, &running, "boom").await.unwrap() {
        FailOutcome::Retry { attempts_left, .. } => assert_eq!(attempts_left, 2),
        FailOutcome::GaveUp => panic!("should retry"),
    }
    // Simulate the reclaim bumping attempts before the next failure.
    running.attempts = 3;
    assert_eq!(
        portable::fail(pool, &running, "boom again").await.unwrap(),
        FailOutcome::GaveUp
    );

    // Dedup scheduling: while a 'sweep' is pending, a second ensure is a no-op.
    let first = portable::ensure_scheduled(pool, NewJob::new("sweep"))
        .await
        .unwrap();
    assert!(first.is_some(), "first schedule inserts");
    let second = portable::ensure_scheduled(pool, NewJob::new("sweep"))
        .await
        .unwrap();
    assert!(second.is_none(), "duplicate schedule is refused");

    // Stalled recovery: a row stuck in 'running' past the cutoff is requeued.
    let stalled = portable::enqueue(pool, NewJob::new("stuck")).await.unwrap();
    let past = Utc::now() - chrono::Duration::hours(1);
    pool.execute(
        "UPDATE core.jobs SET status = 'running', started_at = $1, attempts = 1 WHERE id = $2",
        params![past, stalled],
    )
    .await
    .unwrap();
    let recovered = portable::requeue_stalled(pool, Duration::from_secs(60))
        .await
        .unwrap();
    assert!(recovered >= 1, "stalled row recovered");
    let status: String = pool
        .fetch_scalar("SELECT status FROM core.jobs WHERE id = $1", params![stalled])
        .await
        .unwrap();
    assert_eq!(status, "pending", "recovered back to pending");
}

// ── Chantier B: the outbox reader (event bus) ───────────────────────────────

async fn exercise_outbox(pool: &DbPool) {
    let bus = Arc::new(EventBus::new(64));
    let mut rx = bus.subscribe();
    let poller = OutboxPoller::new(pool.clone(), bus.clone());

    // Two real events written the way a background writer does.
    let uid = Uuid::new_v4();
    let ev = AppEvent::UserCreated {
        user_id: uid,
        email: "a@b.c".into(),
    };
    let payload = serde_json::to_string(&serde_json::json!({
        "event": ev, "meta": {},
    }))
    .unwrap();
    kubuno_db::events::notify(pool, SCHEMA, "kubuno_events", &payload)
        .await
        .unwrap();
    kubuno_db::events::notify(pool, SCHEMA, "kubuno_events", &payload)
        .await
        .unwrap();
    // A row on another channel: drained (marked delivered) but not published.
    kubuno_db::events::notify(pool, SCHEMA, "kubuno_jobs", "")
        .await
        .unwrap();

    let delivered = poller.drain_once().await.unwrap();
    assert_eq!(delivered, 3, "all three rows claimed");

    // Exactly the two events reached the bus.
    let mut seen = 0;
    while let Ok(env) = rx.try_recv() {
        match &env.event {
            AppEvent::UserCreated { user_id, .. } => assert_eq!(*user_id, uid),
            other => panic!("unexpected event: {other:?}"),
        }
        seen += 1;
    }
    assert_eq!(seen, 2, "only kubuno_events rows are published");

    // Exactly once: a second drain has nothing left.
    assert_eq!(poller.drain_once().await.unwrap(), 0, "nothing redelivered");
}

/// Asserts every catalog table the PostgreSQL migrations seed reaches the SAME
/// row count on whichever engine the pool speaks - proof that the consolidated
/// MySQL/SQLite schema ships the same seed data, not just the same tables. The
/// counts are the FINAL seeded state of PostgreSQL (after all migrations, some
/// of which delete or rewrite earlier seed rows), captured from a live dump.
async fn seed_counts(pool: &DbPool) {
    // (table, expected rows) - the FINAL PostgreSQL catalog.
    let expected: &[(&str, i64)] = &[
        ("settings", 158),
        ("privileges", 51),
        ("roles", 7),
        ("role_privileges", 52),
        ("setting_values", 19),
        ("user_groups", 3),
        ("target_audiences", 1),
        ("org_units", 1),
        ("content_detectors", 14),
        ("instance_identity", 1),
    ];
    for (table, want) in expected {
        let got: i64 = pool
            .fetch_scalar(
                &format!("SELECT COUNT(*) FROM core.{table}"),
                params![],
            )
            .await
            .unwrap_or_else(|e| panic!("count {table}: {e}"));
        assert_eq!(
            got, *want,
            "seed row count for core.{table} differs across engines",
        );
    }

    // Spot-check that the seed VALUES round-trip, not just the counts: a named
    // setting is reachable by its (reserved-word) `key`, a UUID-keyed role is
    // reachable by slug, and a role_privilege's FK resolves back to that role.
    let named_settings: i64 = pool
        .fetch_scalar(
            "SELECT COUNT(*) FROM core.settings WHERE \"key\" = $1",
            params!["instance.name"],
        )
        .await
        .expect("read seeded setting by key");
    assert_eq!(named_settings, 1, "seeded setting reachable by reserved `key`");

    // Every seeded role_privilege resolves to a seeded role: the cross-table FK
    // references survived the UUID → BINARY(16)/BLOB translation intact.
    let dangling: i64 = pool
        .fetch_scalar(
            "SELECT COUNT(*) FROM core.role_privileges rp \
             LEFT JOIN core.roles r ON r.id = rp.role_id WHERE r.id IS NULL",
            params![],
        )
        .await
        .expect("count dangling role_privileges");
    assert_eq!(dangling, 0, "every role_privilege FK resolves to a seeded role");

    // The `read-only-admin` role is seeded with its full read grant set.
    let ro_admin: Uuid = pool
        .fetch_scalar(
            "SELECT id FROM core.roles WHERE slug = $1",
            params!["read-only-admin"],
        )
        .await
        .expect("seeded read-only-admin role");
    let grants: i64 = pool
        .fetch_scalar(
            "SELECT COUNT(*) FROM core.role_privileges WHERE role_id = $1",
            params![ro_admin],
        )
        .await
        .expect("count read-only-admin grants");
    assert!(grants >= 1, "read-only-admin role has seeded privileges");

    // Handler round-trip on the reserved-word `key` column, written the way the
    // settings store does (double-quoted identifier, portable via ANSI_QUOTES on
    // MySQL). Uses a random user-scope key so a shared server never collides.
    let uid = Uuid::new_v4();
    let skey = format!("handler.key.{uid}");
    // A setting_value's `key` is an FK to settings.key, so define the setting
    // first (also a write through the reserved-word column).
    pool.execute(
        "INSERT INTO core.settings (\"key\", value) VALUES ($1, $2)",
        params![skey.clone(), serde_json::json!({"default": true})],
    )
    .await
    .expect("write setting by reserved `key`");
    pool.execute(
        "INSERT INTO core.setting_values (\"key\", scope_type, scope_id, value) \
         VALUES ($1, $2, $3, $4)",
        params![skey.clone(), "user", uid, serde_json::json!({"on": true})],
    )
    .await
    .expect("write setting_value by reserved `key`");
    let back: i64 = pool
        .fetch_scalar(
            "SELECT COUNT(*) FROM core.setting_values WHERE \"key\" = $1 AND scope_id = $2",
            params![skey.clone(), uid],
        )
        .await
        .expect("read setting_value by reserved `key`");
    assert_eq!(back, 1, "setting_value round-trips on the reserved `key` column");

    // Privileges are keyed by the reserved word too: read the seeded catalog the
    // way the authz catalog handler does.
    let priv_rows: i64 = pool
        .fetch_scalar(
            "SELECT COUNT(*) FROM core.privileges WHERE \"key\" IN ($1, $2)",
            params!["core.users.read", "core.users.create"],
        )
        .await
        .expect("read privileges by reserved `key`");
    assert_eq!(priv_rows, 2, "seeded privileges reachable by reserved `key`");
}

/// Exercises the authorization/settings paths that used to run only on
/// PostgreSQL (they called stored `LANGUAGE sql`/plpgsql functions). Every
/// assertion runs against the live engine, so a recursive-CTE or dialect slip on
/// MySQL/SQLite fails here rather than in production.
async fn exercise_authz_settings(pool: &DbPool) {
    use kubuno_core::database::compat;
    let backend = pool.backend();

    // Build A → B under the existing root: root ─ A ─ B.
    let root: Uuid = pool
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM core.org_units WHERE parent_id IS NULL",
            params![],
        )
        .await
        .expect("query root")
        .expect("a root org unit exists after seeding");
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    pool.execute(
        "INSERT INTO core.org_units (id, name, parent_id) VALUES ($1, $2, $3)",
        params![a, format!("A-{a}"), root],
    )
    .await
    .expect("insert unit A");
    pool.execute(
        "INSERT INTO core.org_units (id, name, parent_id) VALUES ($1, $2, $3)",
        params![b, format!("B-{b}"), a],
    )
    .await
    .expect("insert unit B");

    // org_unit_descendants(A) = {A, B}, never the parent.
    let sql = format!("SELECT id FROM {} d", compat::org_unit_descendants(1));
    let desc: std::collections::HashSet<Uuid> = pool
        .fetch_all_as::<(Uuid,)>(&sql, params![a])
        .await
        .expect("descendants")
        .into_iter()
        .map(|(x,)| x)
        .collect();
    assert!(desc.contains(&a) && desc.contains(&b), "descendants include self and child");
    assert!(!desc.contains(&root), "descendants exclude the parent");

    // org_unit_ancestors(B) climbs B → A → root, nearest first.
    let sql = format!("SELECT id, depth FROM {} a ORDER BY depth", compat::org_unit_ancestors(1));
    let anc: Vec<(Uuid, i32)> = pool.fetch_all_as::<(Uuid, i32)>(&sql, params![b]).await.expect("ancestors");
    assert_eq!(anc.first().map(|(id, _)| *id), Some(b), "nearest ancestor is the unit itself");
    let anc_ids: std::collections::HashSet<Uuid> = anc.iter().map(|(x, _)| *x).collect();
    assert!(anc_ids.contains(&a) && anc_ids.contains(&root), "ancestors reach the root");

    // Multi-root walk tags each descendant with its root.
    let sql = format!("SELECT root, id FROM {} w", compat::org_unit_descendants_with_root(1, 1));
    let pairs: Vec<(Uuid, Uuid)> = pool.fetch_all_as::<(Uuid, Uuid)>(&sql, params![a]).await.expect("desc_with_root");
    assert!(pairs.iter().any(|(r, i)| *r == a && *i == b), "root A maps to descendant B");

    // A user placed in B, a super-user role granted at instance scope.
    let user = Uuid::new_v4();
    pool.execute(
        "INSERT INTO core.users (id, email, username, password_hash, role, org_unit_id) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        params![user, format!("az-{user}@x.test"), format!("az-{user}"), "h", "admin", b],
    )
    .await
    .expect("insert user");
    let su_role = Uuid::new_v4();
    pool.execute(
        "INSERT INTO core.roles (id, slug, name, is_superuser) VALUES ($1, $2, $3, $4)",
        params![su_role, format!("su-{su_role}"), "SU", true],
    )
    .await
    .expect("insert su role");
    pool.execute(
        "INSERT INTO core.role_assignments (id, role_id, subject_user_id, scope) \
         VALUES ($1, $2, $3, 'instance')",
        params![Uuid::new_v4(), su_role, user],
    )
    .await
    .expect("insert su assignment");

    // superadmin_ids lists that account.
    let sql = format!("SELECT user_id FROM {} s WHERE s.user_id = $1", compat::superadmin_ids(backend));
    let su: Option<Uuid> = pool.fetch_optional_scalar::<Uuid>(&sql, params![user]).await.expect("superadmin_ids");
    assert_eq!(su, Some(user), "the instance super-user is listed");

    // authz::context::resolve: a delegated grant scoped to A expands to A and B.
    let deleg = Uuid::new_v4();
    pool.execute(
        "INSERT INTO core.roles (id, slug, name) VALUES ($1, $2, $3)",
        params![deleg, format!("dg-{deleg}"), "Delegate"],
    )
    .await
    .expect("insert delegate role");
    pool.execute(
        "INSERT INTO core.role_privileges (role_id, privilege_key) VALUES ($1, $2)",
        params![deleg, "core.users.read"],
    )
    .await
    .expect("insert role_privilege");
    pool.execute(
        "INSERT INTO core.role_assignments (id, role_id, subject_user_id, scope, scope_org_unit_id) \
         VALUES ($1, $2, $3, 'org_unit', $4)",
        params![Uuid::new_v4(), deleg, user, a],
    )
    .await
    .expect("insert scoped assignment");
    let ctx = kubuno_core::authz::context::resolve(
        pool,
        user,
        kubuno_core::audit::ActorOrigin::Session,
        None,
    )
    .await
    .expect("resolve admin context");
    assert!(ctx.is_superuser, "the instance super-user role is recognised");
    let scope = ctx
        .privileges
        .get("core.users.read")
        .expect("the delegated privilege is present");
    assert!(
        scope.units.contains(&a) && scope.units.contains(&b),
        "an org-unit-scoped grant expands to the whole subtree"
    );

    // label_access: an owned label reads back as owner with management rights.
    let label = Uuid::new_v4();
    pool.execute(
        "INSERT INTO core.labels (id, owner_id, name) VALUES ($1, $2, $3)",
        params![label, user, format!("lbl-{label}")],
    )
    .await
    .expect("insert label");
    let sql = format!(
        "SELECT la.is_owner, la.can_manage FROM {} la WHERE la.label_id = $4",
        compat::label_access(backend, 1)
    );
    let acc: Option<(bool, bool)> = pool
        .fetch_optional_as::<(bool, bool)>(&sql, params![user, user, user, label])
        .await
        .expect("label_access");
    assert_eq!(acc, Some((true, true)), "the owner has full label access");

    // setting_chain (portable load_chain): default + instance + unit-A override,
    // resolved for the user in B.
    use kubuno_core::settings::chain;
    use kubuno_core::settings::scope::SettingScope;
    let skey = format!("test.authz.{}", Uuid::new_v4());
    pool.execute(
        "INSERT INTO core.settings (\"key\", value, default_value) VALUES ($1, $2, $3)",
        params![skey.clone(), serde_json::json!("dflt"), serde_json::json!("dflt")],
    )
    .await
    .expect("insert setting");
    pool.execute(
        "INSERT INTO core.setting_values (\"key\", scope_type, scope_id, value) \
         VALUES ($1, 'instance', $2, $3)",
        params![skey.clone(), Uuid::nil(), serde_json::json!("inst")],
    )
    .await
    .expect("insert instance value");
    pool.execute(
        "INSERT INTO core.setting_values (\"key\", scope_type, scope_id, value) \
         VALUES ($1, 'org_unit', $2, $3)",
        params![skey.clone(), a, serde_json::json!("unitA")],
    )
    .await
    .expect("insert org-unit value");
    let levels = chain::load_chain(pool, &skey, &SettingScope::user(user))
        .await
        .expect("load_chain");
    let types: std::collections::HashSet<&str> = levels.iter().map(|l| l.scope_type.as_str()).collect();
    assert!(types.contains("default"), "chain carries the factory default");
    assert!(types.contains("instance"), "chain carries the instance override");
    assert!(types.contains("org_unit"), "chain carries the unit-A override");
    // Ordered from most general to most specific.
    let specs: Vec<i32> = levels.iter().map(|l| l.specificity).collect();
    assert!(specs.windows(2).all(|w| w[0] <= w[1]), "chain is ordered by specificity: {specs:?}");

    // rules::store::resolve_subject: the user's unit chain and empty group set.
    let subject = kubuno_core::rules::store::resolve_subject(pool, user).await.expect("resolve_subject");
    assert_eq!(subject.org_unit_id, Some(b), "subject sits in unit B");
    assert!(
        subject.unit_chain.contains(&a) && subject.unit_chain.contains(&b) && subject.unit_chain.contains(&root),
        "subject unit chain climbs to the root: {:?}",
        subject.unit_chain
    );
}

/// Exercises the handler-level paths ported off PostgreSQL-only SQL: the
/// `update_me` dynamic typed UPDATE, the per-engine `FOR UPDATE` clause, the
/// data export assembled in Rust (former `json_agg`/`row_to_json` + `host()`),
/// the tamper-evident audit append (its id read back via `RETURNING`/
/// `LAST_INSERT_ID`), and the labels-browse access query (portable
/// `label_access` derived table + `ILIKE`).
async fn exercise_ported_paths(pool: &DbPool) {
    use kubuno_db::DbQueryBuilder;

    // The audit HMAC chain is process-wide: install the key once so the append
    // below links a row_hash rather than leaving the columns NULL.
    kubuno_core::audit::chain::init_audit_key("portability-test-internal-secret-key-xyz");

    // An org unit to hang the account on (`users.org_unit_id` is NOT NULL on the
    // consolidated schema): reuse the root that `schema_round_trips` created.
    let ou: Uuid = pool
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM core.org_units WHERE parent_id IS NULL",
            params![],
        )
        .await
        .expect("query root org unit")
        .expect("a root org unit exists");

    let uid = Uuid::new_v4();
    let uname = format!("u{}", &uid.simple().to_string()[..12]);
    pool.execute(
        "INSERT INTO core.users (id, email, username, password_hash, role, preferences, org_unit_id) \
         VALUES ($1, $2, $3, $4, 'user', $5, $6)",
        params![
            uid,
            format!("{uname}@ex.test"),
            uname.clone(),
            "x",
            serde_json::json!({ "a": 1 }),
            ou
        ],
    )
    .await
    .expect("insert export user");

    // ── update_me: the dynamic, per-column typed UPDATE (no inline casts) ──
    {
        let mut qb = DbQueryBuilder::new(pool.backend(), "UPDATE core.users SET ");
        qb.push("display_name = ").push_bind("Nom Porté".to_string());
        qb.push(", preferences = ")
            .push_bind(serde_json::json!({ "a": 2, "b": true }));
        qb.push(" WHERE id = ").push_bind(uid);
        let n = qb.execute(pool).await.expect("update_me-style update");
        assert_eq!(n, 1, "one row updated");
        let (name, prefs) = pool
            .fetch_optional_as::<(Option<String>, serde_json::Value)>(
                "SELECT display_name, preferences FROM core.users WHERE id = $1",
                params![uid],
            )
            .await
            .expect("read back updated user")
            .expect("user row present");
        assert_eq!(name.as_deref(), Some("Nom Porté"));
        assert_eq!(prefs["b"], serde_json::json!(true), "typed JSON bind wrote through");
    }

    // ── FOR UPDATE: the per-engine row lock clause (empty on SQLite) parses ──
    {
        let mut tx = pool.begin().await.expect("begin for-update tx");
        let fu = pool.backend().for_update();
        let got = tx
            .fetch_optional_scalar::<Uuid>(
                &format!("SELECT id FROM core.users WHERE id = $1{fu}"),
                params![uid],
            )
            .await
            .expect("locked select");
        assert_eq!(got, Some(uid));
        tx.commit().await.expect("commit for-update tx");
    }

    // ── data export: assembled in Rust, incl. host(ip_address) ──
    {
        // A session so account_devices reads a row through `inet_text`.
        let rt = Uuid::new_v4();
        pool.execute(
            "INSERT INTO core.refresh_tokens (id, user_id, token_hash, expires_at) \
             VALUES ($1, $2, $3, $4)",
            params![
                rt,
                uid,
                format!("hash-{rt}"),
                Utc::now() + chrono::Duration::days(1)
            ],
        )
        .await
        .expect("insert refresh token");

        let profile = kubuno_core::data_export::core_data::account_profile(pool, uid)
            .await
            .expect("account_profile");
        assert_eq!(profile["profil"]["username"], serde_json::json!(uname));
        assert!(profile["groupes"].is_array());

        let devices = kubuno_core::data_export::core_data::account_devices(pool, uid)
            .await
            .expect("account_devices");
        assert_eq!(devices.as_array().map(|a| a.len()), Some(1), "the one session");

        let accounts = kubuno_core::data_export::core_data::instance_accounts(pool)
            .await
            .expect("instance_accounts");
        assert!(accounts.as_array().is_some_and(|a| !a.is_empty()));

        let groups = kubuno_core::data_export::core_data::instance_groups(pool)
            .await
            .expect("instance_groups");
        assert!(groups.is_array(), "groups assembled with their membres");

        let settings = kubuno_core::data_export::core_data::instance_settings(pool)
            .await
            .expect("instance_settings");
        assert!(settings.is_array());

        kubuno_core::data_export::core_data::instance_org_units(pool)
            .await
            .expect("instance_org_units");
    }

    // ── audit append + read-back (RETURNING / LAST_INSERT_ID) ──
    {
        let ctx = kubuno_core::audit::model::AuditContext::system("Portability test");
        let atx = ctx.begin(pool).await.expect("begin audit tx");
        let id = atx
            .commit(
                kubuno_core::audit::model::AuditEntry::new("core.test.append")
                    .module("core")
                    .after(serde_json::json!({ "k": 1 })),
            )
            .await
            .expect("audit append committed with an engine-assigned id");
        let (action, has_hash) = pool
            .fetch_optional_as::<(String, bool)>(
                "SELECT action, (row_hash IS NOT NULL) FROM core.admin_audit WHERE id = $1",
                params![id],
            )
            .await
            .expect("read the appended audit row")
            .expect("audit row present at its id");
        assert_eq!(action, "core.test.append");
        assert!(has_hash, "the HMAC chain linked a row_hash");
    }

    // ── labels browse: portable label_access derived table + ILIKE ──
    {
        let lid = Uuid::new_v4();
        pool.execute(
            "INSERT INTO core.labels (id, owner_id, name) VALUES ($1, $2, $3)",
            params![lid, uid, format!("lbl-{lid}")],
        )
        .await
        .expect("insert label");
        let link = Uuid::new_v4();
        pool.execute(
            "INSERT INTO core.label_links \
                 (id, label_id, owner_id, module, resource_type, resource_id, title) \
             VALUES ($1, $2, $3, 'drive', 'file', $4, 'Titre')",
            params![link, lid, uid, format!("res-{link}")],
        )
        .await
        .expect("insert label link");

        let la = kubuno_core::database::compat::label_access(pool.backend(), 1);
        let sql = format!(
            "SELECT k.label_id, k.owner_id \
               FROM core.label_links k \
               JOIN {la} a ON a.label_id = k.label_id \
              WHERE (k.owner_id = $4 OR a.can_manage) AND {ilike}",
            la = la,
            ilike = pool.backend().ilike("k.title", 5),
        );
        let rows = pool
            .fetch_all_as::<(Uuid, Uuid)>(
                &sql,
                params![uid, uid, uid, uid, "%Titre%".to_string()],
            )
            .await
            .expect("labels browse access query");
        assert!(
            rows.iter().any(|(l, o)| *l == lid && *o == uid),
            "own label link is visible through the browse access query"
        );
    }

    // ── domains: per-domain account count via the portable email split ──
    {
        let duid = Uuid::new_v4();
        let dun = format!("d{}", &duid.simple().to_string()[..12]);
        pool.execute(
            "INSERT INTO core.users (id, email, username, password_hash, role, preferences, org_unit_id) \
             VALUES ($1, $2, $3, 'x', 'user', $4, $5)",
            params![
                duid,
                format!("{dun}@dom-probe.test"),
                dun.clone(),
                serde_json::json!({}),
                ou
            ],
        )
        .await
        .expect("insert domain-probe user");

        let did = Uuid::new_v4();
        pool.execute(
            "INSERT INTO core.domains (id, name, kind, verify_token, created_by) \
             VALUES ($1, 'dom-probe.test', 'secondary', $2, $3)",
            params![did, format!("tok{}", did.simple()), duid],
        )
        .await
        .expect("insert probe domain");

        let domains = kubuno_core::domains::store::list(pool)
            .await
            .expect("list domains with account counts");
        let probe = domains
            .iter()
            .find(|d| d.name == "dom-probe.test")
            .expect("the probe domain is listed");
        assert_eq!(
            probe.account_count, 1,
            "the one account at dom-probe.test is counted through email_domain()"
        );
    }

    // ── admin stats: the daily sign-up series, buckets generated in Rust ──
    {
        let series = kubuno_core::handlers::admin::users::daily_series(
            pool,
            "core.users",
            "created_at",
            14,
        )
        .await
        .expect("daily sign-up series");
        assert_eq!(series.len(), 14, "one zero-filled bucket per day over the window");
        let total: i64 = series.iter().map(|(_, c)| *c).sum();
        assert!(total >= 1, "the accounts just inserted fall in today's bucket");
        let today = Utc::now().date_naive().format("%Y-%m-%d").to_string();
        assert_eq!(
            series.last().map(|(d, _)| d.as_str()),
            Some(today.as_str()),
            "the series ends on today's UTC calendar day"
        );
    }

    // ── audit drill-down: portable cell truncation + instant + inet_text ──
    {
        // `core.admin_audit` is append-only (a trigger forbids UPDATE on
        // PostgreSQL), so the oversized reason is written at append time: 300
        // characters, past the 200-char clip the reader applies in Rust.
        let long = "z".repeat(300);
        let ctx = kubuno_core::audit::model::AuditContext::system("Portability drill-down");
        let atx = ctx.begin(pool).await.expect("begin drill-down audit tx");
        atx.commit(
            kubuno_core::audit::model::AuditEntry::new("core.test.detail")
                .module("core")
                .detail(long),
        )
        .await
        .expect("append an audit row with an oversized reason");

        let columns = kubuno_core::handlers::admin::detail::for_table("core.admin_audit")
            .expect("audit detail catalogue");
        let counted = kubuno_core::handlers::admin::period::Counted::rows(
            "core.admin_audit",
            "occurred_at",
            "TRUE",
        );
        let win = kubuno_core::handlers::admin::period::resolve_window(
            "last_7_days",
            chrono_tz::Tz::UTC,
        );
        let table = kubuno_core::handlers::admin::detail::read(pool, &counted, &win, columns, "test")
            .await
            .expect("drill-down read across engines");

        // The first column of every row is the instant, formatted in Rust as `…Z`.
        let a_row = table
            .rows
            .iter()
            .find(|r| r.first().and_then(|c| c.as_ref()).is_some())
            .expect("at least one detail row");
        assert!(
            a_row[0].as_ref().unwrap().ends_with('Z'),
            "the instant is formatted in Rust, not by to_char"
        );
        // The `reason` column (`t.detail`) is index 5 (when, action, actor,
        // target, outcome, reason): our stretched row is clipped to exactly 200.
        let clipped = table.rows.iter().any(|r| {
            r.get(5)
                .and_then(|c| c.as_deref())
                .is_some_and(|s| s.chars().count() == 200 && s.chars().all(|c| c == 'z'))
        });
        assert!(clipped, "an oversized cell is clipped to MAX_CELL characters in Rust");

        // The DEVICE and RULE catalogues build a label with `CONCAT_WS`; confirm
        // the engine supports it (SQLite gained it in 3.44; the bundled build is
        // newer), so those drill-downs read on every engine too.
        let cc: String = pool
            .fetch_scalar::<String>("SELECT CONCAT_WS('-', 'a', 'b')", params![])
            .await
            .expect("CONCAT_WS available on this engine");
        assert_eq!(cc, "a-b");
    }

    // ── audiences: reach via correlated COUNT(DISTINCT … CASE join) ──
    {
        // A second active account, and a group holding both it and `uid`.
        let other = Uuid::new_v4();
        let oname = format!("g{}", &other.simple().to_string()[..12]);
        pool.execute(
            "INSERT INTO core.users (id, email, username, password_hash, role, preferences, org_unit_id) \
             VALUES ($1, $2, $3, 'x', 'user', $4, $5)",
            params![
                other,
                format!("{oname}@ex.test"),
                oname.clone(),
                serde_json::json!({}),
                ou
            ],
        )
        .await
        .expect("insert second audience account");

        let gid = Uuid::new_v4();
        pool.execute(
            "INSERT INTO core.user_groups (id, name, description, permissions, is_default, release_exempt) \
             VALUES ($1, $2, NULL, $3, $4, $5)",
            params![gid, format!("aud-grp-{gid}"), serde_json::json!([]), false, false],
        )
        .await
        .expect("insert audience group");
        for m in [uid, other] {
            pool.execute(
                "INSERT INTO core.user_group_members (group_id, user_id) VALUES ($1, $2)",
                params![gid, m],
            )
            .await
            .expect("add group member");
        }

        let aud = Uuid::new_v4();
        pool.execute(
            "INSERT INTO core.target_audiences (id, name, description, created_by) \
             VALUES ($1, $2, NULL, $3)",
            params![aud, format!("aud-{aud}"), uid],
        )
        .await
        .expect("insert audience");
        // One user member (also in the group) and one group member: reach must
        // count `uid` once though two entries resolve to it.
        pool.execute(
            "INSERT INTO core.target_audience_members (audience_id, member_type, member_id, added_by) \
             VALUES ($1, 'user', $2, $3)",
            params![aud, uid, uid],
        )
        .await
        .expect("add user member");
        pool.execute(
            "INSERT INTO core.target_audience_members (audience_id, member_type, member_id, added_by) \
             VALUES ($1, 'group', $2, $3)",
            params![aud, gid, uid],
        )
        .await
        .expect("add group member entry");

        let sql = format!(
            "SELECT member_count, reach, applied_to FROM ({}) s WHERE id = $1",
            kubuno_core::handlers::admin::audiences::LIST_SQL,
        );
        let (member_count, reach, applied_to): (i64, i64, i64) = pool
            .fetch_optional_as::<(i64, i64, i64)>(&sql, params![aud])
            .await
            .expect("audience reach query across engines")
            .expect("the audience row is present");
        assert_eq!(member_count, 2, "two entries: one user, one group");
        assert_eq!(
            reach, 2,
            "reach counts uid once though it is both a direct member and in the group"
        );
        assert_eq!(applied_to, 0, "the audience is applied nowhere yet");
    }

    // ── rekey: the JSON-string round-trip of the settings-backed secret store ──
    {
        let backend = pool.backend();
        // Store a text value as a JSON string the way `security:rekey` writes the
        // SMTP password (`json_string`), then read it back unwrapped
        // (`json_text`) - the two constructs that had no portable spelling.
        let key = format!("mail.smtp_password.probe.{}", Uuid::new_v4());
        let write = format!(
            "INSERT INTO core.settings (\"key\", value) VALUES ($1, {})",
            backend.json_string(2),
        );
        pool.execute(&write, params![key.clone(), "sealed-ciphertext".to_string()])
            .await
            .expect("write a JSON-string secret");

        let read = format!(
            "SELECT {} FROM core.settings WHERE \"key\" = $1",
            backend.json_text("value", &[]),
        );
        let back: String = pool
            .fetch_scalar::<String>(&read, params![key.clone()])
            .await
            .expect("read the JSON-string secret back");
        assert_eq!(
            back, "sealed-ciphertext",
            "json_string/json_text round-trip (rekey settings store)"
        );

        // Rewrite it, exactly as the rekey UPDATE does.
        let update = format!(
            "UPDATE core.settings SET value = {} WHERE \"key\" = $2",
            backend.json_string(1),
        );
        pool.execute(&update, params!["resealed".to_string(), key.clone()])
            .await
            .expect("rewrite the JSON-string secret");
        let back2: String = pool
            .fetch_scalar::<String>(&read, params![key])
            .await
            .expect("read the rewritten secret");
        assert_eq!(back2, "resealed", "the rewritten secret reads back");
    }
}

async fn run_all(pool: &DbPool) {
    setup(pool).await;
    seed_counts(pool).await;
    schema_round_trips(pool).await;
    exercise_authz_settings(pool).await;
    exercise_jobs(pool).await;
    // The transactional outbox is the fallback for engines WITHOUT
    // `LISTEN`/`NOTIFY`: on PostgreSQL `kubuno_db::events::notify` publishes with
    // `pg_notify` and writes no outbox row, so the poller has nothing to drain
    // (that path is covered by the `PgListener` reader). Exercise the outbox
    // only where it is actually the delivery mechanism.
    if pool.backend() != Backend::Postgres {
        exercise_outbox(pool).await;
    }
    // Last: it appends an audit row whose fact-event writes an outbox row, which
    // would otherwise be counted by `exercise_outbox`'s exact-count assertion.
    exercise_ported_paths(pool).await;
}

#[tokio::test]
async fn sqlite_end_to_end() {
    let dir = tempdir();
    let pool = sqlite_pool(&dir).await;
    run_all(&pool).await;
}

#[tokio::test]
async fn postgres_end_to_end() {
    if let Some(pool) = maybe_pool("postgres", "KUBUNO_PG_TEST_URL").await {
        run_all(&pool).await;
    }
}

#[tokio::test]
async fn mysql_end_to_end() {
    if let Some(pool) = maybe_pool("mysql", "KUBUNO_MYSQL_TEST_URL").await {
        run_all(&pool).await;
    }
}

/// A throwaway directory for the SQLite files, removed on drop.
struct TempDir(std::path::PathBuf);
impl std::ops::Deref for TempDir {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn tempdir() -> TempDir {
    let p = std::env::temp_dir().join(format!("kubuno-core-dbport-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&p).unwrap();
    TempDir(p)
}
