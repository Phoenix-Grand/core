//! Module registration lifecycle: the register DTO, register/heartbeat/
//! unregister handlers, config read-back, and their guards.

use crate::{
    auth::middleware::{AuthUser, InternalRequest},
    authz::{catalog::PrivilegeDef, keys, AdminCtx},
    errors::AppError,
    events::AppEvent,
    modules::registry::{ActiveInstance, ModuleRoute, SidebarItem},
    state::AppState,
};
use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use kubuno_db::{dialect::Assign, new_id, params};
use serde::Deserialize;
use serde_json::json;

use super::*;

#[derive(Deserialize)]
pub struct RegisterModuleDto {
    pub module_id:         String,
    pub display_name:      Option<String>,
    pub description:       Option<String>,
    pub base_url:          String,
    pub routes:            Vec<ModuleRoute>,
    pub sidebar_items:     Vec<SidebarItem>,
    pub subscribed_events: Vec<String>,
    pub version:           String,
    pub settings_path:     Option<String>,
    /// Commandes CLI offertes par le module.
    /// Format : [{ "name": "files:upload", "description": "...", "usage": "..." }]
    #[serde(default)]
    pub cli_commands:      Vec<serde_json::Value>,
    /// Outils MCP exposés par le module.
    /// Format : [{ "name", "description", "input_schema", "route", "method" }]
    #[serde(default)]
    pub mcp_tools:         Vec<serde_json::Value>,
    /// Schéma déclaratif des paramètres du module (manifeste `[[settings]]`).
    /// Le core sème les portées `global`/`overridable` dans core.settings et
    /// résout la valeur effective (override utilisateur ?? défaut global).
    #[serde(default)]
    pub settings_schema:   Vec<SettingDef>,
    /// Privilèges déclarés par le module, **relatifs à lui** : `<domaine>.<verbe>`.
    /// Le core préfixe de force par `module_id` (cf. `crate::authz::catalog`) :
    /// un module ne peut jamais écrire hors de son propre espace, et surtout pas
    /// dans `core`.
    #[serde(default)]
    pub privileges:        Vec<PrivilegeDef>,
    /// Déclencheurs offerts au moteur de règles d'administration, **relatifs**
    /// au module (nom simple, sans préfixe). Le core préfixe de force par
    /// `module_id` (cf. `crate::rules::catalog`) : même discipline que pour les
    /// privilèges et les paramètres. Un module qui n'en déclare aucun n'apparaît
    /// simplement pas dans le catalogue des règles.
    #[serde(default)]
    pub rule_triggers:     Vec<crate::rules::catalog::TriggerDef>,
    /// Actions offertes au moteur de règles. Chacune DOIT porter l'endpoint
    /// interne qui l'exécute - c'est le module qui dit où le répartiteur doit
    /// frapper, le core ne connaît aucune route de module.
    #[serde(default)]
    pub rule_actions:      Vec<crate::rules::catalog::ActionDef>,
    /// Module d'infrastructure interne (ex. stt) : enregistré pour le routage,
    /// mais masqué de la liste des modules de l'administration.
    #[serde(default)]
    pub internal:          bool,
    /// Groups the module's settings are split into, one entry of the admin menu
    /// each (manifest `[[setting_groups]]`). Empty for a module that never
    /// declared any: its panel stays the single page it has always been.
    #[serde(default)]
    pub setting_groups:    Vec<SettingGroup>,
}

/// One page of a module's administration surface.
fn validate_module_id(id: &str) -> Result<(), AppError> {
    if id.is_empty() || id.len() > 50 {
        return Err(AppError::Validation("module_id: 1-50 caractères".into()));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::Validation(
            "module_id: uniquement lettres, chiffres, tirets et underscores".into(),
        ));
    }
    if RESERVED_MODULE_IDS.contains(&id) {
        return Err(AppError::Validation(format!(
            "L'identifiant '{id}' est réservé par le core"
        )));
    }
    Ok(())
}

