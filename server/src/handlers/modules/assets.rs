//! Frontend asset serving for modules: on-disk resolution, content-hashed
//! entry aliasing, brand-logo URLs, and the static asset route.

use crate::{errors::AppError, state::AppState};
use axum::{
    body::Body,
    extract::{Path as AxumPath, State},
    http::{header, HeaderValue},
    response::Response,
};
use std::collections::HashMap;

/// Résout le dossier on-disk d'un module en privilégiant le store marketplace
/// (`modules_install_dir`) sur les paquets système (`modules_dir`).
pub fn module_disk_dir(settings: &crate::config::Settings, id: &str) -> std::path::PathBuf {
    let store = std::path::Path::new(&settings.server.modules_install_dir).join(id);
    if store.is_dir() {
        store
    } else {
        std::path::Path::new(&settings.server.modules_dir).join(id)
    }
}

/// Jeton de cache-busting du bundle UI d'un module = hash court du CONTENU de
/// `entry.js`. `entry.js`/`entry.css` ont un nom FIXE (le host les charge sans
/// connaître de hash) et sont servis en `no-store` - mais iOS Safari resert un
/// module ES périmé depuis son cache indexé par URL tant que l'URL reste stable.
/// On suffixe donc `?v=<hash>` : l'URL change dès que le contenu change (bust
/// précis, sans faux positif comme un mtime préservé). Renvoie `None` si le
/// fichier n'existe pas (module sans UI).
///
/// Le hash n'est recalculé que lorsque le fichier change : cache mémoire clé
/// `(mtime, size)`. Les appels `/api/v1/modules` suivants ne font qu'un `stat`.
pub fn frontend_entry_version(path: &std::path::Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::sync::{LazyLock, Mutex};

    /// What is remembered about a file already hashed: modification time, size,
    /// and the digest. The pair (mtime, size) is the cheap proof that the digest
    /// still describes the file.
    type Fingerprint = (u64, u64, String);

    // path -> fingerprint ; évite de re-hasher un fichier inchangé.
    static CACHE: LazyLock<Mutex<HashMap<std::path::PathBuf, Fingerprint>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();

    if let Ok(cache) = CACHE.lock() {
        if let Some((m, s, h)) = cache.get(path) {
            if *m == mtime && *s == size {
                return Some(h.clone());
            }
        }
    }

    // Cache miss : lecture + hash hors verrou (ne pas bloquer les autres modules).
    let bytes = std::fs::read(path).ok()?;
    let digest = Sha256::digest(&bytes);
    let hash: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();

    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(path.to_path_buf(), (mtime, size, hash.clone()));
    }
    Some(hash)
}

/// Réécrit l'URL content-hashée de l'entrée UI (`entry-<hash>.js` /
/// `entry-<hash>.css`) vers le vrai nom de fichier sur disque (`entry.js` /
/// `entry.css`). Le `<hash>` DOIT être hexadécimal → aucune collision avec un
/// éventuel vrai fichier `entry-*.js`. Tout autre chemin (chunks, assets…) passe
/// inchangé. Sûr vis-à-vis de la traversée : la sortie est toujours `entry.{ext}`.
fn resolve_entry_alias(asset_path: &str) -> std::borrow::Cow<'_, str> {
    for ext in [".js", ".css"] {
        if let Some(rest) = asset_path.strip_suffix(ext) {
            if let Some(hash) = rest.strip_prefix("entry-") {
                if !hash.is_empty() && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return std::borrow::Cow::Owned(format!("entry{ext}"));
                }
            }
        }
    }
    std::borrow::Cow::Borrowed(asset_path)
}

/// Public URL of the brand logo for a registry id, when the host ships one.
///
/// The app launcher and the desktop gallery want a real brand image, not only a
/// lucide glyph (`icon`) - for a whole module (`id` = the module id) and for its
/// launchable sub-apps (`id` = the sidebar item id, e.g. `office-documents`,
/// `paintsharp-vertex`). Those PNGs live with the HOST frontend
/// (`core/frontend/public/<id>-logo.png`, served at `/<id>-logo.png`), so the
/// core resolves the URL by looking for that file in the served directory.
/// Returns `None` when nothing ships for that id, so a client keeps falling back
/// to the lucide icon rather than loading a broken image.
///
/// One historical naming exception is handled explicitly: the `media` module's
/// file is `media-listen-logo.png` (its `media-listen` sub-app already matches
/// the convention).
pub fn logo_url_for(frontend_dist: &str, id: &str) -> Option<String> {
    let mut candidates: Vec<String> = vec![format!("{id}-logo.png")];
    if id == "media" {
        candidates.push("media-listen-logo.png".to_owned());
    }
    candidates
        .into_iter()
        .find(|file| std::path::Path::new(frontend_dist).join(file).is_file())
        .map(|file| format!("/{file}"))
}
/// Sert un asset statique du bundle frontend d'un module :
/// `GET /modules/<id>/frontend/<chemin>` -> `<modules_dir>/<id>/frontend/<chemin>`.
///
/// Aucune connaissance des modules dans le core : convention de dossier pure
/// (façon « extension PHP »). Un module tiers dépose son UI buildée, le core la
/// sert. Restreint au sous-dossier `frontend/` et protégé contre la traversée.
pub async fn serve_module_asset(
    State(state): State<AppState>,
    AxumPath((module_id, asset_path)): AxumPath<(String, String)>,
) -> Result<Response, AppError> {
    if module_id.is_empty()
        || !module_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::NotFound("module".into()));
    }
    // Anti-traversée : aucun segment vide ni `..`.
    if asset_path
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(AppError::NotFound("asset".into()));
    }

    // Le host demande l'entrée UI sous un nom content-hashé `entry-<hash>.js` /
    // `entry-<hash>.css` (cache-busting, cf. `list_modules`) ; sur disque le
    // fichier s'appelle `entry.js` / `entry.css`. On réécrit l'alias hashé.
    let real_asset = resolve_entry_alias(&asset_path);
    let full = module_disk_dir(&state.settings, &module_id)
        .join("frontend")
        .join(real_asset.as_ref());

    let data = tokio::fs::read(&full)
        .await
        .map_err(|_| AppError::NotFound("asset".into()))?;

    let content_type = match asset_path.rsplit('.').next() {
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css")              => "text/css; charset=utf-8",
        Some("svg")              => "image/svg+xml",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("woff2")            => "font/woff2",
        Some("woff")             => "font/woff",
        Some("png")              => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp")             => "image/webp",
        Some("wasm")             => "application/wasm",
        _                        => "application/octet-stream",
    };

    let mut resp = Response::new(Body::from(data));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    Ok(resp)
}
