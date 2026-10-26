//! The installation wizard's HTTP surface.
//!
//! Three endpoints and the static frontend. Everything else under `/api/v1/`
//! answers 503 with `setup_required`, so a client that reaches a not-yet
//! installed instance is told what is going on instead of getting a puzzling
//! 404 from the SPA fallback.

use super::config_file::{self, Assign};
use super::token::SetupToken;
use crate::config::Settings;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use crate::database::SCHEMA;
use kubuno_db::{params, Backend, DbPool, DbSettings};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tower_http::services::{ServeDir, ServeFile};

pub(crate) struct SetupState {
    pub settings: Settings,
    pub token: SetupToken,
    pub done: tokio::sync::watch::Sender<bool>,
    pub installed: Arc<AtomicBool>,
    /// Half-filled installation forms, held for the browser tab that is filling
    /// them in. See `draft` below for why they live here and not in the browser.
    pub drafts: std::sync::Mutex<HashMap<String, DraftEntry>>,
}

pub(crate) struct DraftEntry {
    saved: std::time::Instant,
    data: serde_json::Value,
}

/// A draft is dropped after this long without a write - an installation left
/// open in a forgotten tab must not sit in memory for ever.
const DRAFT_TTL: Duration = Duration::from_secs(2 * 60 * 60);
/// Cap on drafts kept at once, so an unattended port cannot be made to grow the
/// process by posting draft after draft.
const DRAFT_MAX: usize = 32;
/// A draft carries a logo as a data-URI; anything past this is not a form.
const DRAFT_MAX_BYTES: usize = 512 * 1024;

pub(crate) fn router(state: Arc<SetupState>) -> Router {
    let dist = state.settings.server.frontend_dist.clone();
    let static_files =
        ServeDir::new(&dist).fallback(ServeFile::new(format!("{dist}/index.html")));

    Router::new()
        .route("/api/v1/setup/status", get(status))
        .route("/api/v1/setup/themes", get(themes))
        .route("/api/v1/setup/draft/:id", get(get_draft).put(put_draft).delete(delete_draft))
        .route("/api/v1/setup/test-database", post(test_database))
        .route("/api/v1/setup/install", post(install))
        // Anything else the SPA or a module may call while we are not installed.
        .route("/api/v1/*rest", any(not_installed))
        .route("/internal/*rest", any(not_installed))
        .with_state(state)
        .fallback_service(static_files)
}

/// A refusal the wizard can SHOW IN THE OPERATOR'S LANGUAGE.
///
/// The server has no idea which language the screen is in - it is reached before
/// any account, any preference, any session exists. So it names the reason with
/// a stable `code` (plus whatever the sentence needs) and lets the client
/// translate it. The French `error` text stays for anything reading this API
/// without a UI: curl, a log, an installer script.
fn bad_code(code: &str, msg: impl Into<String>, params: serde_json::Value) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg.into(), "code": code, "params": params })),
    )
        .into_response()
}


async fn not_installed() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "Kubuno is not installed yet",
            "setup_required": true,
        })),
    )
        .into_response()
}

// ── Status ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Defaults {
    db_host: String,
    db_port: u16,
    db_name: String,
    db_user: String,
}

#[derive(Serialize)]
struct StatusResponse {
    setup_required: bool,
    version: &'static str,
    missing: Vec<&'static str>,
    config_path: String,
    config_writable: bool,
    token_file: String,
    defaults: Defaults,
}

async fn status(State(st): State<Arc<SetupState>>) -> Json<StatusResponse> {
    let target = config_file::target_path();
    let s = &st.settings;
    Json(StatusResponse {
        setup_required: true,
        version: env!("CARGO_PKG_VERSION"),
        missing: super::missing(s),
        config_writable: config_file::is_writable(&target),
        config_path: target.display().to_string(),
        token_file: st.token.file().display().to_string(),
        defaults: Defaults {
            db_host: s.database.host.clone().unwrap_or_else(|| "localhost".into()),
            db_port: s.database.port.unwrap_or(5432),
            db_name: s.database.database.clone().unwrap_or_else(|| "kubuno".into()),
            db_user: s.database.user.clone().unwrap_or_else(|| "kubuno".into()),
        },
    })
}

// ── Draft ────────────────────────────────────────────────────────────────────
//
// The wizard's half-filled form, kept BY THE SERVER rather than in the browser.
//
// It holds the installation token, the database password and the administrator
// password: the browser is the wrong place for those, and a refresh that lost
// them sent the operator back to the first screen with empty fields. Here they
// stay in the installer process's memory - they never touch a disk, they vanish
// when the process ends, and they are erased the moment the installation
// succeeds. The tab keeps only an unguessable identifier.

fn draft_id_is_valid(id: &str) -> bool {
    id.len() >= 32 && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// Drops what has gone stale, and keeps the store bounded.
fn prune(store: &mut HashMap<String, DraftEntry>) {
    store.retain(|_, e| e.saved.elapsed() < DRAFT_TTL);
    while store.len() >= DRAFT_MAX {
        // Oldest first - a live tab writes on every keystroke, so the one that
        // has not written in the longest time is the safest to lose.
        let oldest = store
            .iter()
            .min_by_key(|(_, e)| e.saved)
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => { store.remove(&k); }
            None => break,
        }
    }
}

async fn get_draft(
    State(st): State<Arc<SetupState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if !draft_id_is_valid(&id) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "identifiant invalide" }))).into_response();
    }
    let mut store = match st.drafts.lock() {
        Ok(s) => s,
        Err(e) => e.into_inner(),
    };
    prune(&mut store);
    match store.get(&id) {
        Some(e) => Json(json!({ "draft": e.data })).into_response(),
        None => Json(json!({ "draft": serde_json::Value::Null })).into_response(),
    }
}

async fn put_draft(
    State(st): State<Arc<SetupState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(data): Json<serde_json::Value>,
) -> Response {
    if !draft_id_is_valid(&id) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "identifiant invalide" }))).into_response();
    }
    if serde_json::to_string(&data).map(|s| s.len()).unwrap_or(usize::MAX) > DRAFT_MAX_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": "brouillon trop volumineux" }))).into_response();
    }
    let mut store = match st.drafts.lock() {
        Ok(s) => s,
        Err(e) => e.into_inner(),
    };
    prune(&mut store);
    store.insert(id, DraftEntry { saved: std::time::Instant::now(), data });
    StatusCode::NO_CONTENT.into_response()
}

