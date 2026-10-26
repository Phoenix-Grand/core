use crate::{
    authz::{keys, AdminCtx},
    audit::{redact, redact::target, retention, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    errors::AppError,
    modules::registry::ActiveInstance,
    state::AppState,
};
use axum::{extract::State, Json};
use chrono::Utc;
use kubuno_db::{params, DbPool, DbQueryBuilder};
use serde_json::{json, Value};
use std::collections::HashMap;

/// One row of the general settings tab.
#[derive(sqlx::FromRow)]
struct SettingRow {
    key:         String,
    value:       Value,
    category:    String,
    label:       Option<String>,
    description: Option<String>,
    is_public:   bool,
}

/// One installed module as the admin console lists it.
#[derive(sqlx::FromRow)]
struct AdminModuleRow {
    id:           String,
    display_name: String,
    version:      String,
    description:  Option<String>,
    is_enabled:   bool,
    installed_at: chrono::DateTime<chrono::Utc>,
    config:       Value,
}

/// One module and its declared dependencies, for the cascade graph.
#[derive(sqlx::FromRow)]
struct DependencyRow {
    id:           String,
    // PostgreSQL `TEXT[]` today; read as a JSON array (portable) - the column is
    // migrated `TEXT[]` → `JSONB` on the schema-consolidation side.
    #[sqlx(json)]
    dependencies: Vec<String>,
}

/// One event-log entry.
#[derive(sqlx::FromRow)]
struct EventLogRow {
    id:            i64,
    event_type:    String,
    source_module: Option<String>,
    payload:       Value,
    created_at:    chrono::DateTime<chrono::Utc>,
}

pub async fn get_settings(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::SETTINGS_READ)?;
    // Module-owned settings (module_id set) are managed in their module's admin
    // view (Modules → module → settings); listing them here too was flooding the
    // general Settings tab with duplicates.
    //
    // The `mail` category is excluded for a stronger reason than tidiness: one
    // of its keys holds an AES-GCM blob, and this route returns raw values. It
    // is owned by `/admin/mail/settings`, which reports the credential as a
    // boolean and is the only writer that encrypts.
    let rows = state
        .db
        .fetch_all_as::<SettingRow>(
            "SELECT \"key\", value, category, label, description, is_public FROM core.settings \
             WHERE module_id IS NULL AND category <> 'mail' ORDER BY category, \"key\"",
            params![],
        )
        .await?;

    let settings: Vec<_> = rows
        .into_iter()
        .map(|r| {
            json!({
                "key": r.key,
                "value": r.value,
                "category": r.category,
                "label": r.label,
                "description": r.description,
                "is_public": r.is_public,
            })
        })
        .collect();

    Ok(Json(json!({ "settings": settings })))
}

