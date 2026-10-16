//! Per-module database resolution.
//!
//! Every module inherits the core's own engine and credentials by default: the
//! supervisor injects `KUBUNO_DB_*` derived from `[database]` in the core config
//! (see [`crate::config::database_credentials`]). An administrator may point ONE
//! module at a different engine or server by storing an override row in
//! `core.module_databases`. This module resolves the credentials a module should
//! be started with - the override when an enabled row exists, the inherited
//! credentials otherwise - and seals/opens the override password at rest.
//!
//! The override password uses the same AES-GCM scheme as the OIDC and SMTP
//! secrets, with a key derived from the data-encryption root under a dedicated
//! domain so one store's key is useless against another.

use crate::config::{database_credentials, DatabaseSettings, DbCredentials};
use crate::crypto::{datakey, encryption};
use kubuno_db::{params, Backend, DbPool};

/// Key-derivation domain for the per-module database password, kept apart from
/// the other data-at-rest stores (OIDC, SMTP, TOTP…).
const DOMAIN: &[u8] = b"kubuno:module-db:";

/// The engine's default TCP port, used when the override left `port` at 0.
fn default_port(engine: &str) -> u16 {
    match Backend::parse(engine) {
        Some(Backend::MySql) => 3306,
        _ => 5432,
    }
}

/// Seals an override password with the module-database key. Empty stays empty
/// (no password), so an override that carries no password stores no blob.
pub fn encrypt_password(jwt_secret: &str, plain: &str) -> anyhow::Result<String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    let key = datakey::key(DOMAIN, jwt_secret);
    encryption::encrypt(&key, plain.as_bytes())
}

/// Opens a sealed override password. An empty blob decrypts to the empty string.
pub fn decrypt_password(jwt_secret: &str, blob: &str) -> anyhow::Result<String> {
    if blob.is_empty() {
        return Ok(String::new());
    }
    let key = datakey::key(DOMAIN, jwt_secret);
    let bytes = encryption::decrypt(&key, blob)?;
    Ok(String::from_utf8(bytes)?)
}

/// One row of `core.module_databases`, decoded across all three engines.
#[derive(sqlx::FromRow, Debug, Clone)]
pub struct ModuleDbRow {
    pub module_id:     String,
    pub engine:        String,
    pub host:          String,
    /// Stored as an INTEGER column; 0 means "the engine default".
    pub port:          i32,
    pub db_user:       String,
    pub password_enc:  String,
    pub db_name:       String,
    pub db_path:       String,
    pub schema_prefix: Option<String>,
    pub enabled:       bool,
}

impl ModuleDbRow {
    /// The credentials this override injects into the module process. The
    /// password is decrypted here (the only place it returns to plaintext, en
    /// route to the child's environment).
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
}

/// The credentials (and optional schema prefix) a module should be started with.
pub struct Resolved {
    pub credentials:   DbCredentials,
    pub schema_prefix: Option<String>,
    /// `true` when an enabled override was applied, `false` when inherited.
    pub overridden:    bool,
}

/// Resolves the database a module connects to.
///
/// An enabled row in `core.module_databases` wins; otherwise the module inherits
/// the core's own credentials. A missing table (an instance not yet migrated) or
/// any read error falls back to inheritance, so resolution never keeps a module
/// from starting.
pub async fn resolve(
    db: &DbPool,
    main_db: &DatabaseSettings,
    jwt_secret: &str,
    module_id: &str,
) -> anyhow::Result<Resolved> {
    let inherited = || -> anyhow::Result<Resolved> {
        Ok(Resolved {
            credentials:   database_credentials(main_db)?,
            schema_prefix: main_db
                .schema_prefix
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_string),
            overridden: false,
        })
    };

    let row = db
        .fetch_optional_as::<ModuleDbRow>(
            "SELECT module_id, engine, host, port, db_user, password_enc, db_name, db_path, \
                    schema_prefix, enabled \
             FROM core.module_databases WHERE module_id = $1",
            params![module_id],
        )
        .await;

    match row {
        Ok(Some(r)) if r.enabled => Ok(Resolved {
            credentials:   r.to_credentials(jwt_secret)?,
            schema_prefix: r.prefix(),
            overridden:    true,
        }),
        Ok(_) => inherited(),
        Err(e) => {
            // The table may be absent on an instance whose migrations have not
            // caught up; inheriting keeps the module running.
            tracing::warn!(
                module_id,
                error = %e,
                "Lecture de l'override de base de données impossible - héritage du SGBD principal"
            );
            inherited()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JWT: &str = "test-jwt-secret-that-is-long-enough-1234567890";

    #[test]
    fn password_round_trips_and_empty_stays_empty() {
        // Empty in, empty out - an override with no password stores no blob.
        assert_eq!(encrypt_password(JWT, "").unwrap(), "");
        assert_eq!(decrypt_password(JWT, "").unwrap(), "");

        let blob = encrypt_password(JWT, "s3cr3t!").unwrap();
        assert_ne!(blob, "s3cr3t!", "the stored value must not be plaintext");
        assert_eq!(decrypt_password(JWT, &blob).unwrap(), "s3cr3t!");
    }

    #[test]
    fn a_different_key_cannot_open_the_blob() {
        let blob = encrypt_password(JWT, "s3cr3t!").unwrap();
        assert!(decrypt_password("another-secret-entirely-0987654321zzzz", &blob).is_err());
    }

    #[test]
    fn to_credentials_fills_the_default_port_and_decrypts() {
        let row = ModuleDbRow {
            module_id:     "calendar".into(),
            engine:        "mysql".into(),
            host:          "db.internal".into(),
            port:          0, // 0 → engine default
            db_user:       "kube".into(),
            password_enc:  encrypt_password(JWT, "pw").unwrap(),
            db_name:       "cal".into(),
            db_path:       String::new(),
            schema_prefix: Some(" ".into()),
            enabled:       true,
        };
        let c = row.to_credentials(JWT).unwrap();
        assert_eq!(c.engine, "mysql");
        assert_eq!(c.port, 3306, "MySQL default port when stored as 0");
        assert_eq!(c.password, "pw");
        // A blank prefix collapses to None.
        assert_eq!(row.prefix(), None);
    }

    #[test]
    fn stored_port_is_honoured_when_set() {
        let row = ModuleDbRow {
            module_id:     "notes".into(),
            engine:        "postgres".into(),
            host:          "h".into(),
            port:          6543,
            db_user:       "u".into(),
            password_enc:  String::new(),
            db_name:       "d".into(),
            db_path:       String::new(),
            schema_prefix: Some("kub_".into()),
            enabled:       true,
        };
        let c = row.to_credentials(JWT).unwrap();
        assert_eq!(c.port, 6543);
        assert_eq!(c.password, "", "empty blob decrypts to empty");
        assert_eq!(row.prefix().as_deref(), Some("kub_"));
    }
}