async fn delete_draft(
    State(st): State<Arc<SetupState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if let Ok(mut store) = st.drafts.lock() {
        store.remove(&id);
    }
    StatusCode::NO_CONTENT.into_response()
}

// ── Themes ───────────────────────────────────────────────────────────────────

/// The themes shipped with the instance, read straight from `themes_dir`.
///
/// They are on disk before the first boot (the package seeds them), so the
/// wizard can offer the real ones rather than an invented palette - and the
/// choice is the same object the administration console manages afterwards.
/// A few of each theme's variables travel with it so the wizard can draw a
/// faithful preview without loading the theme itself.
#[derive(Serialize)]
struct ThemeChoice {
    id: String,
    name: String,
    color_scheme: String,
    /// The theme's CSS variables, in full - not a swatch.
    ///
    /// The wizard applies them to itself the moment one is picked, so choosing a
    /// theme is something you SEE rather than a promise about later. All six
    /// shipped themes together weigh under 10 KB, which is cheaper than a second
    /// round trip per selection. (Their component stylesheets are not loaded
    /// here: serving those needs the running instance.)
    vars: std::collections::HashMap<String, String>,
}

async fn themes(State(st): State<Arc<SetupState>>) -> Json<serde_json::Value> {
    let trusted = std::collections::HashSet::new();
    let entries = crate::handlers::themes::load_all_themes(&st.settings.server.themes_dir, &trusted);
    let choices: Vec<ThemeChoice> = entries
        .into_iter()
        .map(|e| ThemeChoice {
            id: e.manifest.id,
            name: e.manifest.name,
            color_scheme: e.manifest.color_scheme,
            vars: e.manifest.vars,
        })
        .collect();
    Json(json!({ "themes": choices }))
}

// ── Database ─────────────────────────────────────────────────────────────────

/// What SQLite falls back to when the operator names no directory. Mirrors the
/// `database.path` default the running instance ships (`config/settings.rs`), so
/// the file the wizard probes is the file the instance later opens.
use crate::config::paths::default_sqlite_dir;

#[derive(Deserialize, Clone)]
pub(crate) struct DbForm {
    /// `"postgres"` (default), `"mysql"`/`"mariadb"` or `"sqlite"`. Absent on the
    /// PostgreSQL-only wizard this branch shipped, so it defaults to PostgreSQL
    /// and the older frontend keeps working unchanged.
    #[serde(default = "default_engine")]
    engine: String,
    #[serde(default)]
    host: String,
    port: Option<u16>,
    #[serde(default)]
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: String,
    /// Optional schema-name prefix, so several instances can share one database
    /// server (see `[database] schema_prefix`). Empty means none.
    #[serde(default)]
    schema_prefix: Option<String>,
    /// SQLite only: the directory that holds `<schema>.sqlite`. Ignored by the
    /// server engines.
    #[serde(default)]
    path: Option<String>,
}

fn default_engine() -> String {
    "postgres".to_string()
}

impl DbForm {
    /// The chosen engine, parsed. `None` on an unknown name.
    fn backend(&self) -> Option<Backend> {
        Backend::parse(&self.engine)
    }

    fn options(&self, database: &str) -> PgConnectOptions {
        PgConnectOptions::new()
            .host(self.host.trim())
            .port(self.port.unwrap_or(5432))
            .username(self.user.trim())
            .password(&self.password)
            .database(database)
    }

    /// The engine-agnostic settings the shared pool opens from - the same section
    /// the running instance deserializes from `config.toml`, built here from the
    /// wizard's fields so `test-database` and `install` reach the database
    /// through `kubuno_db` exactly as the booted instance will.
    fn to_db_settings(&self) -> DbSettings {
        // `serde_json` rather than a struct literal: `DbSettings` owns private
        // serde defaults and may grow fields; going through deserialization keeps
        // this in step with the running instance's own parsing.
        let mut obj = serde_json::json!({
            "engine": self.engine,
            "max_connections": 2,
            "min_connections": 0,
            "connect_timeout": 8,
            "run_migrations": false,
        });
        let m = obj.as_object_mut().expect("json object");
        match self.backend() {
            Some(Backend::Sqlite) => {
                m.insert("path".into(), json!(self.sqlite_dir()));
            }
            _ => {
                m.insert("host".into(), json!(self.host.trim()));
                if let Some(p) = self.port {
                    m.insert("port".into(), json!(p));
                }
                m.insert("user".into(), json!(self.user.trim()));
                m.insert("password".into(), json!(self.password));
                m.insert("database".into(), json!(self.database.trim()));
            }
        }
        // Carry the schema prefix into the install/test pool so `kubuno_db`
        // creates and migrates the core's own schema under `<prefix>core` - the
        // exact namespace the booted instance reconnects to. Without it the
        // wizard would populate `core` while the restarted instance looks for
        // `<prefix>core` and finds it empty (the admin account lost).
        if !self.schema_prefix().is_empty() {
            m.insert("schema_prefix".into(), json!(self.schema_prefix()));
        }
        serde_json::from_value(obj).expect("DbSettings from wizard fields")
    }