pub async fn update_settings(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(updates): Json<HashMap<String, Value>>,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::SETTINGS_MANAGE)?;
    // The retention floor is validated before anything is written: a compromised
    // administrator must not be able to shrink the audit window at all, and
    // refusing outright (rather than clamping) tells the operator the floor
    // exists. The same rule is duplicated as a CHECK constraint in migration
    // 000040, which closes the direct-SQL path.
    if let Some(value) = updates.get(retention::RETENTION_SETTING_KEY) {
        retention::validate_retention(value)?;
    }

    // The relay settings are refused here, not silently ignored. Accepting
    // `mail.smtp_password` on this route would store whatever string was posted
    // *in clear* under a key the rest of the code reads as ciphertext - the
    // credential would then be unusable and readable at the same time. There is
    // exactly one writer, and it encrypts.
    if let Some(key) = updates.keys().find(|k| crate::handlers::admin::mail::owns_setting(k)) {
        return Err(AppError::Validation(format!(
            "'{key}' is configured in Administration → Email (PATCH /admin/mail/settings)"
        )));
    }

    // The authentication policy is refused here for the same reason, and for a
    // sharper one: this route writes `core.settings.value`, which the scope
    // resolver no longer reads. Accepting it would let an administrator believe
    // they had changed who may sign in while nothing had changed at all - and it
    // would step around the anti-lockout guard, which lives on the scoped route.
    if let Some(key) = updates
        .keys()
        .find(|k| k.as_str() == crate::auth::methods::KEY_METHODS
                || k.as_str() == crate::auth::methods::KEY_ADMIN_FALLBACK)
    {
        return Err(AppError::Validation(format!(
            "'{key}' is configured by scope in Administration → Security → Authentication and SSO (PUT /admin/settings/scoped/{key}), so it can vary by organizational unit and pass the lockout protection check"
        )));
    }

    // The numeric bounds of the password policy (migration `000115`), applied on
    // this route too: it writes the instance mirror, and a minimum length of 3
    // accepted here would be a policy the resolver then quietly reads as 8.
    for (key, value) in &updates {
        super::setting_scopes::validate_password_policy_value(key, value)?;
        // Same reason, for the network keys: this route writes them too, and an
        // ACME directory URL or a listener port that only the scoped route
        // checked would simply be written through this one instead.
        crate::network::config::validate_setting(key, value)?;
    }

    // Bounds declared by a module (`min`/`max` on an int) are enforced here and
    // not only in the console. The panel disables its Save button when a field
    // is out of range, but the panel is one caller among possible others, and a
    // knob that drives a listener's port or a retry delay has no business
    // accepting anything the wire happens to carry.
    validate_module_bounds(&state.db, &updates).await?;

    // Every key that is about to change is audited, including the retention
    // setting itself - the one an attacker would go for first.
    let mut tx = audit.begin(&state.db).await?;
    let admin_id = audit.admin.id;

    let mut entries: Vec<AuditEntry> = Vec::with_capacity(updates.len());

    for (key, value) in &updates {
        let for_update = tx.backend().for_update();
        let previous: Option<Value> = tx
            .fetch_optional_scalar::<Value>(
                &format!(
                    "SELECT value FROM core.settings WHERE \"key\" = $1{}",
                    for_update
                ),
                params![key],
            )
            .await
            .map_err(|e| { tracing::error!(error = %e, key = %key, "update_settings: lecture"); AppError::Database(e) })?;

        let Some(previous) = previous else {
            return Err(AppError::NotFound(format!("Setting '{key}' inexistant")));
        };

        tx.execute(
            r#"UPDATE core.settings
               SET value = $1, updated_at = $2, updated_by = $3
               WHERE "key" = $4"#,
            params![value.clone(), Utc::now(), admin_id, key],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, key = %key, "update_settings: écriture"); AppError::Database(e) })?;

        entries.push(
            AuditEntry::new("core.settings.change")
                .target(target::SETTING, key, key.clone())
                .before(redact::setting(key, &previous))
                .after(redact::setting(key, value))
                .reversible(),
        );
    }

    // At least one entry is required to commit; an empty PATCH has nothing to
    // audit and nothing to change either.
    let Some(last) = entries.pop() else {
        return Ok(Json(json!({ "message": "No settings to update", "updated": 0 })));
    };
    for entry in entries {
        tx.also(entry);
    }
    tx.commit(last).await?;

    // Réglages appliqués à chaud (sans redémarrage).
    if updates.keys().any(|k| k.starts_with("security.ddos_")) {
        crate::auth::ddos::reload_from_db(&state.db).await;
    }

    // The health report is cached for a minute, and several of its checks read
    // settings written here. Invalidating unconditionally costs one extra
    // evaluation; not invalidating tells the operator their fix did not take.
    crate::health::invalidate();

    Ok(Json(json!({ "message": "Settings updated", "updated": updates.len() })))
}

