use crate::{
    authz::{keys, AdminCtx},
    audit::{redact::target, AdminAudit, AuditEntry},
    errors::AppError,
    state::AppState,
};
use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, HeaderValue},
    response::Response,
    Json,
};
use kubuno_db::{dialect::Assign, params, DbPool};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;

// IDs of the themes shipped with the application - protected from replacement and
// deletion. There are no longer any compiled-in builtins (the former "Kubuno
// Light" / "Kubuno Dark" were removed); themes now live entirely in themes_dir.
const BUILTIN_IDS: &[&str] = &[];

// Settings key holding the JSON array of theme IDs the admin trusts to run JS.
const TRUSTED_KEY: &str = "appearance.trusted_themes";

// Hard limits for ZIP theme import (defense against zip bombs / oversized uploads).
const MAX_ZIP_BYTES: usize = 25 * 1024 * 1024; // compressed upload cap
const MAX_TOTAL_UNCOMPRESSED: u64 = 40 * 1024 * 1024; // sum of extracted files
const MAX_FILE_UNCOMPRESSED: u64 = 8 * 1024 * 1024; // single extracted file
const MAX_FILES: usize = 400;

// Extensions allowed inside a theme bundle. Anything else is rejected at import.
const ALLOWED_EXTS: &[&str] = &[
    "json", "css", "js", "mjs", "map", "svg", "png", "jpg", "jpeg", "webp", "gif", "woff", "woff2",
    "ttf", "otf",
];

/// One CSS/JS pair a theme provides, either globally or for a targeted module.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ThemeAsset {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub css: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
}

/// A theme manifest. Backward compatible with the legacy "vars-only" theme files
/// (where `global`/`modules` are absent): such a theme simply restyles via CSS vars.
/// A bundled theme (imported as a ZIP) may additionally ship a global stylesheet/
/// script and per-module stylesheets/scripts that override component appearance.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ThemeManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color_scheme: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_api_version: Option<u32>,
    #[serde(default)]
    pub vars: HashMap<String, String>,
    /// Global skin: applies everywhere in the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global: Option<ThemeAsset>,
    /// Per-module skins, keyed by module id. Only the modules listed here are
    /// affected; every other module keeps its default appearance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modules: Option<HashMap<String, ThemeAsset>>,
}

impl ThemeManifest {
    /// Whether the theme ships any JavaScript override (global or per-module).
    fn has_scripts(&self) -> bool {
        let global_js = self.global.as_ref().is_some_and(|a| a.script.is_some());
        let module_js = self
            .modules
            .as_ref()
            .is_some_and(|m| m.values().any(|a| a.script.is_some()));
        global_js || module_js
    }
}

/// An entry returned by `list_themes`: the manifest plus runtime metadata the
/// frontend needs to decide what to load and whether scripts are allowed.
#[derive(Debug, Clone, Serialize)]
pub struct ThemeEntry {
    #[serde(flatten)]
    pub manifest: ThemeManifest,
    pub builtin: bool,
    /// True if the bundle carries JS overrides.
    pub has_scripts: bool,
    /// True if the admin trusts this theme to run its JS in users' browsers.
    pub scripts_enabled: bool,
    /// Base URL to fetch this theme's bundled assets, e.g. `/api/v1/themes/<id>`.
    /// `None` for built-in / legacy vars-only themes (no asset bundle on disk).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets_base: Option<String>,
}

fn is_valid_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Path of a legacy single-file (vars-only) theme inside `themes_dir`.
fn theme_file_path(themes_dir: &str, id: &str) -> Result<String, AppError> {
    if !is_valid_theme_id(id) {
        return Err(AppError::Validation(
            "Invalid theme ID (allowed characters: a-z, 0-9, -, _)".into(),
        ));
    }
    Ok(format!("{}/{}.json", themes_dir, id))
}