    /// The directory SQLite keeps `core.sqlite` in.
    fn sqlite_dir(&self) -> String {
        match self.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => p.to_string(),
            None => default_sqlite_dir(),
        }
    }

    /// The full path of the SQLite database file.
    fn sqlite_file(&self) -> std::path::PathBuf {
        std::path::Path::new(&self.sqlite_dir()).join(format!("{SCHEMA}.sqlite"))
    }

    /// An identifier we are willing to interpolate into `CREATE DATABASE` - that
    /// statement takes no bind parameters on PostgreSQL or MySQL, so the name is
    /// checked rather than escaped. The rule (`[A-Za-z_][A-Za-z0-9_]{0,62}`) is
    /// safe under both PostgreSQL's `"…"` and MySQL's `` `…` `` quoting.
    fn database_name_is_safe(&self) -> bool {
        let n = self.database.trim();
        !n.is_empty()
            && n.len() <= 63
            && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !n.chars().next().is_some_and(|c| c.is_ascii_digit())
    }

    /// The trimmed schema prefix, or `""` when none was given.
    fn schema_prefix(&self) -> &str {
        self.schema_prefix.as_deref().map(str::trim).unwrap_or("")
    }

    /// A prefix we are willing to write into the config file. Mirrors
    /// `kubuno_db::SchemaPrefix`: empty (none) or `^[a-z0-9_]{1,32}$`.
    fn schema_prefix_is_safe(&self) -> bool {
        let p = self.schema_prefix();
        p.is_empty()
            || (p.len() <= 32
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
    }

    fn validate(&self) -> Result<(), (&'static str, String)> {
        let backend = self
            .backend()
            .ok_or(("db.engine_invalid", format!("Moteur de base inconnu : {}", self.engine)))?;
        // Engine-agnostic: the prefix applies to PostgreSQL schemas, MySQL
        // databases and SQLite files alike, so validate it before any
        // engine-specific early return.
        if !self.schema_prefix_is_safe() {
            return Err((
                "db.schema_prefix_invalid",
                "Invalid schema prefix: only lowercase letters, numbers, and '_'; maximum 32 characters."
                    .to_string(),
            ));
        }
        if backend == Backend::Sqlite {
            // SQLite needs no host, user or database name - only a writable
            // directory, which is validated when the file is probed.
            return Ok(());
        }
        if self.host.trim().is_empty() {
            return Err(("db.host_required", "The database host is required.".to_string()));
        }
        if self.user.trim().is_empty() {
            return Err(("db.user_required", "L'utilisateur de la base est requis.".to_string()));
        }
        if !self.database_name_is_safe() {
            return Err((
                "db.name_invalid",
                "Invalid database name: only letters, numbers, and '_'; cannot start with a number."
                    .to_string(),
            ));
        }
        Ok(())
    }
}

async fn connect(opts: PgConnectOptions) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(8))
        .connect_with(opts)
        .await
}

/// A short-lived MySQL connection to the server itself (no default database),
/// used to test the credentials and - when asked - to `CREATE DATABASE` before
/// the module's own database exists.
async fn connect_mysql_server(form: &DbForm) -> Result<sqlx::MySqlPool, sqlx::Error> {
    use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
    let opts = MySqlConnectOptions::new()
        .host(form.host.trim())
        .port(form.port.unwrap_or(3306))
        .username(form.user.trim())
        .password(&form.password);
    MySqlPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(8))
        .connect_with(opts)
        .await
}

/// PostgreSQL's "database does not exist" - the one failure the wizard can fix
/// on its own rather than sending the administrator to a shell.
fn is_missing_database(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.code().as_deref() == Some("3D000"))
}

#[derive(Serialize)]
struct DbTestResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Stable name of the failure, for the client to translate.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    /// What the translated sentence needs (the database name, mostly).
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_version: Option<String>,
    /// The database is missing, but the account may create it.
    database_missing: bool,
    can_create_database: bool,
    /// This database already carries a Kubuno schema.
    already_initialised: bool,
}

async fn test_database(Json(form): Json<DbForm>) -> Response {
    run_db_test(form).await
}

/// Engine-aware connectivity probe, shared between the installation wizard and
/// the admin console's per-module database panel. Validates the form, then tests
/// the credentials against the chosen engine and reports whether the database
/// exists / can be created / already carries a Kubuno schema.
pub(crate) async fn run_db_test(form: DbForm) -> Response {
    if let Err((code, msg)) = form.validate() {
        return bad_code(code, msg, json!({}));
    }
    match form.backend() {
        Some(Backend::Postgres) => test_database_pg(&form).await,
        Some(Backend::MySql) => test_database_mysql(&form).await,
        Some(Backend::Sqlite) => test_database_sqlite(&form).await,
        None => bad_code("db.engine_invalid", format!("Moteur de base inconnu : {}", form.engine), json!({})),
    }
}

/// Whether the target database already carries a Kubuno `core` schema, decided
/// from a live pool. `core.users` is the marker: it exists only once the
/// migrations have run.
async fn already_initialised(db: &DbPool) -> bool {
    // information_schema is spelled the same on all three engines; `table_schema`
    // is the PostgreSQL schema / the MySQL database / (on SQLite, this table does
    // not exist, so the SQLite path never calls here).
    db.fetch_optional_scalar::<i64>(
        &format!(
            "SELECT {} FROM information_schema.tables \
             WHERE table_schema = 'core' AND table_name = 'users'",
            db.backend().count_bigint("*")
        ),
        params![],
    )
    .await
    .map(|n| n.unwrap_or(0) > 0)
    .unwrap_or(false)
}

async fn test_database_pg(form: &DbForm) -> Response {
    match connect(form.options(form.database.trim())).await {
        Ok(pool) => {
            let version: Option<String> = sqlx::query_scalar("SELECT version()")
                .fetch_one(&pool)
                .await
                .ok();
            let initialised: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM information_schema.tables \
                 WHERE table_schema = 'core' AND table_name = 'users')",
            )
            .fetch_one(&pool)
            .await
            .unwrap_or(false);
            pool.close().await;
            Json(DbTestResponse {
                ok: true,
                error: None,
                code: None,
                params: None,
                server_version: version,
                database_missing: false,
                can_create_database: false,
                already_initialised: initialised,
            })
            .into_response()
        }
        Err(e) if is_missing_database(&e) => {
            // The server and the account are fine; only the database is absent.
            // Say whether we could create it, so the wizard can offer to.
            let can_create = match connect(form.options("postgres")).await {
                Ok(p) => {
                    let allowed: bool =
                        sqlx::query_scalar("SELECT pg_catalog.has_database_privilege(current_user, current_database(), 'CONNECT') AND (SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user)")
                            .fetch_one(&p)
                            .await
                            .unwrap_or(false);
                    p.close().await;
                    allowed
                }
                Err(_) => false,
            };
            Json(DbTestResponse {
                ok: false,
                error: Some(format!("La base « {} » n'existe pas encore.", form.database.trim())),
                code: Some("db.missing_named".into()),
                params: Some(json!({ "name": form.database.trim() })),
                server_version: None,
                database_missing: true,
                can_create_database: can_create,
                already_initialised: false,
            })
            .into_response()
        }
        Err(e) => {
            let (code, msg) = friendly_db_error(&e);
            Json(DbTestResponse {
            ok: false,
            error: Some(msg),
            code: Some(code.into()),
            params: None,
            server_version: None,
            database_missing: false,
            can_create_database: false,
            already_initialised: false,
            })
            .into_response()
        }
    }
}

