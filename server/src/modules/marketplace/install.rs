//! Installation (récursive, dépendances d'abord) et désinstallation d'un module
//! de la marketplace dans le store inscriptible par le core.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool};
use serde::Serialize;

use crate::{config::Settings, errors::AppError};

use super::artifact::{is_kbpkg, resolve_artifact, Artifact};
use super::catalog::{client, fetch_detail, validate_id};
use super::extract::{copy_dir_all, extract_kbpkg, find_module_root, sha256_hex};
use super::progress::{set_phase, set_dependency};

const TRUSTED_REPO_PREFIX: &str = "https://github.com/kubuno/";

#[derive(Debug, Clone, Serialize)]
pub struct InstallReport {
    pub id:      String,
    pub name:    String,
    pub version: String,
    pub path:    String,
    pub started: bool,
    pub config_written: bool,
    /// Dépendances déclarées par le module (installées automatiquement si absentes).
    #[serde(default)]
    pub dependencies: Vec<String>,
}

/// Ce module a-t-il déjà été installé avec une empreinte vérifiée ?
///
/// En cas d'erreur de base, on répond `true` : mieux vaut refuser une
/// installation qu'on ne sait pas justifier que l'accepter faute d'information.
async fn was_verified_before(db: &DbPool, id: &str) -> bool {
    let sql = format!(
        "SELECT {} FROM core.module_integrity WHERE module_id = $1",
        db.backend().count_bigint("*")
    );
    match db.fetch_scalar::<i64>(&sql, params![id]).await {
        Ok(n) => n > 0,
        Err(e) => {
            tracing::error!(module_id = %id, error = %e, "Lecture de l'historique d'intégrité impossible");
            true
        }
    }
}

/// Retient qu'une empreinte a bien été vérifiée pour ce module.
async fn was_signed_before(db: &DbPool, id: &str) -> bool {
    match db
        .fetch_optional_scalar::<bool>(
            "SELECT signed FROM core.module_integrity WHERE module_id = $1",
            params![id],
        )
        .await
    {
        Ok(v) => v.unwrap_or(false),
        Err(e) => {
            tracing::error!(module_id = %id, error = %e, "Lecture de l'historique de signature impossible");
            // Comme pour l'empreinte : dans le doute, refuser plutôt qu'accepter.
            true
        }
    }
}

async fn remember_verified(db: &DbPool, id: &str, sha256: &str, signed: bool) {
    // `last_seen_at` is bound from Rust and carried through the update branch
    // (`= excluded.last_seen_at`) rather than written with `NOW()` in SQL, so
    // the same statement runs on every engine. `signed` stays sticky: once true
    // it never reverts.
    let now = Utc::now();
    let sql = format!(
        "INSERT INTO core.module_integrity (module_id, last_sha256, signed, last_seen_at) \
         VALUES ($1, $2, $3, $4){}",
        db.backend().upsert(
            "core.module_integrity",
            &["module_id"],
            &[
                Assign::Incoming("last_sha256"),
                Assign::Expr { col: "signed", expr: "{cur} OR {new}" },
                Assign::Incoming("last_seen_at"),
            ],
        )
    );
    if let Err(e) = db.execute(&sql, params![id, sha256, signed, now]).await {
        tracing::error!(module_id = %id, error = %e, "Enregistrement de l'empreinte vérifiée impossible");
    }
}

/// `true` si le module est déjà présent sur disque (store OU paquet système), donc
/// utilisable comme dépendance sans réinstallation.
fn is_available(settings: &Settings, id: &str) -> bool {
    Path::new(&settings.server.modules_install_dir).join(id).is_dir()
        || Path::new(&settings.server.modules_dir).join(id).is_dir()
}

/// Résultat d'une matérialisation : le module est téléchargé, vérifié et déposé dans
/// le store, mais PAS encore démarré (on démarre après ses dépendances).
struct Materialized {
    dest_mod:       PathBuf,
    manifest:       crate::modules::manifest::ModuleManifest,
    name:           String,
    version:        String,
    config_written: bool,
}