/// Directory of a bundled theme inside `themes_dir`.
fn theme_dir_path(themes_dir: &str, id: &str) -> Result<std::path::PathBuf, AppError> {
    if !is_valid_theme_id(id) {
        return Err(AppError::Validation(
            "Invalid theme ID (allowed characters: a-z, 0-9, -, _)".into(),
        ));
    }
    Ok(std::path::Path::new(themes_dir).join(id))
}

// ── Trust list (admin-controlled set of theme IDs allowed to run scripts) ──────

async fn load_trusted(db: &DbPool) -> HashSet<String> {
    match db
        .fetch_optional_scalar::<Value>(
            "SELECT value FROM core.settings WHERE \"key\" = $1",
            params![TRUSTED_KEY],
        )
        .await
    {
        Ok(Some(Value::Array(arr))) => arr
            .into_iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        Ok(_) => HashSet::new(),
        Err(e) => {
            tracing::error!("Lecture de {TRUSTED_KEY} impossible: {e}");
            HashSet::new()
        }
    }
}

async fn save_trusted(db: &DbPool, trusted: &HashSet<String>) -> Result<(), AppError> {
    let mut ids: Vec<&String> = trusted.iter().collect();
    ids.sort();
    let value = json!(ids);
    let backend = db.backend();
    let clause = backend.upsert(
        "core.settings",
        &["key"],
        &[Assign::Incoming("value"), Assign::Incoming("updated_at")],
    );
    let sql = format!(
        "INSERT INTO core.settings (\"key\", value, category, label, is_public, updated_at) \
         VALUES ($1, $2, 'appearance', 'Thèmes autorisés à exécuter des scripts', FALSE, $3){clause}"
    );
    db.execute(&sql, params![TRUSTED_KEY, value, chrono::Utc::now()])
        .await
        .map_err(|e| {
        tracing::error!("Écriture de {TRUSTED_KEY} impossible: {e}");
        AppError::Internal(anyhow::anyhow!("Impossible d'enregistrer la confiance des thèmes"))
    })?;
    Ok(())
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/// GET /api/v1/themes - list every available theme (public, no auth).
pub async fn list_themes(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let trusted = load_trusted(&state.db).await;
    let themes = load_all_themes(&state.settings.server.themes_dir, &trusted);
    Ok(Json(json!({ "themes": themes })))
}

/// POST /api/v1/admin/themes - import a vars-only theme as JSON (admin only).
/// Kept for backward compatibility with the simple JSON theme editor/upload.
pub async fn create_theme(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(theme): Json<ThemeManifest>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::THEMES_MANAGE)?;
    if BUILTIN_IDS.contains(&theme.id.as_str()) {
        return Err(AppError::Validation(
            "Cannot replace a theme bundled with the application".into(),
        ));
    }
    if theme.name.trim().is_empty() {
        return Err(AppError::Validation("The theme must have a name".into()));
    }
    if theme.vars.is_empty() {
        return Err(AppError::Validation(
            "The theme must contain color variables".into(),
        ));
    }

    let themes_dir = &state.settings.server.themes_dir;
    let path = theme_file_path(themes_dir, &theme.id)?;

    if let Err(e) = std::fs::create_dir_all(themes_dir) {
        tracing::error!("Impossible de créer le répertoire de thèmes {themes_dir}: {e}");
        return Err(AppError::Internal(anyhow::anyhow!(
            "Impossible de créer le répertoire de thèmes"
        )));
    }

    let json = serde_json::to_string_pretty(&theme)
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;

    std::fs::write(&path, &json).map_err(|e| {
        tracing::error!("Impossible d'écrire le thème {path}: {e}");
        AppError::Internal(anyhow::anyhow!("Impossible d'enregistrer le thème"))
    })?;

    tracing::info!("Thème '{}' importé ({})", theme.id, path);

    // Themes live on disk, not in a table: there is no transaction to ride
    // along with, so the entry is recorded standalone once the write succeeded.
    audit
        .record(
            &state.db,
            AuditEntry::new("core.themes.create")
                .target(target::THEME, &theme.id, theme.name.clone())
                .after(json!({ "id": &theme.id, "name": &theme.name, "source": "json" })),
        )
        .await;

    mirror_themes(&state);
    Ok(Json(json!({ "theme": theme })))
}

