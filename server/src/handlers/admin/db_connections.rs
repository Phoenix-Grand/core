//! Admin console: the registry of known database connections.
//!
//! A switch (see [`super::db_switch`]) preserves the previous database - this
//! endpoint set makes it reachable again. For the main database and for each
//! module it lists every connection the scope has pointed at, and lets a
//! superadministrator:
//!
//! * **switch (existing data)** - re-point at a registered connection and restart,
//!   using ITS data as it stands (no copy);
//! * **switch (overwrite)** - copy the current data onto the target (overwriting
//!   its old data), then re-point and restart;
//! * **sync** - copy the current data onto a registered connection WITHOUT
//!   switching, to refresh a standby in place;
//! * **forget** - drop a connection from the registry (never the current one).
//!
//! The stored password is never returned: a row reports only `has_password`. The
//! registry itself lives in [`crate::modules::db_registry`]; here is the HTTP
//! surface and the orchestration each action needs.

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{redact::target as audit_target, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    authz::AdminCtx,
    config::settings::database_credentials,
    errors::AppError,
    maintenance::{MaintenanceGuard, GLOBAL_SCOPE},
    modules::{db_config, db_registry as registry},
    state::AppState,
};
use kubuno_db::{params, Backend, DbPool, SchemaPrefix};

use super::db_switch::{
    self, create_job, do_core_copy, do_module_copy, fetch_job, finish_err, finish_ok, job_json,
    settings_from, TargetDto,
};

/// `{ "overwrite": bool }` - how a switch treats the target's existing data.
#[derive(Deserialize, Default)]
pub struct SwitchDto {
    #[serde(default)]
    overwrite: bool,
}