/// Télécharge, vérifie (SHA-256), extrait et relocalise un module dans le store.
/// Ne le démarre pas. Applique la garde de confiance (officiel + dépôt kubuno).
async fn materialize(settings: &Settings, db: &DbPool, id: &str) -> Result<Materialized, AppError> {
    validate_id(id)?;
    let http = client()?;

    // 1) Métadonnées + garde de confiance (module officiel, dépôt sous kubuno/).
    set_phase(id, "resolving", "Resolving module…");
    let detail = fetch_detail(id).await?;
    let repo = detail.links.repo.clone().ok_or_else(|| {
        AppError::Validation(format!("Module '{id}' does not publish a repository"))
    })?;
    if !detail.official || !repo.starts_with(TRUSTED_REPO_PREFIX) {
        return Err(AppError::Forbidden);
    }

    // 2) Résolution de l'artefact ADAPTÉ À L'OS/ARCH DU CORE. Source PRÉFÉRÉE : URL
    //    directe fournie par la marketplace (à terme, kubuno.com - supposée déjà
    //    résolue pour la plateforme). Repli : asset de la Release GitHub choisi selon
    //    `std::env::consts::OS/ARCH`.
    // Le catalogue dit ce que le module publie, plateforme par plateforme : c'est
    // la source la plus fiable, et la seule qui fonctionne ailleurs que sur Linux.
    let asset = if let Some(a) = detail.artifact.as_ref().and_then(super::artifact::from_recommendation) {
        // Le catalogue a choisi pour cette plateforme : on suit sa recommandation.
        a
    } else if let Some(a) = super::artifact::from_catalogue(&detail.artifacts) {
        // Catalogue plus ancien, qui liste sans recommander : on trie ici.
        a
    } else if !detail.artifacts.is_empty() {
        // Le catalogue décrit bien ce module, mais aucun .kbpkg installable ici :
        // le dire franchement. Un module s'installe uniquement par son paquet
        // Kubuno - les paquets système ne sont ni produits ni acceptés.
        let dispo: Vec<String> = detail.artifacts.iter()
            .map(|a| format!("{} {}/{}", a.kind, a.os, a.arch)).collect();
        return Err(AppError::Validation(format!(
            "'{id}' does not publish a Kubuno package (.kbpkg) for {}/{} (available: {}). Rebuild it as a .kbpkg and publish it again.",
            std::env::consts::OS, std::env::consts::ARCH, dispo.join(", ")
        )));
    } else { match detail.download_url.clone() {
        Some(url) => {
            if !url.starts_with("https://") {
                return Err(AppError::Validation("Insecure artifact URL (HTTPS required)".into()));
            }
            if !is_kbpkg(&url) {
                return Err(AppError::Validation(format!(
                    "Artifact format rejected: {url}; modules can only be installed as .kbpkg packages"
                )));
            }
            Artifact { url, sha256: detail.sha256.as_deref().map(|s| s.trim_start_matches("sha256:").to_ascii_lowercase()) }
        }
        None => resolve_artifact(&http, &repo, &detail.version).await?,
    } };
    tracing::info!(module_id = %id, version_catalogue = %detail.version, os = std::env::consts::OS, arch = std::env::consts::ARCH, url = %asset.url, "Marketplace : téléchargement du paquet .kbpkg");
    set_phase(id, "downloading", "Downloading artifact…");
    let bytes = http
        .get(&asset.url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AppError::Internal(anyhow::anyhow!("téléchargement .kbpkg: {e}")))?
        .bytes()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("lecture .kbpkg: {e}")))?;

    // 2b) Vérification d'intégrité SHA-256 (empreinte publiée par GitHub). Échec DUR
    //     en cas de divergence ; simple avertissement si aucune empreinte n'est fournie.
    set_phase(id, "verifying", "Verifying integrity…");
    // Le manifeste signé, quand il est disponible ET valide, fait autorité sur
    // l'empreinte : c'est la seule que quelqu'un ait signée. À défaut, on garde
    // celle que le catalogue annonce - et la règle de non-régression ci-dessous
    // empêche qu'une signature ou une empreinte disparaisse sans conséquence.
    let signed = super::manifest::fetch_signed(&http, &super::catalog::catalog_base()).await;
    let signed_digest = signed.as_ref().and_then(|s| s.digest_for(id, &asset.url).map(str::to_string));
    if signed_digest.is_none() && was_signed_before(db, id).await {
        // Deux situations très différentes derrière la même absence.
        return if signed.is_none() {
            tracing::error!(module_id = %id, "Marketplace : manifeste signé indisponible pour un module déjà signé - installation reportée");
            Err(super::manifest::unavailable_error(id))
        } else {
            tracing::error!(module_id = %id, "Marketplace : ce module était signé, le manifeste actuel ne le couvre plus - installation refusée");
            Err(super::manifest::downgrade_error(id))
        };
    }
    let asset_sha = signed_digest.clone().or_else(|| asset.sha256.clone());

    match asset_sha.as_deref() {
        Some(expected) => {
            let actual = sha256_hex(&bytes);
            if actual != expected {
                tracing::error!(module_id = %id, expected, actual, "Marketplace : SHA-256 non conforme - installation refusée");
                return Err(AppError::Internal(anyhow::anyhow!(
                    ".kbpkg integrity verification failed (expected SHA-256 {expected}, received {actual})"
                )));
            }
            tracing::info!(module_id = %id, sha256 = %actual, "Marketplace : intégrité SHA-256 vérifiée");
            // Ce module est désormais de ceux dont on sait qu'ils s'accompagnent
            // d'une empreinte : une version ultérieure qui n'en aurait plus sera
            // refusée (voir la branche `None`).
            remember_verified(db, id, &actual, signed_digest.is_some()).await;
            if signed_digest.is_some() {
                tracing::info!(module_id = %id, "Marketplace : empreinte attestée par le manifeste signé du catalogue");
            } else {
                // Politique retenue : on accepte, mais on le dit - et la règle de
                // non-régression ci-dessus empêche d'en profiter deux fois.
                tracing::warn!(module_id = %id, "Marketplace : origine NON SIGNÉE - empreinte vérifiée, mais rien n'atteste qui l'a produite");
            }
        }
        None => {
            // Une empreinte absente n'est tolérable que si ce module n'en a
            // jamais eu. Sinon c'est une régression, et la retirer du catalogue
            // suffirait à désactiver toute la vérification.
            if was_verified_before(db, id).await {
                tracing::error!(
                    module_id = %id,
                    "Marketplace : empreinte SHA-256 absente alors que ce module en avait une - installation refusée"
                );
                return Err(AppError::Validation(format!(
                    "'{id}' was previously installed with a verified checksum, but the proposed artifact has none. Installation refused: removing a checksum reduces security."
                )));
            }
            tracing::warn!(module_id = %id, "Marketplace : aucune empreinte SHA-256 publiée - intégrité non vérifiée");
        }
    }

    // 3) Staging dans le store (inscriptible par le core).
    let install_dir = PathBuf::from(&settings.server.modules_install_dir);
    let staging = install_dir.join(".staging").join(id);
    let _ = tokio::fs::remove_dir_all(&staging).await;
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("création staging {}: {e}", staging.display())))?;
    let pkg_path = staging.join("artifact");
    tokio::fs::write(&pkg_path, &bytes)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("écriture artefact: {e}")))?;

    // 4) Extraction du .kbpkg (archive ZIP, en Rust pur).
    set_phase(id, "extracting", "Extracting package…");
    let extract = staging.join("extract");
    tokio::fs::create_dir_all(&extract)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("création extract: {e}")))?;
    extract_kbpkg(&pkg_path, &extract).await?;

    // 5) Relocalisation du dossier module → store/<id> (self-contained). On localise le
    //    dossier du module quel que soit le layout de l'archive (deb imbriqué ou plat).
    let src_mod = find_module_root(&extract, id).ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!("artefact invalide : module.toml introuvable pour « {id} »"))
    })?;
    // The catalogue already picks the artefact for this OS/arch; the package
    // itself is checked anyway, since a mislabelled release would otherwise
    // only fail when the module is spawned.
    let toml_src = tokio::fs::read_to_string(src_mod.join("module.toml"))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("lecture module.toml: {e}")))?;
    let pkg_manifest: crate::modules::manifest::ModuleManifest = toml::from_str(&toml_src)
        .map_err(|e| AppError::Validation(format!("Invalid module.toml: {e}")))?;
    if let Err(msg) = super::target::check(None, &src_mod, &toml_src, &pkg_manifest) {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(AppError::Validation(format!("« {id} » : {msg}")));
    }
    let dest_mod = install_dir.join(id);
    let _ = tokio::fs::remove_dir_all(&dest_mod).await;
    // rename intra-fs (staging et dest sont tous deux sous modules_install_dir).
    tokio::fs::rename(&src_mod, &dest_mod)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("relocalisation module: {e}")))?;

    // 6) Config → modules_config_dir/<id> (best-effort : /etc peut être non inscriptible).
    let mut config_written = false;
    let src_cfg = extract.join("etc/kubuno/modules").join(id);
    if src_cfg.is_dir() {
        let dest_cfg = Path::new(&settings.server.modules_config_dir).join(id);
        match copy_dir_all(&src_cfg, &dest_cfg) {
            Ok(_) => config_written = true,
            Err(e) => tracing::warn!(module_id = %id, dir = %dest_cfg.display(), error = %e,
                "Config du module non écrite (permissions ?) - démarrage avec les valeurs par défaut"),
        }
    }

    // A .kbpkg carries its example configuration at the module ROOT - there is no
    // etc/ tree in it. Without this fallback no configuration was ever written for
    // a module installed from a package, so the module resolved its paths relative
    // to its working directory (which is its CONFIGURATION directory) and wrote
    // user data under /etc. Seeded once only: an administrator's existing file is
    // never overwritten.
    if !config_written {
        let example = dest_mod.join("config.toml.example");
        let dest_cfg = Path::new(&settings.server.modules_config_dir).join(id);
        let dest_file = dest_cfg.join("config.toml");
        if example.is_file() && !dest_file.exists() {
            match std::fs::create_dir_all(&dest_cfg).and_then(|()| std::fs::copy(&example, &dest_file)) {
                Ok(_) => {
                    config_written = true;
                    tracing::info!(module_id = %id, file = %dest_file.display(),
                        "Configuration du module initialisée depuis config.toml.example");
                }
                Err(e) => tracing::warn!(module_id = %id, file = %dest_file.display(), error = %e,
                    "Configuration du module non initialisée (permissions ?) - le module écrira ses données en chemin relatif"),
            }
        }
    }

    // 7) Nettoyage du staging.
    let _ = tokio::fs::remove_dir_all(install_dir.join(".staging")).await;

    // 7 bis) Le store doit rester écrivable par le service, même quand c'est la CLI
    //        sous sudo qui vient d'y écrire (cf. align_store_ownership).
    align_store_ownership(&install_dir, &dest_mod);

    // 8) Parse du manifeste relocalisé (les dépendances y figurent).
    let toml_str = tokio::fs::read_to_string(dest_mod.join("module.toml"))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("lecture module.toml: {e}")))?;
    let manifest: crate::modules::manifest::ModuleManifest = toml::from_str(&toml_str)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("parse module.toml: {e}")))?;

    // The version of the package actually installed, read from its own manifest -
    // not the one the catalogue announced. The core downloads the latest release,
    // so a catalogue lagging behind made every success message, and the server
    // log, name a version that was never installed.
    let installed_version = manifest.module.version.clone();

    Ok(Materialized {
        dest_mod,
        manifest,
        name: detail.name,
        version: installed_version,
        config_written,
    })
}