/// Rebuild the Drive `System/Themes` mirror off the request path (best-effort).
fn mirror_themes(state: &AppState) {
    let st = state.clone();
    tokio::spawn(async move { crate::handlers::theme_mirror::sync(&st).await });
}

/// POST /api/v1/admin/themes/import - import a bundled theme as a `.zip` (admin).
/// The archive must contain a `theme.json` manifest at its root plus any
/// referenced CSS/JS/asset files. Extraction is strictly validated.
pub async fn import_theme_zip(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    mut multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("import d'un thème empaqueté")?;
    let mut zip_bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::Validation(format!("Invalid field: {e}")))?
    {
        if field.name() == Some("file") {
            let data = field
                .bytes()
                .await
                .map_err(|e| AppError::Validation(format!("Reading file: {e}")))?;
            if data.len() > MAX_ZIP_BYTES {
                return Err(AppError::Validation(format!(
                    "The archive must not exceed {} MB",
                    MAX_ZIP_BYTES / (1024 * 1024)
                )));
            }
            zip_bytes = Some(data.to_vec());
        }
    }

    let zip_bytes =
        zip_bytes.ok_or_else(|| AppError::Validation("Missing 'file' field (.zip archive)".into()))?;
    let themes_dir = state.settings.server.themes_dir.clone();

    // The `zip` crate is synchronous and extraction touches the filesystem - run
    // it off the async runtime to avoid blocking the executor.
    let manifest = tokio::task::spawn_blocking(move || extract_theme_zip(zip_bytes, &themes_dir))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?
        .map_err(AppError::Validation)?;

    let trusted = load_trusted(&state.db).await;
    let entry = ThemeEntry {
        has_scripts: manifest.has_scripts(),
        scripts_enabled: trusted.contains(&manifest.id),
        assets_base: Some(format!("/api/v1/themes/{}", manifest.id)),
        builtin: false,
        manifest,
    };
    tracing::info!("Thème '{}' importé (bundle ZIP)", entry.manifest.id);

    audit
        .record(
            &state.db,
            AuditEntry::new("core.themes.import")
                .target(target::THEME, &entry.manifest.id, entry.manifest.name.clone())
                .after(json!({
                    "id": &entry.manifest.id,
                    "name": &entry.manifest.name,
                    "source": "zip",
                    // Whether the bundle ships JavaScript at all: the operator
                    // reading the trail wants that before the trust decision.
                    "has_scripts": entry.has_scripts,
                })),
        )
        .await;

    mirror_themes(&state);
    Ok(Json(json!({ "theme": entry })))
}

