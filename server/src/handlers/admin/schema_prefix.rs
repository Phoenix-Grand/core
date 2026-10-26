//! Admin console: change the global schema prefix (WordPress-style) at run time.
//!
//! The prefix ([`kubuno_db::SchemaPrefix`]) namespaces every schema so several
//! Kubuno instances can share one database server. It is chosen at install time
//! (`[database] schema_prefix`); this endpoint changes it on a running instance
//! by renaming the live namespaces and persisting the new value.
//!
//! ## What a change does, engine by engine
//!
//! * **PostgreSQL** - `ALTER SCHEMA "<old>core" RENAME TO "<new>core"` for the
//!   core and every module schema present, in one transaction.
//! * **MySQL/MariaDB** - a database cannot be renamed in one statement, so each
//!   `<old>*` database is recreated as `<new>*` and its tables moved.
//! * **SQLite** - the prefix names files, not a server namespace; there is no
//!   live rename to perform, so a change here is refused with a clear message
//!   (it would point the modules at empty files). The card reports this.
//!
//! Renaming the `core` schema takes the primary namespace out from under the
//! running pool, so the operation persists the new value and asks for a core
//! restart to finalise - which also restarts every module with the new
//! `KUBUNO_DB_SCHEMA_PREFIX`. This is a deliberate brief outage: the data is
//! moved atomically (per engine) and the source is never left half-renamed.

use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    audit::{redact::target, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    authz::AdminCtx,
    errors::AppError,
    maintenance::{MaintenanceGuard, GLOBAL_SCOPE},
    setup::config_file,
    state::AppState,
};

/// A prefix rendered for a human: the empty prefix reads as "(none)".
fn prefix_label(prefix: &str) -> &str {
    if prefix.is_empty() {
        "(aucun)"
    } else {
        prefix
    }
}

