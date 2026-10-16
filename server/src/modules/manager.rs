use crate::{config::{DbCredentials, Settings}, errors::AppError};
use chrono::Utc;
use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::watch;

use super::manifest::{load_all, ModuleManifest};

// ── Registre d'arrêt des superviseurs ────────────────────────────────────────
// Permet à la désinstallation d'ARRÊTER un module lancé (kill du process + fin de
// la boucle de supervision). Un canal `watch<bool>` par module ; `true` = arrêter.

static SUPERVISORS: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
fn supervisors() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    SUPERVISORS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Demande l'arrêt d'un module supervisé (kill du process, fin de la supervision).
/// Retourne `true` si un superviseur écoutait ce module.
pub fn stop_module(module_id: &str) -> bool {
    if let Ok(mut map) = supervisors().lock() {
        if let Some(tx) = map.remove(module_id) {
            let _ = tx.send(true);
            return true;
        }
    }
    false
}

// ── Statut DB ────────────────────────────────────────────────────

pub async fn mark_healthy(db: &DbPool, instance_id: uuid::Uuid) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.module_instances SET status = 'healthy', last_heartbeat = $1 WHERE id = $2",
        params![Utc::now(), instance_id],
    )
    .await?;
    Ok(())
}

pub async fn mark_stopped(db: &DbPool, module_id: &str) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.module_instances SET status = 'stopped' WHERE module_id = $1",
        params![module_id],
    )
    .await?;
    Ok(())
}

// ── Sync DB ──────────────────────────────────────────────────────

/// Upserte le module dans core.modules d'après son manifest.
///
/// - Nouveaux modules : insérés avec is_enabled = TRUE (démarrés par défaut).
/// - Modules connus   : metadata mise à jour, is_enabled PRÉSERVÉ (choix de l'admin).
///
/// Retourne `true` si le module doit être démarré.
async fn sync_to_db(db: &DbPool, manifest: &ModuleManifest) -> bool {
    let m = &manifest.module;
    let backend = db.backend();

    // MySQL has no RETURNING, so the upsert runs first and `is_enabled` is
    // reselected by primary key: on conflict the row keeps its stored
    // `is_enabled` (it is not in the SET list), so the reselect returns the
    // admin's choice, and a freshly inserted row returns TRUE.
    //
    // NOTE (migration consolidation): `dependencies` is a PostgreSQL `TEXT[]`
    // column, bound here as a JSON array. The MySQL/SQLite schema stores it as
    // JSON; the PostgreSQL column must be migrated `TEXT[]` → `JSONB` for this
    // bind to be accepted there. Flagged for the schema-consolidation step.
    let conflict = backend.upsert(
        "core.modules",
        &["id"],
        &[
            Assign::Incoming("display_name"),
            Assign::Incoming("version"),
            Assign::Incoming("description"),
            Assign::Incoming("author"),
            Assign::Incoming("license"),
            Assign::Incoming("homepage_url"),
            Assign::Incoming("runtime"),
            Assign::Incoming("dependencies"),
            // "Sticky": once internal, stays internal (a later re-register can't unset it).
            Assign::Expr { col: "is_core_module", expr: "{cur} OR {new}" },
            Assign::Incoming("updated_at"),
        ],
    );
    let sql = format!(
        "INSERT INTO core.modules \
            (id, display_name, version, description, author, license, \
             homepage_url, runtime, dependencies, is_enabled, is_core_module, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11){conflict}"
    );
    let now = Utc::now();
    let write = db
        .execute(
            &sql,
            params![
                m.id.clone(),
                m.display_name.clone(),
                m.version.clone(),
                m.description.as_deref(),
                m.author.as_deref(),
                m.license.as_deref(),
                m.homepage_url.as_deref(),
                m.runtime.clone(),
                m.dependencies.clone(),
                m.internal,
                now,
            ],
        )
        .await;
    let result = match write {
        Ok(_) => db
            .fetch_scalar::<bool>(
                "SELECT is_enabled FROM core.modules WHERE id = $1",
                params![m.id.clone()],
            )
            .await,
        Err(e) => Err(e),
    };

    match result {
        Ok(enabled) => {
            if enabled {
                tracing::debug!(module_id = %m.id, version = %m.version, "Module synchronisé (activé)");
            } else {
                tracing::info!(module_id = %m.id, "Module synchronisé (désactivé par l'admin)");
            }
            enabled
        }
        Err(e) => {
            tracing::error!(module_id = %m.id, error = %e, "Erreur sync core.modules");
            // En cas d'erreur DB, on démarre quand même (fail-open)
            true
        }
    }
}

