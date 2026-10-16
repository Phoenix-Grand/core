use crate::auth::internal_secret::{authenticate, derive_module_secret, InternalCaller};
use config::{Config, ConfigError, Environment, File};
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
pub struct Settings {
    pub server:   ServerSettings,
    pub database: DatabaseSettings,
    pub auth:     AuthSettings,
    pub storage:  StorageSettings,
    pub logging:  LoggingSettings,
    /// Full-text search tuning. Optional section: absent = built-in defaults.
    #[serde(default)]
    pub search:   SearchSettings,
    /// Explicit platform directories. Optional section: absent = the platform
    /// layout of `kubuno-paths` (see [`crate::config::paths`]).
    #[serde(default)]
    pub paths:    crate::config::paths::PathsSettings,
}

/// `[search]` - applied to the core at start-up and carried to every module it
/// starts (`KUBUNO_DB_SEARCH_MAX_TERMS`), so the whole instance shares it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SearchSettings {
    /// The most distinct words a search keeps; later words are ignored. Each
    /// word costs one `LIKE '%…%'` per searched column, so this bounds the work
    /// one request can ask of the database. Absent = 16; clamped to `1..=256`.
    #[serde(default)]
    pub max_terms: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerSettings {
    pub host:            String,
    pub port:            u16,
    pub frontend_dist:   String,
    pub internal_secret: String,
    /// Répertoire contenant les sous-dossiers de chaque module installé.
    pub modules_dir:     String,
    /// Répertoire parent des configurations par module (`<dir>/<module_id>/config.toml`).
    /// Sert aussi de répertoire de travail (CWD) du processus module. Défaut FHS Linux ;
    /// surchargeable (Windows/macOS) via `KV__SERVER__MODULES_CONFIG_DIR`.
    #[serde(default = "default_modules_config_dir")]
    pub modules_config_dir: String,
    /// Répertoire parent des données par module (`<dir>/<module_id>/`). Défaut FHS Linux ;
    /// surchargeable via `KV__SERVER__MODULES_DATA_DIR`.
    #[serde(default = "default_modules_data_dir")]
    pub modules_data_dir:   String,
    /// Répertoire des modules installés depuis la **marketplace** à l'exécution.
    /// Distinct de `modules_dir` (paquets système, souvent en lecture seule pour le
    /// service) : il doit être INSCRIPTIBLE par le core (défaut sous `/var/lib/kubuno`,
    /// propriété de l'utilisateur du service). Scanné EN PLUS de `modules_dir`.
    #[serde(default = "default_modules_install_dir")]
    pub modules_install_dir: String,
    /// Répertoire contenant les fichiers de thèmes JSON.
    pub themes_dir:      String,
    /// Origines CORS autorisées (séparées par des virgules). Vide = même origine uniquement.
    /// Exemple : http://localhost:5173,https://cloud.example.com
    #[serde(default)]
    pub cors_origins:    Vec<String>,
    /// Ajoute l'attribut Secure aux cookies (activer en production HTTPS).
    #[serde(default)]
    pub secure_cookies:  bool,
    /// Plages CIDR (IPv4 et IPv6) des mandataires inverses autorisés à définir
    /// `X-Forwarded-For` / `X-Real-IP`. Toute requête provenant d'une autre
    /// adresse voit ces en-têtes IGNORÉS : l'adresse de la socket fait foi.
    ///
    /// Sans ce filtre, n'importe quel client peut faire varier l'en-tête à
    /// chaque requête et contourner la limitation de débit et la protection
    /// anti-déni de service.
    ///
    /// Défaut : bouclage et plages privées (127.0.0.0/8, ::1/128, 10.0.0.0/8,
    /// 172.16.0.0/12, 192.168.0.0/16, fc00::/7) - voir
    /// [`crate::auth::client_ip::DEFAULT_TRUSTED_PROXY_CIDRS`]. Un mandataire
    /// atteignant le core depuis une adresse PUBLIQUE (tunnel VPN, répartiteur
    /// de charge distant) doit être déclaré explicitement ici.
    #[serde(default = "default_trusted_proxy_cidrs")]
    pub trusted_proxy_cidrs: Vec<String>,
    /// Distribue à chaque module supervisé un secret interne **dérivé** de
    /// `internal_secret` (voir [`crate::auth::internal_secret`]) au lieu du
    /// secret maître. Le core sait alors quel module l'appelle ; un module
    /// compromis ne peut plus se faire passer pour un autre auprès du core.
    ///
    /// Les modules n'ont rien à changer : ils lisent toujours
    /// `KUBUNO_INTERNAL_SECRET` et le présentent tel quel.
    ///
    /// ⚠️ Défaut `false` : certains modules s'appellent **directement** entre eux
    /// (client `kubuno-drive` → `http://127.0.0.1:3101/ipc/*`) et comparent le
    /// secret reçu à leur propre secret. Deux modules dotés de secrets distincts
    /// ne peuvent donc plus dialoguer en direct. Activer ce réglage suppose
    /// d'exempter ce groupe via `shared_secret_modules`, ou que les modules
    /// concernés délèguent la validation au core.
    #[serde(default)]
    pub derive_module_secrets: bool,
    /// Modules conservant le secret **maître** lorsque `derive_module_secrets`
    /// est actif. Nécessaire pour le groupe de modules qui s'appellent
    /// directement (IPC de pair à pair), le récepteur exigeant l'égalité stricte
    /// des secrets. Aucun identifiant n'est codé en dur dans le core.
    #[serde(default)]
    pub shared_secret_modules: Vec<String>,
    /// Durcissement : refuse le secret **maître** sur `/internal/*` et sur le
    /// chemin d'authentification interne du proxy - seuls les secrets dérivés
    /// sont alors acceptés. À n'activer qu'une fois tous les modules supervisés
    /// par le core (un module lancé à la main avec le secret maître, en
    /// développement, serait rejeté).
    #[serde(default)]
    pub reject_master_internal_secret: bool,
    /// Terminaison TLS native (HTTPS) dans le core. Voir [`TlsSettings`].
    #[serde(default)]
    pub tls:             TlsSettings,
}