/// Give the store back to the account that runs the server.
///
/// `kubuno modules:install` is documented as a `sudo` command, so everything it
/// creates under the store belongs to root - including the store directory itself
/// when the package never created it. The core runs as an unprivileged service
/// account and can then no longer write there, which breaks every later install
/// from the Marketplace with a permission error that points nowhere.
///
/// The target owner is DERIVED from the directory that contains the store (the
/// data directory the packaging created for the service account) rather than
/// hardcoded: a custom `modules_install_dir` and a custom service user work the
/// same way. Best-effort - a failure is logged, never fatal, since an install run
/// by the service itself already has the right owner and nothing to repair.
#[cfg(unix)]
fn align_store_ownership(install_dir: &Path, dest_mod: &Path) {
    use std::os::unix::fs::MetadataExt;

    let Some(parent) = install_dir.parent() else { return };
    let Ok(reference) = std::fs::metadata(parent) else { return };
    let (uid, gid) = (reference.uid(), reference.gid());

    // The store itself is only a container: a single chown is enough.
    if let Ok(meta) = std::fs::symlink_metadata(install_dir) {
        if (meta.uid(), meta.gid()) != (uid, gid) {
            match std::os::unix::fs::chown(install_dir, Some(uid), Some(gid)) {
                Ok(()) => tracing::info!(dir = %install_dir.display(), uid, gid,
                    "Store des modules : propriétaire réaligné sur celui du répertoire de données"),
                Err(e) => tracing::warn!(dir = %install_dir.display(), error = %e,
                    "Store des modules : propriétaire non réaligné - le service risque de ne plus pouvoir y écrire"),
            }
        }
    }

    // The module just unpacked: the whole tree must belong to the service.
    if let Ok(meta) = std::fs::symlink_metadata(dest_mod) {
        if (meta.uid(), meta.gid()) != (uid, gid) {
            if let Err(e) = chown_tree(dest_mod, uid, gid) {
                tracing::warn!(dir = %dest_mod.display(), error = %e,
                    "Module installé : propriétaire non réaligné - le service risque de ne pas pouvoir le lire");
            }
        }
    }
}