// ── Superviseur de processus ─────────────────────────────────────

/// Scanne `modules_dir`, synchronise avec la DB, puis lance et supervise
/// chaque module activé.
///
/// Variables d'environnement injectées dans chaque processus :
///   KUBUNO_CORE_URL        → URL du core (pour l'auto-enregistrement)
///   KUBUNO_INTERNAL_SECRET → Secret interne du module (dérivé du secret maître
///                            si `server.derive_module_secrets` est actif, sinon
///                            le secret maître lui-même)
///   KUBUNO_MODULE_ID       → Identifiant du module
///   KUBUNO_CONFIG_DIR      → /etc/kubuno/modules/<id>/
///   KUBUNO_DATA_DIR        → /var/lib/kubuno/modules/<id>/
///   KUBUNO_DB_HOST/PORT/USER/PASSWORD/NAME → Credentials PostgreSQL
pub async fn start_all(settings: Arc<Settings>, modules_dir: &Path, db: DbPool) {
    // On scanne DEUX emplacements : les paquets système (`modules_dir`) ET les modules
    // installés à l'exécution depuis la marketplace (`modules_install_dir`, inscriptible
    // par le core). En cas de doublon d'id, l'installation marketplace a la priorité
    // (mise à jour explicite par l'admin).
    let install_dir = PathBuf::from(&settings.server.modules_install_dir);
    // Create the store here, while running as the service account, so that it
    // belongs to the server whatever installed the first module. Left to the CLI
    // under sudo it would be created as root, and the server could never write a
    // marketplace install into it again.
    if !install_dir.is_dir() {
        match std::fs::create_dir_all(&install_dir) {
            Ok(()) => tracing::info!(dir = %install_dir.display(), "Store des modules créé"),
            Err(e) => tracing::error!(dir = %install_dir.display(), error = %e,
                "Création du store des modules impossible - les installations depuis la marketplace échoueront"),
        }
    }
    let mut manifests = load_all(&install_dir);
    let mut seen: std::collections::HashSet<String> =
        manifests.iter().map(|(_, m)| m.module.id.clone()).collect();
    for (dir, m) in load_all(modules_dir) {
        if seen.insert(m.module.id.clone()) {
            manifests.push((dir, m));
        } else {
            tracing::info!(module_id = %m.module.id, "Module système masqué par une version marketplace");
        }
    }

    if manifests.is_empty() {
        tracing::info!(dir = %modules_dir.display(), "Aucun module trouvé");
        return;
    }

    tracing::info!(
        dir   = %modules_dir.display(),
        store = %install_dir.display(),
        count = manifests.len(),
        "Modules découverts - synchronisation DB…"
    );

    for (module_dir, manifest) in manifests {
        spawn_module(settings.clone(), module_dir, manifest, db.clone()).await;
    }
}

/// Démarre (et supervise) UN module déjà présent sur disque, à chaud - utilisé au
/// démarrage (`start_all`) et après une installation marketplace. Synchronise les
/// métadonnées en DB puis lance la boucle de supervision dans une tâche dédiée.
/// Retourne `true` si le module a été lancé (activé), `false` s'il est désactivé.
pub async fn spawn_module(
    settings: Arc<Settings>,
    module_dir: PathBuf,
    manifest: ModuleManifest,
    db: DbPool,
) -> bool {
    let enabled = sync_to_db(&db, &manifest).await;
    if !enabled {
        tracing::info!(module_id = %manifest.module.id, "Module désactivé - non démarré");
        return false;
    }

    let core_url = format!(
        "http://{}:{}",
        if settings.server.host == "0.0.0.0" { "127.0.0.1" } else { &settings.server.host },
        settings.server.port
    );
    // Resolve the database for THIS module: an enabled override in
    // `core.module_databases` points it at another engine/server, otherwise it
    // inherits the core's own credentials.
    let resolved = match super::db_config::resolve(
        &db,
        &settings.database,
        &settings.auth.jwt_secret,
        &manifest.module.id,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, module_id = %manifest.module.id, "Credentials DB indisponibles - module non démarré");
            return false;
        }
    };
    let db_credentials = resolved.credentials;
    let db_schema_prefix = resolved.schema_prefix;
    if resolved.overridden {
        tracing::info!(
            module_id = %manifest.module.id,
            engine    = %db_credentials.engine,
            "Module démarré avec une base de données dédiée (override admin)"
        );
    }
    // Secret propre à ce module (dérivé du maître) lorsque la dérivation est
    // active - le module le lit comme n'importe quel secret partagé, il ignore
    // qu'il lui est spécifique. Voir `crate::auth::internal_secret`.
    let secret   = settings.server.module_secret(&manifest.module.id);
    tracing::debug!(
        module_id = %manifest.module.id,
        derived   = secret != settings.server.internal_secret,
        "Secret interne du module préparé"
    );
    let cfg_dir  = settings.server.modules_config_dir.clone();
    let data_dir = settings.server.modules_data_dir.clone();
    let db2      = db.clone();

    // Canal d'arrêt. Si un superviseur existait déjà pour cet id (mise à jour, ou
    // remplacement d'une version système par une version marketplace), on le prie de
    // s'arrêter (kill de son process) avant de démarrer le nouveau.
    let (stop_tx, stop_rx) = watch::channel(false);
    if let Ok(mut map) = supervisors().lock() {
        if let Some(old) = map.insert(manifest.module.id.clone(), stop_tx) {
            let _ = old.send(true);
        }
    }

    tokio::spawn(async move {
        supervise(manifest, module_dir, core_url, secret, db_credentials, db_schema_prefix, db2, cfg_dir, data_dir, stop_rx).await;
    });
    true
}

