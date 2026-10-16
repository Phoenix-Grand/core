//! Extraction de l'archive téléchargée, repérage du dossier module et petits
//! utilitaires système (empreinte SHA-256, copie récursive).

use std::path::{Path, PathBuf};

use crate::errors::AppError;

/// Déballe un `.kbpkg` (archive ZIP) vers `dest`.
///
/// Extraction en Rust pur (crate `zip`) : aucun outil externe (`dpkg-deb`, `tar`,
/// `unzip`) n'est requis, ce qui la rend identique sur Linux, Windows et macOS.
/// C'est le seul format qu'un module puisse prendre - cf. `artifact.rs`.
pub(super) async fn extract_kbpkg(file: &Path, dest: &Path) -> Result<(), AppError> {
    let (file, dest) = (file.to_path_buf(), dest.to_path_buf());
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let f = std::fs::File::open(&file)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("ouverture .kbpkg: {e}")))?;
        let mut ar = zip::ZipArchive::new(f)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("lecture .kbpkg: {e}")))?;
        ar.extract(&dest)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("extraction .kbpkg: {e}")))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("tâche extraction .kbpkg: {e}")))??;
    Ok(())
}

/// Localise le dossier du module `id` dans l'arbre extrait. Le `.kbpkg` a pour
/// racine le dossier du module (`<id>/` ou la racine de l'archive) ; les chemins
/// hérités (`usr/lib/kubuno/modules/<id>`) restent tolérés par sécurité. On se
/// repère sur la présence de `module.toml`.
pub(super) fn find_module_root(extract: &Path, id: &str) -> Option<PathBuf> {
    for cand in [
        extract.join("usr/lib/kubuno/modules").join(id),
        extract.join("usr/local/kubuno/modules").join(id),
        extract.join("modules").join(id),
        extract.join(id),
        extract.to_path_buf(),
    ] {
        if cand.join("module.toml").is_file() {
            return Some(cand);
        }
    }
    // Recherche bornée d'un dossier contenant `module.toml`.
    find_toml_dir(extract, 5)
}

fn find_toml_dir(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth == 0 { return None; }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() { subdirs.push(p); }
    }
    for d in &subdirs {
        if d.join("module.toml").is_file() {
            return Some(d.clone());
        }
    }
    for d in &subdirs {
        if let Some(found) = find_toml_dir(d, depth - 1) {
            return Some(found);
        }
    }
    None
}

/// Calcule le SHA-256 hex d'un buffer.
pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// Copie récursive d'un dossier (best-effort, utilisée pour la config en /etc).
pub(super) fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}
