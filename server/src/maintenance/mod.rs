//! Maintenance notices - a permanent banner shown to every connected user for
//! the whole duration of a database maintenance operation (engine switch,
//! schema-prefix change, backup restore, module database change/switch/sync).
//!
//! ## How it stays consistent
//!
//! An operation opens a [`MaintenanceGuard`] before its real work and closes it
//! with [`finish`](MaintenanceGuard::finish) in **every** branch - success and
//! error alike. The guard:
//!
//!   - on creation: inserts a row in `core.maintenance_notices` and broadcasts a
//!     `maintenance` / `start` WebSocket message to every connected client;
//!   - on `finish()`: deletes the row and broadcasts `maintenance` / `end`;
//!   - on `Drop` without a prior `finish()` (an early return, a panic, a
//!     cancelled task): a best-effort background cleanup removes the row and
//!     broadcasts `end`, so a banner never outlives the work it announces.
//!
//! The WebSocket messages are the real-time channel; `/api/v1/config` carries
//! the same active notices as a fallback for a client that (re)loads while an
//! operation runs (see [`active`]).
//!
//! Because a finalisation can be cut short by a process restart (a core engine
//! switch ends by restarting the service), the core also sweeps stale notices at
//! startup (see [`sweep_stale`]): every `global` notice still present belongs to
//! an operation a restart interrupted, and any notice older than
//! [`STALE_AFTER_MINUTES`] is likewise abandoned.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use kubuno_db::{new_id, params, DbPool};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::websocket::hub::{WsHub, WsMessage};

/// Scope value for an operation that affects the whole instance.
pub const GLOBAL_SCOPE: &str = "global";

/// WebSocket message type carrying maintenance start/end events.
const WS_TYPE: &str = "maintenance";

/// A notice still present at startup and older than this is considered abandoned
/// by a process that died mid-operation, and is swept away.
const STALE_AFTER_MINUTES: i64 = 30;

/// One active maintenance notice, as served by `/api/v1/config` and read back
/// from `core.maintenance_notices`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct MaintenanceNotice {
    pub id: Uuid,
    /// `"global"` (whole instance) or a module id (that module only).
    pub scope: String,
    pub message: String,
    pub kind: String,
    pub started_at: DateTime<Utc>,
}

/// The notices currently active, newest first - the fallback the shell reads on
/// (re)load. Never fails the caller: on a database error it logs and returns an
/// empty list, so `/api/v1/config` still serves.
pub async fn active(db: &DbPool) -> Vec<MaintenanceNotice> {
    match db
        .fetch_all_as::<MaintenanceNotice>(
            "SELECT id, scope, message, kind, started_at \
               FROM core.maintenance_notices ORDER BY started_at DESC",
            params![],
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(error = %e, "maintenance: lecture des avis actifs impossible");
            Vec::new()
        }
    }
}

/// Removes notices left behind by an operation whose process died before it
/// could finish (a restart during a core engine switch, a panic that skipped
/// `Drop`). Runs once at startup, best-effort - a failure here never blocks the
/// boot.
///
/// Every `global` notice present at startup is cleared unconditionally: such a
/// notice can only have been opened by a process that is no longer this one, so
/// its operation has already ended (typically by the very restart we are booting
/// from). Any notice - module-scoped included - older than
/// [`STALE_AFTER_MINUTES`] is cleared too.
pub async fn sweep_stale(db: &DbPool) {
    // The cutoff is expressed as a server-side `NOW() - INTERVAL` in the engine's
    // own spelling rather than a bound value: on SQLite the column is TEXT and its
    // default is `strftime(...)`, so comparing it against a Rust-bound timestamp
    // (which sqlx encodes with a different separator) would compare unlike text.
    // `interval_before` produces the same representation the column stores.
    let cutoff = db
        .backend()
        .interval_before(STALE_AFTER_MINUTES as u32, kubuno_db::dialect::Unit::Minute);
    let sql = format!(
        "DELETE FROM core.maintenance_notices WHERE scope = $1 OR started_at < {cutoff}"
    );
    match db.execute(&sql, params![GLOBAL_SCOPE]).await {
        Ok(n) if n > 0 => {
            tracing::warn!(count = n, "maintenance: {n} avis périmé(s) balayé(s) au démarrage")
        }
        Ok(_) => {}
        Err(e) => {
            tracing::error!(error = %e, "maintenance: balayage des avis périmés impossible")
        }
    }
}