/// The current prefix, trimmed. Empty string means "no prefix".
fn current_prefix(state: &AppState) -> String {
    state
        .settings
        .database
        .schema_prefix
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

fn engine(state: &AppState) -> String {
    state.settings.database.engine.clone()
}

/// Whether the schema prefix can be renamed on this engine (false on SQLite).
fn applicable(state: &AppState) -> bool {
    !matches!(
        kubuno_db::Backend::parse(&engine(state)),
        Some(kubuno_db::Backend::Sqlite)
    )
}

/// The connection parameters the instance is currently using, so the migration
/// form starts from what is already known instead of blank fields. The password
/// is never exposed - only whether one is set. `null` if it cannot be resolved.
fn current_connection(state: &AppState) -> Value {
    match crate::config::settings::database_credentials(&state.settings.database) {
        Ok(c) => json!({
            "engine":       c.engine,
            "host":         c.host,
            "port":         if c.port == 0 { Value::Null } else { json!(c.port) },
            "user":         c.user,
            "database":     c.database,
            "path":         c.path,
            "has_password": !c.password.is_empty(),
        }),
        Err(_) => Value::Null,
    }
}

/// `GET /admin/database/schema-prefix` - the current prefix and whether it can
/// be changed on this engine.
pub async fn get_schema_prefix(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("gestion du préfixe de schéma")?;
    Ok(Json(json!({
        "prefix":     current_prefix(&state),
        "engine":     engine(&state),
        "applicable": applicable(&state),
        "current":    current_connection(&state),
    })))
}

#[derive(Deserialize)]
pub struct SchemaPrefixDto {
    /// The new prefix. Empty clears it. Must match `^[a-z0-9_]{1,32}$` otherwise.
    #[serde(default)]
    prefix: String,
}

/// `PUT /admin/database/schema-prefix` - validate, rename the live namespaces,
/// persist the new value, and report that a core restart finalises it.
pub async fn put_schema_prefix(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<SchemaPrefixDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("gestion du préfixe de schéma")?;

    let new_prefix = dto.prefix.trim().to_string();
    // Validated exactly like the pool's own `SchemaPrefix`: empty, or the safe
    // identifier alphabet. A bad value never reaches a DDL statement.
    kubuno_db::SchemaPrefix::new(Some(&new_prefix))
        .map_err(AppError::Validation)?;

    if !applicable(&state) {
        return Err(AppError::Validation(
            "Schema prefixes do not apply to SQLite: each schema is a file, so there is no server namespace to rename. Change the prefix only on PostgreSQL or MySQL."
                .into(),
        ));
    }

    let old_prefix = current_prefix(&state);
    if old_prefix == new_prefix {
        return Ok(Json(json!({
            "changed": false,
            "prefix":  new_prefix,
        })));
    }

    // Persist the new prefix FIRST. If the config cannot be written (e.g. the
    // config directory is not writable by the service account), nothing is
    // renamed, so the instance is never left with renamed schemas and a stale
    // config - the state that breaks it until a manual repair. The in-memory
    // settings keep the old value until the process restarts, which is exactly
    // what finalises the change.
    persist_prefix(&new_prefix)?;

    // A global maintenance banner covers the live rename (an atomic, per-engine
    // outage on the primary namespace).
    let guard = MaintenanceGuard::start(
        &state.db,
        &state.ws_hub,
        GLOBAL_SCOPE,
        format!(
            "Changing schema prefix ('{}' → '{}')…",
            prefix_label(&old_prefix),
            prefix_label(&new_prefix)
        ),
        "prefix_change",
    )
    .await;

    // Rename the live namespaces (core + every module schema present, primary and
    // secondary), atomic per engine. On failure, roll the persisted prefix back
    // so the config matches the schemas the transactional rename left unchanged.
    let outcome: Result<Json<Value>, AppError> =
        match kubuno_db::rename_schema_prefix(&state.db, &old_prefix, &new_prefix).await {
            Ok(o) => {
                tracing::warn!(
                    from = %old_prefix,
                    to = %new_prefix,
                    renamed = ?o.renamed,
                    "Préfixe de schéma changé - redémarrage du core requis pour finaliser"
                );
                audit
                    .record(
                        &state.db,
                        AuditEntry::new("core.database.prefix_change")
                            .target(target::DATABASE, "core", "Préfixe de schéma")
                            .detail(format!(
                                "préfixe « {} » → « {} » sur {} schéma(s) : {}",
                                prefix_label(&old_prefix),
                                prefix_label(&new_prefix),
                                o.renamed.len(),
                                o.renamed.join(", ")
                            )),
                    )
                    .await;
                Ok(Json(json!({
                    "changed":          true,
                    "prefix":           new_prefix,
                    "renamed":          o.renamed,
                    "restart_required": true,
                })))
            }
            Err(e) => {
                if let Err(re) = persist_prefix(&old_prefix) {
                    tracing::error!(error = %re, "Rollback du préfixe dans la config impossible après un renommage échoué");
                }
                tracing::error!(error = %e, from = %old_prefix, to = %new_prefix, "Renommage du préfixe de schéma échoué");
                let mapped = match e {
                    kubuno_db::AdminError::Sqlx(err) => AppError::Database(err),
                    kubuno_db::AdminError::BadPrefix(p) => {
                        AppError::Validation(format!("Invalid prefix: {p}"))
                    }
                    other => AppError::Internal(anyhow::anyhow!(other.to_string())),
                };
                audit
                    .record(
                        &state.db,
                        AuditEntry::new("core.database.prefix_change")
                            .target(target::DATABASE, "core", "Préfixe de schéma")
                            .failed(format!(
                                "changement de préfixe « {} » → « {} » échoué : {mapped}",
                                prefix_label(&old_prefix),
                                prefix_label(&new_prefix)
                            )),
                    )
                    .await;
                Err(mapped)
            }
        };

    // Tears the banner down in both branches.
    guard.finish().await;
    outcome
}

/// Writes `[database] schema_prefix = "<prefix>"` into the running config file.
fn persist_prefix(prefix: &str) -> Result<(), AppError> {
    let target = config_file::target_path();
    if !config_file::is_writable(&target) {
        return Err(AppError::Internal(anyhow::anyhow!(
            "Le fichier de configuration {} n'est pas accessible en écriture ; \
             le nouveau préfixe n'a pas pu être enregistré (le renommage a bien eu lieu).",
            target.display()
        )));
    }
    let source = config_file::source_text(&target);
    let patched = config_file::patch(
        &source,
        &[config_file::Assign::text("database", "schema_prefix", prefix)],
    );
    config_file::write_atomic(&target, &patched).map_err(AppError::Internal)?;
    Ok(())
}