async fn test_database_mysql(form: &DbForm) -> Response {
    // Connect to the server itself, not to `core`: the database may not exist
    // yet, and connecting with it as the default schema would fail before we can
    // say so helpfully.
    let server = match connect_mysql_server(form).await {
        Ok(p) => p,
        Err(e) => {
            let (code, msg) = friendly_db_error(&e);
            return db_test_error(code, msg);
        }
    };

    let version: Option<String> = sqlx::query_scalar("SELECT VERSION()").fetch_one(&server).await.ok();
    let db_name = form.database.trim();
    let exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ?",
    )
    .bind(db_name)
    .fetch_one(&server)
    .await
    .unwrap_or(0);

    if exists > 0 {
        // The database is there: open it through the shared pool and ask whether
        // it already holds a Kubuno schema.
        let initialised = match kubuno_db::connect(&form.to_db_settings(), SCHEMA).await {
            Ok(db) => already_initialised(&db).await,
            Err(_) => false,
        };
        server.close().await;
        return Json(DbTestResponse {
            ok: true,
            error: None,
            code: None,
            params: None,
            server_version: version,
            database_missing: false,
            can_create_database: false,
            already_initialised: initialised,
        })
        .into_response();
    }

    // Missing: report whether this account may create it, so the wizard can offer
    // to - the same shape as the PostgreSQL branch.
    let can_create = mysql_can_create_database(&server).await;
    server.close().await;
    Json(DbTestResponse {
        ok: false,
        error: Some(format!("La base « {db_name} » n'existe pas encore.")),
        code: Some("db.missing_named".into()),
        params: Some(json!({ "name": db_name })),
        server_version: version,
        database_missing: true,
        can_create_database: can_create,
        already_initialised: false,
    })
    .into_response()
}

/// Whether the connected MySQL account holds a server-wide `CREATE` right.
///
/// Read from `SHOW GRANTS`: a grant of `ALL PRIVILEGES ON *.*` or `CREATE …
/// ON *.*` lets the account make a new database. Read rather than attempted, so
/// a test never creates anything.
async fn mysql_can_create_database(server: &sqlx::MySqlPool) -> bool {
    let rows: Vec<(String,)> = sqlx::query_as("SHOW GRANTS FOR CURRENT_USER()")
        .fetch_all(server)
        .await
        .unwrap_or_default();
    rows.iter().any(|(g,)| {
        let g = g.to_uppercase();
        g.contains("ON *.*") && (g.contains("ALL PRIVILEGES") || g.contains("CREATE"))
    })
}

async fn test_database_sqlite(form: &DbForm) -> Response {
    let dir = form.sqlite_dir();
    // "Connect" to SQLite is "can I write the file?". Create the directory and
    // probe it, rather than parsing permission bits.
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return db_test_error("db.sqlite_dir", format!("Cannot access directory '{dir}': {e}"));
    }
    let probe = std::path::Path::new(&dir).join(".kubuno-write-probe");
    if let Err(e) = std::fs::File::create(&probe) {
        return db_test_error(
            "db.sqlite_readonly",
            format!("Directory '{dir}' is not writable: {e}"),
        );
    }
    let _ = std::fs::remove_file(&probe);

    // If a file is already there, say whether it carries a Kubuno schema, the way
    // the server engines do.
    let already = if form.sqlite_file().exists() {
        match kubuno_db::connect(&form.to_db_settings(), SCHEMA).await {
            Ok(db) => db
                .fetch_optional_scalar::<i64>(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'users'",
                    params![],
                )
                .await
                .map(|n| n.unwrap_or(0) > 0)
                .unwrap_or(false),
            Err(_) => false,
        }
    } else {
        false
    };

    let version: Option<String> = match kubuno_db::connect(&form.to_db_settings(), SCHEMA).await {
        Ok(db) => db.fetch_optional_scalar("SELECT sqlite_version()", params![]).await.ok().flatten(),
        Err(_) => None,
    };

    Json(DbTestResponse {
        ok: true,
        error: None,
        code: None,
        params: None,
        server_version: version,
        database_missing: false,
        can_create_database: false,
        already_initialised: already,
    })
    .into_response()
}

/// A failed `DbTestResponse` carrying a stable code and a French sentence.
fn db_test_error(code: &str, msg: String) -> Response {
    Json(DbTestResponse {
        ok: false,
        error: Some(msg),
        code: Some(code.into()),
        params: None,
        server_version: None,
        database_missing: false,
        can_create_database: false,
        already_initialised: false,
    })
    .into_response()
}

/// The connection error in the administrator's terms. The credentials are never
/// echoed back.
fn friendly_db_error(e: &sqlx::Error) -> (&'static str, String) {
    match e {
        sqlx::Error::Database(d) => match d.code().as_deref() {
            Some("28P01") => ("db.bad_password", "PostgreSQL refused the password for this user.".into()),
            Some("28000") => ("db.refused", "Connection refused for this user (see pg_hba.conf).".into()),
            Some("3D000") => ("db.missing", "Cette base n'existe pas.".into()),
            _ => ("db.other", format!("PostgreSQL refused the connection: {d}")),
        },
        sqlx::Error::PoolTimedOut => (
            "db.timeout",
            "Timed out: the host or port is not responding.".into(),
        ),
        other => ("db.unreachable", format!("Connexion impossible : {other}")),
    }
}

// ── Install ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct AdminForm {
    username: String,
    email: String,
    password: String,
}

#[derive(Deserialize)]
struct InstanceForm {
    #[serde(default)]
    name: String,
    /// Optional data-URI carrying the instance logo the operator picked in the
    /// wizard. Stored verbatim into `instance.logo_url`, exactly what the shell
    /// already reads there (a small file, so the size cap below stops it from
    /// bloating a public setting the login page fetches on every load).
    #[serde(default)]
    logo_dataurl: Option<String>,
    /// Optional accent colour as `#RRGGBB`. Written to `instance.color_primary`.
    #[serde(default)]
    color_primary: Option<String>,
    /// Optional id of one of the themes shipped with the instance. Written to
    /// `appearance.theme`, the setting the shell and the console already read.
    #[serde(default)]
    theme_id: Option<String>,
    /// The language chosen in the wizard, which becomes the instance's default
    /// (`instance.locale`) - what everyone sees until they pick their own.
    #[serde(default)]
    locale: Option<String>,
}

#[derive(Deserialize)]
struct InstallRequest {
    token: String,
    database: DbForm,
    #[serde(default)]
    create_database: bool,
    admin: AdminForm,
    #[serde(default)]
    instance: Option<InstanceForm>,
}