/// Recursive `chown` that never follows a symlink (a link inside an untrusted
/// archive must not be able to redirect the change outside the store).
#[cfg(unix)]
fn chown_tree(path: &Path, uid: u32, gid: u32) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return std::os::unix::fs::lchown(path, Some(uid), Some(gid));
    }
    if meta.is_dir() {
        for entry in std::fs::read_dir(path)? {
            chown_tree(&entry?.path(), uid, gid)?;
        }
    }
    std::os::unix::fs::chown(path, Some(uid), Some(gid))
}

#[cfg(not(unix))]
fn align_store_ownership(_install_dir: &Path, _dest_mod: &Path) {}

/// Installe un module et, RÉCURSIVEMENT, ses dépendances manquantes AVANT de le
/// démarrer (dépendances d'abord). `visited` protège des cycles ; `depth` borne la
/// profondeur. Chaque module traverse la même garde de confiance (via `materialize`).
fn install_node<'a>(
    settings: Arc<Settings>,
    db: DbPool,
    id: &'a str,
    visited: &'a mut std::collections::HashSet<String>,
    depth: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<InstallReport, AppError>> + Send + 'a>> {
    Box::pin(async move {
        if depth > 16 {
            return Err(AppError::Validation("Dependency chain too deep".into()));
        }

        // 1) Matérialise CE module (téléchargement/extraction/relocalisation).
        let mat = materialize(&settings, &db, id).await?;
        let deps = mat.manifest.module.dependencies.clone();

        // 2) Installe les dépendances absentes du disque, AVANT de démarrer ce module.
        for dep in &deps {
            if dep == id || is_available(&settings, dep) {
                continue;
            }
            if !visited.insert(dep.clone()) {
                continue; // cycle ou déjà en cours d'installation
            }
            set_dependency(id, dep);
            tracing::info!(module_id = %id, dependency = %dep, "Marketplace : installation d'une dépendance manquante");
            install_node(settings.clone(), db.clone(), dep, &mut *visited, depth + 1).await?;
        }

        // 3) Démarre ce module (à chaud).
        set_phase(id, "starting", "Starting module…");
        let started = crate::modules::manager::spawn_module(
            settings.clone(), mat.dest_mod.clone(), mat.manifest, db.clone(),
        ).await;
        tracing::info!(module_id = %id, version = %mat.version, started, "Marketplace : module installé");

        Ok(InstallReport {
            id: id.to_string(),
            name: mat.name,
            version: mat.version,
            path: mat.dest_mod.display().to_string(),
            started,
            config_written: mat.config_written,
            dependencies: deps,
        })
    })
}

