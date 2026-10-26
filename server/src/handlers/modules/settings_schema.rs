//! Module settings schema: declared groups/fields, validation, and the
//! internal read-back of a module's instance settings.

use crate::{auth::middleware::InternalRequest, errors::AppError, state::AppState};
use axum::{
    extract::{Path as AxumPath, State},
    Json,
};
use kubuno_db::{params, DbPool};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::*;

/// One page of a module's administration surface.
///
/// A group sits ABOVE `category`: it is an entry of the admin menu tree under
/// the module, with its own address (`/admin/modules/<module>/<group>`), and the
/// `category` of each of its settings becomes a tab inside it. Forty-eight knobs
/// on one page is a wall nobody reads; five addresses, each answering one
/// question, is a panel.
///
/// `id` is a STABLE, UNTRANSLATED slug because it travels in the URL - an
/// address may not change shape with the interface language.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SettingGroup {
    pub id:          String,
    pub label:       String,
    /// Lucide icon name, shown in the menu.
    #[serde(default)]
    pub icon:        Option<String>,
    /// Menu order. Absent = after every positioned group, declaration order kept.
    #[serde(default)]
    pub position:    Option<i32>,
    /// One sentence read at the top of the page.
    #[serde(default)]
    pub description: Option<String>,
}

/// Une déclaration de paramètre poussée par un module à l'enregistrement.
/// `key` est relatif au module (sans préfixe) ; le core le stocke sous
/// `<module_id>.<key>` dans core.settings.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SettingDef {
    pub key:         String,
    /// "global" (admin only), "user" (par utilisateur), "overridable"
    /// (défaut global surchargeable par l'utilisateur).
    pub scope:       String,
    /// "bool" | "int" | "string" | "enum"
    #[serde(rename = "type")]
    pub value_type:  String,
    /// Domaine des valeurs autorisées pour `type = "enum"`.
    #[serde(default)]
    pub values:      Option<Vec<serde_json::Value>>,
    /// Valeur par défaut (sortie d'usine).
    pub default:     serde_json::Value,
    #[serde(default)]
    pub label:       Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Sous-catégorie d'affichage (sinon = module_id).
    #[serde(default)]
    pub category:    Option<String>,
    /// Id of a `[[setting_groups]]` entry of the SAME manifest: which page of the
    /// module's admin surface this setting belongs to. `None` = ungrouped, which
    /// is what every module declared before groups existed.
    #[serde(default)]
    pub group:       Option<String>,
    /// Exposé dans /api/v1/config public (is_public).
    #[serde(default)]
    pub public:      bool,

    // ---------------------------------------------------------------------
    // Presentation metadata. Every field below is optional and defaulted, so a
    // manifest written before they existed still deserialises unchanged.
    //
    // They are what lets a module with seventy knobs (mail) stay readable
    // without a single line of module-specific code in the admin console: the
    // console renders the schema, and only the schema.
    // ---------------------------------------------------------------------
    /// Rare/expert knob: folded behind an "Avancé" disclosure inside its section.
    #[serde(default)]
    pub advanced:    bool,
    /// "info" | "warning" | "danger" - how loudly the console must warn before
    /// this is changed. `danger` means "can make the server unreachable or lose
    /// mail" and requires an explicit confirmation in the UI.
    #[serde(default)]
    pub risk:        Option<String>,
    /// Bounds for `type = "int"`, enforced by the console AND by the API.
    #[serde(default)]
    pub min:         Option<i64>,
    #[serde(default)]
    pub max:         Option<i64>,
    /// Suffix shown after the field ("Mo", "s", "min", "‰").
    #[serde(default)]
    pub unit:        Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    /// The `string` value is a LIST, one entry per line → textarea.
    #[serde(default)]
    pub multiline:   bool,
    /// Key of another `bool` setting of the SAME module. The setting is hidden
    /// while that boolean is false - a panel must shrink when a feature is off.
    #[serde(default)]
    pub depends_on:  Option<String>,
}

pub const VALID_SCOPES:      &[&str] = &["global", "user", "overridable"];
pub const VALID_VALUE_TYPES: &[&str] = &["bool", "int", "string", "enum"];
const VALID_RISKS:       &[&str] = &["info", "warning", "danger"];

impl SettingDef {
    /// Rejects a value that violates the bounds this definition declares.
    ///
    /// Called by the console-facing write path as well as by registration: a
    /// front end can be bypassed, so `min`/`max` only mean something if the API
    /// says no too.
    pub fn validate_value(&self, value: &serde_json::Value) -> Result<(), AppError> {
        if self.value_type != "int" || (self.min.is_none() && self.max.is_none()) {
            return Ok(());
        }
        // JSON numbers arrive as i64 most of the time, but a console that echoes
        // a text field can send "25". Both mean the same integer here.
        let n = match value {
            serde_json::Value::Number(n) => n.as_i64(),
            serde_json::Value::String(s) => s.trim().parse::<i64>().ok(),
            serde_json::Value::Null      => return Ok(()),
            _                            => None,
        };
        let Some(n) = n else {
            return Err(AppError::Validation(format!(
                "'{}' expects an integer",
                self.key
            )));
        };
        let label = self.label.clone().unwrap_or_else(|| self.key.clone());
        if let Some(min) = self.min {
            if n < min {
                return Err(AppError::Validation(format!(
                    "'{label}' must be greater than or equal to {min}"
                )));
            }
        }
        if let Some(max) = self.max {
            if n > max {
                return Err(AppError::Validation(format!(
                    "'{label}' must be less than or equal to {max}"
                )));
            }
        }
        Ok(())
    }
}