/// Checks every module-owned key of a settings PATCH against the declaration
/// its module pushed at registration.
///
/// The declaration lives in `core.modules.config` (whole manifest), so it is
/// loaded once per module touched by the request rather than once per key.
/// Keys owned by the core itself carry no such declaration and pass through.
async fn validate_module_bounds(
    db: &DbPool,
    updates: &HashMap<String, Value>,
) -> Result<(), AppError> {
    use crate::handlers::modules::SettingDef;

    let keys: Vec<String> = updates.keys().cloned().collect();
    // `= ANY($1)` over an array is PostgreSQL-only; a portable `IN (...)` list is
    // built instead, so the number of placeholders follows the key count.
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        "SELECT \"key\", module_id FROM core.settings WHERE \"key\"",
    );
    qb.push_in(keys.iter().map(String::as_str));
    let owners: Vec<(String, Option<String>)> = qb
        .fetch_all_as(db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "update_settings: propriétaires des réglages");
            AppError::Database(e)
        })?;

    let mut schemas: HashMap<String, Vec<SettingDef>> = HashMap::new();
    for (full_key, module_id) in owners {
        let Some(module_id) = module_id else { continue };
        let Some(value) = updates.get(&full_key) else { continue };
        if !schemas.contains_key(&module_id) {
            let schema = crate::handlers::modules::load_settings_schema(db, &module_id).await?;
            schemas.insert(module_id.clone(), schema);
        }
        // The stored key is `<module>.<key>`; the declaration is relative.
        let short = full_key
            .strip_prefix(&format!("{module_id}."))
            .unwrap_or(&full_key);
        if let Some(def) = schemas
            .get(&module_id)
            .and_then(|defs| defs.iter().find(|d| d.key == short))
        {
            def.validate_value(value)?;
        }
    }
    Ok(())
}

pub async fn public_config(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let rows = state
        .db
        .fetch_all_as::<(String, Value)>(
            "SELECT \"key\", value FROM core.settings WHERE is_public = TRUE",
            params![],
        )
        .await?;

    let mut config: HashMap<String, Value> = rows.into_iter().collect();

    // Active maintenance notices ride along in the public config under a
    // reserved key: the shell reads them on (re)load to show the banner without
    // waiting for a WebSocket message. The real-time updates come over the
    // `maintenance` WebSocket channel; this is the fallback for a fresh load.
    let notices = crate::maintenance::active(&state.db).await;
    config.insert(
        "maintenance.notices".to_string(),
        serde_json::to_value(&notices).unwrap_or_else(|_| json!([])),
    );

    Ok(Json(json!({ "config": config })))
}

pub async fn list_admin_modules(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::MODULES_READ)?;
    // Internal infrastructure modules (e.g. stt) are registered for routing but
    // hidden from the admin module list.
    let modules = state
        .db
        .fetch_all_as::<AdminModuleRow>(
            "SELECT id, display_name, version, description, is_enabled, installed_at, config FROM core.modules WHERE is_core_module = FALSE ORDER BY display_name",
            params![],
        )
        .await?;

    let data: Vec<_> = modules
        .into_iter()
        .map(|m| {
            let config = m.config;
            let settings_path = config.get("settings_path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            // The pages this module's admin surface is split into. Served with
            // the inventory ON PURPOSE: the console's navigation tree grafts
            // every module's groups under it, and doing that from a per-module
            // request would mean one round trip per installed module just to
            // draw a menu.
            let groups = crate::handlers::modules::setting_groups_from_config(Some(&config));
            json!({
                "id": m.id,
                "icon": crate::handlers::modules::module_icon_from_config(Some(&config)),
                "display_name": m.display_name,
                "version": m.version,
                "description": m.description,
                "is_enabled": m.is_enabled,
                "installed_at": m.installed_at,
                "settings_path": settings_path,
                "setting_groups": groups,
            })
        })
        .collect();

    Ok(Json(json!({ "modules": data })))
}

pub async fn get_admin_module(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::MODULES_READ)?;
    let row = state
        .db
        .fetch_optional_as::<AdminModuleRow>(
            "SELECT id, display_name, version, description, is_enabled, installed_at, config FROM core.modules WHERE id = $1",
            params![&id],
        )
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Module '{id}' not found")))?;

    let config = row.config;
    let settings_path = config.get("settings_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let groups = crate::handlers::modules::setting_groups_from_config(Some(&config));

    Ok(Json(json!({
        "id": row.id,
        "display_name": row.display_name,
        "version": row.version,
        "description": row.description,
        "is_enabled": row.is_enabled,
        "installed_at": row.installed_at,
        "settings_path": settings_path,
        "setting_groups": groups,
        "icon": crate::handlers::modules::module_icon_from_config(Some(&config)),
    })))
}