/// Synchronous, sandboxed extraction of a theme archive into `themes_dir/<id>/`.
/// Returns the validated manifest, or a human-readable validation error.
fn extract_theme_zip(zip_bytes: Vec<u8>, themes_dir: &str) -> Result<ThemeManifest, String> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Archive ZIP invalide : {e}"))?;

    if archive.len() > MAX_FILES {
        return Err(format!("Trop de fichiers dans l'archive (max {MAX_FILES})"));
    }

    // 1. Read & validate the manifest first so we know the target directory.
    let manifest: ThemeManifest = {
        let mut f = archive
            .by_name("theme.json")
            .map_err(|_| "theme.json is missing from the archive root".to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s)
            .map_err(|e| format!("Lecture de theme.json : {e}"))?;
        serde_json::from_str(&s).map_err(|e| format!("theme.json invalide : {e}"))?
    };

    if !is_valid_theme_id(&manifest.id) {
        return Err("Invalid theme ID (a-z, 0-9, -, _, maximum 64)".into());
    }
    if BUILTIN_IDS.contains(&manifest.id.as_str()) {
        return Err("Cannot replace a theme bundled with the application".into());
    }
    if manifest.name.trim().is_empty() {
        return Err("The theme must have a name".into());
    }

    let dest = std::path::Path::new(themes_dir).join(&manifest.id);
    // Replace any previous version of this theme.
    if dest.exists() {
        std::fs::remove_dir_all(&dest)
            .map_err(|e| format!("Cleaning up the old theme: {e}"))?;
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("Creating directory: {e}"))?;

    // 2. Extract every entry with strict guards.
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Reading entry {i}: {e}"))?;
        if file.is_dir() {
            continue;
        }
        // `enclosed_name` rejects absolute paths and `..` traversal.
        let rel = match file.enclosed_name() {
            Some(p) => p,
            None => return Err("Unsafe file name in archive".into()),
        };
        let ext = rel
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !ALLOWED_EXTS.contains(&ext.as_str()) {
            return Err(format!("File type not allowed: {}", rel.display()));
        }
        let size = file.size();
        if size > MAX_FILE_UNCOMPRESSED {
            return Err(format!("Fichier trop volumineux : {}", rel.display()));
        }
        total = total.saturating_add(size);
        if total > MAX_TOTAL_UNCOMPRESSED {
            return Err("Uncompressed archive is too large".into());
        }

        let out_path = dest.join(&rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Creating folder: {e}"))?;
        }
        let mut out = std::fs::File::create(&out_path)
            .map_err(|e| format!("Writing {}: {e}", rel.display()))?;
        std::io::copy(&mut file, &mut out)
            .map_err(|e| format!("Copie de {} : {e}", rel.display()))?;
    }

    Ok(manifest)
}

/// GET /api/v1/themes/:id/*path - serve a bundled theme's asset (public).
/// Scoped to the theme's own directory; rejects path traversal.
pub async fn serve_theme_asset(
    State(state): State<AppState>,
    Path((id, asset_path)): Path<(String, String)>,
) -> Result<Response, AppError> {
    if !is_valid_theme_id(&id) {
        return Err(AppError::NotFound("theme".into()));
    }
    if asset_path
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(AppError::NotFound("asset".into()));
    }

    let full = std::path::Path::new(&state.settings.server.themes_dir)
        .join(&id)
        .join(&asset_path);

    let data = tokio::fs::read(&full)
        .await
        .map_err(|_| AppError::NotFound("asset".into()))?;

    let content_type = match asset_path.rsplit('.').next() {
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    };

    let mut resp = Response::new(Body::from(data));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    Ok(resp)
}

#[derive(Debug, Deserialize)]
pub struct TrustDto {
    pub scripts_enabled: bool,
}

/// PATCH /api/v1/admin/themes/:id/trust - allow or forbid a theme to run its JS
/// overrides in users' browsers (admin only). CSS is always applied regardless.
pub async fn set_theme_trust(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<String>,
    Json(dto): Json<TrustDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require_superuser("approbation d'un thème")?;
    if !is_valid_theme_id(&id) {
        return Err(AppError::Validation("Invalid theme ID".into()));
    }
    if BUILTIN_IDS.contains(&id.as_str()) {
        // Built-ins carry no scripts - nothing to trust.
        return Err(AppError::Validation(
            "Built-in themes do not run scripts".into(),
        ));
    }

    let mut trusted = load_trusted(&state.db).await;
    let was_trusted = trusted.contains(&id);
    if dto.scripts_enabled {
        trusted.insert(id.clone());
    } else {
        trusted.remove(&id);
    }
    save_trusted(&state.db, &trusted).await?;

    tracing::info!(
        "Thème '{id}' : exécution des scripts {}",
        if dto.scripts_enabled { "AUTORISÉE" } else { "révoquée" }
    );

    // Granting a theme the right to run JavaScript in every user's browser is
    // one of the most consequential switches in the console - it belongs in the
    // trail with an explicit before/after.
    audit
        .record(
            &state.db,
            AuditEntry::new("core.themes.trust")
                .target(target::THEME, &id, id.clone())
                .before(json!({ "id": &id, "trusted": was_trusted }))
                .after(json!({ "id": &id, "trusted": dto.scripts_enabled }))
                .reversible(),
        )
        .await;

    Ok(Json(json!({ "id": id, "scripts_enabled": dto.scripts_enabled })))
}