/// Refuse un appel interne agissant sur un module qui n'est pas celui de
/// l'appelant authentifié.
///
/// Un appelant NON identifié (secret maître : le core lui-même, un outil
/// d'exploitation, ou un module lancé hors supervision en développement) passe
/// comme avant - la compatibilité prime tant que `reject_master_internal_secret`
/// n'est pas activé.
pub fn ensure_caller_is(internal: &InternalRequest, module_id: &str) -> Result<(), AppError> {
    match internal.module_id() {
        Some(caller) if caller != module_id => {
            tracing::warn!(
                caller = %caller,
                target = %module_id,
                "Appel interne refusé : le module authentifié n'est pas celui visé"
            );
            Err(AppError::Forbidden)
        }
        _ => Ok(()),
    }
}

pub async fn register_module(
    State(state): State<AppState>,
    internal: InternalRequest,
    Json(dto): Json<RegisterModuleDto>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    validate_module_id(&dto.module_id)?;
    ensure_caller_is(&internal, &dto.module_id)?;
    // Before anything is written: a manifest that declares a knob the console
    // could not render honestly is refused as a whole, not repaired silently.
    validate_settings_schema(&dto.module_id, &dto.settings_schema)?;
    // Same discipline for the pages the panel is split into: a knob assigned to
    // a group that does not exist would be rendered nowhere at all.
    validate_setting_groups(&dto.module_id, &dto.setting_groups, &dto.settings_schema)?;

    // Première inscription : is_enabled = TRUE (le module est actif par défaut).
    // Sur ON CONFLICT, is_enabled n'est PAS mis à jour - l'admin garde le contrôle.
    let display_name = dto.display_name.as_deref().unwrap_or(&dto.module_id);
    // The full settings manifest (every scope) is kept durably in core.modules.config
    // so the user-settings page can render even when the module process is down.
    // The groups travel by the same road as the schema: one JSONB document, no
    // column and no table per presentation attribute. The admin menu can then be
    // built from the module inventory alone, without a request per module.
    let config = serde_json::json!({
        "settings_path":   dto.settings_path,
        "settings_schema": dto.settings_schema,
        "setting_groups":  dto.setting_groups,
        // The module's own glyph, kept HERE rather than read back from its
        // running instance: the admin inventory lists modules that are stopped
        // or switched off, and those are precisely the rows an operator needs to
        // recognise at a glance. An icon that disappears when a module stops
        // would blank exactly the entries worth looking at.
        "icon":            module_icon(&dto.sidebar_items),
    });
    let cli_commands = serde_json::Value::Array(dto.cli_commands.clone());
    let backend = state.db.backend();
    let modules_clause = backend.upsert(
        "core.modules",
        &["id"],
        &[
            Assign::Incoming("version"),
            Assign::Incoming("display_name"),
            Assign::Incoming("description"),
            Assign::Incoming("config"),
            Assign::Incoming("cli_commands"),
            Assign::Expr { col: "is_core_module", expr: "{cur} OR {new}" },
            Assign::Incoming("updated_at"),
        ],
    );
    let modules_sql = format!(
        r#"INSERT INTO core.modules (id, display_name, description, version, runtime, is_enabled, config, cli_commands, is_core_module, updated_at)
           VALUES ($1, $2, $3, $4, 'rust', TRUE, $5, $6, $7, $8){modules_clause}"#
    );
    state
        .db
        .execute(
            &modules_sql,
            params![
                &dto.module_id,
                display_name,
                dto.description.as_deref(),
                &dto.version,
                config,
                cli_commands,
                dto.internal,
                Utc::now()
            ],
        )
        .await?;

    // Vérifier si le module est activé - FALSE uniquement si l'admin l'a désactivé après coup
    let is_enabled: bool = state
        .db
        .fetch_scalar::<bool>(
            "SELECT is_enabled FROM core.modules WHERE id = $1",
            params![&dto.module_id],
        )
        .await?;

    if !is_enabled {
        tracing::info!(module_id = %dto.module_id, "Module désactivé, enregistrement refusé");
        return Err(AppError::Forbidden);
    }

    let now = Utc::now();
    let instance = ActiveInstance {
        module_id:         dto.module_id.clone(),
        base_url:          dto.base_url.clone(),
        routes:            dto.routes,
        sidebar_items:     dto.sidebar_items,
        subscribed_events: dto.subscribed_events,
        registered_at:     now,
        last_heartbeat:    now,
    };

    // Remplace l'instance précédente du module (un seul processus actif à la fois)
    let mut tx = state.db.begin().await?;
    tx.execute(
        "DELETE FROM core.module_instances WHERE module_id = $1",
        params![&dto.module_id],
    )
    .await?;
    // No RETURNING: the instance id is generated in Rust. `subscribed_events` was
    // a PostgreSQL TEXT[] column and is now bound as a JSON array (the migration
    // to a JSON column is handled separately).
    tx.execute(
        r#"INSERT INTO core.module_instances
           (id, module_id, base_url, routes, sidebar_items, subscribed_events, mcp_tools, status, pid, registered_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'healthy', NULL, $8)"#,
        params![
            new_id(),
            &dto.module_id,
            &dto.base_url,
            serde_json::to_value(&instance.routes).unwrap_or_default(),
            serde_json::to_value(&instance.sidebar_items).unwrap_or_default(),
            instance.subscribed_events.clone(),
            serde_json::Value::Array(dto.mcp_tools.clone()),
            now
        ],
    )
    .await?;

    // Seed the DECLARATION of every setting into core.settings, which since
    // migration 000060 is the schema table: key, type, enum domain, owning
    // module, factory default, label, visibility. The values live in
    // core.setting_values, one row per scope, and none is created here - a
    // freshly declared setting must read as "factory", not as "set at instance
    // level". The `value` column is a compatibility mirror of the instance scope
    // and is deliberately left out of the conflict update: an admin-set value is
    // never clobbered by a re-registration.
    //
    // User-scoped settings are seeded too, unlike before: without a row in the
    // schema table they have no foreign key to hang a per-account value on, and
    // the per-scope resolution could not see them at all.
    let settings_clause = backend.upsert(
        "core.settings",
        &["key"],
        &[
            Assign::Incoming("default_value"),
            Assign::Incoming("category"),
            Assign::Incoming("label"),
            Assign::Incoming("description"),
            Assign::Incoming("is_public"),
            Assign::Incoming("scope"),
            Assign::Incoming("value_type"),
            Assign::Incoming("allowed_values"),
            Assign::Incoming("module_id"),
        ],
    );
    // `value` is bound to the factory default at $2 and `default_value` to the
    // same value at $3 - a positional placeholder is never reused across engines,
    // so the value is passed twice rather than pointing two columns at one $2.
    let settings_sql = format!(
        r#"INSERT INTO core.settings
               ("key", value, default_value, category, label, description, is_public,
                scope, value_type, allowed_values, module_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11){settings_clause}"#
    );
    for def in &dto.settings_schema {
        if !VALID_SCOPES.contains(&def.scope.as_str()) {
            tracing::warn!(module_id = %dto.module_id, key = %def.key, scope = %def.scope,
                "Paramètre ignoré : portée invalide");
            continue;
        }
        if !VALID_VALUE_TYPES.contains(&def.value_type.as_str()) {
            tracing::warn!(module_id = %dto.module_id, key = %def.key, value_type = %def.value_type,
                "Paramètre ignoré : type invalide");
            continue;
        }
        // A per-account preference has no instance-wide value to publish, so it
        // stays out of the public /api/v1/config whatever the manifest says:
        // what would be exposed there is a default nobody chose.
        let is_public = def.public && def.scope != "user";
        let full_key = format!("{}.{}", dto.module_id, def.key);
        let category = def.category.clone().unwrap_or_else(|| dto.module_id.clone());
        let allowed  = def.values.clone().map(serde_json::Value::Array);
        tx.execute(
            &settings_sql,
            params![
                full_key,
                def.default.clone(),
                def.default.clone(),
                category,
                def.label.as_deref(),
                def.description.as_deref(),
                is_public,
                &def.scope,
                &def.value_type,
                allowed,
                &dto.module_id
            ],
        )
        .await?;
    }

    // Privilege catalogue: same forced prefixing as the settings above, and the
    // orphan flag cleared for a module that has come back.
    crate::authz::catalog::register_module_privileges(&mut tx, &dto.module_id, &dto.privileges)
        .await?;

    // Rule catalogue: what this module lets an administrator react to, and what
    // it lets a rule do to it. Third declaration of the same shape, on purpose -
    // a module widens the core's vocabulary and the core learns nothing about
    // the module beyond what it was handed.
    crate::rules::catalog::register_module(
        &mut tx,
        &dto.module_id,
        &dto.rule_triggers,
        &dto.rule_actions,
    )
    .await?;

    tx.commit().await?;

    // A module that just registered is no longer an orphan's namespace, and one
    // that never came back still is. Off the request path.
    {
        let st = state.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::authz::catalog::refresh_orphans(&st.db).await {
                tracing::warn!(error = %e, "authz: réévaluation des orphelins impossible");
            }
            if let Err(e) = crate::rules::catalog::refresh_orphans(&st.db).await {
                tracing::warn!(error = %e, "rules: réévaluation des orphelins impossible");
            }
            // A module coming back can re-arm rules that were loaded as dead:
            // rebuild the memory index rather than wait for the next write.
            crate::rules::store::notify_reload(&st.db).await;
        });
    }
    crate::authz::cache::invalidate_all();

    state.modules.write().await.register(instance);

    state.events.publish(AppEvent::ModuleRegistered {
        module_id: dto.module_id.clone(),
        base_url:  dto.base_url,
    });

    // When the drive comes online, (re)build the read-only theme mirror it hosts
    // under System/Themes. Best-effort, off the request path.
    if dto.module_id == "drive" {
        let st = state.clone();
        tokio::spawn(async move { crate::handlers::theme_mirror::sync(&st).await });
    }

    Ok((StatusCode::CREATED, Json(json!({ "message": "Module enregistré" }))))
}