pub async fn toggle_module(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::MODULES_MANAGE)?;
    tracing::warn!(module_id = %id, "toggle_module appelé");
    let enabled = body
        .get("is_enabled")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| AppError::Validation("Field 'is_enabled' is required (bool)".into()))?;

    // Only the flag flip is transactional-with-audit; the cascade below drives
    // the in-memory registry and the event bus, which no transaction can roll
    // back anyway.
    let mut tx = audit.begin(&state.db).await?;

    // `DbTx` cannot decode a struct or tuple, so the locked row is read column by
    // column. The row lock is spelled per engine via `Backend::for_update`
    // (empty on SQLite, whose writes are already serialized).
    let for_update = tx.backend().for_update();
    let previous = tx
        .fetch_optional_row(
            &format!(
                "SELECT display_name, version, is_enabled FROM core.modules WHERE id = $1{}",
                for_update
            ),
            params![&id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, module_id = %id, "toggle_module: lecture"); AppError::Database(e) })?;

    let Some(row) = previous else {
        return Err(AppError::NotFound(format!("Module '{id}' not found")));
    };
    let display_name: String = row.try_get("display_name").map_err(AppError::Database)?;
    let version: String = row.try_get("version").map_err(AppError::Database)?;
    let was_enabled: bool = row.try_get("is_enabled").map_err(AppError::Database)?;

    tx.execute(
        "UPDATE core.modules SET is_enabled = $1 WHERE id = $2",
        params![enabled, &id],
    )
    .await
    .map_err(|e| { tracing::error!(error = %e, module_id = %id, "toggle_module: écriture"); AppError::Database(e) })?;

    let module_snap = |is_enabled: bool| {
        redact::snapshot(
            target::MODULE,
            &json!({
                "id": &id, "display_name": &display_name,
                "version": &version, "is_enabled": is_enabled,
            }),
        )
    };
    tx.commit(
        AuditEntry::new(if enabled { "core.modules.enable" } else { "core.modules.disable" })
            .target(target::MODULE, &id, display_name.clone())
            .before(module_snap(was_enabled))
            .after(module_snap(enabled))
            .reversible(),
    )
    .await?;

    let mut also_disabled: Vec<String> = Vec::new();

    if !enabled {
        // Cascade disable: find every module that depends on this one.
        let dependents = find_all_dependents(&state.db, &id).await?;

        // Disable every dependent in the database.
        for dep_id in &dependents {
            state.db.execute("UPDATE core.modules SET is_enabled = FALSE WHERE id = $1", params![dep_id]).await?;
            state.db.execute("UPDATE core.module_instances SET status = 'stopped' WHERE module_id = $1", params![dep_id]).await?;
            state.modules.write().await.unregister(dep_id);
            state.events.publish(crate::events::AppEvent::ModuleUnregistered { module_id: dep_id.clone() });
        }
        also_disabled = dependents;

        // Disable the module itself.
        state.modules.write().await.unregister(&id);
        state.db.execute("UPDATE core.module_instances SET status = 'stopped' WHERE module_id = $1", params![&id]).await?;
        state.events.publish(crate::events::AppEvent::ModuleUnregistered { module_id: id });
    } else {
        // Enable: restore the instance from the database without waiting for the
        // next heartbeat. `DbTx` is not involved here, so the row is read on the
        // pool with `fetch_optional_row` and mapped by hand - `subscribed_events`
        // is a PostgreSQL `TEXT[]` column (see the port notes).
        let row = state
            .db
            .fetch_optional_row(
                "SELECT base_url, routes, sidebar_items, subscribed_events, registered_at \
                 FROM core.module_instances WHERE module_id = $1 \
                 ORDER BY registered_at DESC LIMIT 1",
                params![&id],
            )
            .await?;

        if let Some(row) = row {
            let base_url: String = row.try_get("base_url").map_err(AppError::Database)?;
            let routes: Value = row.try_get("routes").map_err(AppError::Database)?;
            let sidebar_items: Value = row.try_get("sidebar_items").map_err(AppError::Database)?;
            let instance = ActiveInstance {
                module_id:         id.clone(),
                base_url:          base_url.clone(),
                routes:            serde_json::from_value(routes).unwrap_or_default(),
                sidebar_items:     serde_json::from_value(sidebar_items).unwrap_or_default(),
                subscribed_events: {
                    // `subscribed_events` is a PostgreSQL `TEXT[]` read as a JSON
                    // array (portable); migrated `TEXT[]` → `JSONB` schema-side.
                    let raw: Value = row.try_get("subscribed_events").map_err(AppError::Database)?;
                    serde_json::from_value(raw).unwrap_or_default()
                },
                registered_at:     row.try_get("registered_at").map_err(AppError::Database)?,
                last_heartbeat:    Utc::now(),
            };
            state
                .db
                .execute(
                    "UPDATE core.module_instances SET status = 'healthy', last_heartbeat = $1 \
                     WHERE module_id = $2",
                    params![Utc::now(), &id],
                )
                .await?;
            state.modules.write().await.register(instance);
            state.events.publish(crate::events::AppEvent::ModuleRegistered {
                module_id: id,
                base_url,
            });
        }
        // No known instance: the module re-registers itself at the next heartbeat.
    }

    Ok(Json(json!({
        "message":       if enabled { "Module enabled" } else { "Module disabled" },
        "also_disabled": also_disabled,
    })))
}