/// Installe (ou met à jour) un module depuis la marketplace, avec ses dépendances.
pub async fn install(settings: Arc<Settings>, db: DbPool, id: &str) -> Result<InstallReport, AppError> {
    validate_id(id)?;
    let mut visited = std::collections::HashSet::new();
    visited.insert(id.to_string());
    install_node(settings, db, id, &mut visited, 0).await
}

/// `true` si le module `id` a été installé via la marketplace (présent dans le store,
/// donc désinstallable). Les paquets système (`/usr/lib`) ne le sont pas ici.
pub fn is_store_installed(settings: &Settings, id: &str) -> bool {
    Path::new(&settings.server.modules_install_dir).join(id).is_dir()
}

/// Désinstalle un module installé depuis la marketplace : arrête le process, retire
/// les fichiers du store et purge la DB. N'agit QUE sur les modules du store (les
/// paquets système restent intacts).
pub async fn uninstall(settings: Arc<Settings>, db: DbPool, id: &str) -> Result<(), AppError> {
    validate_id(id)?;
    let store_dir = PathBuf::from(&settings.server.modules_install_dir).join(id);
    if !store_dir.is_dir() {
        return Err(AppError::Validation(format!(
            "'{id}' was not installed from the marketplace and cannot be uninstalled here"
        )));
    }

    // 1) Arrêt de la supervision + kill du process, puis court délai pour la propagation.
    let stopped = crate::modules::manager::stop_module(id);
    tracing::info!(module_id = %id, stopped, "Marketplace : arrêt du module avant désinstallation");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // 2) Suppression des fichiers du store.
    tokio::fs::remove_dir_all(&store_dir)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("suppression {}: {e}", store_dir.display())))?;

    // 3) Purge DB (instances + réglages semés + métadonnées).
    let _ = db
        .execute("DELETE FROM core.module_instances WHERE module_id = $1", params![id])
        .await;
    let _ = db
        .execute("DELETE FROM core.settings WHERE module_id = $1", params![id])
        .await;
    db.execute("DELETE FROM core.modules WHERE id = $1", params![id])
        .await
        .map_err(|e| { tracing::error!(module_id = %id, error = %e, "uninstall: purge core.modules"); e })?;

    tracing::info!(module_id = %id, "Marketplace : module désinstallé");
    Ok(())
}