/// Validates the presentation metadata of a whole manifest.
///
/// Unlike `scope` and `type` - tolerated with a warning since the first
/// modules shipped, and skipped one by one - a malformed *new* field aborts the
/// registration. These fields are new: nothing in the wild carries them, so
/// there is no compatibility to protect, and a knob silently dropped from an
/// administration panel is worse than a module that refuses to start.
pub fn validate_settings_schema(module_id: &str, defs: &[SettingDef]) -> Result<(), AppError> {
    let bool_keys: std::collections::HashSet<&str> = defs
        .iter()
        .filter(|d| d.value_type == "bool")
        .map(|d| d.key.as_str())
        .collect();

    for def in defs {
        let where_ = format!("{module_id}.{}", def.key);

        if let Some(risk) = &def.risk {
            if !VALID_RISKS.contains(&risk.as_str()) {
                return Err(AppError::Validation(format!(
                    "{where_}: unknown risk '{risk}' (expected: info, warning, or danger)"
                )));
            }
        }

        if def.min.is_some() || def.max.is_some() {
            if def.value_type != "int" {
                return Err(AppError::Validation(format!(
                    "{where_}: min/max only apply to type = \"int\" (received \"{}\")",
                    def.value_type
                )));
            }
            if let (Some(min), Some(max)) = (def.min, def.max) {
                if min > max {
                    return Err(AppError::Validation(format!(
                        "{where_}: min ({min}) is greater than max ({max})"
                    )));
                }
            }
        }

        if def.multiline && def.value_type != "string" {
            return Err(AppError::Validation(format!(
                "{where_}: multiline only applies to type = \"string\" (received \"{}\")",
                def.value_type
            )));
        }

        if let Some(parent) = &def.depends_on {
            if parent.trim().is_empty() {
                return Err(AppError::Validation(format!(
                    "{where_}: depends_on is empty"
                )));
            }
            if parent == &def.key {
                return Err(AppError::Validation(format!(
                    "{where_}: depends_on references itself"
                )));
            }
            // Resolved against this manifest on purpose: a typo would otherwise
            // hide the setting for good, with nothing to point at.
            if !bool_keys.contains(parent.as_str()) {
                return Err(AppError::Validation(format!(
                    "{where_}: depends_on = '{parent}' does not name a boolean setting declared by this module"
                )));
            }
        }
    }
    Ok(())
}

/// Longest acceptable group slug - it is a path segment, not a sentence.
pub(super) const MAX_GROUP_ID_LEN: usize = 50;

/// Validates the `[[setting_groups]]` of a manifest and every reference to them.
///
/// A module that declares no group is valid and unchanged: `groups` empty and no
/// setting carrying a `group` passes straight through. What is refused is a
/// half-declaration - a setting pointing at a group that does not exist would
/// vanish from every page of the panel, silently, which is exactly the failure
/// mode groups exist to prevent.
///
/// `id` is checked as a URL slug because it IS one: it becomes a path segment of
/// `/admin/modules/<module>/<group>`. An accent or a space there would either be
/// percent-encoded on every link or break the route outright.
pub fn validate_setting_groups(
    module_id: &str,
    groups: &[SettingGroup],
    defs: &[SettingDef],
) -> Result<(), AppError> {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();

    for g in groups {
        let id = g.id.as_str();
        if id.is_empty() {
            return Err(AppError::Validation(format!(
                "{module_id}: a settings group has an empty ID"
            )));
        }
        if id.len() > MAX_GROUP_ID_LEN {
            return Err(AppError::Validation(format!(
                "{module_id}: group ID '{id}' exceeds {MAX_GROUP_ID_LEN} characters"
            )));
        }
        if !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(AppError::Validation(format!(
                "{module_id}: group ID '{id}' is not a URL slug (only lowercase letters, numbers, and hyphens)"
            )));
        }
        if !seen.insert(id) {
            return Err(AppError::Validation(format!(
                "{module_id}: group ID '{id}' is declared twice"
            )));
        }
        if g.label.trim().is_empty() {
            return Err(AppError::Validation(format!(
                "{module_id}: group '{id}' has no label"
            )));
        }
        if let Some(icon) = &g.icon {
            if icon.trim().is_empty() {
                return Err(AppError::Validation(format!(
                    "{module_id}: group '{id}' declares an empty icon"
                )));
            }
        }
    }

    for def in defs {
        let Some(group) = &def.group else { continue };
        if !seen.contains(group.as_str()) {
            return Err(AppError::Validation(format!(
                "{module_id}.{}: group = '{group}' does not name a [[setting_groups]] declared by this module",
                def.key
            )));
        }
    }

    Ok(())
}