/// GET /api/v1/modules/:module/config
///
/// Renvoie, pour l'utilisateur courant, le schéma des paramètres du module et
/// leur résolution complète. Depuis la migration `000060` la chaîne n'est plus
/// « surcharge utilisateur ?? valeur globale ?? défaut » mais la résolution par
/// portée du core :
///
/// ```text
///   utilisateur ?? groupe ?? unité la plus proche ?? … ?? instance ?? usine
/// ```
///
/// C'est ce qui fait qu'un réglage de module posé sur une unité descend
/// réellement à ses comptes. La provenance (`source`) et le verrou
/// (`locked`) accompagnent chaque entrée : un module qui affiche un contrôle
/// désactivé doit pouvoir dire pourquoi.
///
/// Filtré par privilège : un non-admin ne voit pas les paramètres de portée
/// `global` (réservés admin).
/// A module reading back its OWN instance settings, as the administrator left
/// them in the console.
///
/// Until now a module could declare settings and the console could edit them,
/// but the module itself had no way to read the result: its own schema forbids
/// touching `core.settings`, and the user-facing config route needs a user
/// token, which a background worker does not have. That gap is why settings
/// that drive a module's *runtime* (a listener's port, say) had nowhere to live.
///
/// The caller is identified by the internal secret it presented, never by the
/// request - a module can only ever read its own keys. Only instance-scoped
/// settings are returned: `user` scope has no single value to speak of.
pub async fn get_module_config(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    // This route lives outside `/admin/*`, so the layer guard does not run and
    // the context is resolved here. It replaces a hand-rolled
    // `user.role == "admin"` test - the kind of check that silently stops
    // agreeing with the rest of the system the day delegation arrives.
    ctx: AdminCtx,
    AxumPath(module_id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    use crate::settings::{chain, ScopeKind, SettingScope};

    // 1. Schéma déclaré (durable, lu depuis core.modules.config).
    let config: Option<serde_json::Value> = state
        .db
        .fetch_optional_scalar::<serde_json::Value>(
            "SELECT config FROM core.modules WHERE id = $1",
            params![&module_id],
        )
        .await?;

    let schema: Vec<SettingDef> = config
        .as_ref()
        .and_then(|c| c.get("settings_schema"))
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    // Pages of the panel, in menu order. Empty for a module that declares none -
    // the console then renders the single page it always did.
    let groups = setting_groups_from_config(config.as_ref());

    // "May this caller see instance-scoped settings" is a settings question, so
    // it asks for the settings privilege rather than for a role.
    let is_admin = ctx.has(keys::SETTINGS_READ);
    let user_scope = SettingScope::user(user.id);
    let mut out: Vec<serde_json::Value> = Vec::new();

    for def in &schema {
        // Les non-admins ne voient pas les paramètres purement globaux.
        if def.scope == "global" && !is_admin {
            continue;
        }
        let full_key = format!("{}.{}", module_id, def.key);
        let resolved = chain::resolve_for(&state.db, &full_key, &user_scope).await?;

        // `global` reste exposé pour les interfaces existantes, mais il désigne
        // désormais « la valeur que ce compte hérite », c'est-à-dire l'unité la
        // plus proche s'il y en a une, sinon l'instance - et non plus le seul
        // niveau instance.
        let inherited = resolved.inherited_value.clone();
        let user_val = resolved
            .chain
            .iter()
            .find(|l| l.scope_type == ScopeKind::User.as_str())
            .map(|l| l.value.clone());

        let effective = resolved
            .value
            .clone()
            .unwrap_or_else(|| def.default.clone());

        out.push(json!({
            "key":              def.key,
            "scope":            def.scope,
            "type":             def.value_type,
            "values":           def.values,
            "label":            def.label,
            "description":      def.description,
            "category":         def.category.clone().unwrap_or_else(|| module_id.clone()),
            // Which page of the panel this belongs to; null = ungrouped.
            "group":            def.group,
            "default":          def.default,
            // Presentation metadata, forwarded verbatim: the console renders
            // the schema and nothing else, so a knob added by a module shows up -
            // searchable, bounded, folded where it belongs - with no change
            // on this side of the wire.
            "advanced":         def.advanced,
            "risk":             def.risk,
            "min":              def.min,
            "max":              def.max,
            "unit":             def.unit,
            "placeholder":      def.placeholder,
            "multiline":        def.multiline,
            "depends_on":       def.depends_on,
            "global":           inherited,
            "user":             user_val,
            "effective":        effective,
            "source":           resolved.source,
            "locked":           resolved.locked_above,
            "lock_source":      resolved.lock_source,
            // Un réglage verrouillé plus haut n'est plus modifiable par le
            // compte, quelle que soit sa portée déclarée.
            "editable_by_user": (def.scope == "user" || def.scope == "overridable")
                                    && resolved.can_override(),
        }));
    }

    Ok(Json(json!({
        "module":         module_id,
        "settings":       out,
        "setting_groups": groups,
    })))
}

pub async fn module_heartbeat(
    State(state): State<AppState>,
    internal: InternalRequest,
    axum::extract::Path(module_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_caller_is(&internal, &module_id)?;
    let found = state.modules.write().await.update_heartbeat(&module_id);
    if found {
        Ok(Json(json!({ "ok": true })))
    } else {
        Err(AppError::NotFound(format!("Module '{module_id}' non enregistré")))
    }
}

pub async fn unregister_module(
    State(state): State<AppState>,
    internal: InternalRequest,
    axum::extract::Path(module_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_caller_is(&internal, &module_id)?;
    state.modules.write().await.unregister(&module_id);
    crate::modules::manager::mark_stopped(&state.db, &module_id).await?;
    state.events.publish(AppEvent::ModuleUnregistered { module_id });
    Ok(Json(json!({ "message": "Module désenregistré" })))
}