/// Verify the embedded `SHA256SUMS` file (coreutils `sha256sum` format:
/// `<hex>␠␠<relative path>`). A missing file means "not verified" and is tolerated
/// (best-effort, offline copies may lack it). A listed file that is missing or whose
/// digest does not match is an error: the archive has been tampered with.
async fn verify_sha256sums(mod_dir: &Path) -> Result<(), AppError> {
    let content = match tokio::fs::read_to_string(mod_dir.join("SHA256SUMS")).await {
        Ok(c) => c,
        Err(_) => return Ok(()), // no SHA256SUMS: nothing to check
    };
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() { continue; }
        // Standard separator is two spaces; also accept a single space and a leading
        // `*` (binary-mode marker).
        let (expected, rel) = match line.split_once("  ").or_else(|| line.split_once(' ')) {
            Some((h, r)) => (h.trim(), r.trim().trim_start_matches('*')),
            None => continue,
        };
        // Never check ourselves, never escape the module directory.
        if rel.is_empty() || rel == "SHA256SUMS" || rel.contains("..") { continue; }
        let bytes = tokio::fs::read(mod_dir.join(rel)).await.map_err(|e| {
            AppError::Validation(format!("SHA256SUMS lists « {rel} », which is missing: {e}"))
        })?;
        if !sha256_hex(&bytes).eq_ignore_ascii_case(expected) {
            return Err(AppError::Validation(format!(
                "SHA-256 mismatch for « {rel} » - the package has been altered"
            )));
        }
    }
    Ok(())
}