fn default_trusted_proxy_cidrs() -> Vec<String> {
    crate::auth::client_ip::DEFAULT_TRUSTED_PROXY_CIDRS
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

/// Longueur minimale de `server.internal_secret`, en octets. 32 octets est le
/// plancher pour un secret devant résister à une recherche hors ligne ;
/// `openssl rand -hex 32` en produit 64.
const MIN_INTERNAL_SECRET_LEN: usize = 32;

impl ServerSettings {
    /// Valide le secret partagé qui protège `/internal/*`. Un secret vide rend
    /// ces routes accessibles à toute requête envoyant un en-tête
    /// `X-Internal-Secret` vide.
    ///
    /// La valeur n'est JAMAIS incluse dans le message d'erreur ni journalisée.
    fn validate_internal_secret(&self) -> Result<(), String> {
        let len = self.internal_secret.trim().len();
        if len == 0 {
            return Err(format!(
                "server.internal_secret est vide : les routes /internal/* accepteraient alors \
                 toute requête portant un en-tête X-Internal-Secret vide. Renseignez-le dans \
                 {} (section [server]) ou via KV__SERVER__INTERNAL_SECRET. \
                 Générez une valeur avec : openssl rand -hex 32",
                crate::config::paths::current().config_file().display()
            ));
        }
        if len < MIN_INTERNAL_SECRET_LEN {
            return Err(format!(
                "server.internal_secret trop court ({len} octets) : {MIN_INTERNAL_SECRET_LEN} \
                 octets minimum. Régénérez-le avec : openssl rand -hex 32 \
                 (et reportez la même valeur dans les modules non supervisés par le core)"
            ));
        }
        Ok(())
    }

    /// Secret interne remis au module `module_id` au démarrage - et donc celui
    /// que le core doit lui présenter quand il l'appelle (le module compare le
    /// `X-Internal-Secret` reçu à sa propre valeur).
    ///
    /// La valeur retournée ne doit jamais être journalisée.
    pub fn module_secret(&self, module_id: &str) -> String {
        let exempt = self
            .shared_secret_modules
            .iter()
            .any(|m| m.trim() == module_id);
        if self.derive_module_secrets && !exempt {
            derive_module_secret(&self.internal_secret, module_id)
        } else {
            self.internal_secret.clone()
        }
    }

    /// Authentifie un `X-Internal-Secret` présenté au core et identifie son
    /// émetteur. `None` = secret invalide (la requête doit être refusée).
    pub fn authenticate_internal(&self, presented: &str) -> Option<InternalCaller> {
        authenticate(
            &self.internal_secret,
            presented,
            !self.reject_master_internal_secret,
        )
    }
}

fn default_modules_config_dir() -> String {
    path_string(&crate::config::paths::current().modules_config_dir)
}

fn default_modules_data_dir() -> String {
    path_string(&crate::config::paths::current().modules_data_dir)
}

fn default_modules_install_dir() -> String {
    path_string(&crate::config::paths::current().modules_store)
}

fn path_string(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Where the packaged modules (read-only, shipped by the installer) live.
///
/// Not a `kubuno-paths` directory: it belongs to the installation, not to the
/// instance. Off Linux it is beside the executables, never `/usr/lib/...`,
/// which on Windows would be a drive-relative `C:\usr\lib\...` that any local
/// user can create and fill with a "module" the service would then run.
fn default_system_modules_dir() -> String {
    match kubuno_paths::Os::current() {
        kubuno_paths::Os::Linux => "/usr/lib/kubuno/modules".to_string(),
        kubuno_paths::Os::MacOs => "/usr/local/kubuno/modules".to_string(),
        kubuno_paths::Os::Windows => std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.join("modules")))
            .map(|p| path_string(&p))
            .unwrap_or_else(|| path_string(&crate::config::paths::current().data_dir.join("modules-system"))),
    }
}

/// Configuration HTTPS / TLS native.
///
/// Quand `enabled = true`, le core termine lui-même le TLS (HTTPS direct, sans
/// reverse-proxy). Quand `enabled = false` (défaut), il sert en HTTP nu - la
/// terminaison TLS peut alors être faite par un reverse-proxy (nginx…).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TlsSettings {
    /// Active la terminaison TLS native (HTTPS) dans le core.
    #[serde(default)]
    pub enabled: bool,
    /// Chemin du certificat PEM (chaîne complète : feuille + intermédiaires).
    #[serde(default)]
    pub cert_path: String,
    /// Chemin de la clé privée PEM (PKCS#8 ou RSA, non chiffrée).
    #[serde(default)]
    pub key_path: String,
    /// Si > 0, écoute AUSSI en HTTP nu sur ce port et redirige (308) vers HTTPS.
    /// 0 (défaut) = pas de redirection. Exemple : 80 pour rediriger le web standard.
    #[serde(default)]
    pub redirect_http_from_port: u16,
}

impl TlsSettings {
    /// Valide la cohérence quand TLS est activé : les chemins doivent être
    /// renseignés et les fichiers exister/être lisibles.
    pub fn validate(&self) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        if self.cert_path.trim().is_empty() || self.key_path.trim().is_empty() {
            return Err(
                "server.tls.enabled = true exige server.tls.cert_path et server.tls.key_path".into(),
            );
        }
        for (label, path) in [("cert_path", &self.cert_path), ("key_path", &self.key_path)] {
            if !std::path::Path::new(path).is_file() {
                return Err(format!("server.tls.{label} introuvable : {path}"));
            }
        }
        Ok(())
    }
}

/// The `[database]` section is owned by kubuno-db: which of its fields matter
/// (`url`/host/port/user/password/database, or SQLite `path`) depends on the
/// `engine` the administrator chooses at run time, and the pool is opened by
/// `kubuno_db::connect`.
pub use kubuno_db::DbSettings as DatabaseSettings;

/// "The database engine follows the connection URL": when the URL is what the
/// pool connects with (no discrete `host`/`user`, see `kubuno_db::connect`), its
/// scheme decides the engine - `postgres://`/`postgresql://`, `mysql://`/
/// `mariadb://`, `sqlite://`. `engine` used to keep its `postgres` default, so a
/// lone `KV__DATABASE__URL=mysql://…` (how a development core is pointed at its
/// database) was dialled with the PostgreSQL protocol.
pub fn engine_from_url(db: &mut DatabaseSettings) {
    if db.host.is_some() || db.user.is_some() {
        return;
    }
    let Some(scheme) = db.url.as_deref().and_then(|u| u.split_once("://")).map(|(s, _)| s) else {
        return;
    };
    let canonical = match kubuno_db::Backend::parse(scheme) {
        Some(kubuno_db::Backend::Postgres) => "postgres",
        Some(kubuno_db::Backend::MySql) => "mysql",
        Some(kubuno_db::Backend::Sqlite) => "sqlite",
        None => return,
    };
    if db.engine != canonical {
        db.engine = canonical.to_string();
    }
}

