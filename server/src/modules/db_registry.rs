//! Registry of known database connections per scope.
//!
//! Switching a scope's engine (see [`crate::handlers::admin::db_switch`]) moves a
//! pointer: the config file for the core, the `core.module_databases` override
//! for a module. Once it moves, the previous database is still there but the
//! console has forgotten how to reach it. This registry keeps every connection a
//! scope has ever pointed at - the source before a switch, the target after it -
//! in `core.db_connections`, so an administrator can always go back to an earlier
//! database.
//!
//! A "scope" is `"core"` (the main database) or a module id. At most one row per
//! scope carries `is_current = true`: the database the scope runs on right now.
//! That single-current invariant is enforced here, in [`mark_current`], because
//! a partial unique index is not portable across the three engines.
//!
//! The stored password is sealed with AES-GCM under a dedicated key domain, the
//! same scheme as [`crate::modules::db_config`], and never returns in a response
//! or a log - the read API exposes only whether a password is stored.

use crate::config::DbCredentials;
use crate::crypto::{datakey, encryption};
use crate::errors::AppError;
use chrono::{DateTime, Utc};
use kubuno_db::{params, Backend, DbPool};
use uuid::Uuid;

/// Key-derivation domain for a registered connection's password, kept apart from
/// the per-module override store (`kubuno:module-db:`) and the other data-at-rest
/// stores so one store's key is useless against another.
const DOMAIN: &[u8] = b"kubuno:db-connection:";

/// The scope name of the core's own main database.
pub const CORE_SCOPE: &str = "core";

/// Seals a connection password. Empty stays empty (a connection with no password
/// stores no blob).
pub fn encrypt_password(jwt_secret: &str, plain: &str) -> anyhow::Result<String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    let key = datakey::key(DOMAIN, jwt_secret);
    encryption::encrypt(&key, plain.as_bytes())
}

/// Opens a sealed connection password. An empty blob decrypts to the empty string.
pub fn decrypt_password(jwt_secret: &str, blob: &str) -> anyhow::Result<String> {
    if blob.is_empty() {
        return Ok(String::new());
    }
    let key = datakey::key(DOMAIN, jwt_secret);
    let bytes = encryption::decrypt(&key, blob)?;
    Ok(String::from_utf8(bytes)?)
}

/// One row of `core.db_connections`, decoded across all three engines.
#[derive(sqlx::FromRow, Clone)]
pub struct ConnRow {
    pub id:             Uuid,
    pub scope:          String,
    pub engine:         String,
    pub host:           String,
    /// Stored as an INTEGER column; 0 means "the engine default".
    pub port:           i32,
    pub db_user:        String,
    pub password_enc:   String,
    pub db_name:        String,
    pub db_path:        String,
    pub schema_prefix:  Option<String>,
    pub label:          Option<String>,
    pub is_current:     bool,
    pub created_at:     DateTime<Utc>,
    pub last_used_at:   DateTime<Utc>,
    pub last_synced_at: Option<DateTime<Utc>>,
}

impl ConnRow {
    /// The credentials this connection describes. The password is decrypted here
    /// (the only place it returns to plaintext, en route to a copy or a repoint).
    pub fn to_credentials(&self, jwt_secret: &str) -> anyhow::Result<DbCredentials> {
        let port = if self.port <= 0 {
            default_port(&self.engine)
        } else {
            self.port as u16
        };
        Ok(DbCredentials {
            engine:   self.engine.clone(),
            host:     self.host.clone(),
            port,
            user:     self.db_user.clone(),
            password: decrypt_password(jwt_secret, &self.password_enc)?,
            database: self.db_name.clone(),
            path:     self.db_path.clone(),
        })
    }

    /// The non-empty, validated schema prefix, or `None`.
    pub fn prefix(&self) -> Option<String> {
        self.schema_prefix
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string)
    }

    /// The label to show: the stored one, or a value derived from the connection.
    pub fn effective_label(&self) -> String {
        match self.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
            Some(l) => l.to_string(),
            None => derive_label(&self.engine, &self.host, self.port, &self.db_name, &self.db_path),
        }
    }
}

/// The engine's default TCP port, used when a row left `port` at 0.
fn default_port(engine: &str) -> u16 {
    match Backend::parse(engine) {
        Some(Backend::MySql) => 3306,
        _ => 5432,
    }
}

