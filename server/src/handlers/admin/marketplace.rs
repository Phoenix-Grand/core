//! Admin : navigation dans la marketplace + installation de modules.
//!
//! Réservé aux administrateurs. Le catalogue est croisé avec `core.modules` pour
//! marquer les modules déjà installés (et leur version / état activé).

use std::collections::HashMap;

use axum::{extract::{Path, State}, http::StatusCode, response::IntoResponse, Json};
use kubuno_db::params;
use serde_json::json;

use crate::{
    authz::{keys, AdminCtx},
    audit::{redact::target, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    errors::AppError,
    modules::marketplace,
    state::AppState,
};

/// Local install state of a module, joined against the remote catalog.
#[derive(sqlx::FromRow)]
struct ModuleState {
    id:         String,
    version:    String,
    is_enabled: bool,
}

/// `GET /api/v1/admin/marketplace` - catalogue distant + état d'installation local.
pub async fn list_marketplace(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::MARKETPLACE_MANAGE)?;
    let catalog = marketplace::fetch_catalog().await?;

    // Local state: installed version + enabled flag, keyed by module id.
    let rows = state
        .db
        .fetch_all_as::<ModuleState>("SELECT id, version, is_enabled FROM core.modules", params![])
        .await?;
    let installed: HashMap<String, (String, bool)> = rows
        .into_iter()
        .map(|r| (r.id, (r.version, r.is_enabled)))
        .collect();

    let modules: Vec<_> = catalog
        .into_iter()
        .map(|m| {
            let local = installed.get(&m.id);
            // Désinstallable uniquement si installé depuis la marketplace (store).
            let removable = marketplace::is_store_installed(&state.settings, &m.id);
            json!({
                "id":            m.id,
                "name":          m.name,
                "version":       m.version,
                "author":        m.author,
                "official":      m.official,
                "category":      m.category,
                "accent":        m.accent,
                "summary":       m.summary,
                "description":   m.description,
                "license":       m.license,
                "tags":          m.tags,
                "rating":        m.rating,
                "updated":       m.updated,
                "links":         m.links,
                "installed":         local.is_some(),
                "installed_version": local.map(|(v, _)| v.clone()),
                "enabled":           local.map(|(_, e)| *e),
                "removable":         removable,
            })
        })
        .collect();

    Ok(Json(json!({ "modules": modules })))
}

/// `POST /api/v1/admin/marketplace/:id/install` - lance l'installation en tâche de
/// fond et répond immédiatement `202 Accepted`. Le frontend suit l'avancement via
/// `GET /api/v1/admin/marketplace/:id/status`.
pub async fn install_marketplace(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    ctx.require_superuser("installation d'un module")?;
    // Refuse une installation déjà en cours pour ce module.
    if let Some(p) = marketplace::get_progress(&id) {
        if !matches!(p.phase.as_str(), "done" | "error") {
            return Err(AppError::Conflict(format!("Installation of '{id}' is already in progress")));
        }
    }
    marketplace::begin(&id);
    tracing::info!(module_id = %id, "Marketplace : installation demandée par un admin");

    // The request is audited, then the outcome of the detached install is
    // audited too. Installation runs in the background - there is no
    // transaction to ride along with - so both entries go through the
    // standalone path, carrying the requesting operator's context.
    audit
        .record(
            &state.db,
            AuditEntry::new("core.marketplace.install_request")
                .target(target::MARKETPLACE, &id, id.clone()),
        )
        .await;

    let settings = state.settings.clone();
    let db = state.db.clone();
    let mid = id.clone();
    let ctx = audit.ctx.clone();
    tokio::spawn(async move {
        let result = marketplace::install(settings, db.clone(), &mid).await;
        let entry = match &result {
            Ok(r) => {
                tracing::info!(module_id = %mid, version = %r.version, started = r.started, "Marketplace : installation terminée");
                AuditEntry::new("core.marketplace.install")
                    .target(target::MARKETPLACE, &mid, mid.clone())
                    .after(json!({ "id": &mid, "version": &r.version }))
            }
            Err(e) => {
                tracing::error!(module_id = %mid, error = %e.detail(), "Marketplace : installation échouée");
                AuditEntry::new("core.marketplace.install")
                    .target(target::MARKETPLACE, &mid, mid.clone())
                    .failed(e.detail())
            }
        };
        ctx.record(&db, entry).await;
        marketplace::finish_progress(&mid, &result);
    });

    Ok((StatusCode::ACCEPTED, Json(json!({ "status": "started", "id": id }))))
}

/// `GET /api/v1/admin/marketplace/:id/status` - état d'avancement d'une installation.
pub async fn install_status(
    State(_state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::MARKETPLACE_MANAGE)?;
    Ok(Json(json!({ "id": id, "progress": marketplace::get_progress(&id) })))
}

/// `DELETE /api/v1/admin/marketplace/:id` - désinstalle un module de la marketplace.
pub async fn uninstall_marketplace(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require_superuser("désinstallation d'un module")?;
    let previous: Option<(String, String)> = state
        .db
        .fetch_optional_as::<(String, String)>(
            "SELECT display_name, version FROM core.modules WHERE id = $1",
            params![&id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, module_id = %id, "uninstall_marketplace: lecture"); AppError::Database(e) })?;

    // `uninstall` removes files from disk as well as rows: it is not
    // transactional, so the entry is written right after it succeeds.
    if let Err(e) = marketplace::uninstall(state.settings.clone(), state.db.clone(), &id).await {
        audit
            .record(
                &state.db,
                AuditEntry::new("core.marketplace.uninstall")
                    .target(target::MARKETPLACE, &id, id.clone())
                    .failed(e.detail()),
            )
            .await;
        return Err(e);
    }

    let (name, version) = previous.unwrap_or_else(|| (id.clone(), String::new()));
    audit
        .record(
            &state.db,
            AuditEntry::new("core.marketplace.uninstall")
                .target(target::MARKETPLACE, &id, name.clone())
                .before(json!({ "id": &id, "name": name, "version": version })),
        )
        .await;
    // Retrait du registre en mémoire + notification.
    state.modules.write().await.unregister(&id);
    state.events.publish(crate::events::AppEvent::ModuleUnregistered { module_id: id.clone() });
    tracing::info!(module_id = %id, "Marketplace : désinstallation demandée par un admin");
    Ok(Json(json!({ "ok": true })))
}