/// Minimal presence check the installer and `load()` share. kubuno-db validates
/// the concrete fields per engine when it connects; here we only reject an
/// obviously empty PostgreSQL/MySQL section early, with a friendly message. On
/// SQLite the file path defaults, so nothing is required.
pub fn validate_database(db: &DatabaseSettings) -> Result<(), String> {
    let backend = kubuno_db::Backend::parse(&db.engine)
        .ok_or_else(|| format!("database.engine inconnu : {}", db.engine))?;
    if matches!(backend, kubuno_db::Backend::Sqlite) {
        return Ok(());
    }
    if db.url.is_none() && (db.user.is_none() || db.database.is_none()) {
        return Err(
            "database: fournissez 'url' OU les champs 'host/user/password/database'".into(),
        );
    }
    // Reject an invalid schema prefix early, at config load, with a clear
    // message (WordPress-style prefix shared by several instances). kubuno-db
    // enforces the same `^[a-z0-9_]{1,32}$` rule again when it connects; doing
    // it here means an install with `KV__DATABASE__SCHEMA_PREFIX` or a bad
    // `[database] schema_prefix` never reaches the pool.
    kubuno_db::SchemaPrefix::new(db.schema_prefix.as_deref())?;
    Ok(())
}

/// Extracts the individual credentials (engine/host/port/user/password/database
/// and, for SQLite, the file path), whether the configuration is in URL or
/// discrete-field mode. Used by the supervisor to inject them into the module
/// processes so a module connects to the SAME engine and database as the core.
pub fn database_credentials(db: &DatabaseSettings) -> anyhow::Result<DbCredentials> {
    let default_port = match kubuno_db::Backend::parse(&db.engine) {
        Some(kubuno_db::Backend::MySql) => 3306,
        _ => 5432,
    };
    // Same precedence as `kubuno_db::connect`, which opens the core's own pool:
    // discrete fields win as soon as `host` or `user` is set. Reading the URL first
    // here handed the modules another database than the core's whenever both were
    // present (e.g. a config an engine switch rewrote around a leftover `url`).
    let discrete = db.host.is_some() || db.user.is_some();
    if let Some(raw) = db.url.as_ref().filter(|_| !discrete) {
        // A SQLite URL is `sqlite://<path>`; keep the path and skip URL parsing.
        if let Some(path) = raw.strip_prefix("sqlite://") {
            return Ok(DbCredentials {
                engine: db.engine.clone(),
                host: String::new(),
                port: default_port,
                user: String::new(),
                password: String::new(),
                database: String::new(),
                path: path.to_string(),
            });
        }
        let parsed = url::Url::parse(raw)
            .map_err(|e| anyhow::anyhow!("database.url invalide : {e}"))?;
        return Ok(DbCredentials {
            engine:   db.engine.clone(),
            host:     parsed.host_str().unwrap_or("localhost").to_string(),
            port:     parsed.port().unwrap_or(default_port),
            user:     parsed.username().to_string(),
            password: parsed.password().unwrap_or("").to_string(),
            database: parsed.path().trim_start_matches('/').to_string(),
            path:     db.path.clone().unwrap_or_default(),
        });
    }
    Ok(DbCredentials {
        engine:   db.engine.clone(),
        host:     db.host.clone().unwrap_or_else(|| "localhost".to_string()),
        port:     db.port.unwrap_or(default_port),
        user:     db.user.clone().unwrap_or_default(),
        password: db.password.clone().unwrap_or_default(),
        database: db.database.clone().unwrap_or_default(),
        path:     db.path.clone().unwrap_or_default(),
    })
}