/// A human-readable label derived from a connection, e.g. `postgres@db:5432/cal`
/// or `sqlite:/var/lib/kubuno/db`.
pub fn derive_label(engine: &str, host: &str, port: i32, db_name: &str, db_path: &str) -> String {
    match Backend::parse(engine) {
        Some(Backend::Sqlite) => {
            let default = crate::config::paths::default_sqlite_dir();
            let p = if db_path.trim().is_empty() { default.as_str() } else { db_path.trim() };
            format!("sqlite:{p}")
        }
        _ => {
            let h = if host.trim().is_empty() { "localhost" } else { host.trim() };
            let mut s = format!("{engine}@{h}");
            if port > 0 {
                s.push_str(&format!(":{port}"));
            }
            if !db_name.trim().is_empty() {
                s.push('/');
                s.push_str(db_name.trim());
            }
            s
        }
    }
}

/// The stored port for a connection: the concrete port for a server engine, 0 for
/// SQLite (which has no port).
fn store_port(creds: &DbCredentials) -> i32 {
    match Backend::parse(&creds.engine) {
        Some(Backend::Sqlite) => 0,
        _ => i32::from(creds.port),
    }
}

/// Registers (or refreshes) a connection in the scope's registry, idempotently.
///
/// Keyed by the connection's identity `(scope, engine, host, port, db_name,
/// db_path)`: a brand-new target is inserted, an already-known one has its
/// credentials, prefix, label and `last_used_at` refreshed instead of duplicated.
/// `is_current` is never changed here - call [`mark_current`] to move the current
/// pointer, so the single-current invariant stays in one place. Returns the row
/// id either way.
#[allow(clippy::too_many_arguments)]
pub async fn register(
    db: &DbPool,
    jwt_secret: &str,
    scope: &str,
    creds: &DbCredentials,
    prefix: Option<&str>,
    label: Option<&str>,
    make_current: bool,
) -> Result<Uuid, AppError> {
    let password_enc = encrypt_password(jwt_secret, &creds.password).map_err(AppError::Internal)?;
    let port_store = store_port(creds);
    let prefix_store = prefix.map(str::trim).filter(|p| !p.is_empty());
    let label_store = label.map(str::trim).filter(|l| !l.is_empty());
    let id = Uuid::new_v4();

    // On conflict, refresh the mutable fields but keep the existing id, is_current
    // and created_at. COALESCE keeps a stored label when this registration carries
    // none.
    let conflict = db.backend().upsert(
        "core.db_connections",
        &["scope", "engine", "host", "port", "db_name", "db_path"],
        &[
            kubuno_db::dialect::Assign::Incoming("db_user"),
            kubuno_db::dialect::Assign::Incoming("password_enc"),
            kubuno_db::dialect::Assign::Incoming("schema_prefix"),
            kubuno_db::dialect::Assign::Expr { col: "label", expr: "COALESCE({new}, {cur})" },
            kubuno_db::dialect::Assign::Incoming("last_used_at"),
        ],
    );
    let sql = format!(
        "INSERT INTO core.db_connections \
            (id, scope, engine, host, port, db_user, password_enc, db_name, db_path, \
             schema_prefix, label, is_current, last_used_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13){conflict}"
    );
    db.execute(
        &sql,
        params![
            id,
            scope,
            creds.engine.clone(),
            creds.host.trim(),
            port_store,
            creds.user.trim(),
            password_enc,
            creds.database.trim(),
            creds.path.trim(),
            prefix_store,
            label_store,
            false,
            Utc::now(),
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(scope, engine = %creds.engine, error = %e, "Enregistrement d'une connexion DB");
        AppError::Database(e)
    })?;

    // Recover the row id portably (MySQL has no RETURNING): the identity tuple is
    // unique, so it selects exactly the row just inserted or refreshed.
    let row = db
        .fetch_one_as::<IdRow>(
            "SELECT id FROM core.db_connections \
              WHERE scope = $1 AND engine = $2 AND host = $3 AND port = $4 \
                AND db_name = $5 AND db_path = $6",
            params![
                scope,
                creds.engine.clone(),
                creds.host.trim(),
                port_store,
                creds.database.trim(),
                creds.path.trim()
            ],
        )
        .await
        .map_err(AppError::Database)?;

    if make_current {
        mark_current(db, scope, row.id).await?;
    }
    Ok(row.id)
}

#[derive(sqlx::FromRow)]
struct IdRow {
    id: Uuid,
}

