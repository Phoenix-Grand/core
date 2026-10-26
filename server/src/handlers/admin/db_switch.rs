//! Admin console: switch a scope's database engine while keeping its data.
//!
//! "A scope" is the core's own database or one module's. Switching means copying
//! every row of that scope, table by table in foreign-key order, from the
//! current engine onto a freshly-migrated target on another engine, then
//! pointing the scope at the target. The copy engine ([`kubuno_db::copy_schema`])
//! is generic and type-preserving; this module is the orchestration and the
//! persisted progress a `core.db_migration_jobs` row records.
//!
//! ## Safety
//!
//! The source is never touched: it is read, the target is filled and verified,
//! and only then is the pointer moved (the config file for the core, the
//! `core.module_databases` override for a module). If the copy fails at any
//! point the source stays the reference, so a failed switch loses nothing.
//!
//! ## Why the core needs a restart
//!
//! Copying the core's own data happens while the core still runs on the source.
//! Adopting the target means reconnecting the process's own pool, which only a
//! restart does cleanly - so the core copy persists the new settings and reports
//! `restart_required`. The module copy restarts the module through the
//! supervisor and needs no core restart.

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

use crate::{
    audit::{redact::target, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    authz::AdminCtx,
    config::{DatabaseSettings, DbCredentials},
    errors::AppError,
    maintenance::{MaintenanceGuard, GLOBAL_SCOPE},
    modules::db_config,
    setup::config_file,
    state::AppState,
};
use kubuno_db::{params, Backend, DbPool, SchemaPrefix};

const ENGINES: [&str; 3] = ["postgres", "mysql", "sqlite"];

// ─────────────────────────────────────────────────────────────────────────────
// The target the operator supplies
// ─────────────────────────────────────────────────────────────────────────────

/// The destination engine/credentials. Mirrors the install wizard and the
/// per-module override form. Deliberately not `Debug`: it carries a password.
#[derive(Deserialize, Clone)]
pub struct TargetDto {
    engine: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: String,
    #[serde(default)]
    path: Option<String>,
}

impl TargetDto {
    pub(crate) fn validate(&self) -> Result<Backend, AppError> {
        let backend = Backend::parse(&self.engine)
            .filter(|_| ENGINES.contains(&self.engine.as_str()))
            .ok_or_else(|| AppError::Validation(format!("Unknown engine: {}", self.engine)))?;
        if backend != Backend::Sqlite {
            if self.host.trim().is_empty() {
                return Err(AppError::Validation("The target database host is required.".into()));
            }
            if self.user.trim().is_empty() {
                return Err(AppError::Validation("The target database user is required.".into()));
            }
        }
        Ok(backend)
    }

    fn default_port(&self) -> u16 {
        match Backend::parse(&self.engine) {
            Some(Backend::MySql) => 3306,
            _ => 5432,
        }
    }

    pub(crate) fn credentials(&self) -> DbCredentials {
        DbCredentials {
            engine:   self.engine.clone(),
            host:     self.host.trim().to_string(),
            port:     self.port.unwrap_or_else(|| self.default_port()),
            user:     self.user.trim().to_string(),
            password: self.password.clone(),
            database: self.database.trim().to_string(),
            path:     self.path.clone().unwrap_or_default(),
        }
    }

    /// Builds a target from concrete credentials, so a registered connection can
    /// drive the same copy path as an operator-typed form.
    pub(crate) fn from_credentials(creds: &DbCredentials) -> Self {
        TargetDto {
            engine:   creds.engine.clone(),
            host:     creds.host.clone(),
            port:     if creds.port == 0 { None } else { Some(creds.port) },
            user:     creds.user.clone(),
            password: creds.password.clone(),
            database: creds.database.clone(),
            path:     if creds.path.is_empty() { None } else { Some(creds.path.clone()) },
        }
    }
}

/// Builds engine-agnostic [`DatabaseSettings`] from credentials plus an optional
/// prefix, going through deserialization so it stays in step with the running
/// instance's own parsing.
pub(crate) fn settings_from(creds: &DbCredentials, prefix: &str) -> Result<DatabaseSettings, AppError> {
    let mut obj = json!({
        "engine": creds.engine,
        "max_connections": 4,
        "min_connections": 0,
        "connect_timeout": 10,
        "run_migrations": false,
    });
    let m = obj.as_object_mut().expect("json object");
    match Backend::parse(&creds.engine) {
        Some(Backend::Sqlite) => {
            let default = crate::config::paths::default_sqlite_dir();
            let dir = if creds.path.trim().is_empty() { default.as_str() } else { creds.path.trim() };
            m.insert("path".into(), json!(dir));
        }
        _ => {
            m.insert("host".into(), json!(creds.host));
            m.insert("port".into(), json!(creds.port));
            m.insert("user".into(), json!(creds.user));
            m.insert("password".into(), json!(creds.password));
            m.insert("database".into(), json!(creds.database));
        }
    }
    if !prefix.is_empty() {
        m.insert("schema_prefix".into(), json!(prefix));
    }
    serde_json::from_value(obj).map_err(|e| AppError::Internal(e.into()))
}

// ─────────────────────────────────────────────────────────────────────────────
// The persisted job
// ─────────────────────────────────────────────────────────────────────────────

/// One `core.db_migration_jobs` row.
#[derive(sqlx::FromRow, Clone)]
pub struct Job {
    pub id:            Uuid,
    pub scope:         String,
    pub source_engine: String,
    pub target_engine: String,
    pub status:        String,
    pub tables_total:  i32,
    pub tables_done:   i32,
    pub total_rows:    i64,
    pub copied_rows:   i64,
    pub current_table: String,
    pub error:         String,
}

pub(crate) fn job_json(j: &Job) -> Value {
    json!({
        "id":            j.id,
        "scope":         j.scope,
        "source_engine": j.source_engine,
        "target_engine": j.target_engine,
        "status":        j.status,
        "tables_total":  j.tables_total,
        "tables_done":   j.tables_done,
        "total_rows":    j.total_rows,
        "copied_rows":   j.copied_rows,
        "current_table": j.current_table,
        "error":         j.error,
    })
}

pub(crate) const JOB_COLS: &str = "id, scope, source_engine, target_engine, status, tables_total, \
                        tables_done, total_rows, copied_rows, current_table, error";

pub(crate) async fn create_job(db: &DbPool, scope: &str, source: &str, target: &str) -> Result<Uuid, AppError> {
    let id = Uuid::new_v4();
    db.execute(
        "INSERT INTO core.db_migration_jobs (id, scope, source_engine, target_engine, status) \
         VALUES ($1, $2, $3, $4, 'running')",
        params![id, scope, source, target],
    )
    .await
    .map_err(AppError::Database)?;
    Ok(id)
}

// Each placeholder appears once and in order: kubuno-db refuses a reused `$n` on
// every engine (MySQL/SQLite placeholders are positional), so a value needed
// twice is bound twice. `finish_ok` used to reuse `$1`/`$2`; the refusal was
// swallowed and every successful switch stayed "running" forever.

/// Progress of a running job. Guarded on `status = 'running'`: progress updates
/// are fire-and-forget tasks that can land after the job finished, and must not
/// overwrite its final figures.
const SET_PROGRESS_SQL: &str = "UPDATE core.db_migration_jobs \
        SET current_table = $1, tables_done = $2, copied_rows = $3 \
      WHERE id = $4 AND status = 'running'";

const FINISH_OK_SQL: &str = "UPDATE core.db_migration_jobs \
        SET status = 'succeeded', tables_total = $1, tables_done = $2, \
            total_rows = $3, copied_rows = $4, current_table = '' WHERE id = $5";

const FINISH_ERR_SQL: &str =
    "UPDATE core.db_migration_jobs SET status = 'failed', error = $1 WHERE id = $2";

pub(crate) async fn set_progress(db: &DbPool, id: Uuid, table: &str, tables_done: i32, copied: i64) {
    if let Err(e) = db.execute(SET_PROGRESS_SQL, params![table, tables_done, copied, id]).await {
        tracing::warn!(error = %e, "db_switch: mise à jour de la progression impossible");
    }
}

pub(crate) async fn finish_ok(db: &DbPool, id: Uuid, tables_total: i32, total_rows: i64) {
    if let Err(e) = db
        .execute(FINISH_OK_SQL, params![tables_total, tables_total, total_rows, total_rows, id])
        .await
    {
        tracing::error!(error = %e, job = %id, "db_switch: impossible de marquer la migration réussie");
    }
}

pub(crate) async fn finish_err(db: &DbPool, id: Uuid, message: &str) {
    if let Err(e) = db.execute(FINISH_ERR_SQL, params![message, id]).await {
        tracing::error!(error = %e, job = %id, "db_switch: impossible de marquer la migration en échec");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading jobs
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /admin/database/migration-jobs[?scope=…]`
pub async fn list_jobs(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("consultation des migrations de base de données")?;
    let jobs: Vec<Job> = state
        .db
        .fetch_all_as(
            &format!("SELECT {JOB_COLS} FROM core.db_migration_jobs ORDER BY created_at DESC"),
            params![],
        )
        .await
        .map_err(AppError::Database)?;
    Ok(Json(json!({ "jobs": jobs.iter().map(job_json).collect::<Vec<_>>() })))
}

/// `GET /admin/database/migration-jobs/:id`
pub async fn get_job(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("consultation des migrations de base de données")?;
    let job: Option<Job> = state
        .db
        .fetch_optional_as(
            &format!("SELECT {JOB_COLS} FROM core.db_migration_jobs WHERE id = $1"),
            params![id],
        )
        .await
        .map_err(AppError::Database)?;
    match job {
        Some(j) => Ok(Json(json!({ "job": job_json(&j) }))),
        None => Err(AppError::NotFound("Migration not found".into())),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The core main-database switch
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /admin/database/migrate` - copy the whole core database onto another
/// engine and persist the new settings; a core restart finalises it.
pub async fn migrate_core_database(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<TargetDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("migration de la base de données principale")?;
    let target_backend = dto.validate()?;
    ensure_switchable_config(target_backend)?;
    let source_engine = state.settings.database.engine.clone();

    let prefix_str = state
        .settings
        .database
        .schema_prefix
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let eff = SchemaPrefix::new(Some(&prefix_str))
        .map_err(AppError::Validation)?
        .schema("core");

    let creds = dto.credentials();
    let target_settings = settings_from(&creds, &prefix_str)?;

    // Preserve the connection we are leaving so it stays reachable from the
    // registry (best-effort: a registry hiccup must not block the switch).
    if let Ok(src_creds) = crate::config::settings::database_credentials(&state.settings.database) {
        let p = if prefix_str.is_empty() { None } else { Some(prefix_str.as_str()) };
        let _ = crate::modules::db_registry::register(
            &state.db, &state.settings.auth.jwt_secret,
            crate::modules::db_registry::CORE_SCOPE, &src_creds, p, None, true,
        ).await;
    }

    let job = create_job(&state.db, "core", &source_engine, &dto.engine).await?;

    // A global maintenance banner covers the whole copy: every connected user is
    // told the main database is migrating until this returns (or, if the finalising
    // restart cuts it short, until the startup sweep clears it).
    let guard = MaintenanceGuard::start(
        &state.db,
        &state.ws_hub,
        GLOBAL_SCOPE,
        format!(
            "Migrating the primary database ({source_engine} → {})…",
            dto.engine
        ),
        "migrate",
    )
    .await;

    // Everything after this point reports failure onto the job rather than
    // leaving the instance in a half state; the source is never modified.
    let result = do_core_copy(&state, &target_settings, &eff, job).await;
    let outcome: Result<Json<Value>, AppError> = match result {
        Ok((tables, rows)) => match persist_core_settings(&creds, target_backend) {
            Err(e) => {
                let msg = format!("Copy succeeded, but the configuration could not be written: {}", e.detail());
                finish_err(&state.db, job, &msg).await;
                record_core_switch(&audit, &state.db, &source_engine, &dto.engine, Err(&msg)).await;
                Err(e)
            }
            Ok(()) => {
                finish_ok(&state.db, job, tables, rows).await;
                // Record the adopted target as the scope's new current connection.
                let p = if prefix_str.is_empty() { None } else { Some(prefix_str.as_str()) };
                let _ = crate::modules::db_registry::register(
                    &state.db, &state.settings.auth.jwt_secret,
                    crate::modules::db_registry::CORE_SCOPE, &creds, p, None, true,
                ).await;
                tracing::warn!(from = %source_engine, to = %dto.engine, tables, rows,
                    "Base principale copiée vers le nouveau moteur - redémarrage du core requis");
                record_core_switch(
                    &audit, &state.db, &source_engine, &dto.engine, Ok((tables, rows)),
                ).await;
                Ok(Json(json!({
                    "job":              job_json(&fetch_job(&state.db, job).await?),
                    "restart_required": true,
                })))
            }
        },
        Err(e) => {
            let msg = e.detail();
            finish_err(&state.db, job, &msg).await;
            record_core_switch(&audit, &state.db, &source_engine, &dto.engine, Err(&msg)).await;
            Err(e)
        }
    };

    // Tears the banner down in every branch. A `Drop` on the guard is the fallback
    // if this line is somehow skipped (panic, cancellation).
    guard.finish().await;
    outcome
}

/// Writes the audit trail entry for a core database migration/switch. Best-effort
/// (a failed audit never turns a completed operation into a 500). `result` is the
/// `(tables, rows)` copied on success, or the failure cause on error.
async fn record_core_switch(
    audit: &AdminAudit,
    db: &DbPool,
    from_engine: &str,
    to_engine: &str,
    result: Result<(i32, i64), &str>,
) {
    let entry = AuditEntry::new("core.database.switch")
        .target(target::DATABASE, "core", "Base de données principale");
    let entry = match result {
        Ok((tables, rows)) => entry.detail(format!(
            "base principale migrée {from_engine}→{to_engine}, {tables} tables / {rows} lignes"
        )),
        Err(cause) => entry.failed(format!(
            "migration de la base principale {from_engine}→{to_engine} échouée : {cause}"
        )),
    };
    audit.record(db, entry).await;
}

/// Opens the target, migrates it, and copies the core schema onto it. Returns
/// `(tables, rows)`.
pub(crate) async fn do_core_copy(
    state: &AppState,
    target_settings: &DatabaseSettings,
    eff: &str,
    job: Uuid,
) -> Result<(i32, i64), AppError> {
    // The target pool. `connect` runs `ensure_schema`, so the namespace exists.
    let target = kubuno_db::connect(target_settings, "core")
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Connexion à la base cible impossible : {e}")))?;

    // The target must hold the core tables before a copy, and the core owns its
    // own migrations, so it can build them itself (unlike a module's).
    crate::database::migrations::run(&target)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Migrations sur la cible impossibles : {e:#}")))?;

    let db = state.db.clone();
    let mut done = 0i32;
    let report = kubuno_db::copy_schema(&state.db, eff, &target, eff, &mut |table, copied| {
        done += 1;
        let db = db.clone();
        let table = table.to_string();
        // Progress is best-effort and fire-and-forget so it never blocks the copy.
        tokio::spawn(async move {
            set_progress(&db, job, &table, done, copied).await;
        });
    })
    .await
    .map_err(map_admin_err)?;

    // Modules that inherit the core's database keep their data where it is: only
    // the core scope was copied. Pin each of them, on the target, to the database
    // it uses today, so after the restart it reopens its own data instead of a
    // fresh, empty schema on the new engine. Moving a module is its own switch.
    let pinned = pin_inheriting_modules(state, &target).await?;
    if !pinned.is_empty() {
        tracing::warn!(modules = ?pinned,
            "Modules épinglés sur leur base actuelle : migrez-les séparément vers le nouveau moteur");
    }

    // This very job was copied mid-flight ('running', a partial count). Write its
    // outcome on the target too, or the console of the adopted database would
    // show the switch that produced it as still running, forever.
    let (tables, rows) = (report.tables.len() as i32, report.total_rows);
    finish_ok(&target, job, tables, rows).await;

    Ok((tables, rows))
}

/// Writes, into `target`'s `core.module_databases`, an override for every module
/// that currently inherits the core's database, pointing at that same database.
/// Returns the ids pinned. A module that already has an enabled override keeps
/// it (it was copied with the rest of the core scope).
pub(crate) async fn pin_inheriting_modules(state: &AppState, target: &DbPool) -> Result<Vec<String>, AppError> {
    let ids: Vec<(String,)> = state
        .db
        .fetch_all_as("SELECT id FROM core.modules ORDER BY id", params![])
        .await
        .map_err(AppError::Database)?;
    let jwt = &state.settings.auth.jwt_secret;
    let mut pinned = Vec::new();
    for (id,) in ids {
        let resolved = db_config::resolve(&state.db, &state.settings.database, jwt, &id)
            .await
            .map_err(AppError::Internal)?;
        if resolved.overridden {
            continue;
        }
        let dto = TargetDto::from_credentials(&resolved.credentials);
        upsert_override_on(target, jwt, &id, &dto, resolved.schema_prefix.as_deref()).await?;
        pinned.push(id);
    }
    Ok(pinned)
}

pub(crate) fn map_admin_err(e: kubuno_db::AdminError) -> AppError {
    match e {
        kubuno_db::AdminError::Sqlx(err) => AppError::Database(err),
        other => AppError::Internal(anyhow::anyhow!(other.to_string())),
    }
}

pub(crate) async fn fetch_job(db: &DbPool, id: Uuid) -> Result<Job, AppError> {
    db.fetch_one_as(
        &format!("SELECT {JOB_COLS} FROM core.db_migration_jobs WHERE id = $1"),
        params![id],
    )
    .await
    .map_err(AppError::Database)
}

/// Writes the new engine and credentials into the running config file, mirroring
/// the install wizard's field layout (engine + discrete fields, or the SQLite
/// directory). The schema prefix is left as it was.
pub(crate) fn persist_core_settings(creds: &DbCredentials, backend: Backend) -> Result<(), AppError> {
    let target = config_file::target_path();
    if !config_file::is_writable(&target) {
        return Err(AppError::Internal(anyhow::anyhow!(
            "Le fichier de configuration {} n'est pas accessible en écriture.",
            target.display()
        )));
    }
    let mut assigns = vec![config_file::Assign::text("database", "engine", &creds.engine)];
    match backend {
        Backend::Sqlite => {
            let default = crate::config::paths::default_sqlite_dir();
            let dir = if creds.path.trim().is_empty() { default.as_str() } else { creds.path.trim() };
            assigns.push(config_file::Assign::text("database", "path", dir));
        }
        _ => {
            assigns.push(config_file::Assign::text("database", "host", creds.host.trim()));
            assigns.push(config_file::Assign::raw("database", "port", creds.port.to_string()));
            assigns.push(config_file::Assign::text("database", "user", creds.user.trim()));
            assigns.push(config_file::Assign::text("database", "password", &creds.password));
            assigns.push(config_file::Assign::text("database", "database", creds.database.trim()));
        }
    }
    let patched = config_file::patch(&config_file::source_text(&target), &assigns);
    // A `url` outranks the discrete fields (kubuno-db and the credentials handed to
    // the modules both read it first when present): left in place, it would keep
    // pointing the modules - and, depending on the fields, the core - at the
    // database being left.
    let patched = config_file::remove_key(&patched, "database", "url");
    config_file::write_atomic(&target, &patched).map_err(AppError::Internal)?;
    Ok(())
}

/// The `KV__DATABASE__*` variables that would outrank the configuration file a
/// switch rewrites (environment beats file), or `None` when there are none.
/// With such a variable set, the core would restart on the database it is
/// leaving, so a switch is refused before anything is copied.
pub(crate) fn database_pinned_by_env(target: Backend) -> Option<String> {
    database_env_overrides(target, |k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
}

fn database_env_overrides(target: Backend, is_set: impl Fn(&str) -> bool) -> Option<String> {
    // `PATH` is the SQLite directory: it only competes with a SQLite target.
    let keys: &[&str] = match target {
        Backend::Sqlite => &["KV__DATABASE__URL", "KV__DATABASE__ENGINE", "KV__DATABASE__PATH"],
        _ => &[
            "KV__DATABASE__URL", "KV__DATABASE__ENGINE", "KV__DATABASE__HOST", "KV__DATABASE__PORT",
            "KV__DATABASE__USER", "KV__DATABASE__PASSWORD", "KV__DATABASE__DATABASE",
        ],
    };
    let set: Vec<&str> = keys.iter().copied().filter(|k| is_set(k)).collect();
    if set.is_empty() {
        None
    } else {
        Some(set.join(", "))
    }
}

/// Refuses a core switch the restart could not honour (see [`database_pinned_by_env`]).
pub(crate) fn ensure_switchable_config(target: Backend) -> Result<(), AppError> {
    match database_pinned_by_env(target) {
        Some(vars) => Err(AppError::Validation(format!(
            "The primary database is set by the environment ({vars}), so switching would not take effect after a restart. Remove these variables or configure the database in the configuration file before migrating."
        ))),
        None => Ok(()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-module switch (with data copy)
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /admin/modules/:id/database/migrate` - point a module at another engine
/// AND carry its existing data across.
///
/// Unlike the core, the core cannot build a module's tables (its migrations live
/// in the module repo), so the target is populated by the module itself: the
/// override is stored, the module is restarted onto the empty target where it
/// self-migrates, and once its tables exist the data is copied from the old
/// database. The source database is left intact, so if anything fails the module
/// can be reverted to it with no loss.
pub async fn migrate_module_database(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<String>,
    Json(dto): Json<TargetDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("migration de la base de données d'un module")?;
    dto.validate()?;

    // Module must exist.
    let exists = state
        .db
        .fetch_optional_row("SELECT id FROM core.modules WHERE id = $1", params![id.clone()])
        .await
        .map_err(AppError::Database)?
        .is_some();
    if !exists {
        return Err(AppError::NotFound(format!("Module '{id}' not found")));
    }

    // The source (current) credentials, resolved BEFORE we change anything.
    let source = db_config::resolve(&state.db, &state.settings.database, &state.settings.auth.jwt_secret, &id)
        .await
        .map_err(AppError::Internal)?;
    let source_engine = source.credentials.engine.clone();
    let src_prefix = source.schema_prefix.clone();

    // Preserve the connection we are leaving so it stays reachable (best-effort).
    let _ = crate::modules::db_registry::register(
        &state.db, &state.settings.auth.jwt_secret, &id,
        &source.credentials, src_prefix.as_deref(), None, true,
    ).await;

    let job = create_job(&state.db, &id, &source_engine, &dto.engine).await?;

    // A banner scoped to this module covers the copy (which restarts the module).
    let guard = MaintenanceGuard::start(
        &state.db,
        &state.ws_hub,
        id.clone(),
        format!("Migration de la base du module {id} ({source_engine} → {}) en cours…", dto.engine),
        "migrate",
    )
    .await;

    let result = do_module_copy(&state, &id, &source, &dto, job).await;
    let outcome: Result<Json<Value>, AppError> = match result {
        Ok((tables, rows)) => {
            finish_ok(&state.db, job, tables, rows).await;
            // Record the adopted target as the module's new current connection.
            let _ = crate::modules::db_registry::register(
                &state.db, &state.settings.auth.jwt_secret, &id,
                &dto.credentials(), src_prefix.as_deref(), None, true,
            ).await;
            record_module_switch(
                &audit, &state.db, &id, &source_engine, &dto.engine, Ok((tables, rows)),
            ).await;
            Ok(Json(json!({
                "job":       job_json(&fetch_job(&state.db, job).await?),
                "restarted": true,
            })))
        }
        Err(e) => {
            let msg = e.detail();
            finish_err(&state.db, job, &msg).await;
            record_module_switch(&audit, &state.db, &id, &source_engine, &dto.engine, Err(&msg)).await;
            Err(e)
        }
    };

    guard.finish().await;
    outcome
}

/// Writes the audit trail entry for a module database migration/switch.
/// Best-effort. `result` is the `(tables, rows)` copied on success, or the cause
/// on failure.
async fn record_module_switch(
    audit: &AdminAudit,
    db: &DbPool,
    module_id: &str,
    from_engine: &str,
    to_engine: &str,
    result: Result<(i32, i64), &str>,
) {
    let entry = AuditEntry::new("core.module.database.change")
        .module(module_id)
        .target(target::DATABASE, module_id, format!("Base du module {module_id}"));
    let entry = match result {
        Ok((tables, rows)) => entry.detail(format!(
            "module {module_id} migré {from_engine}→{to_engine}, {tables} tables / {rows} lignes"
        )),
        Err(cause) => entry.failed(format!(
            "migration du module {module_id} {from_engine}→{to_engine} échouée : {cause}"
        )),
    };
    audit.record(db, entry).await;
}

/// Copies a module's data onto `dto` and leaves the module running there - or,
/// when anything fails, puts the module back exactly where it was. The copy
/// re-points the module at the target first, and a failure after that point
/// used to leave it there (stopped, or crash-looping on a half-built target)
/// although its data never left the source.
pub(crate) async fn do_module_copy(
    state: &AppState,
    module_id: &str,
    source: &db_config::Resolved,
    dto: &TargetDto,
    job: Uuid,
) -> Result<(i32, i64), AppError> {
    let previous_override = current_override(&state.db, module_id).await?;
    match do_module_copy_inner(state, module_id, source, dto, job).await {
        Ok(v) => Ok(v),
        Err(e) => {
            let restored = restore_override(&state.db, module_id, previous_override.as_ref()).await;
            let restarted =
                crate::modules::manager::restart_module(state.settings.clone(), state.db.clone(), module_id).await;
            tracing::warn!(module_id, restored = restored.is_ok(), restarted,
                "Migration du module échouée : module remis sur sa base source");
            match restored {
                Ok(()) => Err(e),
                Err(r) => Err(AppError::Internal(anyhow::anyhow!(
                    "{} ; et l'ancienne configuration du module n'a pas pu être rétablie : {}",
                    e.detail(),
                    r.detail()
                ))),
            }
        }
    }
}

async fn do_module_copy_inner(
    state: &AppState,
    module_id: &str,
    source: &db_config::Resolved,
    dto: &TargetDto,
    job: Uuid,
) -> Result<(i32, i64), AppError> {
    // Effective schema names carry the prefix each side declares.
    let src_prefix = source.schema_prefix.clone().unwrap_or_default();
    let src_eff = SchemaPrefix::new(Some(&src_prefix))
        .map_err(AppError::Validation)?
        .schema(module_id);
    // The target inherits the core's prefix unless the override carried its own;
    // here we keep the source prefix for the target so the schema name matches.
    let dst_eff = src_eff.clone();

    // Store the override so the module restarts onto the target and self-migrates.
    // The override carries the same prefix the copy uses, so the module creates
    // its tables at exactly the schema name the copy targets.
    let prefix_opt = if src_prefix.is_empty() { None } else { Some(src_prefix.as_str()) };
    upsert_module_override(state, module_id, dto, prefix_opt).await?;
    let restarted_at = chrono::Utc::now();
    let restarted =
        crate::modules::manager::restart_module(state.settings.clone(), state.db.clone(), module_id).await;
    if !restarted {
        return Err(AppError::Internal(anyhow::anyhow!(
            "Le module n'a pas pu être redémarré sur la base cible."
        )));
    }

    // Open both pools. `connect` needs a `'static` schema name; the module id is
    // owned, so leak it once (bounded, one per migration).
    let schema_static: &'static str = Box::leak(module_id.to_string().into_boxed_str());
    let target_settings = settings_from(&dto.credentials(), &src_prefix)?;
    let target = kubuno_db::connect(&target_settings, schema_static)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Connexion à la base cible impossible : {e}")))?;

    // Wait (bounded) for the module to finish migrating the target. Its first
    // table appears long before its last migration ends, and stopping it then
    // killed it mid-migration: on MySQL/MariaDB, whose DDL is not transactional,
    // the interrupted migration stayed "partially applied" and the module could
    // never start on the target again. A module registers with the core only
    // once its migrations are done, so its registration is the signal.
    wait_for_registration(state, module_id, restarted_at, Duration::from_secs(90)).await?;
    wait_for_tables(&target, &dst_eff, Duration::from_secs(45)).await?;

    // Quiesce the module for the copy, then reopen the source read side.
    crate::modules::manager::stop_module(module_id);
    let source_settings = settings_from(&source.credentials, &src_prefix)?;
    let source_pool = kubuno_db::connect(&source_settings, schema_static)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Connexion à la base source impossible : {e}")))?;

    let db = state.db.clone();
    let mut done = 0i32;
    let report = kubuno_db::copy_schema(&source_pool, &src_eff, &target, &dst_eff, &mut |table, copied| {
        done += 1;
        let db = db.clone();
        let table = table.to_string();
        tokio::spawn(async move { set_progress(&db, job, &table, done, copied).await; });
    })
    .await
    .map_err(map_admin_err)?;


    // Bring the module back up on the now-populated target.
    crate::modules::manager::restart_module(state.settings.clone(), state.db.clone(), module_id).await;
    Ok((report.tables.len() as i32, report.total_rows))
}

/// Stores (or updates) the module's database override so the supervisor starts
/// it on the target. Encrypts the password with the module-database key.
pub(crate) async fn upsert_module_override(
    state: &AppState,
    module_id: &str,
    dto: &TargetDto,
    prefix: Option<&str>,
) -> Result<(), AppError> {
    upsert_override_on(&state.db, &state.settings.auth.jwt_secret, module_id, dto, prefix).await
}

/// [`upsert_module_override`] against any core database - the running one, or a
/// switch target being prepared before the core adopts it.
pub(crate) async fn upsert_override_on(
    db: &DbPool,
    jwt_secret: &str,
    module_id: &str,
    dto: &TargetDto,
    prefix: Option<&str>,
) -> Result<(), AppError> {
    let creds = dto.credentials();
    let password_enc = db_config::encrypt_password(jwt_secret, &creds.password).map_err(AppError::Internal)?;
    let port_store: i32 = dto.port.map(i32::from).unwrap_or(0);
    let prefix_store = prefix.map(str::trim).filter(|p| !p.is_empty());
    let conflict = db.backend().upsert(
        "core.module_databases",
        &["module_id"],
        &[
            kubuno_db::dialect::Assign::Incoming("engine"),
            kubuno_db::dialect::Assign::Incoming("host"),
            kubuno_db::dialect::Assign::Incoming("port"),
            kubuno_db::dialect::Assign::Incoming("db_user"),
            kubuno_db::dialect::Assign::Incoming("password_enc"),
            kubuno_db::dialect::Assign::Incoming("db_name"),
            kubuno_db::dialect::Assign::Incoming("db_path"),
            kubuno_db::dialect::Assign::Incoming("schema_prefix"),
            kubuno_db::dialect::Assign::Incoming("enabled"),
        ],
    );
    let sql = format!(
        "INSERT INTO core.module_databases \
            (module_id, engine, host, port, db_user, password_enc, db_name, db_path, schema_prefix, enabled) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE){conflict}"
    );
    db.execute(
        &sql,
        params![
            module_id,
            creds.engine,
            creds.host.trim(),
            port_store,
            creds.user.trim(),
            password_enc,
            creds.database.trim(),
            creds.path.trim(),
            prefix_store,
        ],
    )
    .await
    .map_err(AppError::Database)?;
    Ok(())
}

/// The module's override row as stored (password still encrypted), if any.
pub(crate) async fn current_override(db: &DbPool, module_id: &str) -> Result<Option<db_config::ModuleDbRow>, AppError> {
    db.fetch_optional_as(
        "SELECT module_id, engine, host, port, db_user, password_enc, db_name, db_path, \
                schema_prefix, enabled \
           FROM core.module_databases WHERE module_id = $1",
        params![module_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, module_id, "db_switch: lecture de l'override du module");
        AppError::Database(e)
    })
}

/// Puts a module's override back to `previous` exactly (no row = the module
/// inherits the core's database again).
pub(crate) async fn restore_override(
    db: &DbPool,
    module_id: &str,
    previous: Option<&db_config::ModuleDbRow>,
) -> Result<(), AppError> {
    let Some(row) = previous else {
        db.execute("DELETE FROM core.module_databases WHERE module_id = $1", params![module_id])
            .await
            .map_err(AppError::Database)?;
        return Ok(());
    };
    db.execute(
        "UPDATE core.module_databases \
            SET engine = $1, host = $2, port = $3, db_user = $4, password_enc = $5, \
                db_name = $6, db_path = $7, schema_prefix = $8, enabled = $9 \
          WHERE module_id = $10",
        params![
            row.engine.as_str(),
            row.host.as_str(),
            row.port,
            row.db_user.as_str(),
            row.password_enc.as_str(),
            row.db_name.as_str(),
            row.db_path.as_str(),
            row.schema_prefix.as_deref(),
            row.enabled,
            module_id
        ],
    )
    .await
    .map_err(AppError::Database)?;
    Ok(())
}

/// Polls the registry until the module has registered with the core after
/// `since` - i.e. it started on its new database and finished migrating it.
pub(crate) async fn wait_for_registration(
    state: &AppState,
    module_id: &str,
    since: chrono::DateTime<chrono::Utc>,
    timeout: Duration,
) -> Result<(), AppError> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let registered = state
            .modules
            .read()
            .await
            .get(module_id)
            .is_some_and(|i| i.registered_at >= since);
        if registered {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(AppError::Internal(anyhow::anyhow!(
                "Le module ne s'est pas enregistré sur la base cible dans le délai imparti \
                 (migrations en échec ?) ; la copie est annulée et le module remis sur sa base \
                 source (les données source sont intactes)."
            )));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Polls the target schema until it holds at least one base table (the module
/// finished migrating) or the deadline passes.
pub(crate) async fn wait_for_tables(target: &DbPool, eff: &str, timeout: Duration) -> Result<(), AppError> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let count = count_tables(target, eff).await.unwrap_or(0);
        if count > 0 {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(AppError::Internal(anyhow::anyhow!(
                "Le module n'a pas créé ses tables sur la base cible dans le délai imparti ; \
                 la copie est annulée (les données source sont intactes)."
            )));
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }
}

pub(crate) async fn count_tables(pool: &DbPool, eff: &str) -> Result<i64, sqlx::Error> {
    match pool.backend() {
        Backend::Postgres | Backend::MySql => {
            pool.fetch_scalar::<i64>(
                "SELECT COUNT(*) FROM information_schema.tables \
                  WHERE table_schema = $1 AND table_type = 'BASE TABLE' \
                    AND table_name <> '_sqlx_migrations'",
                params![eff],
            )
            .await
        }
        Backend::Sqlite => {
            let sql = format!(
                "SELECT COUNT(*) FROM \"{}\".sqlite_master \
                   WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations'",
                eff.replace('"', "\"\"")
            );
            pool.fetch_scalar::<i64>(&sql, params![]).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kubuno_db::DbSettings;

    /// kubuno-db refuses a reused or out-of-order `$n` on every engine; a job
    /// statement that trips it fails silently at run time (the callers only log).
    #[test]
    fn env_pins_are_reported_per_target_engine() {
        let set = |names: &'static [&'static str]| move |k: &str| names.contains(&k);
        assert_eq!(database_env_overrides(Backend::MySql, set(&[])), None);
        // The SQLite directory does not compete with a MySQL target…
        assert_eq!(database_env_overrides(Backend::MySql, set(&["KV__DATABASE__PATH"])), None);
        // …but a URL always wins over the file.
        assert_eq!(
            database_env_overrides(Backend::MySql, set(&["KV__DATABASE__URL", "KV__DATABASE__PATH"])).as_deref(),
            Some("KV__DATABASE__URL")
        );
        assert_eq!(
            database_env_overrides(Backend::Sqlite, set(&["KV__DATABASE__PATH", "KV__DATABASE__HOST"])).as_deref(),
            Some("KV__DATABASE__PATH")
        );
    }

    #[test]
    fn job_statements_bind_each_placeholder_once() {
        for sql in [SET_PROGRESS_SQL, FINISH_OK_SQL, FINISH_ERR_SQL] {
            for backend in [Backend::Postgres, Backend::MySql, Backend::Sqlite] {
                assert!(
                    kubuno_db::sql::prepare(sql, backend).is_ok(),
                    "{backend:?} refuses: {sql}"
                );
            }
        }
    }

    async fn sqlite_core(dir: &std::path::Path) -> DbPool {
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

    /// A failed module switch puts the module's override back exactly as it was:
    /// the previous row (password blob included), or no row at all.
    #[tokio::test]
    async fn failed_module_switch_override_is_restored() {
        let dir = std::env::temp_dir().join(format!("kbswitch-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let db = sqlite_core(&dir).await;
        let jwt = "test-secret-long-enough-0123456789-0123456789";
        for id in ["withrow", "norow"] {
            db.execute(
                "INSERT INTO core.modules (id, display_name, version) VALUES ($1, $2, '0.0.1')",
                params![id, id],
            )
            .await
            .expect("module");
        }
        let pg = TargetDto::from_credentials(&DbCredentials {
            engine: "postgres".into(), host: "pg.example".into(), port: 5433, user: "u".into(),
            password: "old".into(), database: "kub".into(), path: String::new(),
        });
        upsert_override_on(&db, jwt, "withrow", &pg, Some("kub_")).await.expect("seed override");
        let before_with = current_override(&db, "withrow").await.expect("read");
        let before_none = current_override(&db, "norow").await.expect("read");
        assert!(before_with.is_some() && before_none.is_none());

        // What a switch does first: point both at the target.
        let my = TargetDto::from_credentials(&DbCredentials {
            engine: "mysql".into(), host: "127.0.0.1".into(), port: 3306, user: "k".into(),
            password: "new".into(), database: "k".into(), path: String::new(),
        });
        for id in ["withrow", "norow"] {
            upsert_override_on(&db, jwt, id, &my, None).await.expect("switch override");
        }

        restore_override(&db, "withrow", before_with.as_ref()).await.expect("restore");
        restore_override(&db, "norow", before_none.as_ref()).await.expect("restore");
        let after_with = current_override(&db, "withrow").await.expect("read").expect("row kept");
        let after_none = current_override(&db, "norow").await.expect("read");
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);

        let b = before_with.expect("row");
        assert_eq!(
            (after_with.engine, after_with.host, after_with.port, after_with.password_enc, after_with.schema_prefix),
            (b.engine, b.host, b.port, b.password_enc, b.schema_prefix)
        );
        assert!(after_none.is_none(), "a module that inherited inherits again");
    }

    /// A finished job reports its final figures, and a progress update that
    /// lands late (they are fire-and-forget) does not reopen or rewind it.
    #[tokio::test]
    async fn finished_job_is_succeeded_and_not_rewound_by_late_progress() {
        let dir = std::env::temp_dir().join(format!("kbswitch-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let db = sqlite_core(&dir).await;

        let id = create_job(&db, "core", "postgres", "mysql").await.expect("create job");
        set_progress(&db, id, "users", 3, 40).await;
        finish_ok(&db, id, 83, 6335).await;
        set_progress(&db, id, "late_table", 12, 99).await;

        let job = fetch_job(&db, id).await.expect("fetch job");
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(job.status, "succeeded");
        assert_eq!((job.tables_total, job.tables_done), (83, 83));
        assert_eq!((job.total_rows, job.copied_rows), (6335, 6335));
        assert_eq!(job.current_table, "");
    }
}