/// The first administrator is the most privileged account of the instance, so
/// its password is held to the length that actually resists an offline attack
/// rather than to a token minimum.
const MIN_ADMIN_PASSWORD: usize = 12;

impl AdminForm {
    fn validate(&self) -> Result<(), (&'static str, String)> {
        let u = self.username.trim();
        if u.len() < 3 {
            return Err(("admin.username_short", "The username must contain at least 3 characters.".to_string()));
        }
        if !u.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_') {
            return Err((
                "admin.username_chars",
                "Le nom d'utilisateur n'accepte que lettres, chiffres, « . », « - » et « _ »."
                    .to_string(),
            ));
        }
        let e = self.email.trim();
        if e.len() < 3 || !e.contains('@') || e.starts_with('@') || e.ends_with('@') {
            return Err(("admin.email_invalid", "Adresse e-mail invalide.".to_string()));
        }
        if self.password.chars().count() < MIN_ADMIN_PASSWORD {
            return Err((
                "admin.password_short",
                format!("The administrator password must contain at least {MIN_ADMIN_PASSWORD} characters."),
            ));
        }
        Ok(())
    }
}

/// 32 random bytes as hex - what `openssl rand -hex 32` produces, which is what
/// the configuration file tells administrators to use.
fn generate_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize)]
struct InstallResponse {
    ok: bool,
    /// The database already held an administrator; we kept it.
    admin_existed: bool,
    config_path: String,
}

fn is_hex_colour(v: &str) -> bool {
    let s = v.trim_start_matches('#');
    s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// A data URI carrying an image, capped at ~200 KB (the encoded weight of a
/// medium-sized logo - anything heavier belongs behind the file upload the
/// admin console offers). PNG/JPEG/WebP/SVG only, refused otherwise.
fn is_reasonable_image_dataurl(v: &str) -> bool {
    if v.len() > 300_000 { return false }   // ~200 KB decoded, headers included
    let head = "data:image/";
    if !v.starts_with(head) { return false }
    let rest = &v[head.len()..];
    let (kind, tail) = match rest.split_once(';') { Some(p) => p, None => return false };
    if !matches!(kind, "png" | "jpeg" | "jpg" | "webp" | "svg+xml") { return false }
    tail.starts_with("base64,")
}

/// Re-checked, right where the identifier is spliced into a `CREATE DATABASE`
/// statement, rather than relying on the validation at the top of the handler:
/// the allow-list must not be able to drift away from its use. Both PostgreSQL's
/// `"…"` and MySQL's `` `…` `` quoting are safe for `[A-Za-z_][A-Za-z0-9_]{0,62}`.
fn name_invalid_response() -> Response {
    bad_code(
        "db.name_invalid",
        "Invalid database name: only letters, numbers, and '_'; cannot start with a number.",
        json!({}),
    )
}

/// Reaches the configured database and hands back an engine-agnostic pool,
/// creating the database first when the operator asked and the engine allows it.
///
/// On success the returned pool is opened through `kubuno_db::connect`, which
/// also sets PostgreSQL's search path, creates the `core` schema/MySQL database
/// if still missing, and creates the SQLite file.
async fn reach_database(
    form: &DbForm,
    backend: Backend,
    create: bool,
    db_name: &str,
) -> Result<DbPool, Box<Response>> {
    match backend {
        Backend::Postgres => {
            // Probe the target database. A missing one can be created - when
            // asked - through the maintenance `postgres` database.
            match connect(form.options(db_name)).await {
                Ok(p) => p.close().await,
                Err(e) if is_missing_database(&e) && create => {
                    if !form.database_name_is_safe() {
                        return Err(Box::new(name_invalid_response()));
                    }
                    let admin_pool = connect(form.options("postgres")).await.map_err(|e| {
                        let (c, m) = friendly_db_error(&e);
                        Box::new(bad_code(c, m, json!({})))
                    })?;
                    // Safe: `database_name_is_safe` accepts no quote, space or
                    // separator, so the identifier cannot end early or carry a
                    // second statement.
                    let stmt = format!("CREATE DATABASE \"{db_name}\"");
                    if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(stmt)).execute(&admin_pool).await {
                        tracing::error!(error = %e, "Création de la base impossible");
                        admin_pool.close().await;
                        return Err(Box::new(bad_code(
                            "install.create_db_failed",
                            format!("Cannot create the database: {e}"),
                            json!({ "detail": e.to_string() }),
                        )));
                    }
                    admin_pool.close().await;
                }
                Err(e) => {
                    let (c, m) = friendly_db_error(&e);
                    return Err(Box::new(bad_code(c, m, json!({}))));
                }
            }
        }
        Backend::MySql => {
            if create {
                if !form.database_name_is_safe() {
                    return Err(Box::new(name_invalid_response()));
                }
                let server = connect_mysql_server(form).await.map_err(|e| {
                    let (c, m) = friendly_db_error(&e);
                    Box::new(bad_code(c, m, json!({})))
                })?;
                // Safe for the same reason as the PostgreSQL branch; backtick
                // quoting, MySQL's identifier quote.
                let stmt = format!("CREATE DATABASE IF NOT EXISTS `{db_name}`");
                if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(stmt)).execute(&server).await {
                    tracing::error!(error = %e, "Création de la base impossible");
                    server.close().await;
                    return Err(Box::new(bad_code(
                        "install.create_db_failed",
                        format!("Cannot create the database: {e}"),
                        json!({ "detail": e.to_string() }),
                    )));
                }
                server.close().await;
            }
        }
        // The SQLite file is created by `kubuno_db::connect` below.
        Backend::Sqlite => {}
    }

    kubuno_db::connect(&form.to_db_settings(), SCHEMA).await.map_err(|e| {
        tracing::error!(error = %e, "Connexion à la base impossible pendant l'installation");
        Box::new(bad_code("db.unreachable", format!("Connexion impossible : {e}"), json!({})))
    })
}

/// Writes one instance setting through the shared pool. The value is bound; the
/// key comes from a fixed set of literals in this module, never from the request.
/// The target rows are seeded by the migrations on every engine, so a plain
/// `UPDATE` reaches them without an engine-specific upsert.
async fn set_instance_setting(db: &DbPool, key: &str, value: serde_json::Value) {
    let _ = db
        .execute(
            "UPDATE core.settings SET value = $1 WHERE \"key\" = $2",
            params![value, key],
        )
        .await;
}