/// The instance-global schema prefix (empty when none).
fn instance_prefix(state: &AppState) -> String {
    state
        .settings
        .database
        .schema_prefix
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// A connection row as the console sees it - the password is reduced to a boolean.
fn conn_json(r: &registry::ConnRow) -> Value {
    json!({
        "id":             r.id,
        "engine":         r.engine,
        "host":           r.host,
        "port":           if r.port <= 0 { Value::Null } else { json!(r.port) },
        "user":           r.db_user,
        "database":       r.db_name,
        "path":           r.db_path,
        "schema_prefix":  r.schema_prefix,
        "label":          r.effective_label(),
        "has_password":   !r.password_enc.is_empty(),
        "is_current":     r.is_current,
        "created_at":     r.created_at,
        "last_used_at":   r.last_used_at,
        "last_synced_at": r.last_synced_at,
    })
}

async fn module_exists(state: &AppState, id: &str) -> Result<(), AppError> {
    let found = state
        .db
        .fetch_optional_row("SELECT id FROM core.modules WHERE id = $1", params![id])
        .await
        .map_err(AppError::Database)?
        .is_some();
    if found {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("Module '{id}' introuvable")))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core (main database)
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /admin/database/connections` - the main database's known connections.
pub async fn list_core_connections(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("consultation des connexions de base de données")?;

    // Self-heal: make sure the live connection is recorded and flagged current,
    // so it always appears even on an instance that predates the registry.
    if let Ok(creds) = database_credentials(&state.settings.database) {
        let prefix = instance_prefix(&state);
        let p = if prefix.is_empty() { None } else { Some(prefix.as_str()) };
        registry::ensure_current(&state.db, &state.settings.auth.jwt_secret, registry::CORE_SCOPE, &creds, p)
            .await;
    }

    let rows = registry::list(&state.db, registry::CORE_SCOPE).await?;
    Ok(Json(json!({
        "scope":       registry::CORE_SCOPE,
        "connections": rows.iter().map(conn_json).collect::<Vec<_>>(),
    })))
}

/// `POST /admin/database/connections/:cid/switch` - re-point the core at a
/// registered connection (optionally overwriting its data first). A core restart
/// finalises it, as with #3.
pub async fn switch_core_connection(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(cid): Path<Uuid>,
    Json(dto): Json<SwitchDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("bascule de la base de données principale")?;
    let target = registry::get(&state.db, registry::CORE_SCOPE, cid)
        .await?
        .ok_or_else(|| AppError::NotFound("Connexion enregistrée introuvable".into()))?;
    if target.is_current {
        return Err(AppError::Validation("Cette connexion est déjà la base courante.".into()));
    }
    let target_backend = Backend::parse(&target.engine)
        .ok_or_else(|| AppError::Validation(format!("Moteur inconnu : {}", target.engine)))?;
    db_switch::ensure_switchable_config(target_backend)?;
    let target_creds = target.to_credentials(&state.settings.auth.jwt_secret).map_err(AppError::Internal)?;
    let prefix = instance_prefix(&state);

    // Preserve the connection we are leaving (best-effort).
    if let Ok(src) = database_credentials(&state.settings.database) {
        let p = if prefix.is_empty() { None } else { Some(prefix.as_str()) };
        let _ = registry::register(
            &state.db, &state.settings.auth.jwt_secret, registry::CORE_SCOPE, &src, p, None, true,
        )
        .await;
    }

    let src_engine = state.settings.database.engine.clone();
    let tgt_engine = target.engine.clone();
    let tgt_label = target.effective_label();
    let overwrite = dto.overwrite;

    // A global maintenance banner covers the switch (a copy and/or a re-point that
    // a restart finalises).
    let guard = MaintenanceGuard::start(
        &state.db,
        &state.ws_hub,
        GLOBAL_SCOPE,
        format!("Bascule de la base de données principale vers {tgt_label} en cours…"),
        "switch",
    )
    .await;

    let outcome: Result<Json<Value>, AppError> = async {
        let mut job_value = Value::Null;
        if overwrite {
            // Copy current -> target first (source untouched), then re-point the config
            // ONLY once the copy AND the config write both succeed, so a job never
            // reports success on a switch that did not actually happen.
            let eff = SchemaPrefix::new(Some(&prefix)).map_err(AppError::Validation)?.schema("core");
            let target_settings = settings_from(&target_creds, &prefix)?;
            let job = create_job(&state.db, "core", &src_engine, &target.engine).await?;
            match do_core_copy(&state, &target_settings, &eff, job).await {
                Ok((tables, rows)) => {
                    if let Err(e) = db_switch::persist_core_settings(&target_creds, target_backend) {
                        finish_err(&state.db, job, &format!("Copie réussie mais configuration non écrite : {}", e.detail())).await;
                        return Err(e);
                    }
                    finish_ok(&state.db, job, tables, rows).await;
                    job_value = job_json(&fetch_job(&state.db, job).await?);
                }
                Err(e) => {
                    finish_err(&state.db, job, &e.detail()).await;
                    return Err(e);
                }
            }
        } else {
            // Existing data: just re-point at the target's data as it stands.
            db_switch::persist_core_settings(&target_creds, target_backend)?;
        }

        // The config now points at the target; move the current pointer to match.
        registry::mark_current(&state.db, registry::CORE_SCOPE, target.id).await?;
        tracing::warn!(to = %target.engine, overwrite,
            "Bascule de la base principale sur une connexion enregistrée - redémarrage du core requis");

        Ok(Json(json!({
            "restart_required": true,
            "overwrite":        overwrite,
            "job":              job_value,
        })))
    }
    .await;

    guard.finish().await;

    // Best-effort audit with the real outcome.
    let mode = if overwrite { "écrasement" } else { "données existantes" };
    let entry = AuditEntry::new("core.database.switch")
        .target(audit_target::DATABASE, "core", "Base de données principale");
    let entry = match &outcome {
        Ok(_) => entry.detail(format!(
            "base principale basculée vers {tgt_label} ({src_engine}→{tgt_engine}, {mode})"
        )),
        Err(e) => entry.failed(format!(
            "bascule de la base principale vers {tgt_label} ({src_engine}→{tgt_engine}, {mode}) échouée : {e}"
        )),
    };
    audit.record(&state.db, entry).await;

    outcome
}

/// `POST /admin/database/connections/:cid/sync` - copy the current core data onto
/// a registered connection WITHOUT switching (refresh a standby in place).
pub async fn sync_core_connection(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(cid): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("synchronisation de la base de données principale")?;
    let target = registry::get(&state.db, registry::CORE_SCOPE, cid)
        .await?
        .ok_or_else(|| AppError::NotFound("Connexion enregistrée introuvable".into()))?;
    if target.is_current {
        return Err(AppError::Validation(
            "La base courante ne peut pas être synchronisée avec elle-même.".into(),
        ));
    }
    let target_creds = target.to_credentials(&state.settings.auth.jwt_secret).map_err(AppError::Internal)?;
    let prefix = instance_prefix(&state);
    let eff = SchemaPrefix::new(Some(&prefix)).map_err(AppError::Validation)?.schema("core");
    let target_settings = settings_from(&target_creds, &prefix)?;

    let src_engine = state.settings.database.engine.clone();
    let tgt_engine = target.engine.clone();
    let tgt_label = target.effective_label();

    // A global maintenance banner covers the copy (a read of the live data onto a
    // standby; no switch, but a consequential whole-database read).
    let guard = MaintenanceGuard::start(
        &state.db,
        &state.ws_hub,
        GLOBAL_SCOPE,
        format!("Synchronisation de la base de données principale vers {tgt_label} en cours…"),
        "sync",
    )
    .await;

    let job = create_job(&state.db, "core", &src_engine, &target.engine).await?;
    let outcome: Result<Json<Value>, AppError> = match do_core_copy(&state, &target_settings, &eff, job).await {
        Ok((tables, rows)) => {
            finish_ok(&state.db, job, tables, rows).await;
            registry::touch_synced(&state.db, target.id).await?;
            record_core_sync(&audit, &state.db, &tgt_label, &src_engine, &tgt_engine, Ok((tables, rows))).await;
            Ok(Json(json!({ "job": job_json(&fetch_job(&state.db, job).await?), "synced": true })))
        }
        Err(e) => {
            let msg = e.detail();
            finish_err(&state.db, job, &msg).await;
            record_core_sync(&audit, &state.db, &tgt_label, &src_engine, &tgt_engine, Err(&msg)).await;
            Err(e)
        }
    };

    guard.finish().await;
    outcome
}

/// Best-effort audit for a core standby sync.
async fn record_core_sync(
    audit: &AdminAudit,
    db: &DbPool,
    target_label: &str,
    from_engine: &str,
    to_engine: &str,
    result: Result<(i32, i64), &str>,
) {
    let entry = AuditEntry::new("core.database.sync")
        .target(audit_target::DATABASE, "core", "Base de données principale");
    let entry = match result {
        Ok((tables, rows)) => entry.detail(format!(
            "base principale synchronisée vers {target_label} ({from_engine}→{to_engine}), {tables} tables / {rows} lignes"
        )),
        Err(cause) => entry.failed(format!(
            "synchronisation de la base principale vers {target_label} ({from_engine}→{to_engine}) échouée : {cause}"
        )),
    };
    audit.record(db, entry).await;
}

/// `DELETE /admin/database/connections/:cid` - forget a registered connection.
pub async fn forget_core_connection(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(cid): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("gestion des connexions de base de données")?;
    registry::forget(&state.db, registry::CORE_SCOPE, cid).await?;
    audit
        .record(
            &state.db,
            AuditEntry::new("core.database.connection.forget")
                .target(audit_target::DATABASE, "core", "Base de données principale")
                .detail(format!("connexion enregistrée {cid} retirée du registre")),
        )
        .await;
    Ok(Json(json!({ "ok": true })))
}

/// `POST /admin/database/connections` - register a connection by hand (not made
/// current). Useful to pre-seed a standby the operator will later sync onto.
pub async fn register_core_connection(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<TargetDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("gestion des connexions de base de données")?;
    dto.validate()?;
    let creds = dto.credentials();
    let engine = creds.engine.clone();
    let prefix = instance_prefix(&state);
    let p = if prefix.is_empty() { None } else { Some(prefix.as_str()) };
    let id = registry::register(
        &state.db, &state.settings.auth.jwt_secret, registry::CORE_SCOPE, &creds, p, None, false,
    )
    .await?;
    audit
        .record(
            &state.db,
            AuditEntry::new("core.database.connection.register")
                .target(audit_target::DATABASE, "core", "Base de données principale")
                .detail(format!("connexion {engine} enregistrée dans le registre (id {id})")),
        )
        .await;
    Ok(Json(json!({ "id": id })))
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-module
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /admin/modules/:id/database/connections`
pub async fn list_module_connections(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("consultation des connexions de base de données d'un module")?;
    module_exists(&state, &id).await?;

    // Self-heal: record the module's live (resolved) connection as current.
    if let Ok(res) = db_config::resolve(&state.db, &state.settings.database, &state.settings.auth.jwt_secret, &id).await
    {
        registry::ensure_current(
            &state.db, &state.settings.auth.jwt_secret, &id, &res.credentials, res.schema_prefix.as_deref(),
        )
        .await;
    }

    let rows = registry::list(&state.db, &id).await?;
    Ok(Json(json!({
        "scope":       id,
        "connections": rows.iter().map(conn_json).collect::<Vec<_>>(),
    })))
}

/// `POST /admin/modules/:id/database/connections/:cid/switch`
pub async fn switch_module_connection(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path((id, cid)): Path<(String, Uuid)>,
    Json(dto): Json<SwitchDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("bascule de la base de données d'un module")?;
    module_exists(&state, &id).await?;
    let target = registry::get(&state.db, &id, cid)
        .await?
        .ok_or_else(|| AppError::NotFound("Connexion enregistrée introuvable".into()))?;
    if target.is_current {
        return Err(AppError::Validation("Cette connexion est déjà la base courante du module.".into()));
    }
    let target_creds = target.to_credentials(&state.settings.auth.jwt_secret).map_err(AppError::Internal)?;
    let target_prefix = target.prefix();

    // Resolve the current (source) database before anything changes, and preserve
    // it in the registry (best-effort).
    let source = db_config::resolve(&state.db, &state.settings.database, &state.settings.auth.jwt_secret, &id)
        .await
        .map_err(AppError::Internal)?;
    let _ = registry::register(
        &state.db, &state.settings.auth.jwt_secret, &id, &source.credentials, source.schema_prefix.as_deref(),
        None, true,
    )
    .await;

    let target_dto = TargetDto::from_credentials(&target_creds);
    let src_engine = source.credentials.engine.clone();
    let tgt_engine = target.engine.clone();
    let tgt_label = target.effective_label();
    let overwrite = dto.overwrite;

    // A banner scoped to this module covers the switch (which restarts the module).
    let guard = MaintenanceGuard::start(
        &state.db,
        &state.ws_hub,
        id.clone(),
        format!("Bascule de la base du module {id} vers {tgt_label} en cours…"),
        "switch",
    )
    .await;

    let outcome: Result<Json<Value>, AppError> = async {
        let mut job_value = Value::Null;
        if overwrite {
            // Copy the current data onto the target: the module self-migrates the
            // target on restart, then the source data is copied in (source intact).
            let job = create_job(&state.db, &id, &src_engine, &target.engine).await?;
            match do_module_copy(&state, &id, &source, &target_dto, job).await {
                Ok((tables, rows)) => {
                    finish_ok(&state.db, job, tables, rows).await;
                    job_value = job_json(&fetch_job(&state.db, job).await?);
                }
                Err(e) => {
                    finish_err(&state.db, job, &e.detail()).await;
                    return Err(e);
                }
            }
        } else {
            // Existing data: re-point the override at the target (keeping its own
            // prefix so the module finds its tables) and restart onto it.
            db_switch::upsert_module_override(&state, &id, &target_dto, target_prefix.as_deref()).await?;
            let restarted =
                crate::modules::manager::restart_module(state.settings.clone(), state.db.clone(), &id).await;
            if !restarted {
                return Err(AppError::Internal(anyhow::anyhow!(
                    "Le module n'a pas pu être redémarré sur la connexion cible."
                )));
            }
        }

        registry::mark_current(&state.db, &id, target.id).await?;
        tracing::warn!(module_id = %id, to = %target.engine, overwrite,
            "Bascule du module sur une connexion enregistrée");

        Ok(Json(json!({ "restarted": true, "overwrite": overwrite, "job": job_value })))
    }
    .await;

    guard.finish().await;

    // Best-effort audit with the real outcome.
    let mode = if overwrite { "écrasement" } else { "données existantes" };
    let entry = AuditEntry::new("core.module.database.change")
        .module(id.as_str())
        .target(audit_target::DATABASE, &id, format!("Base du module {id}"));
    let entry = match &outcome {
        Ok(_) => entry.detail(format!(
            "module {id} basculé vers {tgt_label} ({src_engine}→{tgt_engine}, {mode})"
        )),
        Err(e) => entry.failed(format!(
            "bascule du module {id} vers {tgt_label} ({src_engine}→{tgt_engine}, {mode}) échouée : {e}"
        )),
    };
    audit.record(&state.db, entry).await;

    outcome
}

/// `POST /admin/modules/:id/database/connections/:cid/sync` - copy the module's
/// current data onto a registered connection WITHOUT switching. The target must
/// already hold the module's tables (the core cannot build a module's schema), so
/// sync only works on a connection the module was switched to at least once.
pub async fn sync_module_connection(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path((id, cid)): Path<(String, Uuid)>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("synchronisation de la base de données d'un module")?;
    module_exists(&state, &id).await?;
    let target = registry::get(&state.db, &id, cid)
        .await?
        .ok_or_else(|| AppError::NotFound("Connexion enregistrée introuvable".into()))?;
    if target.is_current {
        return Err(AppError::Validation(
            "La base courante ne peut pas être synchronisée avec elle-même.".into(),
        ));
    }
    let source = db_config::resolve(&state.db, &state.settings.database, &state.settings.auth.jwt_secret, &id)
        .await
        .map_err(AppError::Internal)?;

    let src_prefix = source.schema_prefix.clone().unwrap_or_default();
    let src_eff = SchemaPrefix::new(Some(&src_prefix)).map_err(AppError::Validation)?.schema(&id);
    let dst_prefix = target.prefix().unwrap_or_default();
    let dst_eff = SchemaPrefix::new(Some(&dst_prefix)).map_err(AppError::Validation)?.schema(&id);

    // `connect` needs a `'static` schema name; leak the module id once (bounded).
    let schema_static: &'static str = Box::leak(id.clone().into_boxed_str());
    let target_creds = target.to_credentials(&state.settings.auth.jwt_secret).map_err(AppError::Internal)?;
    let target_settings = settings_from(&target_creds, &dst_prefix)?;
    let target_pool = kubuno_db::connect(&target_settings, schema_static)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Connexion à la cible impossible : {e}")))?;

    // The target must already carry the module's tables.
    let has_tables = db_switch::count_tables(&target_pool, &dst_eff).await.map_err(AppError::Database)?;
    if has_tables == 0 {
        return Err(AppError::Validation(
            "La cible ne contient pas encore les tables du module : basculez d'abord dessus pour l'initialiser."
                .into(),
        ));
    }

    let source_settings = settings_from(&source.credentials, &src_prefix)?;
    let source_pool = kubuno_db::connect(&source_settings, schema_static)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Connexion à la source impossible : {e}")))?;

    let src_engine = source.credentials.engine.clone();
    let tgt_engine = target.engine.clone();
    let tgt_label = target.effective_label();

    // A banner scoped to this module covers the copy.
    let guard = MaintenanceGuard::start(
        &state.db,
        &state.ws_hub,
        id.clone(),
        format!("Synchronisation de la base du module {id} vers {tgt_label} en cours…"),
        "sync",
    )
    .await;

    let job = create_job(&state.db, &id, &src_engine, &target.engine).await?;
    let dbh = state.db.clone();
    let mut done = 0i32;
    let copy = kubuno_db::copy_schema(&source_pool, &src_eff, &target_pool, &dst_eff, &mut |table, copied| {
        done += 1;
        let dbh = dbh.clone();
        let table = table.to_string();
        tokio::spawn(async move { db_switch::set_progress(&dbh, job, &table, done, copied).await; });
    })
    .await;

    let outcome: Result<Json<Value>, AppError> = match copy {
        Ok(report) => {
            let (tables, rows) = (report.tables.len() as i32, report.total_rows);
            finish_ok(&state.db, job, tables, rows).await;
            registry::touch_synced(&state.db, target.id).await?;
            record_module_sync(&audit, &state.db, &id, &tgt_label, &src_engine, &tgt_engine, Ok((tables, rows))).await;
            Ok(Json(json!({ "job": job_json(&fetch_job(&state.db, job).await?), "synced": true })))
        }
        Err(e) => {
            let mapped = db_switch::map_admin_err(e);
            let msg = mapped.detail();
            finish_err(&state.db, job, &msg).await;
            record_module_sync(&audit, &state.db, &id, &tgt_label, &src_engine, &tgt_engine, Err(&msg)).await;
            Err(mapped)
        }
    };

    guard.finish().await;
    outcome
}

/// Best-effort audit for a module standby sync.
async fn record_module_sync(
    audit: &AdminAudit,
    db: &DbPool,
    module_id: &str,
    target_label: &str,
    from_engine: &str,
    to_engine: &str,
    result: Result<(i32, i64), &str>,
) {
    let entry = AuditEntry::new("core.module.database.sync")
        .module(module_id)
        .target(audit_target::DATABASE, module_id, format!("Base du module {module_id}"));
    let entry = match result {
        Ok((tables, rows)) => entry.detail(format!(
            "module {module_id} synchronisé vers {target_label} ({from_engine}→{to_engine}), {tables} tables / {rows} lignes"
        )),
        Err(cause) => entry.failed(format!(
            "synchronisation du module {module_id} vers {target_label} ({from_engine}→{to_engine}) échouée : {cause}"
        )),
    };
    audit.record(db, entry).await;
}

/// `DELETE /admin/modules/:id/database/connections/:cid`
pub async fn forget_module_connection(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path((id, cid)): Path<(String, Uuid)>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("gestion des connexions de base de données d'un module")?;
    module_exists(&state, &id).await?;
    registry::forget(&state.db, &id, cid).await?;
    audit
        .record(
            &state.db,
            AuditEntry::new("core.module.database.connection.forget")
                .module(id.as_str())
                .target(audit_target::DATABASE, &id, format!("Base du module {id}"))
                .detail(format!("connexion enregistrée {cid} retirée du registre du module {id}")),
        )
        .await;
    Ok(Json(json!({ "ok": true })))
}
