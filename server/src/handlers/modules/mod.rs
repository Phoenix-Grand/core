//! Module registry HTTP surface, split by responsibility:
//! - `assets`          - frontend asset serving (entry alias, logos, static)
//! - `settings_schema` - declared settings groups/fields, validation, read-back
//! - `registration`    - register/heartbeat/unregister lifecycle + guards
//!
//! This file keeps the module listing, the icon helpers, event/log endpoints,
//! and the tests, and re-exports the sub-modules so callers keep using
//! `crate::handlers::modules::<item>` unchanged.

use crate::{
    auth::middleware::InternalRequest,
    authz::{keys, AdminCtx},
    errors::AppError,
    events::AppEvent,
    state::AppState,
};
use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::json;

mod assets;
mod registration;
mod settings_schema;

pub use assets::*;
pub use registration::*;
pub use settings_schema::*;

#[utoipa::path(
    get,
    path = "/api/v1/modules",
    tag = "modules",
    responses((status = 200, description = "Modules actifs et leurs points d'entrée. Public : l'adresse interne (base_url) n'est servie qu'aux administrateurs."))
)]
/// `GET /api/v1/modules`
///
/// Stays **public on purpose**: the frontend loads module bundles before any
/// sign-in, because a module can serve anonymous routes (a form respondent
/// answering by link needs `forms`' bundle imported before the first render).
/// Requiring a token here would break that, so the fix is not authentication -
/// it is not leaking.
///
/// What used to leak: `base_url`, the module's **internal listening address**
/// (`http://127.0.0.1:3108`). Served to the whole internet, that is a free map
/// of the deployment's internal surface - ports, count of running modules, and
/// which of them are behind the reverse proxy. It is now emitted only to a
/// caller holding `core.modules.read`; everyone else gets the discovery fields
/// and nothing more.
pub async fn list_modules(
    State(state): State<AppState>,
    // Optional on purpose: an anonymous caller is served, just less.
    ctx: Option<AdminCtx>,
) -> Result<Json<serde_json::Value>, AppError> {
    let expose_base_url = ctx
        .map(|c| c.has(keys::MODULES_READ))
        .unwrap_or(false);

    let registry = state.modules.read().await;
    let modules: Vec<_> = registry
        .all()
        .into_iter()
        .map(|i| {
            // Bundle frontend du module (chargé à l'exécution par le host). Présent
            // seulement si le module a déposé son UI buildée dans <dir>/<id>/frontend/.
            // Les modules sans UI (ou non migrés vers le plugin runtime) renvoient null.
            let entry = module_disk_dir(&state.settings, &i.module_id)
                .join("frontend")
                .join("entry.js");
            // Cache-busting du point d'entrée UI du module : le hash du CONTENU
            // est mis DANS le nom (`entry-<hash>.js`), comme les chunks partagés
            // du core (`/shared/kubuno-shared-<hash>.js`) - pas de `?v=`. Sur
            // disque le fichier reste `entry.js` (le module l'émet à nom fixe,
            // sans connaître de hash) : `serve_module_asset` réécrit l'alias
            // hashé vers le vrai fichier. URL content-addressed → servie
            // `immutable` ET busted à chaque changement (nom d'URL différent, ce
            // qui casse aussi le cache iOS Safari indexé par URL). Le host dérive
            // le CSS avec le même hash (voir loadRemoteModules.ts). Sans rebuild
            // des modules ; les chunks internes sont déjà hashés.
            let frontend_entry = frontend_entry_version(&entry)
                .map(|v| format!("/modules/{}/entry-{}.js", i.module_id, v));
            let frontend_dist = &state.settings.server.frontend_dist;
            // Each sidebar item, with a per-sub-app `logo_url` added: a
            // launchable entry (Documents, Spreadsheets, Vertex…) has its own
            // brand logo, keyed by the item id. Serialised then augmented so the
            // item keeps all its stored fields and simply gains one.
            let sidebar_items: Vec<serde_json::Value> = i
                .sidebar_items
                .iter()
                .map(|item| {
                    let mut v = serde_json::to_value(item).unwrap_or_default();
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert(
                            "logo_url".into(),
                            json!(logo_url_for(frontend_dist, &item.id)),
                        );
                    }
                    v
                })
                .collect();
            json!({
                "module_id": i.module_id,
                // Internal address: administrators only. `null` for everyone
                // else, rather than an absent key, so clients keep one shape.
                "base_url": expose_base_url.then(|| i.base_url.clone()),
                "sidebar_items": sidebar_items,
                "frontend_entry": frontend_entry,
                // Brand logo of the module, served by the host as a static
                // asset. `null` when the module ships none (client keeps the
                // lucide `icon` of the sidebar item as its fallback).
                "logo_url": logo_url_for(frontend_dist, &i.module_id),
                "registered_at": i.registered_at,
                "last_heartbeat": i.last_heartbeat,
            })
        })
        .collect();

    Ok(Json(json!({ "modules": modules })))
}