/// Reads back the groups a module pushed at registration, in menu order.
///
/// `position` first (ascending), then declaration order for whatever has none -
/// a sort that is stable, so a module that positions nothing keeps its manifest's
/// order rather than an arbitrary one.
/// The glyph that stands for a module: the icon of its ENTRY POINT - the
/// sidebar item with the lowest position, which is the same rule the shell and
/// the waffle menu already use to pick a module's face. Deriving it rather than
/// asking modules to declare a second icon keeps one answer to "what does this
/// application look like".
///
/// `None` when the module ships no sidebar item at all (a headless module); the
/// console then draws its neutral placeholder rather than borrowing another
/// module's glyph.
pub fn setting_groups_from_config(config: Option<&serde_json::Value>) -> Vec<SettingGroup> {
    let mut groups: Vec<SettingGroup> = config
        .and_then(|c| c.get("setting_groups"))
        .and_then(|g| serde_json::from_value(g.clone()).ok())
        .unwrap_or_default();
    groups.sort_by_key(|g| g.position.unwrap_or(i32::MAX));
    groups
}

/// Reads back the declarative schema a module pushed at registration.
///
/// The manifest is kept whole in `core.modules.config` (see `register_module`),
/// which is what makes every presentation field survive the round trip without
/// a column per attribute in `core.settings`.
pub async fn load_settings_schema(
    db: &DbPool,
    module_id: &str,
) -> Result<Vec<SettingDef>, AppError> {
    let config: Option<serde_json::Value> = db
        .fetch_optional_scalar::<serde_json::Value>(
            "SELECT config FROM core.modules WHERE id = $1",
            params![module_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, module = %module_id, "reading the settings schema");
            AppError::Database(e)
        })?;

    Ok(config
        .as_ref()
        .and_then(|c| c.get("settings_schema"))
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default())
}

pub const RESERVED_MODULE_IDS: &[&str] = &[
    "admin", "auth", "me", "config", "modules", "ws", "health", "ready",
    "internal", "api", "static", "assets",
];
pub async fn internal_module_settings(
    State(state): State<AppState>,
    internal: InternalRequest,
) -> Result<Json<serde_json::Value>, AppError> {
    let module_id = internal
        .module_id()
        .ok_or(AppError::Forbidden)?
        .to_string();

    build_module_settings(&state.db, &module_id).await
}

/// The same read, but the module is named by the URL rather than derived from
/// the secret it presented.
///
/// This is what a module uses on an instance that has NOT enabled per-module
/// derived secrets: every module then presents the master secret, which
/// authenticates the caller as being inside the instance but does not IDENTIFY
/// it, so the secret-only route above answers `403` to all of them. Here the id
/// in the path says whose settings to return, and the internal secret is the
/// proof of belonging - exactly the trust every other `/internal/modules/:id/*`
/// route (heartbeat, unregister) already extends to the master secret.
///
/// When derived secrets ARE in force the caller is identified as well, and
/// [`ensure_caller_is`] then holds it to its own id - a module can never read
/// another module's settings. So the URL is a convenience for the shared-secret
/// deployment, never a way around the isolation of the derived one.
pub async fn internal_module_settings_by_id(
    State(state): State<AppState>,
    internal: InternalRequest,
    AxumPath(module_id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_caller_is(&internal, &module_id)?;
    build_module_settings(&state.db, &module_id).await
}

/// The instance-scoped settings of one module, keyed by their SHORT name (the
/// `<module>.` prefix stripped) with the effective value - the stored one, or
/// the declared default when nothing was ever set.
async fn build_module_settings(
    db: &DbPool,
    module_id: &str,
) -> Result<Json<serde_json::Value>, AppError> {
    let rows: Vec<(String, serde_json::Value, Option<serde_json::Value>)> = db
        .fetch_all_as::<(String, serde_json::Value, Option<serde_json::Value>)>(
            "SELECT \"key\", value, default_value FROM core.settings \
             WHERE module_id = $1 AND scope IN ('global', 'overridable')",
            params![module_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, module = %module_id, "module internal settings");
            AppError::Database(e)
        })?;

    let prefix = format!("{module_id}.");
    let mut settings = serde_json::Map::new();
    for (key, value, default_value) in rows {
        let short = key.strip_prefix(&prefix).unwrap_or(&key).to_string();
        let effective = if value.is_null() {
            default_value.unwrap_or(serde_json::Value::Null)
        } else {
            value
        };
        settings.insert(short, effective);
    }

    Ok(Json(json!({ "module": module_id, "settings": settings })))
}