/// Restarts a module already present on disk, applying whatever database it now
/// resolves to (e.g. after an admin changed its override). Discovery mirrors
/// [`start_all`]: the marketplace store shadows the system package. Returns
/// `true` when a supervisor was (re)started for the module.
pub async fn restart_module(settings: Arc<Settings>, db: DbPool, module_id: &str) -> bool {
    let dirs = [
        PathBuf::from(&settings.server.modules_install_dir),
        PathBuf::from(&settings.server.modules_dir),
    ];
    for dir in dirs {
        for (mod_dir, manifest) in load_all(&dir) {
            if manifest.module.id == module_id {
                // `spawn_module` stops any running supervisor for this id before
                // starting the new one, so this is a genuine restart.
                return spawn_module(settings, mod_dir, manifest, db).await;
            }
        }
    }
    tracing::warn!(module_id, "restart_module : module introuvable sur disque");
    false
}

/// Boucle de supervision : lance le module, le redémarre s'il plante.
/// S'arrête définitivement après 5 échecs consécutifs au lancement.
#[allow(clippy::too_many_arguments)]
async fn supervise(
    manifest:           ModuleManifest,
    module_dir:         PathBuf,
    core_url:           String,
    internal_secret:    String,
    db_credentials:     DbCredentials,
    db_schema_prefix:   Option<String>,
    db:                 DbPool,
    modules_config_dir: String,
    modules_data_dir:   String,
    mut stop_rx:        watch::Receiver<bool>,
) {
    let module_id  = manifest.module.id.clone();
    // Chemins par module dérivés des réglages (défauts FHS Linux, surchargeables
    // sur Windows/macOS via KV__SERVER__MODULES_{CONFIG,DATA}_DIR).
    let config_dir = format!("{}/{module_id}", modules_config_dir.trim_end_matches(['/', '\\']));
    let data_dir   = format!("{}/{module_id}", modules_data_dir.trim_end_matches(['/', '\\']));

    // Le CWD du module doit exister, sinon `spawn` échoue. On crée les deux dossiers
    // (no-op s'ils existent ; les paquets les créent déjà à l'installation).
    if let Err(e) = std::fs::create_dir_all(&config_dir) {
        tracing::warn!(module_id = %module_id, dir = %config_dir, error = %e, "Création du répertoire de config du module impossible");
    }
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        tracing::warn!(module_id = %module_id, dir = %data_dir, error = %e, "Création du répertoire de données du module impossible");
    }

    // Working directory: `spawn` reports a missing CWD as ENOENT - the very same
    // error as a missing executable - so a module whose configuration directory
    // could not be created died five times over with a message pointing at the
    // binary, which was there all along. Only a directory that EXISTS is handed
    // to the child; the module's own directory is the last resort, and it is
    // always present since that is where the binary was found.
    let work_dir = [config_dir.as_str(), data_dir.as_str()]
        .into_iter()
        .find(|d| Path::new(d).is_dir())
        .map(PathBuf::from)
        .unwrap_or_else(|| module_dir.clone());
    if work_dir.as_os_str() != config_dir.as_str() {
        tracing::warn!(
            module_id = %module_id,
            prevu     = %config_dir,
            retenu    = %work_dir.display(),
            "Répertoire de configuration du module inaccessible - le module démarre \
             depuis un répertoire de repli et n'aura pas sa configuration propre"
        );
    }

    let mut consecutive_failures: u32 = 0;

    loop {
        // Arrêt demandé (désinstallation) avant un (re)lancement.
        if *stop_rx.borrow() {
            tracing::info!(module_id = %module_id, "Supervision arrêtée (arrêt demandé)");
            let _ = mark_stopped(&db, &module_id).await;
            break;
        }

        let mut cmd = manifest.build_tokio_command(&module_dir);

        cmd
            .env("KUBUNO_CORE_URL",        &core_url)
            .env("KUBUNO_INTERNAL_SECRET", &internal_secret)
            .env("KUBUNO_MODULE_ID",       &module_id)
            .env("KUBUNO_MODULE_DIR",      module_dir.to_str().unwrap_or(""))
            .env("KUBUNO_CONFIG_DIR",      &config_dir)
            .env("KUBUNO_DATA_DIR",        &data_dir)
            // The engine (and, for SQLite, the file directory) is transported so
            // the module opens the SAME kind of database as the core.
            .env("KUBUNO_DB_ENGINE",       &db_credentials.engine)
            .env("KUBUNO_DB_HOST",         &db_credentials.host)
            .env("KUBUNO_DB_PORT",         db_credentials.port.to_string())
            .env("KUBUNO_DB_USER",         &db_credentials.user)
            .env("KUBUNO_DB_PASSWORD",     &db_credentials.password)
            .env("KUBUNO_DB_NAME",         &db_credentials.database)
            .env("KUBUNO_DB_PATH",         &db_credentials.path)
            // The instance-wide search term cap (`[search] max_terms`), applied
            // by kubuno-db when the module opens its pool.
            .env(kubuno_db::search::MAX_TERMS_ENV, kubuno_db::search::max_terms().to_string())
            .current_dir(&work_dir);

        // Optional schema prefix, carried only when set (an override with a
        // WordPress-style prefix). A module that does not read it simply ignores
        // the variable, so this stays backward-compatible.
        if let Some(prefix) = &db_schema_prefix {
            cmd.env("KUBUNO_DB_SCHEMA_PREFIX", prefix);
        }

        cmd
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit());

        tracing::info!(
            module_id = %module_id,
            runtime   = %manifest.module.runtime,
            "Démarrage du module"
        );

        match cmd.spawn() {
            Ok(mut child) => {
                consecutive_failures = 0;
                // Attend soit la fin du process, soit une demande d'arrêt (→ kill).
                let waited = tokio::select! {
                    status = child.wait() => Some(status),
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            tracing::info!(module_id = %module_id, "Arrêt demandé - kill du module");
                            let _ = child.start_kill();
                            let _ = child.wait().await;
                            let _ = mark_stopped(&db, &module_id).await;
                            break;
                        }
                        None
                    }
                };
                match waited {
                    Some(Ok(status)) if status.success() => {
                        tracing::info!(module_id = %module_id, "Module arrêté proprement");
                        let _ = mark_stopped(&db, &module_id).await;
                        break;
                    }
                    Some(Ok(status)) => {
                        tracing::warn!(
                            module_id = %module_id,
                            code      = ?status.code(),
                            "Module terminé avec erreur, redémarrage…"
                        );
                        let _ = mark_stopped(&db, &module_id).await;
                    }
                    Some(Err(e)) => {
                        tracing::error!(module_id = %module_id, error = %e, "Erreur wait()");
                    }
                    None => {}
                }
            }
            Err(e) => {
                consecutive_failures += 1;
                tracing::error!(
                    module_id   = %module_id,
                    error       = %e,
                    executable  = %manifest.entrypoint_path(&module_dir).display(),
                    repertoire  = %work_dir.display(),
                    attempt     = consecutive_failures,
                    "Impossible de lancer le module (vérifiez l'exécutable ET le répertoire de travail : \
                     les deux manquants donnent la même erreur « No such file or directory »)"
                );
                if consecutive_failures >= 5 {
                    tracing::error!(
                        module_id = %module_id,
                        "5 échecs de lancement consécutifs - supervision abandonnée"
                    );
                    let _ = mark_stopped(&db, &module_id).await;
                    break;
                }
            }
        }

        // Backoff exponentiel : 1s, 2s, 4s, 8s, 16s → plafonné à 30s
        let delay = std::cmp::min(2u64.pow(consecutive_failures.saturating_sub(1).min(4)), 30);
        tokio::time::sleep(tokio::time::Duration::from_secs(delay)).await;
    }
    // NB : on ne retire PAS l'entrée du registre ici - elle a pu être remplacée par un
    // nouveau superviseur (mise à jour). `stop_module` la retire explicitement ; une
    // entrée résiduelle (module arrêté seul) est inoffensive (récepteur disparu).
}