/// Install a module from a LOCAL `.kbpkg` file without network or catalogue:
/// extract → verify embedded digests → relocate into the core-writable store.
/// Does NOT start the module - the core loads it on its next start (store rescan).
/// Returns the module id, version and install path. Backs the
/// `kubuno modules:install <file>` CLI command.
///
/// The Kubuno package is the ONLY format a module installs from: `.deb`, `.rpm`,
/// `.tar.gz` and system installers are refused here, so a module reaches the store
/// through exactly one path.
pub async fn install_local(settings: &Settings, file: &Path) -> Result<InstallReport, AppError> {
    // 1) A module installs from its Kubuno package only (a ZIP, unpacked in pure Rust).
    let fname = file.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !is_kbpkg(&fname) {
        return Err(AppError::Validation(format!(
            "'{fname}' is not a Kubuno package; modules can only be installed as .kbpkg packages"
        )));
    }
    if !file.is_file() {
        return Err(AppError::Validation(format!("file not found: {}", file.display())));
    }

    // 2) Stage under the store (same filesystem as the destination → atomic rename).
    let install_dir = PathBuf::from(&settings.server.modules_install_dir);
    let staging = install_dir.join(".staging").join("_local");
    let _ = tokio::fs::remove_dir_all(&staging).await;
    let extract = staging.join("extract");
    tokio::fs::create_dir_all(&extract).await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("creating staging {}: {e}", extract.display())))?;

    // 3) Extract.
    extract_kbpkg(file, &extract).await?;

    // 4) Locate the module directory and read the id from the manifest (never the filename).
    let src_mod = find_module_root(&extract, "").ok_or_else(|| {
        AppError::Validation("invalid archive: no module.toml found".into())
    })?;
    let toml_str = tokio::fs::read_to_string(src_mod.join("module.toml")).await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("reading module.toml: {e}")))?;
    let manifest: crate::modules::manifest::ModuleManifest = toml::from_str(&toml_str)
        .map_err(|e| AppError::Validation(format!("invalid module.toml: {e}")))?;
    let id = manifest.module.id.clone();
    validate_id(&id)?;

    // 5) Verify embedded digests (offline) if present.
    verify_sha256sums(&src_mod).await?;

    // 5b) Refuse a package built for another OS/architecture now, with a clear
    //     message, rather than letting it fail to spawn later.
    let original_name = file.file_name().and_then(|s| s.to_str());
    if let Err(msg) = super::target::check(original_name, &src_mod, &toml_str, &manifest) {
        let _ = tokio::fs::remove_dir_all(install_dir.join(".staging")).await;
        return Err(AppError::Validation(format!("« {id} » : {msg}")));
    }

    // 6) Relocate → store/<id> (replacing any existing copy).
    let dest_mod = install_dir.join(&id);
    let _ = tokio::fs::remove_dir_all(&dest_mod).await;
    if tokio::fs::rename(&src_mod, &dest_mod).await.is_err() {
        // Fallback to a recursive copy when rename is not possible (different fs).
        let (s, d) = (src_mod.clone(), dest_mod.clone());
        tokio::task::spawn_blocking(move || copy_dir_all(&s, &d))
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("copying module: {e}")))?
            .map_err(|e| AppError::Internal(anyhow::anyhow!("copying module: {e}")))?;
    }

    // 7) Config → modules_config_dir/<id> (best-effort; /etc may be read-only).
    let mut config_written = false;
    let src_cfg = extract.join("etc/kubuno/modules").join(&id);
    if src_cfg.is_dir() {
        let dest_cfg = Path::new(&settings.server.modules_config_dir).join(&id);
        if copy_dir_all(&src_cfg, &dest_cfg).is_ok() { config_written = true; }
    }

    // 8) Clean up staging.
    let _ = tokio::fs::remove_dir_all(install_dir.join(".staging")).await;

    Ok(InstallReport {
        id,
        name:    manifest.module.display_name.clone(),
        version: manifest.module.version.clone(),
        path:    dest_mod.display().to_string(),
        started: false,
        config_written,
        dependencies: manifest.module.dependencies.clone(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    /// Build `<root>/store/<id>` with a nested directory, a file and a symlink
    /// that escapes the tree - the shape an untrusted `.kbpkg` can produce.
    fn sample_store(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let outside = root.join("outside.txt");
        std::fs::write(&outside, b"untouched").unwrap();
        let store = root.join("store");
        let module = store.join("demo");
        std::fs::create_dir_all(module.join("frontend")).unwrap();
        std::fs::write(module.join("module.toml"), b"[module]").unwrap();
        std::fs::write(module.join("frontend/entry.js"), b"//").unwrap();
        std::os::unix::fs::symlink(&outside, module.join("escape")).unwrap();
        (store, module, outside)
    }

    #[test]
    fn chown_tree_walks_the_whole_module_without_following_symlinks() {
        let tmp = std::env::temp_dir().join(format!("kbstore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let (_store, module, outside) = sample_store(&tmp);

        // Re-applying our own uid/gid is permitted without privileges, so the
        // traversal itself is what this exercises.
        let me = std::fs::metadata(&module).unwrap();
        chown_tree(&module, me.uid(), me.gid()).unwrap();

        // The escaping symlink is still a symlink, and its target still exists:
        // a recursive chown that followed it would have left the tree.
        let link = std::fs::symlink_metadata(module.join("escape")).unwrap();
        assert!(link.file_type().is_symlink());
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
        assert!(module.join("frontend/entry.js").is_file());

        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn align_store_ownership_is_a_no_op_when_the_owner_already_matches() {
        let tmp = std::env::temp_dir().join(format!("kbstore-noop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let (store, module, _) = sample_store(&tmp);

        // Everything here belongs to the current user, as it does when the
        // service installs a module itself: nothing to repair, and no panic.
        align_store_ownership(&store, &module);
        assert!(module.join("module.toml").is_file());

        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