async fn install(State(st): State<Arc<SetupState>>, Json(req): Json<InstallRequest>) -> Response {
    // The instance has no accounts yet: this token is the only thing standing
    // between a freshly installed port and whoever reaches it first.
    if !st.token.verify(&req.token) {
        tracing::warn!("Installation refusée : jeton invalide");
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "Jeton d'installation invalide.",
                "code": "token.invalid",
                "params": {},
            })),
        )
            .into_response();
    }
    if let Err((code, msg)) = req.database.validate() {
        return bad_code(code, msg, json!({}));
    }
    if let Err((code, msg)) = req.admin.validate() {
        return bad_code(code, msg, json!({ "min": MIN_ADMIN_PASSWORD }));
    }
    if let Some(c) = req.instance.as_ref().and_then(|i| i.color_primary.as_deref()) {
        if !c.is_empty() && !is_hex_colour(c) {
            return bad_code("instance.color_invalid", "The accent color must use #RRGGBB format.", json!({}));
        }
    }
    if let Some(u) = req.instance.as_ref().and_then(|i| i.logo_dataurl.as_deref()) {
        if !u.is_empty() && !is_reasonable_image_dataurl(u) {
            return bad_code("instance.logo_invalid", "Logo invalide : PNG, JPEG, WebP ou SVG en data-URI, 200 Ko max.", json!({}));
        }
    }

    let backend = match req.database.backend() {
        Some(b) => b,
        None => {
            return bad_code(
                "db.engine_invalid",
                format!("Moteur de base inconnu : {}", req.database.engine),
                json!({}),
            )
        }
    };
    let db_name = req.database.database.trim().to_string();

    // 1. Reach the database, creating it when asked and allowed to. The details
    //    are engine-specific (PostgreSQL and MySQL can `CREATE DATABASE`, SQLite
    //    creates a file); every branch hands back the same engine-agnostic
    //    `DbPool`, so the rest of the installation is written once.
    let db = match reach_database(&req.database, backend, req.create_database, &db_name).await {
        Ok(db) => db,
        Err(resp) => return *resp,
    };

    // 2. Schema. Idempotent, so pointing the wizard at an existing Kubuno
    //    database repairs its configuration instead of destroying its data.
    if let Err(e) = crate::database::migrations::run(&db).await {
        tracing::error!(error = %e, "Migrations refusées pendant l'installation");
        return bad_code("install.schema_failed", format!("Cannot create the schema: {e}"), json!({ "detail": e.to_string() }));
    }

    // 2b. The single-row instance identity is seeded by a PostgreSQL migration
    //     but minted in Rust on MySQL/SQLite (no per-install random default for a
    //     binary primary key). Idempotent and never fatal.
    crate::database::seed::ensure_instance_identity(&db).await;

    // 3. First administrator - unless this database already has one.
    let admin_existed: bool = db
        .fetch_optional_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.users WHERE role = 'admin'",
                db.backend().count_bigint("*")
            ),
            params![],
        )
        .await
        .map(|n| n.unwrap_or(0) > 0)
        .unwrap_or(false);

    if !admin_existed {
        let hash = match crate::crypto::password::hash_password(&req.admin.password) {
            Ok(h) => h,
            Err(e) => {
                tracing::error!(error = %e, "Hachage du mot de passe administrateur impossible");
                return bad_code("install.hash_failed", "Cannot prepare the administrator password.", json!({}));
            }
        };
        let root_unit = crate::database::seed::root_org_unit(&db).await;
        // The id is minted in Rust (no `RETURNING`): MySQL cannot read a
        // DB-generated key back, and the account is reselected by email just below.
        let new_user_id = kubuno_db::new_id();
        let res = db
            .execute(
                "INSERT INTO core.users \
                    (id, email, username, password_hash, display_name, role, email_verified, \
                     is_active, must_change_password, org_unit_id) \
                 VALUES \
                    ($1, $2, $3, $4, 'Administrateur', 'admin', TRUE, TRUE, FALSE, $5)",
                params![
                    new_user_id,
                    req.admin.email.trim(),
                    req.admin.username.trim(),
                    &hash,
                    root_unit,
                ],
            )
            .await;
        if let Err(e) = res {
            tracing::error!(error = %e, "Création du compte administrateur impossible");
            return bad_code("install.admin_failed", format!("Cannot create the administrator account: {e}"), json!({ "detail": e.to_string() }));
        }

        // The console derives every entry from the role ASSIGNMENT, not from
        // `users.role`. Granting it here is what makes the account the operator
        // just created an administrator in fact and not only in name.
        let admin_id: Option<uuid::Uuid> = db
            .fetch_optional_scalar("SELECT id FROM core.users WHERE email = $1", params![req.admin.email.trim()])
            .await
            .unwrap_or(None);
        match admin_id {
            Some(id) => {
                if let Err(e) = crate::authz::bootstrap::grant_instance_superadmin(&db, id).await {
                    tracing::error!(error = %e, "Attribution de la super-administration impossible");
                    return bad_code("install.admin_failed", "Le compte administrateur n'a pas pu recevoir ses droits.", json!({ "detail": e.to_string() }));
                }
            }
            None => {
                tracing::error!("Compte administrateur introuvable juste après sa création");
                return bad_code("install.admin_failed", "Le compte administrateur n'a pas pu recevoir ses droits.", json!({}));
            }
        }
    }

    // 4. Instance name, when one was given. Every write goes through the shared
    //    `DbPool`, so the same code runs on PostgreSQL, MySQL and SQLite. The
    //    target rows are seeded by the migrations on all three engines, so a plain
    //    `UPDATE` reaches them without an engine-specific upsert.
    if let Some(inst) = req.instance.as_ref() {
        if !inst.name.trim().is_empty() {
            set_instance_setting(&db, "instance.name", json!(inst.name.trim())).await;
        }
        // Logo and accent colour follow the same key names the admin console
        // already uses (`instance.logo_url`, `instance.color_primary`), so the
        // shell and the login page read them at once with no wiring of their own.
        if let Some(u) = inst.logo_dataurl.as_deref().filter(|u| !u.is_empty()) {
            set_instance_setting(&db, "instance.logo_url", json!(u)).await;
        }
        if let Some(t) = inst.theme_id.as_deref().filter(|t| !t.is_empty()) {
            // Only a theme that really exists on disk: the id lands in a setting
            // the whole shell reads, and a bogus one would leave every client
            // falling back at each load.
            let known = crate::handlers::themes::load_all_themes(
                &st.settings.server.themes_dir,
                &std::collections::HashSet::new(),
            )
            .iter()
            .any(|e| e.manifest.id == t);
            if known {
                set_instance_setting(&db, "appearance.theme", json!(t)).await;
            } else {
                tracing::warn!(theme = %t, "Thème inconnu ignoré pendant l'installation");
            }
        }
        if let Some(l) = inst.locale.as_deref().filter(|l| !l.is_empty()) {
            // Normalised against the locales the product actually ships, so a
            // regional form (`fr-CA`) lands on one that has translations and an
            // unknown one is dropped rather than stored.
            match crate::settings::intl::normalise_locale(l) {
                Some(code) => {
                    set_instance_setting(&db, crate::settings::intl::LOCALE_KEY, json!(code)).await;
                }
                None => tracing::warn!(locale = %l, "Langue inconnue ignorée pendant l'installation"),
            }
        }
        if let Some(c) = inst.color_primary.as_deref().filter(|c| !c.is_empty()) {
            let hex = if c.starts_with('#') { c.to_string() } else { format!("#{c}") };
            set_instance_setting(&db, "instance.color_primary", json!(hex)).await;
        }
    }
    // The pool is dropped here; sqlx closes its connections in the background and
    // SQLite's WAL file is released for the real instance to reopen.
    drop(db);

    // 5. Configuration file. Written LAST: it is what makes the instance count
    //    as installed, so it is only written once everything else worked. The
    //    fields written depend on the engine: server engines carry credentials,
    //    SQLite carries the directory that holds its file.
    let target = config_file::target_path();
    let mut assigns = vec![Assign::text("database", "engine", &req.database.engine)];
    match backend {
        Backend::Sqlite => {
            assigns.push(Assign::text("database", "path", &req.database.sqlite_dir()));
        }
        _ => {
            assigns.push(Assign::text("database", "host", req.database.host.trim()));
            assigns.push(Assign::raw(
                "database",
                "port",
                req.database
                    .port
                    .unwrap_or(if backend == Backend::MySql { 3306 } else { 5432 })
                    .to_string(),
            ));
            assigns.push(Assign::text("database", "user", req.database.user.trim()));
            assigns.push(Assign::text("database", "password", &req.database.password));
            assigns.push(Assign::text("database", "database", &db_name));
        }
    }
    // Only written when the operator asked for one, so a plain install leaves the
    // key absent (no prefix) and the config file stays minimal. Engine-agnostic:
    // the prefix applies to PostgreSQL schemas, MySQL databases and SQLite files.
    if !req.database.schema_prefix().is_empty() {
        assigns.push(Assign::text("database", "schema_prefix", req.database.schema_prefix()));
    }
    // Secrets already set by an operator are left alone; placeholders are replaced.
    if super::is_placeholder(&st.settings.server.internal_secret) {
        assigns.push(Assign::text("server", "internal_secret", &generate_secret()));
    }
    if super::is_placeholder(&st.settings.auth.jwt_secret) {
        assigns.push(Assign::text("auth", "jwt_secret", &generate_secret()));
    }

    let patched = config_file::patch(&config_file::source_text(&target), &assigns);
    if let Err(e) = config_file::write_atomic(&target, &patched) {
        tracing::error!(error = %e, "Écriture de la configuration impossible");
        return bad_code(
            "install.config_failed",
            format!("The database is ready, but {} could not be written: {e}", target.display()),
            json!({ "path": target.display().to_string(), "detail": e.to_string() }),
        );
    }
    tracing::info!(path = %target.display(), "Configuration écrite par l'assistant d'installation");

    // 6. Hand over to the real instance.
    // The form has served its purpose: the secrets it held go now.
    if let Ok(mut store) = st.drafts.lock() {
        store.clear();
    }
    st.token.consume();
    st.installed.store(true, Ordering::SeqCst);
    let _ = st.done.send(true);

    Json(InstallResponse {
        ok: true,
        admin_existed,
        config_path: target.display().to_string(),
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("kubuno-setup-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).expect("tmp dir");
        d
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let (_parts, body) = resp.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.expect("body");
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    }

    /// `scheme://user:pass@host:port/db` → the discrete wizard fields.
    fn form_from_url(engine: &str, url: &str) -> DbForm {
        let after = url.split_once("://").map(|x| x.1).unwrap_or("");
        let (creds, hostpart) = after.split_once('@').unwrap_or(("", after));
        let (user, pass) = creds.split_once(':').unwrap_or((creds, ""));
        let (hostport, db) = hostpart.split_once('/').unwrap_or((hostpart, ""));
        let (host, port) = match hostport.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()),
            None => (hostport.to_string(), None),
        };
        DbForm {
            engine: engine.to_string(),
            host,
            port,
            user: user.to_string(),
            password: pass.to_string(),
            database: db.to_string(),
            schema_prefix: None,
            path: None,
        }
    }

    fn sqlite_form(dir: &std::path::Path) -> DbForm {
        DbForm {
            engine: "sqlite".to_string(),
            host: String::new(),
            port: None,
            user: String::new(),
            password: String::new(),
            database: String::new(),
            schema_prefix: None,
            path: Some(dir.to_string_lossy().into_owned()),
        }
    }

    // ── to_db_settings / validate ───────────────────────────────────────────────

    #[test]
    fn sqlite_form_needs_no_credentials() {
        let f = sqlite_form(std::path::Path::new("/tmp/x"));
        assert!(f.validate().is_ok());
        let s = f.to_db_settings();
        assert_eq!(s.engine, "sqlite");
        assert_eq!(s.path.as_deref(), Some("/tmp/x"));
        assert!(s.user.is_none());
    }

    #[test]
    fn server_form_carries_credentials() {
        let f = form_from_url("postgres", "postgres://u:p@h:5432/mydb");
        assert!(f.validate().is_ok());
        let s = f.to_db_settings();
        assert_eq!(s.engine, "postgres");
        assert_eq!(s.host.as_deref(), Some("h"));
        assert_eq!(s.port, Some(5432));
        assert_eq!(s.user.as_deref(), Some("u"));
        assert_eq!(s.database.as_deref(), Some("mydb"));
    }

    #[test]
    fn an_unknown_engine_is_rejected() {
        let mut f = sqlite_form(std::path::Path::new("/tmp/x"));
        f.engine = "oracle".into();
        assert!(f.validate().is_err());
    }

    #[test]
    fn schema_prefix_is_carried_into_the_install_pool() {
        // The wizard's prefix must reach `to_db_settings`, so the install pool
        // creates and migrates the core's own schema under `<prefix>core` - the
        // exact namespace the restarted instance reconnects to.
        let mut f = form_from_url("postgres", "postgres://u:p@h:5432/mydb");
        f.schema_prefix = Some("kub_".into());
        assert!(f.validate().is_ok());
        assert_eq!(f.to_db_settings().schema_prefix.as_deref(), Some("kub_"));
    }

    #[test]
    fn an_invalid_schema_prefix_is_rejected_on_every_engine() {
        // Engine-agnostic: rejected on SQLite too, before the engine-specific
        // early return, since the prefix names the SQLite file as well.
        let mut f = sqlite_form(std::path::Path::new("/tmp/x"));
        f.schema_prefix = Some("Kub-Bad".into());
        assert!(f.validate().is_err());
        let mut f = form_from_url("postgres", "postgres://u:p@h:5432/mydb");
        f.schema_prefix = Some("Kub-Bad".into());
        assert!(f.validate().is_err());
    }

    // ── test-database, three engines ────────────────────────────────────────────

    #[tokio::test]
    async fn test_database_sqlite_is_ok_and_uninitialised() {
        let dir = tmp_dir("sqlite-td");
        let resp = test_database(Json(sqlite_form(&dir))).await;
        let v = body_json(resp).await;
        assert_eq!(v["ok"], serde_json::json!(true), "{v}");
        assert_eq!(v["already_initialised"], serde_json::json!(false), "{v}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn test_database_postgres_when_configured() {
        let Some(url) = std::env::var("KUBUNO_PG_TEST_URL").ok().filter(|u| !u.trim().is_empty())
        else {
            eprintln!("KUBUNO_PG_TEST_URL absent - test PG ignoré");
            return;
        };
        let resp = test_database(Json(form_from_url("postgres", &url))).await;
        let v = body_json(resp).await;
        assert_eq!(v["ok"], serde_json::json!(true), "PG test-database: {v}");
        assert!(v["server_version"].as_str().unwrap_or("").contains("PostgreSQL"), "{v}");
    }

    #[tokio::test]
    async fn test_database_mysql_when_configured() {
        let Some(url) = std::env::var("KUBUNO_MYSQL_TEST_URL").ok().filter(|u| !u.trim().is_empty())
        else {
            eprintln!("KUBUNO_MYSQL_TEST_URL absent - test MySQL ignoré");
            return;
        };
        let resp = test_database(Json(form_from_url("mysql", &url))).await;
        let v = body_json(resp).await;
        // The `core` database exists on the shared test server, so this reaches
        // it and reports `ok`.
        assert_eq!(v["ok"], serde_json::json!(true), "MySQL test-database: {v}");
    }

    // ── a complete install on SQLite ────────────────────────────────────────────

    fn test_settings() -> Settings {
        const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let cfg = config::Config::builder()
            .set_default("server.host", "127.0.0.1").unwrap()
            .set_default("server.port", 8080u16).unwrap()
            .set_default("server.frontend_dist", "./frontend/dist").unwrap()
            .set_default("server.internal_secret", SECRET).unwrap()
            .set_default("server.modules_dir", "/usr/lib/kubuno/modules").unwrap()
            .set_default("server.themes_dir", "/var/lib/kubuno/themes").unwrap()
            .set_default("database.engine", "sqlite").unwrap()
            .set_default("database.path", "/tmp/kubuno-unused").unwrap()
            .set_default("database.max_connections", 4u32).unwrap()
            .set_default("database.min_connections", 0u32).unwrap()
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
            .unwrap();
        cfg.try_deserialize().expect("test Settings")
    }

    #[tokio::test]
    async fn install_on_sqlite_yields_a_migrated_core() {
        let base = tmp_dir("sqlite-install");
        let db_dir = base.join("db");
        let token_file = base.join("setup-token");
        let config_file = base.join("config.toml");
        std::env::set_var("KV_SETUP_TOKEN_FILE", &token_file);
        std::env::set_var("KV_CONFIG_FILE", &config_file);
        std::fs::write(&config_file, "[server]\n\n[database]\n\n[auth]\n").unwrap();

        let token = SetupToken::create_or_load().expect("token");
        let token_value = std::fs::read_to_string(&token_file).unwrap().trim().to_string();

        let state = Arc::new(SetupState {
            settings: test_settings(),
            token,
            done: tokio::sync::watch::channel(false).0,
            installed: Arc::new(AtomicBool::new(false)),
            drafts: std::sync::Mutex::new(HashMap::new()),
        });

        let req = InstallRequest {
            token: token_value,
            database: sqlite_form(&db_dir),
            create_database: false,
            admin: AdminForm {
                username: "admin".into(),
                email: "admin@example.com".into(),
                password: "correct horse battery staple".into(),
            },
            instance: None,
        };

        let resp = install(State(state.clone()), Json(req)).await;
        let v = body_json(resp).await;
        assert_eq!(v["ok"], serde_json::json!(true), "install: {v}");
        assert!(state.installed.load(Ordering::SeqCst), "instance marked installed");

        // The core is migrated and carries exactly one administrator.
        let db = kubuno_db::connect(&sqlite_form(&db_dir).to_db_settings(), SCHEMA)
            .await
            .expect("open installed sqlite");
        let admins: i64 = db
            .fetch_scalar(
                &format!(
                    "SELECT {} FROM core.users WHERE role = 'admin'",
                    db.backend().count_bigint("*")
                ),
                params![],
            )
            .await
            .expect("count admins");
        assert_eq!(admins, 1, "exactly one administrator seeded");

        // The configuration names the SQLite engine, so the real instance boots
        // against the file we just migrated.
        let cfg = std::fs::read_to_string(&config_file).unwrap();
        assert!(cfg.contains("engine = \"sqlite\""), "config: {cfg}");

        std::env::remove_var("KV_SETUP_TOKEN_FILE");
        std::env::remove_var("KV_CONFIG_FILE");
        drop(db);
        std::fs::remove_dir_all(&base).ok();
    }
}