pub fn module_icon(sidebar_items: &[crate::modules::registry::SidebarItem]) -> Option<String> {
    sidebar_items
        .iter()
        .min_by_key(|item| item.position)
        .map(|item| item.icon.clone())
        .filter(|icon| !icon.trim().is_empty())
}

/// The icon stored at registration, read back from the module's config.
pub fn module_icon_from_config(config: Option<&serde_json::Value>) -> Option<String> {
    config
        .and_then(|c| c.get("icon"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .filter(|icon| !icon.trim().is_empty())
}

pub async fn publish_event(
    State(state): State<AppState>,
    _internal: InternalRequest,
    Json(event): Json<AppEvent>,
) -> Result<Json<serde_json::Value>, AppError> {
    state.events.publish_and_log(event, &state.db).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ModuleLogEntry {
    pub level:   String,
    pub message: String,
    #[serde(default)]
    pub fields:  serde_json::Value,
}

/// Permet à un module d'écrire dans les logs du core (access.log / error.log).
///
/// WARN et ERROR sont routés vers error.log, INFO/DEBUG vers stdout uniquement.
/// Le module_id apparaît dans chaque ligne comme champ structuré.
pub async fn module_log(
    State(_state): State<AppState>,
    _internal: InternalRequest,
    axum::extract::Path(module_id): axum::extract::Path<String>,
    Json(entry): Json<ModuleLogEntry>,
) -> Result<Json<serde_json::Value>, AppError> {
    // target "module" est capturé par le filtre error.log pour WARN/ERROR
    match entry.level.as_str() {
        "error" => tracing::error!(target: "module", module = %module_id, fields = %entry.fields, "{}", entry.message),
        "warn"  => tracing::warn!(target: "module",  module = %module_id, fields = %entry.fields, "{}", entry.message),
        "debug" => tracing::debug!(target: "module", module = %module_id, fields = %entry.fields, "{}", entry.message),
        "trace" => tracing::trace!(target: "module", module = %module_id, fields = %entry.fields, "{}", entry.message),
        _       => tracing::info!(target: "module",  module = %module_id, fields = %entry.fields, "{}", entry.message),
    }
    Ok(Json(json!({ "ok": true })))
}


#[cfg(test)]
mod tests {
    use super::*;

    fn def(key: &str, value_type: &str) -> SettingDef {
        SettingDef {
            key:         key.into(),
            scope:       "global".into(),
            value_type:  value_type.into(),
            values:      None,
            default:     serde_json::Value::Null,
            label:       None,
            description: None,
            category:    None,
            group:       None,
            public:      false,
            advanced:    false,
            risk:        None,
            min:         None,
            max:         None,
            unit:        None,
            placeholder: None,
            multiline:   false,
            depends_on:  None,
        }
    }

    /// A manifest written before the presentation fields existed must still
    /// deserialise - that is the whole compatibility promise.
    #[test]
    fn legacy_manifest_deserialises_with_defaults() {
        let raw = serde_json::json!({
            "key": "port", "scope": "global", "type": "int", "default": 25
        });
        let d: SettingDef = serde_json::from_value(raw).expect("legacy shape");
        assert!(!d.advanced);
        assert!(!d.multiline);
        assert!(d.risk.is_none());
        assert!(d.min.is_none() && d.max.is_none());
        assert!(d.unit.is_none() && d.placeholder.is_none() && d.depends_on.is_none());
        assert!(d.group.is_none());
    }

    // ── Setting groups ──────────────────────────────────────────────────────

    fn group(id: &str) -> SettingGroup {
        SettingGroup {
            id:          id.into(),
            label:       format!("Groupe {id}"),
            icon:        None,
            position:    None,
            description: None,
        }
    }

    /// Every module but `mail` declares no group at all - that has to keep
    /// registering exactly as before.
    #[test]
    fn a_manifest_without_groups_is_valid() {
        let defs = [def("port", "int"), def("host", "string")];
        assert!(validate_setting_groups("drive", &[], &defs).is_ok());
        assert!(validate_setting_groups("drive", &[], &[]).is_ok());
    }

    /// A setting may stay ungrouped even in a manifest that declares groups:
    /// splitting a panel is opt-in, setting by setting.
    #[test]
    fn a_setting_without_group_is_valid() {
        let mut grouped = def("smtp_port", "int");
        grouped.group = Some("services".into());
        let loose = def("legacy_flag", "bool");
        assert!(validate_setting_groups("mail", &[group("services")], &[grouped, loose]).is_ok());
    }

    #[test]
    fn accepts_a_well_formed_group_declaration() {
        let mut g = group("transport-tls");
        g.icon = Some("Lock".into());
        g.position = Some(3);
        g.description = Some("Le chiffrement des connexions.".into());
        let mut d = def("tls_min_version", "string");
        d.group = Some("transport-tls".into());
        assert!(validate_setting_groups("mail", &[g], &[d]).is_ok());
    }

    #[test]
    fn rejects_a_dangling_group_reference() {
        let mut d = def("spf_fail_action", "string");
        d.group = Some("authentification".into());
        let err = validate_setting_groups("mail", &[group("authentication")], &[d]).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m)
            if m.contains("mail.spf_fail_action") && m.contains("authentification")));
    }

    /// A group cannot be referenced by a module that declares none: the whole
    /// point is that the reference resolves inside the same manifest.
    #[test]
    fn rejects_a_group_reference_without_any_group() {
        let mut d = def("a", "bool");
        d.group = Some("services".into());
        assert!(validate_setting_groups("mail", &[], &[d]).is_err());
    }

    #[test]
    fn rejects_a_non_slug_group_id() {
        for bad in ["Services", "authentification générale", "with space", "under_score", "à"] {
            let err = validate_setting_groups("mail", &[group(bad)], &[]).unwrap_err();
            assert!(
                matches!(err, AppError::Validation(ref m) if m.contains("slug")),
                "id '{bad}' aurait dû être refusé comme slug"
            );
        }
        // Digits and hyphens are what a URL segment is made of.
        assert!(validate_setting_groups("mail", &[group("imap-4")], &[]).is_ok());
    }

    #[test]
    fn rejects_empty_or_duplicate_group_id() {
        let err = validate_setting_groups("mail", &[group("")], &[]).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("empty ID")));

        let err = validate_setting_groups("mail", &[group("a"), group("a")], &[]).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("twice")));

        let long = "a".repeat(MAX_GROUP_ID_LEN + 1);
        assert!(validate_setting_groups("mail", &[group(&long)], &[]).is_err());
    }

    #[test]
    fn rejects_empty_group_label_or_icon() {
        let mut blank = group("services");
        blank.label = "   ".into();
        let err = validate_setting_groups("mail", &[blank], &[]).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("label")));

        let mut no_icon = group("services");
        no_icon.icon = Some(" ".into());
        assert!(validate_setting_groups("mail", &[no_icon], &[]).is_err());
    }

    /// The manifest shape the modules actually send, and the shape the console
    /// reads back - both go through serde, so both are pinned here.
    #[test]
    fn group_round_trips_through_json() {
        let raw = serde_json::json!({
            "id": "authentication",
            "label": "Authentification et signature",
            "icon": "ShieldCheck",
            "position": 4,
            "description": "Ce qui prouve qu'un message vient de son expéditeur."
        });
        let g: SettingGroup = serde_json::from_value(raw).expect("shape complète");
        assert_eq!(g.id, "authentication");
        assert_eq!(g.position, Some(4));

        // icon/position/description are optional: a group may be a label alone.
        let minimal: SettingGroup =
            serde_json::from_value(serde_json::json!({ "id": "misc", "label": "Divers" }))
                .expect("shape minimale");
        assert!(minimal.icon.is_none() && minimal.position.is_none());

        let back = serde_json::to_value(&g).expect("sérialisation");
        assert_eq!(back["icon"], "ShieldCheck");
    }

    /// What the admin menu depends on: positioned groups first, and whatever
    /// carries no position after them, in declaration order.
    #[test]
    fn groups_are_read_back_in_menu_order() {
        let config = serde_json::json!({
            "setting_groups": [
                { "id": "z-late",  "label": "Z" },
                { "id": "second",  "label": "S", "position": 2 },
                { "id": "first",   "label": "F", "position": 1 },
                { "id": "y-late",  "label": "Y" },
            ]
        });
        let ids: Vec<String> = setting_groups_from_config(Some(&config))
            .into_iter()
            .map(|g| g.id)
            .collect();
        assert_eq!(ids, ["first", "second", "z-late", "y-late"]);

        // A module registered before groups existed has no key at all.
        assert!(setting_groups_from_config(Some(&serde_json::json!({}))).is_empty());
        assert!(setting_groups_from_config(None).is_empty());
    }

    #[test]
    fn accepts_a_well_formed_manifest() {
        let mut flag = def("greylisting_enabled", "bool");
        flag.risk = Some("warning".into());
        let mut delay = def("greylist_delay_secs", "int");
        delay.min = Some(0);
        delay.max = Some(3600);
        delay.unit = Some("s".into());
        delay.advanced = true;
        delay.depends_on = Some("greylisting_enabled".into());
        let mut list = def("blocked_domains", "string");
        list.multiline = true;
        list.placeholder = Some("exemple.test".into());
        assert!(validate_settings_schema("mail", &[flag, delay, list]).is_ok());
    }

    #[test]
    fn rejects_unknown_risk() {
        let mut d = def("relay_host", "string");
        d.risk = Some("critical".into());
        let err = validate_settings_schema("mail", &[d]).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("risk 'critical'")));
    }

    #[test]
    fn rejects_inverted_bounds() {
        let mut d = def("max_size_mb", "int");
        d.min = Some(100);
        d.max = Some(10);
        let err = validate_settings_schema("mail", &[d]).unwrap_err();
        assert!(matches!(err, AppError::Validation(ref m) if m.contains("greater than max")));
    }

    #[test]
    fn rejects_bounds_on_non_int() {
        let mut d = def("banner", "string");
        d.max = Some(10);
        assert!(validate_settings_schema("mail", &[d]).is_err());
    }

    #[test]
    fn rejects_multiline_on_non_string() {
        let mut d = def("port", "int");
        d.multiline = true;
        assert!(validate_settings_schema("mail", &[d]).is_err());
    }

    #[test]
    fn rejects_empty_or_dangling_depends_on() {
        let mut empty = def("a", "int");
        empty.depends_on = Some("   ".into());
        assert!(validate_settings_schema("mail", &[empty]).is_err());

        let mut dangling = def("a", "int");
        dangling.depends_on = Some("typo_enabled".into());
        assert!(validate_settings_schema("mail", &[dangling]).is_err());

        // Points at a real key, but that key is not a boolean.
        let mut wrong_type = def("a", "int");
        wrong_type.depends_on = Some("host".into());
        let host = def("host", "string");
        assert!(validate_settings_schema("mail", &[wrong_type, host]).is_err());

        let mut selfref = def("a", "bool");
        selfref.depends_on = Some("a".into());
        assert!(validate_settings_schema("mail", &[selfref]).is_err());
    }

    #[test]
    fn enforces_bounds_on_write() {
        let mut d = def("retry_minutes", "int");
        d.min = Some(1);
        d.max = Some(60);
        assert!(d.validate_value(&serde_json::json!(30)).is_ok());
        // A console echoing a text field sends the number as a string.
        assert!(d.validate_value(&serde_json::json!("30")).is_ok());
        assert!(d.validate_value(&serde_json::json!(0)).is_err());
        assert!(d.validate_value(&serde_json::json!(61)).is_err());
        assert!(d.validate_value(&serde_json::json!("abc")).is_err());
        // Unbounded declarations, and non-int types, let everything through.
        let plain = def("host", "string");
        assert!(plain.validate_value(&serde_json::json!("anything")).is_ok());
    }
}