#[derive(Debug, Clone)]
pub struct DbCredentials {
    /// The engine name (`postgres`/`mysql`/`sqlite`), transported so a module
    /// opens the same kind of database as the core.
    pub engine:   String,
    pub host:     String,
    pub port:     u16,
    pub user:     String,
    pub password: String,
    pub database: String,
    /// SQLite only: the directory holding the per-schema `.sqlite` files.
    pub path:     String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthSettings {
    pub jwt_secret:          String,
    #[serde(with = "duration_secs")]
    pub access_token_ttl:    Duration,
    #[serde(with = "duration_days")]
    pub refresh_token_ttl:   Duration,
    pub oauth_google_id:     Option<String>,
    pub oauth_google_secret: Option<String>,
    pub oauth_github_id:     Option<String>,
    pub oauth_github_secret: Option<String>,
    /// Lifetime, in seconds, of a signed ticket for an image, a preview or a
    /// download (`crate::auth::tickets`). Clamped to 30..=900.
    #[serde(default = "default_ticket_ttl")]
    pub ticket_ttl_secs:        u64,
    /// Lifetime, in seconds, of a signed ticket for a media stream or an
    /// event stream (Range requests keep re-using it during playback). Still
    /// revoked at once by signing out. Clamped to 60..=86400.
    #[serde(default = "default_ticket_stream_ttl")]
    pub ticket_stream_ttl_secs: u64,
    /// DEPRECATED compatibility switch, kept for one release. When `true`, the
    /// core sets an `access_token` cookie (HttpOnly, `Path=/api/v1`) on sign-in,
    /// refresh and account switch, and still accepts it on requests without an
    /// `Authorization` header, so module frontends built before signed tickets
    /// keep loading their images and downloads. Each use is logged as a
    /// deprecation warning naming the module. Will be removed next release.
    #[serde(default = "default_legacy_access_cookie")]
    pub legacy_access_cookie:   bool,
    // OIDC providers (Keycloak, GitLab…) are configured at runtime from the admin
    // console and stored in `core.oauth_providers`, not in static config.
}

pub use kubuno_storage::config::StorageConfig as StorageSettings;
pub use kubuno_storage::config::StorageBackendType;

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingSettings {
    pub level:         String,
    pub format:        LogFormat,
    /// Répertoire où écrire access.log et error.log.
    pub log_dir:       String,
    /// Active l'écriture dans les fichiers (false = stdout uniquement).
    pub file_enabled:  bool,
    /// Politique de rotation : daily | hourly | never.
    pub rotation:      LogRotation,
    /// Nombre de fichiers rotatifs à conserver (ex: 30 → 30 jours avec daily).
    /// Ignoré si rotation = "never".
    pub max_log_files: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    Pretty,
    Json,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogRotation {
    Daily,
    Hourly,
    Never,
}

impl Settings {
    /// Builds the merged configuration sources (defaults → config.toml →
    /// /etc/kubuno/config.toml → KV__ environment).
    /// `explicit` is the file named by `--config` / `KV_CONFIG_FILE`: when given
    /// it REPLACES the default file lookup, the way a daemon's `-c` does, so an
    /// instance can be run against a configuration of its own without the system
    /// one leaking into it.
    fn build_config(explicit: Option<&str>) -> Result<Config, ConfigError> {
        // The platform layout first: it names the system configuration file,
        // and the `[paths]` section of the files (or `KV__PATHS__*`) may then
        // refine the other directories. `[paths]` cannot move the configuration
        // file itself: that is `--config` / `KV_CONFIG_FILE` /
        // `KUBUNO_PATHS_CONFIG_DIR`.
        //
        // Which files are read is decided once, from the environment alone:
        // the system file is read by the system instance only (see
        // `kubuno_paths::plan_config_files`).
        let plan = crate::config::paths::config_plan(explicit)
            .map_err(|e| ConfigError::Message(e.to_string()))?;
        let pre = Self::with_sources(Config::builder(), &plan).build()?;
        let paths_section: crate::config::paths::PathsSettings = match pre.get("paths") {
            Ok(section) => section,
            Err(ConfigError::NotFound(_)) => Default::default(),
            Err(e) => return Err(e),
        };
        let paths = crate::config::paths::init(&paths_section)
            .map_err(|e| ConfigError::Message(e.to_string()))?;

        let cfg = Config::builder()
            // Defaults
            .set_default("server.host", "0.0.0.0")?
            .set_default("server.port", 8080)?
            .set_default("server.frontend_dist", "./frontend/dist")?
            .set_default("server.internal_secret", "")?
            .set_default("server.modules_dir", default_system_modules_dir())?
            .set_default("server.themes_dir", path_string(&paths.themes_dir()))?
            .set_default("server.cors_origins", Vec::<String>::new())?
            .set_default("server.secure_cookies", false)?
            .set_default("server.trusted_proxy_cidrs", default_trusted_proxy_cidrs())?
            .set_default("server.derive_module_secrets", false)?
            .set_default("server.shared_secret_modules", Vec::<String>::new())?
            .set_default("server.reject_master_internal_secret", false)?
            .set_default("server.tls.enabled", false)?
            .set_default("server.tls.cert_path", "")?
            .set_default("server.tls.key_path", "")?
            .set_default("server.tls.redirect_http_from_port", 0)?
            .set_default("database.engine", "postgres")?
            // SQLite only: directory holding the `<schema>.sqlite` files.
            .set_default("database.path", path_string(&paths.sqlite_dir()))?
            .set_default("database.max_connections", 20)?
            .set_default("database.min_connections", 2)?
            .set_default("database.connect_timeout", 10u64)?
            .set_default("database.run_migrations", true)?
            .set_default("auth.access_token_ttl", 900u64)?
            .set_default("auth.refresh_token_ttl", 30u64)?
            .set_default("storage.backend", "local")?
            .set_default("storage.local_path", "./data/files")?
            .set_default("logging.level", "info")?
            .set_default("logging.format", "pretty")?
            .set_default("logging.log_dir", path_string(&paths.log_dir))?
            .set_default("logging.file_enabled", true)?
            .set_default("logging.rotation", "never")?
            .set_default("logging.max_log_files", 30u32)?;
        let cfg = Self::with_sources(cfg, &plan).build()?;

        Ok(cfg)
    }

    /// The configuration sources of `plan`, in increasing priority:
    /// 1. ONLY the file named explicitly (`--config` / `KV_CONFIG_FILE`), or:
    /// 2. `config.<ext>` in the working directory;
    /// 3. the system files (macOS: the pre-`kubuno-paths` `/etc/kubuno/config.toml`
    ///    first; then `/etc/kubuno`, `%ProgramData%\Kubuno` or
    ///    `/Library/Application Support/Kubuno`), for the system instance only;
    ///    or the instance's own `<config_dir>/config.toml` when its configuration
    ///    directory is not the system one (user mode, `KUBUNO_PATHS_CONFIG_DIR`);
    /// 4. the `KV__` environment variables (Docker / one-off overrides), e.g.
    ///    `KV__DATABASE__URL=postgres://...`; lists are comma-separated:
    ///    `KV__SERVER__TRUSTED_PROXY_CIDRS=127.0.0.0/8,10.0.0.0/8`.
    ///
    /// The directory files are given without their extension, as before, so
    /// that `config.toml`, `config.yaml`… are all recognised.
    fn with_sources(
        builder: config::ConfigBuilder<config::builder::DefaultState>,
        plan: &kubuno_paths::ConfigPlan,
    ) -> config::ConfigBuilder<config::builder::DefaultState> {
        fn stem(p: &std::path::Path) -> String {
            path_string(&p.with_extension(""))
        }
        let mut builder = builder;
        if let Some(explicit) = &plan.explicit {
            builder = builder.add_source(File::with_name(&path_string(explicit)).required(true));
        } else {
            if let Some(local) = &plan.local {
                builder = builder.add_source(File::from(local.as_path()).required(false));
            }
            for system in &plan.system {
                builder = builder.add_source(File::with_name(&stem(system)).required(false));
            }
            if let Some(own) = &plan.instance {
                builder = builder.add_source(File::with_name(&stem(own)).required(false));
            }
        }
        builder.add_source(
            Environment::with_prefix("KV")
                .separator("__")
                .try_parsing(true)
                .list_separator(",")
                .with_list_parse_key("server.trusted_proxy_cidrs")
                .with_list_parse_key("server.shared_secret_modules"),
        )
    }

    /// Merged configuration WITHOUT the checks `load()` applies. A fresh
    /// installation is precisely the state `load()` rejects - no database, the
    /// shipped placeholder secrets - and the first-run installer has to read it
    /// to know it must offer the wizard.
    pub fn load_unvalidated() -> Result<Self, ConfigError> {
        Self::load_unvalidated_from(None)
    }

    /// As `load_unvalidated`, against the configuration file named by
    /// `--config` / `KV_CONFIG_FILE` when there is one.
    pub fn load_unvalidated_from(explicit: Option<&str>) -> Result<Self, ConfigError> {
        let mut settings: Self = Self::build_config(explicit)?
            .try_deserialize()
            .map_err(|e| ConfigError::Message(with_skipped_system_note(e.to_string(), explicit)))?;
        engine_from_url(&mut settings.database);
        Ok(settings)
    }

    pub fn load() -> Result<Self, ConfigError> {
        Self::load_from(None)
    }

    /// As `load`, against an explicitly named configuration file.
    pub fn load_from(explicit: Option<&str>) -> Result<Self, ConfigError> {
        let settings = Self::load_unvalidated_from(explicit)?;
        let explain = |e: String| ConfigError::Message(with_skipped_system_note(e, explicit));
        validate_database(&settings.database).map_err(explain)?;
        settings.server.tls.validate().map_err(explain)?;
        settings.server.validate_internal_secret().map_err(explain)?;
        Ok(settings)
    }
}

/// `error`, plus why the system configuration was not read when it exists:
/// an instance that is not the system one must never fall back to it, and
/// must not leave the operator guessing either.
fn with_skipped_system_note(error: String, explicit: Option<&str>) -> String {
    let Ok(plan) = crate::config::paths::config_plan(explicit) else {
        return error;
    };
    match &plan.skipped {
        Some((files, why)) => {
            let present: Vec<String> = files.iter().filter(|f| f.exists()).map(|f| f.display().to_string()).collect();
            if present.is_empty() {
                error
            } else {
                format!("{error}\n(the system configuration {} was not read: {why})", present.join(", "))
            }
        }
        None => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use config::Config;

    /// 64 hex characters, i.e. what `openssl rand -hex 32` produces - the tests
    /// must use a value that passes `validate_internal_secret()`.
    const TEST_INTERNAL_SECRET: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn db_settings(v: serde_json::Value) -> DatabaseSettings {
        serde_json::from_value(v).expect("database settings")
    }

    #[test]
    fn the_engine_follows_the_url_scheme_when_the_url_is_used() {
        let mut my = db_settings(serde_json::json!({ "url": "mysql://u:p@127.0.0.1:3306/kubuno_dev" }));
        assert_eq!(my.engine, "postgres", "serde default before normalisation");
        engine_from_url(&mut my);
        assert_eq!(my.engine, "mysql");

        let mut maria = db_settings(serde_json::json!({ "url": "mariadb://u:p@h/db" }));
        engine_from_url(&mut maria);
        assert_eq!(maria.engine, "mysql");

        let mut lite = db_settings(serde_json::json!({ "engine": "postgres", "url": "sqlite://C:/data" }));
        engine_from_url(&mut lite);
        assert_eq!(lite.engine, "sqlite");

        // Discrete fields are what connects: the URL does not decide.
        let mut fields = db_settings(serde_json::json!({
            "engine": "mysql", "url": "postgres://u:p@h/db", "host": "127.0.0.1", "user": "k"
        }));
        engine_from_url(&mut fields);
        assert_eq!(fields.engine, "mysql");

        // An unknown scheme leaves the configured engine alone.
        let mut odd = db_settings(serde_json::json!({ "engine": "postgres", "url": "odbc://x/y" }));
        engine_from_url(&mut odd);
        assert_eq!(odd.engine, "postgres");
    }

    #[test]
    fn module_credentials_follow_the_core_pool_precedence() {
        // Only a URL: the URL.
        let only_url = db_settings(serde_json::json!({
            "engine": "postgres", "url": "postgres://pg:secret@db-a:5433/kub"
        }));
        let c = database_credentials(&only_url).expect("creds");
        assert_eq!((c.host.as_str(), c.port, c.user.as_str(), c.database.as_str()), ("db-a", 5433, "pg", "kub"));

        // A leftover URL beside discrete fields: the fields, like kubuno_db::connect.
        let both = db_settings(serde_json::json!({
            "engine": "mysql", "url": "postgres://pg:secret@db-a:5433/kub",
            "host": "127.0.0.1", "port": 3306, "user": "kubuno_dev", "password": "pw", "database": "kubuno_dev"
        }));
        let c = database_credentials(&both).expect("creds");
        assert_eq!(c.engine, "mysql");
        assert_eq!((c.host.as_str(), c.port, c.user.as_str()), ("127.0.0.1", 3306, "kubuno_dev"));
        assert_eq!((c.password.as_str(), c.database.as_str()), ("pw", "kubuno_dev"));
    }

    fn minimal_config() -> Config {
        Config::builder()
            .set_default("server.host", "127.0.0.1").unwrap()
            .set_default("server.port", 8080u16).unwrap()
            .set_default("server.frontend_dist", "./frontend/dist").unwrap()
            .set_default("server.internal_secret", TEST_INTERNAL_SECRET).unwrap()
            .set_default("server.modules_dir", "/usr/lib/kubuno/modules").unwrap()
            .set_default("server.themes_dir", "/var/lib/kubuno/themes").unwrap()
            .set_default("database.url", "postgres://test@localhost/test").unwrap()
            .set_default("database.max_connections", 5u32).unwrap()
            .set_default("database.min_connections", 1u32).unwrap()
            .set_default("database.connect_timeout", 5u64).unwrap()
            .set_default("database.run_migrations", false).unwrap()
            .set_default("auth.jwt_secret", "secret_key_long_enough_for_testing_purposes").unwrap()
            .set_default("auth.access_token_ttl", 900u64).unwrap()
            .set_default("auth.refresh_token_ttl", 30u64).unwrap()
            .set_default("storage.backend", "local").unwrap()
            .set_default("storage.local_path", "./data/files").unwrap()
            .set_default("logging.level", "info").unwrap()
            .set_default("logging.format", "pretty").unwrap()
            .set_default("logging.log_dir", "/var/log/kubuno").unwrap()
            .set_default("logging.file_enabled", false).unwrap()
            .set_default("logging.rotation", "daily").unwrap()
            .set_default("logging.max_log_files", 30u32).unwrap()
            .build()
            .unwrap()
    }

    #[test]
    fn search_section_is_optional() {
        let s: Settings = minimal_config().try_deserialize().unwrap();
        assert_eq!(s.search.max_terms, None);
    }

    #[test]
    fn search_max_terms_is_read_from_the_config_file() {
        let path = std::env::temp_dir().join(format!("kubuno-search-{}.toml", uuid::Uuid::new_v4()));
        std::fs::write(&path, "[search]\nmax_terms = 40\n").unwrap();
        let s: Settings = Config::builder()
            .add_source(minimal_config())
            .add_source(File::from(path.as_path()))
            .build()
            .unwrap()
            .try_deserialize()
            .unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(s.search.max_terms, Some(40));
    }

    #[test]
    fn test_settings_deserialize_all_fields() {
        let settings: Settings = minimal_config().try_deserialize()
            .expect("Settings doit se désérialiser avec tous les champs");
        assert_eq!(settings.server.host, "127.0.0.1");
        assert_eq!(settings.server.port, 8080);
        assert_eq!(settings.database.url.as_deref(), Some("postgres://test@localhost/test"));
        assert!(!settings.database.run_migrations);
        assert_eq!(settings.auth.jwt_secret, "secret_key_long_enough_for_testing_purposes");
        assert_eq!(settings.storage.backend, StorageBackendType::Local);
        assert_eq!(settings.logging.format, LogFormat::Pretty);
    }

    #[test]
    fn test_settings_missing_database_credentials_fails() {
        let cfg = Config::builder()
            .set_default("server.host", "127.0.0.1").unwrap()
            .set_default("server.port", 8080u16).unwrap()
            .set_default("server.frontend_dist", "./frontend/dist").unwrap()
            .set_default("server.internal_secret", TEST_INTERNAL_SECRET).unwrap()
            .set_default("server.modules_dir", "/usr/lib/kubuno/modules").unwrap()
            .set_default("server.themes_dir", "/var/lib/kubuno/themes").unwrap()
            // ni url ni user/database - tous absents
            .set_default("database.max_connections", 5u32).unwrap()
            .set_default("database.min_connections", 1u32).unwrap()
            .set_default("database.connect_timeout", 5u64).unwrap()
            .set_default("database.run_migrations", false).unwrap()
            .set_default("auth.jwt_secret", "secret_key").unwrap()
            .set_default("auth.access_token_ttl", 900u64).unwrap()
            .set_default("auth.refresh_token_ttl", 30u64).unwrap()
            .set_default("storage.backend", "local").unwrap()
            .set_default("storage.local_path", "./data").unwrap()
            .set_default("logging.level", "info").unwrap()
            .set_default("logging.format", "pretty").unwrap()
            .set_default("logging.log_dir", "/var/log/kubuno").unwrap()
            .set_default("logging.file_enabled", false).unwrap()
            .set_default("logging.rotation", "daily").unwrap()
            .set_default("logging.max_log_files", 30u32).unwrap()
            .build().unwrap();
        let settings: Settings = cfg.try_deserialize().expect("Désérialisation doit réussir");
        let err = validate_database(&settings.database);
        assert!(err.is_err(), "validate() doit échouer sans url ni user/database");
        let msg = err.unwrap_err();
        assert!(msg.contains("url"), "L'erreur doit mentionner 'url': {msg}");
    }

    #[test]
    fn test_duration_access_token_secs() {
        let settings: Settings = minimal_config().try_deserialize().unwrap();
        assert_eq!(settings.auth.access_token_ttl.as_secs(), 900);
        assert_eq!(settings.database.connect_timeout.as_secs(), 5);
    }

    #[test]
    fn test_duration_refresh_token_days() {
        let settings: Settings = minimal_config().try_deserialize().unwrap();
        assert_eq!(settings.auth.refresh_token_ttl.as_secs(), 30 * 86_400);
    }

    #[test]
    fn test_storage_backend_local() {
        let settings: Settings = minimal_config().try_deserialize().unwrap();
        assert_eq!(settings.storage.backend, StorageBackendType::Local);
    }

    #[test]
    fn test_storage_backend_s3() {
        let cfg = Config::builder()
            .set_default("server.host", "0.0.0.0").unwrap()
            .set_default("server.port", 8080u16).unwrap()
            .set_default("server.frontend_dist", "./frontend/dist").unwrap()
            .set_default("server.internal_secret", TEST_INTERNAL_SECRET).unwrap()
            .set_default("server.modules_dir", "/usr/lib/kubuno/modules").unwrap()
            .set_default("server.themes_dir", "/var/lib/kubuno/themes").unwrap()
            .set_default("database.url", "postgres://test@localhost/test").unwrap()
            .set_default("database.max_connections", 5u32).unwrap()
            .set_default("database.min_connections", 1u32).unwrap()
            .set_default("database.connect_timeout", 5u64).unwrap()
            .set_default("database.run_migrations", false).unwrap()
            .set_default("auth.jwt_secret", "secret_key").unwrap()
            .set_default("auth.access_token_ttl", 900u64).unwrap()
            .set_default("auth.refresh_token_ttl", 30u64).unwrap()
            .set_default("storage.backend", "s3").unwrap()
            .set_default("storage.local_path", "./data").unwrap()
            .set_default("logging.level", "info").unwrap()
            .set_default("logging.format", "json").unwrap()
            .set_default("logging.log_dir", "/var/log/kubuno").unwrap()
            .set_default("logging.file_enabled", false).unwrap()
            .set_default("logging.rotation", "daily").unwrap()
            .set_default("logging.max_log_files", 30u32).unwrap()
            .build().unwrap();
        let settings: Settings = cfg.try_deserialize().unwrap();
        assert_eq!(settings.storage.backend, StorageBackendType::S3);
        assert_eq!(settings.logging.format, LogFormat::Json);
    }

    #[test]
    fn test_env_separator_double_underscore() {
        // Vérifie que KV__AUTH__JWT_SECRET mappe bien sur auth.jwt_secret
        // (et pas auth.jwt.secret comme avec separator("_"))
        unsafe {
            std::env::set_var("KV__AUTH__JWT_SECRET", "my_test_secret_value");
            std::env::set_var("KV__DATABASE__URL", "postgres://env@localhost/testdb");
            std::env::set_var("KV__STORAGE__LOCAL_PATH", "/tmp/kubuno_test");
            // Settings::load() refuse désormais un secret interne trop court :
            // on en fournit un valide (et on neutralise le config.toml système).
            std::env::set_var("KV__SERVER__INTERNAL_SECRET", TEST_INTERNAL_SECRET);
            std::env::set_var("KV__SERVER__TRUSTED_PROXY_CIDRS", "127.0.0.0/8,10.0.0.0/8");
        }
        let result = Settings::load();
        unsafe {
            std::env::remove_var("KV__AUTH__JWT_SECRET");
            std::env::remove_var("KV__DATABASE__URL");
            std::env::remove_var("KV__STORAGE__LOCAL_PATH");
            std::env::remove_var("KV__SERVER__INTERNAL_SECRET");
            std::env::remove_var("KV__SERVER__TRUSTED_PROXY_CIDRS");
        }
        let settings = result.expect("Settings::load() doit réussir avec KV__ env vars");
        assert_eq!(settings.auth.jwt_secret, "my_test_secret_value");
        assert_eq!(settings.database.url.as_deref(), Some("postgres://env@localhost/testdb"));
        assert_eq!(settings.storage.local_path.as_deref(), Some("/tmp/kubuno_test"));
        // Une liste passée par variable d'environnement est bien découpée sur ','
        assert_eq!(
            settings.server.trusted_proxy_cidrs,
            vec!["127.0.0.0/8".to_string(), "10.0.0.0/8".to_string()]
        );
    }

    #[test]
    fn test_trusted_proxy_cidrs_default_is_loopback_and_private() {
        let settings: Settings = minimal_config().try_deserialize().unwrap();
        assert_eq!(
            settings.server.trusted_proxy_cidrs,
            crate::auth::client_ip::DEFAULT_TRUSTED_PROXY_CIDRS
                .iter()
                .map(|s| (*s).to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_internal_secret_empty_is_rejected() {
        let mut settings: Settings = minimal_config().try_deserialize().unwrap();
        settings.server.internal_secret = String::new();
        let err = settings.server.validate_internal_secret()
            .expect_err("un secret interne vide doit être refusé");
        assert!(err.contains("internal_secret"), "message inattendu : {err}");
        assert!(err.contains("openssl rand"), "le message doit expliquer comment en générer un : {err}");
    }

    #[test]
    fn test_internal_secret_whitespace_only_is_rejected() {
        let mut settings: Settings = minimal_config().try_deserialize().unwrap();
        settings.server.internal_secret = "     ".to_string();
        assert!(settings.server.validate_internal_secret().is_err());
    }

    #[test]
    fn test_internal_secret_too_short_is_rejected() {
        let mut settings: Settings = minimal_config().try_deserialize().unwrap();
        settings.server.internal_secret = "test_secret".to_string();
        let err = settings.server.validate_internal_secret()
            .expect_err("un secret interne de 11 octets doit être refusé");
        // Le message donne la longueur mais JAMAIS la valeur.
        assert!(err.contains("11 octets"), "message inattendu : {err}");
        assert!(!err.contains("test_secret"), "le secret ne doit jamais apparaître : {err}");
    }

    #[test]
    fn test_internal_secret_at_minimum_length_is_accepted() {
        let mut settings: Settings = minimal_config().try_deserialize().unwrap();
        settings.server.internal_secret = "a".repeat(MIN_INTERNAL_SECRET_LEN);
        assert!(settings.server.validate_internal_secret().is_ok());
    }

    #[test]
    fn test_internal_secret_valid_is_accepted() {
        let settings: Settings = minimal_config().try_deserialize().unwrap();
        assert!(settings.server.validate_internal_secret().is_ok());
    }

    /// Défaut : compatibilité stricte - chaque module reçoit le secret maître.
    #[test]
    fn test_module_secret_defaults_to_the_master_secret() {
        let settings: Settings = minimal_config().try_deserialize().unwrap();
        assert!(!settings.server.derive_module_secrets);
        assert_eq!(settings.server.module_secret("drive"), TEST_INTERNAL_SECRET);
    }

    #[test]
    fn test_derived_mode_gives_each_module_its_own_secret() {
        let mut settings: Settings = minimal_config().try_deserialize().unwrap();
        settings.server.derive_module_secrets = true;

        let drive  = settings.server.module_secret("drive");
        let office = settings.server.module_secret("office");
        assert_ne!(drive, office);
        assert_ne!(drive, TEST_INTERNAL_SECRET);

        // Le core identifie l'émetteur de chaque secret.
        assert_eq!(
            settings.server.authenticate_internal(&drive).and_then(|c| c.module_id().map(str::to_owned)),
            Some("drive".to_owned())
        );
        assert_eq!(
            settings.server.authenticate_internal(&office).and_then(|c| c.module_id().map(str::to_owned)),
            Some("office".to_owned())
        );
        // Le secret maître reste accepté, sans identification.
        assert_eq!(
            settings.server.authenticate_internal(TEST_INTERNAL_SECRET),
            Some(InternalCaller::Master)
        );
        // Une valeur quelconque est refusée.
        assert_eq!(settings.server.authenticate_internal("nope"), None);
    }

    #[test]
    fn test_shared_secret_modules_are_exempt_from_derivation() {
        let mut settings: Settings = minimal_config().try_deserialize().unwrap();
        settings.server.derive_module_secrets = true;
        settings.server.shared_secret_modules = vec!["drive".into(), "office".into()];

        assert_eq!(settings.server.module_secret("drive"), TEST_INTERNAL_SECRET);
        assert_eq!(settings.server.module_secret("office"), TEST_INTERNAL_SECRET);
        assert_ne!(settings.server.module_secret("calendar"), TEST_INTERNAL_SECRET);
    }

    #[test]
    fn test_strict_mode_rejects_the_master_secret() {
        let mut settings: Settings = minimal_config().try_deserialize().unwrap();
        settings.server.derive_module_secrets = true;
        settings.server.reject_master_internal_secret = true;

        assert_eq!(settings.server.authenticate_internal(TEST_INTERNAL_SECRET), None);
        let mail = settings.server.module_secret("mail");
        assert_eq!(
            settings.server.authenticate_internal(&mail),
            Some(InternalCaller::Module("mail".into()))
        );
    }
}

// Serde helpers pour Duration
fn default_ticket_ttl() -> u64 {
    300
}

fn default_ticket_stream_ttl() -> u64 {
    4 * 3600
}

fn default_legacy_access_cookie() -> bool {
    true
}

mod duration_secs {
    use serde::{Deserialize, Deserializer};
    use std::time::Duration;

    pub fn deserialize<'de, D>(d: D) -> Result<Duration, D::Error>
    where
        D: Deserializer<'de>,
    {
        let secs = u64::deserialize(d)?;
        Ok(Duration::from_secs(secs))
    }
}

mod duration_days {
    use serde::{Deserialize, Deserializer};
    use std::time::Duration;

    pub fn deserialize<'de, D>(d: D) -> Result<Duration, D::Error>
    where
        D: Deserializer<'de>,
    {
        let days = u64::deserialize(d)?;
        Ok(Duration::from_secs(days * 86_400))
    }
}

/// Which configuration files are merged, on real files in a temporary
/// directory that reproduces each layout (never the machine's own
/// `/etc/kubuno` or `/var/lib/kubuno`).
#[cfg(test)]
mod config_source_tests {
    use super::*;
    use kubuno_paths::{ConfigPlan, Mode, Os, Paths, ServiceContext, SystemConfigSkip};
    use std::path::{Path, PathBuf};

    struct Root(PathBuf);
    impl Root {
        fn new(name: &str) -> Self {
            let d = std::env::temp_dir().join(format!("kubuno-cfgsrc-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Root(d)
        }
        fn dir(&self, rel: &str) -> PathBuf {
            let d = self.0.join(rel);
            std::fs::create_dir_all(&d).unwrap();
            d
        }
        fn write(&self, rel: &str, text: &str) -> PathBuf {
            let f = self.0.join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, text).unwrap();
            f
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The Linux system layout, rooted in `root` (`<root>/etc/kubuno`,
    /// `<root>/var/lib/kubuno`, …).
    fn system_layout(root: &Root) -> Paths {
        let lib = root.dir("var/lib/kubuno");
        let etc = root.dir("etc/kubuno");
        Paths {
            os: Os::current(),
            mode: Mode::System,
            config_dir: etc.clone(),
            state_dir: lib.clone(),
            data_dir: lib.clone(),
            log_dir: root.0.join("var/log/kubuno"),
            cache_dir: root.0.join("var/cache/kubuno"),
            runtime_dir: root.0.join("run/kubuno"),
            backup_dir: root.0.join("var/backups/kubuno"),
            modules_store: lib.join("modules-store"),
            modules_config_dir: etc.join("modules"),
            modules_data_dir: lib.join("modules"),
        }
    }

    /// The prod configuration: its database URL and JWT secret.
    fn prod_config(root: &Root) {
        root.write(
            "etc/kubuno/config.toml",
            "[probe]\norigin = \"system\"\nsystem_only = \"prod-db-url-and-jwt-secret\"\n",
        );
    }

    fn merged(plan: &ConfigPlan) -> Config {
        Settings::with_sources(Config::builder(), plan).build().unwrap()
    }

    fn service() -> ServiceContext {
        // systemd unit, User=kubuno: started by the service manager, as the
        // account that owns the state directory.
        ServiceContext { service_manager: true, service_account: true, privileged: false }
    }

    #[test]
    fn production_layout_loads_the_system_file_exactly_as_before() {
        let root = Root::new("prod");
        prod_config(&root);
        let system = system_layout(&root);
        let cwd = system.state_dir.clone(); // WorkingDirectory=/var/lib/kubuno

        let plan = crate::config::paths::config_plan_for(&system, &system, Some(&cwd), None, service());
        assert_eq!(plan.skipped, None);
        let cfg = merged(&plan);
        assert_eq!(cfg.get_string("probe.origin").unwrap(), "system");
        assert_eq!(cfg.get_string("probe.system_only").unwrap(), "prod-db-url-and-jwt-secret");

        // With a config.toml in the working directory: read first, the system
        // file still wins over it, and what only it sets is kept: as today.
        root.write("var/lib/kubuno/config.toml", "[probe]\norigin = \"local\"\nlocal_only = \"yes\"\n");
        let plan = crate::config::paths::config_plan_for(&system, &system, Some(&cwd), None, service());
        assert_eq!(plan.skipped, None);
        let cfg = merged(&plan);
        assert_eq!(cfg.get_string("probe.origin").unwrap(), "system");
        assert_eq!(cfg.get_string("probe.system_only").unwrap(), "prod-db-url-and-jwt-secret");
        assert_eq!(cfg.get_string("probe.local_only").unwrap(), "yes");
    }

    #[test]
    fn administration_commands_under_sudo_read_the_system_file() {
        let root = Root::new("sudo");
        prod_config(&root);
        let system = system_layout(&root);
        let cwd = root.dir("root");
        let admin = ServiceContext { privileged: true, ..ServiceContext::default() };
        let plan = crate::config::paths::config_plan_for(&system, &system, Some(&cwd), None, admin);
        assert_eq!(merged(&plan).get_string("probe.origin").unwrap(), "system");
    }

    #[test]
    fn a_development_core_never_reads_the_system_file() {
        let root = Root::new("dev");
        prod_config(&root);
        let system = system_layout(&root);
        let checkout = root.dir("home/dev/core/server");

        // 1. Its own config.toml in its checkout, even run as root.
        let local = root.write("home/dev/core/server/config.toml", "[probe]\norigin = \"dev\"\n");
        let everything = ServiceContext { privileged: true, service_account: true, service_manager: true };
        let plan = crate::config::paths::config_plan_for(&system, &system, Some(&checkout), None, everything);
        assert_eq!(plan.skipped.as_ref().unwrap().1, SystemConfigSkip::LocalConfig(local));
        let cfg = merged(&plan);
        assert_eq!(cfg.get_string("probe.origin").unwrap(), "dev");
        assert!(cfg.get_string("probe.system_only").is_err(), "nothing of the system file leaks in");

        // 2. No file of its own, as an ordinary user: no fallback either.
        let elsewhere = root.dir("home/dev/elsewhere");
        let plan =
            crate::config::paths::config_plan_for(&system, &system, Some(&elsewhere), None, ServiceContext::default());
        assert_eq!(plan.skipped.as_ref().unwrap().1, SystemConfigSkip::NotService);
        assert!(merged(&plan).get_string("probe.system_only").is_err());

        // 3. Explicit --config: that file only.
        let own = root.write("home/dev/kubuno.toml", "[probe]\norigin = \"explicit\"\n");
        let plan = crate::config::paths::config_plan_for(
            &system,
            &system,
            Some(&checkout),
            Some(own.to_str().unwrap()),
            everything,
        );
        let cfg = merged(&plan);
        assert_eq!(cfg.get_string("probe.origin").unwrap(), "explicit");
        assert!(cfg.get_string("probe.system_only").is_err());

        // 4. A state directory of its own (and its own config and data dirs).
        let mut instance = system.clone();
        instance.state_dir = root.dir("home/dev/state");
        instance.data_dir = root.dir("home/dev/data");
        instance.config_dir = root.dir("home/dev/config");
        root.write("home/dev/config/config.toml", "[probe]\norigin = \"own-config-dir\"\n");
        let plan = crate::config::paths::config_plan_for(&instance, &system, Some(&elsewhere), None, everything);
        assert_eq!(plan.skipped.as_ref().unwrap().1, SystemConfigSkip::NotSystemInstance);
        let cfg = merged(&plan);
        assert_eq!(cfg.get_string("probe.origin").unwrap(), "own-config-dir");
        assert!(cfg.get_string("probe.system_only").is_err());

        // 5. User mode.
        let mut user = instance.clone();
        user.mode = Mode::User;
        let plan = crate::config::paths::config_plan_for(&user, &system, Some(&elsewhere), None, everything);
        assert!(merged(&plan).get_string("probe.system_only").is_err());
    }

    #[test]
    fn the_skip_reason_is_explained_without_values() {
        let root = Root::new("note");
        prod_config(&root);
        let system = system_layout(&root);
        let plan = crate::config::paths::config_plan_for(
            &system,
            &system,
            Some(Path::new(&root.dir("home/dev"))),
            None,
            ServiceContext::default(),
        );
        let (files, why) = plan.skipped.unwrap();
        assert_eq!(files, vec![root.0.join("etc/kubuno/config.toml")]);
        let text = why.to_string();
        assert!(text.contains("sudo") && text.contains("--config"), "{text}");
        assert!(!text.contains("prod-db-url"), "never a value");
    }
}