/// Retourne tous les modules qui dépendent directement ou indirectement de `module_id`.
/// Utilise une recherche BFS dans le graphe de dépendances.
async fn find_all_dependents(db: &DbPool, module_id: &str) -> Result<Vec<String>, AppError> {
    // Load every dependency list in a single query to avoid N+1. Note that
    // `dependencies` is a PostgreSQL `TEXT[]` column (see the port notes).
    let rows = db
        .fetch_all_as::<DependencyRow>(
            "SELECT id, dependencies FROM core.modules WHERE is_enabled = TRUE",
            params![],
        )
        .await?;

    // Build the reverse graph: dep_id → [modules that depend on it].
    let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        for dep in row.dependencies {
            reverse.entry(dep).or_default().push(row.id.clone());
        }
    }

    // BFS depuis module_id
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut queue: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    queue.push_back(module_id.to_string());

    while let Some(current) = queue.pop_front() {
        if let Some(dependents) = reverse.get(&current) {
            for dep in dependents {
                if dep != module_id && !visited.contains(dep) {
                    visited.insert(dep.clone());
                    queue.push_back(dep.clone());
                }
            }
        }
    }

    Ok(visited.into_iter().collect())
}

pub async fn list_event_log(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::AUDIT_READ)?;
    let limit: i64 = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50).min(200);
    let offset: i64 = q.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);
    let event_type = q.get("event_type").map(|s| s.as_str());

    // The optional `event_type` filter is applied with a builder rather than the
    // PostgreSQL `($1::text IS NULL OR ...)` trick, which both reused a
    // placeholder and cast with `::text`.
    let mut qb = DbQueryBuilder::new(
        state.db.backend(),
        "SELECT id, event_type, source_module, payload, created_at FROM core.event_log",
    );
    if let Some(et) = event_type {
        qb.push(" WHERE event_type = ").push_bind(et);
    }
    qb.push_order_by("created_at DESC");
    qb.push_limit_offset(limit, offset);
    let rows: Vec<EventLogRow> = qb.fetch_all_as(&state.db).await?;

    let data: Vec<_> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.id,
                "event_type": r.event_type,
                "source_module": r.source_module,
                "payload": r.payload,
                "created_at": r.created_at,
            })
        })
        .collect();

    Ok(Json(json!({ "events": data, "limit": limit, "offset": offset })))
}