/// RAII guard that keeps a maintenance banner up for the duration of an
/// operation. Create it with [`start`](Self::start) before the work and call
/// [`finish`](Self::finish) in every branch. If it is dropped without `finish`
/// (an early return, a panic, a cancelled task), a best-effort background
/// cleanup tears the notice down anyway.
pub struct MaintenanceGuard {
    db: DbPool,
    ws: Arc<WsHub>,
    id: Uuid,
    scope: String,
    finished: bool,
}

impl MaintenanceGuard {
    /// Opens a notice: INSERT the row + broadcast `start`. Best-effort - a
    /// failure to record the notice is logged but never blocks the operation it
    /// announces, and the guard is returned regardless so the caller's control
    /// flow is unchanged.
    ///
    /// `scope` is [`GLOBAL_SCOPE`] for an instance-wide operation, or a module id
    /// for a per-module one. `message` is shown verbatim to every user, so it
    /// must never carry a secret. `kind` is a short machine tag (e.g. `migrate`,
    /// `restore`, `switch`).
    pub async fn start(
        db: &DbPool,
        ws: &Arc<WsHub>,
        scope: impl Into<String>,
        message: impl Into<String>,
        kind: impl Into<String>,
    ) -> Self {
        let id = new_id();
        let scope = scope.into();
        let message = message.into();
        let kind = kind.into();

        if let Err(e) = db
            .execute(
                "INSERT INTO core.maintenance_notices (id, scope, message, kind) \
                 VALUES ($1, $2, $3, $4)",
                params![id, &scope, &message, &kind],
            )
            .await
        {
            tracing::error!(error = %e, scope = %scope, "maintenance: ouverture d'un avis impossible");
        }

        ws.broadcast(WsMessage {
            r#type: WS_TYPE.to_string(),
            module: scope_module(&scope),
            payload: json!({
                "action": "start",
                "id": id,
                "scope": scope,
                "message": message,
                "kind": kind,
            }),
        })
        .await;

        Self {
            db: db.clone(),
            ws: Arc::clone(ws),
            id,
            scope,
            finished: false,
        }
    }

    /// Closes the notice: DELETE the row + broadcast `end`. Call it in every
    /// success and error branch. Consumes the guard, so the `Drop` fallback then
    /// does nothing.
    pub async fn finish(mut self) {
        self.finished = true;
        remove_notice(&self.db, self.id).await;
        broadcast_end(&self.ws, self.id, &self.scope).await;
    }
}

impl Drop for MaintenanceGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        // Reached only when `finish` was skipped (early return, panic, cancelled
        // task). `Drop` cannot await, so the teardown is spawned best-effort onto
        // the runtime; the banner is removed as soon as it runs. The startup
        // sweep is the final safety net should even this be lost.
        let db = self.db.clone();
        let ws = Arc::clone(&self.ws);
        let id = self.id;
        let scope = std::mem::take(&mut self.scope);
        tokio::spawn(async move {
            remove_notice(&db, id).await;
            broadcast_end(&ws, id, &scope).await;
        });
    }
}

/// `None` for the global scope (banner shown for the whole instance), the module
/// id otherwise (banner shown on that module only).
fn scope_module(scope: &str) -> Option<String> {
    if scope == GLOBAL_SCOPE {
        None
    } else {
        Some(scope.to_string())
    }
}