/// DELETE /api/v1/admin/themes/:id - delete a custom theme (admin only).
/// Built-in themes cannot be deleted. Handles both bundle dirs and legacy files.
pub async fn delete_theme(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::THEMES_MANAGE)?;
    if BUILTIN_IDS.contains(&id.as_str()) {
        // Refused attempt: recorded like any other, it is the interesting kind.
        audit
            .record(
                &state.db,
                AuditEntry::new("core.themes.delete")
                    .target(target::THEME, &id, id.clone())
                    .denied("builtin_theme"),
            )
            .await;
        return Err(AppError::Forbidden);
    }

    let themes_dir = &state.settings.server.themes_dir;
    let dir = theme_dir_path(themes_dir, &id)?;
    let file = theme_file_path(themes_dir, &id)?;

    let mut removed = false;
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| {
            tracing::error!("Impossible de supprimer le thème {dir:?}: {e}");
            AppError::Internal(anyhow::anyhow!("Impossible de supprimer le thème"))
        })?;
        removed = true;
    }
    if std::path::Path::new(&file).exists() {
        std::fs::remove_file(&file).map_err(|e| {
            tracing::error!("Impossible de supprimer le thème {file}: {e}");
            AppError::Internal(anyhow::anyhow!("Impossible de supprimer le thème"))
        })?;
        removed = true;
    }

    if !removed {
        return Err(AppError::NotFound(format!("Theme '{id}' not found")));
    }

    // Drop it from the trust list as well, so a re-import starts untrusted.
    let mut trusted = load_trusted(&state.db).await;
    if trusted.remove(&id) {
        let _ = save_trusted(&state.db, &trusted).await;
    }

    tracing::info!("Thème '{id}' supprimé");

    audit
        .record(
            &state.db,
            AuditEntry::new("core.themes.delete")
                .target(target::THEME, &id, id.clone())
                .before(json!({ "id": &id })),
        )
        .await;

    mirror_themes(&state);
    Ok(Json(json!({ "deleted": id })))
}

// ── Internal: enumerate all themes (built-ins + bundles + legacy files) ─────────

fn parse_manifest(raw: &str) -> Option<ThemeManifest> {
    serde_json::from_str::<ThemeManifest>(raw).ok()
}

pub(crate) fn load_all_themes(themes_dir: &str, trusted: &HashSet<String>) -> Vec<ThemeEntry> {
    let mut entries: Vec<ThemeEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let dir = match std::fs::read_dir(themes_dir) {
        Ok(d) => d,
        Err(_) => return entries, // directory may not exist yet
    };

    for entry in dir.flatten() {
        let path = entry.path();

        // Bundled theme: a subdirectory containing a theme.json manifest.
        if path.is_dir() {
            let manifest_path = path.join("theme.json");
            let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
                continue;
            };
            let Some(m) = parse_manifest(&raw) else {
                tracing::warn!("Manifeste de thème ignoré ({manifest_path:?})");
                continue;
            };
            if !is_valid_theme_id(&m.id) || seen.contains(&m.id) {
                continue;
            }
            seen.insert(m.id.clone());
            let has_scripts = m.has_scripts();
            entries.push(ThemeEntry {
                has_scripts,
                scripts_enabled: has_scripts && trusted.contains(&m.id),
                assets_base: Some(format!("/api/v1/themes/{}", m.id)),
                builtin: false,
                manifest: m,
            });
            continue;
        }

        // Legacy vars-only theme: a single *.json file.
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Some(m) = parse_manifest(&raw) else {
                tracing::warn!("Thème ignoré ({path:?})");
                continue;
            };
            if !is_valid_theme_id(&m.id) || seen.contains(&m.id) {
                continue;
            }
            seen.insert(m.id.clone());
            entries.push(ThemeEntry {
                has_scripts: false,
                scripts_enabled: false,
                assets_base: None,
                builtin: false,
                manifest: m,
            });
        }
    }

    entries
}
