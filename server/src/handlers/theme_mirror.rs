//! Read-only mirror of the installed themes into the Drive's "System" area.
//!
//! The themes remain owned by the core (source of truth = `server.themes_dir`).
//! For visibility, the core PUSHES each theme as a `<id>.zip` file under
//! `/System/Themes` - a protected folder owned by the drive's reserved system
//! owner - through the drive module's IPC API (authenticated with
//! `X-Internal-Secret`). Admins still import/delete themes from the admin
//! console; this only reflects them so they show up (and can be downloaded) in
//! the Drive UI.
//!
//! Best-effort: if the `drive` module is not installed or not active, nothing
//! happens. The mirror is (re)built whenever the drive registers and after any
//! theme change (import / create / delete), so it self-heals.

use crate::state::AppState;
use base64::Engine as _;
use serde_json::json;
use std::collections::HashSet;
use std::io::{Read, Write};

/// The drive module's reserved "system" owner (`Uuid::from_u128(1)`), under
/// which the shared System area lives.
const SYSTEM_OWNER: &str = "00000000-0000-0000-0000-000000000001";
/// Folder path (relative to the system owner root) hosting the theme mirror.
const THEMES_PATH: &str = "System/Themes";

/// Rebuild the theme mirror inside Drive `System/Themes`. Never returns an error
/// to the caller: failures (including "drive absent") are logged at debug level.
pub async fn sync(state: &AppState) {
    if let Err(e) = try_sync(state).await {
        tracing::debug!(error = %e, "Theme mirror into Drive skipped");
    }
}

async fn try_sync(state: &AppState) -> anyhow::Result<()> {
    // Resolve the drive module's base URL; skip silently if it is not active.
    let base_url = {
        let reg = state.modules.read().await;
        match reg.get("drive") {
            Some(inst) => inst.base_url.trim_end_matches('/').to_string(),
            None => return Ok(()),
        }
    };
    // Secret interne du module drive (celui qu'il détient), pas le secret maître.
    let secret = state.settings.server.module_secret("drive");
    let themes_dir = state.settings.server.themes_dir.clone();
    let client = reqwest::Client::new();

    let folder_id = ensure_folder(&client, &base_url, &secret).await?;

    // Push every on-disk theme as <id>.zip (idempotent overwrite).
    let mut wanted: HashSet<String> = HashSet::new();
    for id in theme_ids(&themes_dir) {
        let zip = build_zip(&themes_dir, &id)?;
        let name = format!("{id}.zip");
        upload(&client, &base_url, &secret, &folder_id, &name, &zip).await?;
        wanted.insert(name);
    }

    // Remove mirror files whose theme no longer exists.
    prune(&client, &base_url, &secret, &folder_id, &wanted).await?;
    Ok(())
}

/// Ensure `/System/Themes` exists (protected) and return its folder id.
async fn ensure_folder(client: &reqwest::Client, base_url: &str, secret: &str) -> anyhow::Result<String> {
    let v: serde_json::Value = client
        .post(format!("{base_url}/ipc/folders/ensure-path"))
        .header("X-Internal-Secret", secret)
        .json(&json!({ "user_id": SYSTEM_OWNER, "path": THEMES_PATH, "protect": true, "icon": "Palette" }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    v["folder"]["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("ensure-path: réponse sans folder.id"))
}

/// Upload (overwrite) a single `<id>.zip` into the mirror folder.
async fn upload(
    client: &reqwest::Client,
    base_url: &str,
    secret: &str,
    folder_id: &str,
    name: &str,
    zip: &[u8],
) -> anyhow::Result<()> {
    let content = base64::engine::general_purpose::STANDARD.encode(zip);
    client
        .post(format!("{base_url}/ipc/files/with-content"))
        .header("X-Internal-Secret", secret)
        .json(&json!({
            "user_id":   SYSTEM_OWNER,
            "folder_id": folder_id,
            "name":      name,
            "mime_type": "application/zip",
            "content":   content,
            "overwrite": true,
        }))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

/// Delete mirror files not present in `wanted` (themes removed since last sync).
async fn prune(
    client: &reqwest::Client,
    base_url: &str,
    secret: &str,
    folder_id: &str,
    wanted: &HashSet<String>,
) -> anyhow::Result<()> {
    let v: serde_json::Value = client
        .get(format!("{base_url}/ipc/files"))
        .header("X-Internal-Secret", secret)
        .query(&[("user_id", SYSTEM_OWNER), ("folder_id", folder_id)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if let Some(files) = v["files"].as_array() {
        for f in files {
            let (Some(id), Some(name)) = (f["id"].as_str(), f["name"].as_str()) else { continue };
            if !wanted.contains(name) {
                let _ = client
                    .delete(format!("{base_url}/ipc/files/{id}"))
                    .header("X-Internal-Secret", secret)
                    .json(&json!({ "user_id": SYSTEM_OWNER }))
                    .send()
                    .await;
            }
        }
    }
    Ok(())
}

/// Theme ids on disk = immediate sub-directories that hold a `theme.json`.
fn theme_ids(themes_dir: &str) -> Vec<String> {
    let mut ids = Vec::new();
    if let Ok(rd) = std::fs::read_dir(themes_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && p.join("theme.json").is_file() {
                if let Some(name) = e.file_name().to_str() {
                    ids.push(name.to_string());
                }
            }
        }
    }
    ids
}

/// Zip the whole theme bundle directory (`theme.json` + assets), preserving the
/// relative layout so the archive re-imports as-is.
fn build_zip(themes_dir: &str, id: &str) -> anyhow::Result<Vec<u8>> {
    let root = std::path::Path::new(themes_dir).join(id);
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();

    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir)?.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let rel = p.strip_prefix(&root)?.to_string_lossy().replace('\\', "/");
                zip.start_file(rel, opts)?;
                let mut data = Vec::new();
                std::fs::File::open(&p)?.read_to_end(&mut data)?;
                zip.write_all(&data)?;
            }
        }
    }
    Ok(zip.finish()?.into_inner())
}