async fn remove_notice(db: &DbPool, id: Uuid) {
    if let Err(e) = db
        .execute(
            "DELETE FROM core.maintenance_notices WHERE id = $1",
            params![id],
        )
        .await
    {
        tracing::error!(error = %e, notice_id = %id, "maintenance: clôture d'un avis impossible");
    }
}

async fn broadcast_end(ws: &WsHub, id: Uuid, scope: &str) {
    ws.broadcast(WsMessage {
        r#type: WS_TYPE.to_string(),
        module: scope_module(scope),
        payload: json!({
            "action": "end",
            "id": id,
            "scope": scope,
        }),
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::query::{self, AuditQuery};
    use crate::audit::{redact::target, ActorOrigin, AuditActor, AuditContext, AuditEntry};
    use kubuno_db::DbSettings;
    use std::path::{Path, PathBuf};

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kbmaint-{name}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// A migrated SQLite pool in a throwaway directory - the portable engine that
    /// runs everywhere, so these tests need no external server.
    async fn sqlite_pool(dir: &Path) -> DbPool {
        let settings: DbSettings = serde_json::from_value(serde_json::json!({
            "engine": "sqlite",
            "path": dir.to_str().expect("utf-8 path"),
            "max_connections": 2,
            "min_connections": 0,
            "connect_timeout": 10,
            "run_migrations": false,
        }))
        .expect("db settings");
        let pool = kubuno_db::connect(&settings, "core").await.expect("connect sqlite");
        crate::database::migrations::run(&pool).await.expect("migrations");
        pool
    }

    fn empty_query() -> AuditQuery {
        AuditQuery {
            actor_id: None,
            action: None,
            target_type: None,
            outcome: None,
            from: None,
            to: None,
            q: None,
            limit: Some(10),
            cursor: None,
        }
    }

    // ── Part A: the maintenance guard and the /config fallback ──────────────────

    #[tokio::test]
    async fn guard_posts_then_lifts_the_notice() {
        let dir = tmp_dir("guard");
        let pool = sqlite_pool(&dir).await;
        let ws = Arc::new(WsHub::new());

        assert!(active(&pool).await.is_empty(), "no notice before start");

        let guard =
            MaintenanceGuard::start(&pool, &ws, GLOBAL_SCOPE, "Migration en cours…", "migrate").await;

        // INSERT visible - this is exactly what `/config` serves.
        let notices = active(&pool).await;
        assert_eq!(notices.len(), 1, "one active notice after start");
        assert_eq!(notices[0].scope, GLOBAL_SCOPE);
        assert_eq!(notices[0].message, "Migration en cours…");
        assert_eq!(notices[0].kind, "migrate");

        guard.finish().await;

        // DELETE visible - the banner lifts on its own.
        assert!(active(&pool).await.is_empty(), "notice lifted after finish()");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn notice_is_scoped_module_vs_global() {
        let dir = tmp_dir("scope");
        let pool = sqlite_pool(&dir).await;
        let ws = Arc::new(WsHub::new());

        let global = MaintenanceGuard::start(&pool, &ws, GLOBAL_SCOPE, "Instance", "restore").await;
        let module = MaintenanceGuard::start(&pool, &ws, "drive", "Module drive", "switch").await;

        let notices = active(&pool).await;
        assert_eq!(notices.len(), 2);
        assert!(notices.iter().any(|n| n.scope == GLOBAL_SCOPE));
        assert!(notices.iter().any(|n| n.scope == "drive"));

        // Lifting the module notice leaves the global one untouched.
        module.finish().await;
        let after = active(&pool).await;
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].scope, GLOBAL_SCOPE);

        global.finish().await;
        assert!(active(&pool).await.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn sweep_clears_stale_and_global_but_keeps_a_fresh_module_notice() {
        let dir = tmp_dir("sweep");
        let pool = sqlite_pool(&dir).await;

        // A stale module notice (older than the cutoff) - an operation a crash
        // abandoned. `started_at` is written in the exact text shape the column
        // stores (the SQLite default), so the sweep's comparison is like-for-like.
        let stale = new_id();
        let old = (Utc::now() - chrono::Duration::minutes(STALE_AFTER_MINUTES + 5))
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string();
        pool.execute(
            "INSERT INTO core.maintenance_notices (id, scope, message, kind, started_at) \
             VALUES ($1, $2, $3, $4, $5)",
            params![stale, "drive", "abandoned", "switch", old],
        )
        .await
        .unwrap();

        // A fresh GLOBAL notice - left by an operation that ended with a restart.
        let global = new_id();
        pool.execute(
            "INSERT INTO core.maintenance_notices (id, scope, message, kind) VALUES ($1, $2, $3, $4)",
            params![global, GLOBAL_SCOPE, "left by restart", "migrate"],
        )
        .await
        .unwrap();

        // A fresh MODULE notice - a live operation from another process (kept).
        let fresh = new_id();
        pool.execute(
            "INSERT INTO core.maintenance_notices (id, scope, message, kind) VALUES ($1, $2, $3, $4)",
            params![fresh, "mail", "fresh module op", "switch"],
        )
        .await
        .unwrap();

        assert_eq!(active(&pool).await.len(), 3);

        sweep_stale(&pool).await;

        let remaining = active(&pool).await;
        assert_eq!(remaining.len(), 1, "only the fresh module notice survives: {remaining:?}");
        assert_eq!(remaining[0].scope, "mail");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A migrated pool on the shared PostgreSQL test database, or `None` when the
    /// server is not configured (the test then skips, printing why).
    async fn pg_pool_if_configured() -> Option<DbPool> {
        let url = std::env::var("KUBUNO_PG_TEST_URL").ok().filter(|u| !u.trim().is_empty())?;
        let settings: DbSettings = serde_json::from_value(serde_json::json!({
            "engine": "postgres",
            "url": url,
            "max_connections": 2,
            "min_connections": 0,
            "connect_timeout": 10,
            "run_migrations": false,
        }))
        .expect("pg settings");
        let pool = kubuno_db::connect(&settings, "core").await.expect("connect pg");
        crate::database::migrations::run(&pool).await.expect("pg migrations");
        Some(pool)
    }

    #[tokio::test]
    async fn guard_and_sweep_on_postgres_when_configured() {
        let Some(pool) = pg_pool_if_configured().await else {
            eprintln!("KUBUNO_PG_TEST_URL absent - test PG ignoré");
            return;
        };
        let ws = Arc::new(WsHub::new());
        // Start from a clean slate on the shared test database.
        pool.execute("DELETE FROM core.maintenance_notices", params![]).await.unwrap();

        // Guard posts then lifts, with module-vs-global scoping.
        let g = MaintenanceGuard::start(&pool, &ws, GLOBAL_SCOPE, "Migration en cours…", "migrate").await;
        let m = MaintenanceGuard::start(&pool, &ws, "drive", "Module drive", "switch").await;
        assert_eq!(active(&pool).await.len(), 2);
        m.finish().await;
        let after = active(&pool).await;
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].scope, GLOBAL_SCOPE);
        g.finish().await;
        assert!(active(&pool).await.is_empty());

        // Sweep on native timestamptz: stale + global cleared, fresh module kept.
        let stale = new_id();
        let old = Utc::now() - chrono::Duration::minutes(STALE_AFTER_MINUTES + 5);
        pool.execute(
            "INSERT INTO core.maintenance_notices (id, scope, message, kind, started_at) \
             VALUES ($1, $2, $3, $4, $5)",
            params![stale, "drive", "abandoned", "switch", old],
        )
        .await
        .unwrap();
        let global = new_id();
        pool.execute(
            "INSERT INTO core.maintenance_notices (id, scope, message, kind) VALUES ($1, $2, $3, $4)",
            params![global, GLOBAL_SCOPE, "left by restart", "migrate"],
        )
        .await
        .unwrap();
        let fresh = new_id();
        pool.execute(
            "INSERT INTO core.maintenance_notices (id, scope, message, kind) VALUES ($1, $2, $3, $4)",
            params![fresh, "mail", "fresh module op", "switch"],
        )
        .await
        .unwrap();
        assert_eq!(active(&pool).await.len(), 3);

        sweep_stale(&pool).await;

        let remaining = active(&pool).await;
        assert_eq!(remaining.len(), 1, "only the fresh module notice survives: {remaining:?}");
        assert_eq!(remaining[0].scope, "mail");

        // Leave the shared database as we found it.
        pool.execute("DELETE FROM core.maintenance_notices", params![]).await.unwrap();
    }

    // ── Part B: a sensitive operation writes a correct audit entry ──────────────

    fn test_ctx() -> AuditContext {
        AuditContext {
            actor: AuditActor {
                // No id keeps the row free of the users FK in this isolated test;
                // the denormalised label is what the trail actually shows.
                id: None,
                label: "Administrateur de test <admin@kubuno.local>".to_string(),
                role: Some("admin".to_string()),
                origin: ActorOrigin::Session,
                token_id: None,
            },
            ip: Some("203.0.113.7".parse().expect("ip")),
            user_agent: Some("kubuno-tests/1.0".to_string()),
        }
    }

    #[tokio::test]
    async fn audit_records_a_success_with_a_summary_detail() {
        let dir = tmp_dir("audit-ok");
        let pool = sqlite_pool(&dir).await;
        crate::audit::chain::init_audit_key("test-internal-secret-value-0123456789");

        let ctx = test_ctx();
        let id = ctx
            .record(
                &pool,
                AuditEntry::new("core.database.switch")
                    .target(target::DATABASE, "core", "Base de données principale")
                    .detail("base principale migrée postgres→sqlite, 42 tables / 12345 lignes"),
            )
            .await;
        assert!(id.is_some(), "audit row written");

        let page = query::list(&pool, &empty_query()).await.expect("list");
        let row = page.rows.first().expect("one audit row");
        assert_eq!(row.action, "core.database.switch");
        assert_eq!(row.module_id.as_deref(), Some("core"));
        assert_eq!(row.target_type.as_deref(), Some("database"));
        assert_eq!(row.target_id.as_deref(), Some("core"));
        assert_eq!(row.outcome, "success");
        assert!(
            row.detail.as_deref().unwrap_or("").contains("42 tables / 12345 lignes"),
            "detail summarises the change: {:?}",
            row.detail
        );
        // Who / where are captured by the context.
        assert!(row.actor_label.contains("admin@kubuno.local"));
        assert_eq!(row.ip_address.as_deref(), Some("203.0.113.7"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn audit_records_a_failure_with_cause_in_detail() {
        let dir = tmp_dir("audit-fail");
        let pool = sqlite_pool(&dir).await;
        crate::audit::chain::init_audit_key("test-internal-secret-value-0123456789");

        let ctx = test_ctx();
        ctx.record(
            &pool,
            AuditEntry::new("core.database.restore")
                .target(target::DATABASE, "core", "Restauration depuis backup.ndjson.gz")
                .failed("restauration à chaud depuis « backup.ndjson.gz » échouée : disque plein"),
        )
        .await;

        let mut q = empty_query();
        q.outcome = Some("error".to_string());
        let page = query::list(&pool, &q).await.expect("list");
        let row = page.rows.first().expect("one failed audit row");
        assert_eq!(row.action, "core.database.restore");
        assert_eq!(row.outcome, "error");
        assert!(
            row.detail.as_deref().unwrap_or("").contains("disque plein"),
            "failure detail names the cause: {:?}",
            row.detail
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