/// Makes `id` the scope's current connection and clears the flag on every other
/// row of the scope, in one transaction, so at most one connection per scope is
/// ever current. Also refreshes its `last_used_at`.
pub async fn mark_current(db: &DbPool, scope: &str, id: Uuid) -> Result<(), AppError> {
    let mut tx = db.begin().await.map_err(AppError::Database)?;
    tx.execute(
        "UPDATE core.db_connections SET is_current = $1 WHERE scope = $2",
        params![false, scope],
    )
    .await
    .map_err(AppError::Database)?;
    let n = tx
        .execute(
            "UPDATE core.db_connections SET is_current = $1, last_used_at = $2 \
              WHERE id = $3 AND scope = $4",
            params![true, Utc::now(), id, scope],
        )
        .await
        .map_err(AppError::Database)?;
    if n != 1 {
        // The row is gone or belongs to another scope; do not leave the scope
        // with no current connection.
        return Err(AppError::NotFound("Connexion enregistrée introuvable".into()));
    }
    tx.commit().await.map_err(AppError::Database)?;
    Ok(())
}

const COLS: &str = "id, scope, engine, host, port, db_user, password_enc, db_name, db_path, \
                    schema_prefix, label, is_current, created_at, last_used_at, last_synced_at";

/// Every connection known for a scope, newest first.
pub async fn list(db: &DbPool, scope: &str) -> Result<Vec<ConnRow>, AppError> {
    db.fetch_all_as::<ConnRow>(
        &format!("SELECT {COLS} FROM core.db_connections WHERE scope = $1 ORDER BY created_at DESC"),
        params![scope],
    )
    .await
    .map_err(|e| {
        tracing::error!(scope, error = %e, "Lecture du registre des connexions DB");
        AppError::Database(e)
    })
}

/// One connection of a scope by id, or `None`.
pub async fn get(db: &DbPool, scope: &str, id: Uuid) -> Result<Option<ConnRow>, AppError> {
    db.fetch_optional_as::<ConnRow>(
        &format!("SELECT {COLS} FROM core.db_connections WHERE scope = $1 AND id = $2"),
        params![scope, id],
    )
    .await
    .map_err(AppError::Database)
}

/// The scope's current connection, if one is recorded.
pub async fn current(db: &DbPool, scope: &str) -> Result<Option<ConnRow>, AppError> {
    db.fetch_optional_as::<ConnRow>(
        &format!("SELECT {COLS} FROM core.db_connections WHERE scope = $1 AND is_current = $2"),
        params![scope, true],
    )
    .await
    .map_err(AppError::Database)
}

/// Forgets a connection. Refuses to forget the scope's current connection, so the
/// registry never loses the pointer to the live database.
pub async fn forget(db: &DbPool, scope: &str, id: Uuid) -> Result<(), AppError> {
    let row = get(db, scope, id).await?.ok_or_else(|| AppError::NotFound("Connexion enregistrée introuvable".into()))?;
    if row.is_current {
        return Err(AppError::Validation(
            "Impossible d'oublier la connexion en cours d'utilisation.".into(),
        ));
    }
    db.execute(
        "DELETE FROM core.db_connections WHERE scope = $1 AND id = $2",
        params![scope, id],
    )
    .await
    .map_err(AppError::Database)?;
    Ok(())
}

/// Records that a connection's data was refreshed from the current database.
pub async fn touch_synced(db: &DbPool, id: Uuid) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.db_connections SET last_synced_at = $1 WHERE id = $2",
        params![Utc::now(), id],
    )
    .await
    .map_err(AppError::Database)?;
    Ok(())
}

/// Ensures the scope's live connection is present in the registry and flagged
/// current, registering it from `creds` when it is missing. Idempotent and
/// best-effort: a registry read/write failure is logged and swallowed so it never
/// keeps the console from loading. This is how the initial (install-time)
/// connection ends up in the registry without a dedicated install hook.
pub async fn ensure_current(
    db: &DbPool,
    jwt_secret: &str,
    scope: &str,
    creds: &DbCredentials,
    prefix: Option<&str>,
) {
    match current(db, scope).await {
        Ok(Some(_)) => {} // a current connection is already recorded
        Ok(None) => {
            if let Err(e) = register(db, jwt_secret, scope, creds, prefix, None, true).await {
                tracing::warn!(scope, error = %e, "Auto-enregistrement de la connexion courante impossible");
            }
        }
        Err(e) => {
            tracing::warn!(scope, error = %e, "Lecture de la connexion courante impossible");
        }
    }
}
