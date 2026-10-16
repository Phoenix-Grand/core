//! Reading directories out of the database, and the encryption of the one field
//! that never travels in clear.
//!
//! The service-account password is stored as an AES-256-GCM blob keyed by a
//! domain-separated derivation of the JWT secret - the same construction the
//! SMTP relay (`crate::mailer::config`) and the OIDC client secrets
//! (`crate::auth::oauth`) use. The three keys differ, so one of them leaking
//! never unlocks another.

use crate::crypto::datakey;
use kubuno_db::{params, DbPool};

use crate::{crypto::encryption, errors::AppError};

use super::model::LdapDirectory;

/// Master switch. Off, no sign-in attempt reaches any directory - the lever an
/// operator pulls at 3 a.m. without editing every row.
pub const KEY_LOGIN_ENABLED: &str = "auth.directory_login_enabled";
/// Instance default for provisioning on a first successful directory sign-in.
/// A directory may narrow it (`allow_signup = false`) but never widen it.
pub const KEY_PROVISION_ON_LOGIN: &str = "auth.directory_provision_on_login";

/// Key used to encrypt the service-account password.
pub fn secret_key(jwt_secret: &str) -> [u8; 32] {
    // The key comes from the data-encryption root, not from the token-signing
    // secret, so rotating the latter leaves what is stored readable. The root is
    // seeded with the JWT secret on first boot, so existing values keep the same
    // derivation; `jwt_secret` is only the fallback when the root was never loaded.
    datakey::key(b"kubuno:ldap:", jwt_secret)
}

/// Encrypts a service password. An empty one stays empty rather than becoming a
/// blob that decrypts to nothing: the "is a password set" boolean is derived
/// from emptiness, and encrypting "" would answer yes.
pub fn encrypt_password(jwt_secret: &str, plain: &str) -> Result<String, AppError> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    encryption::encrypt(&secret_key(jwt_secret), plain.as_bytes()).map_err(AppError::Internal)
}

/// Decrypts the stored blob.
///
/// A blob that no longer decrypts means the JWT secret was rotated. Saying so
/// once, loudly, and carrying on without credentials is the same choice the mail
/// relay makes: an unreadable secret must not stop the instance from booting,
/// and the anonymous bind that follows fails with a message an operator can act
/// on.
pub fn decrypt_password(jwt_secret: &str, blob: &str) -> String {
    if blob.is_empty() {
        return String::new();
    }
    match encryption::decrypt(&secret_key(jwt_secret), blob) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => {
            tracing::error!(
                error = %e,
                "annuaire : mot de passe de service indéchiffrable (secret JWT changé ?) - liaison anonyme"
            );
            String::new()
        }
    }
}

/// Is directory authentication allowed at all on this instance?
///
/// Defaults to **true** when the key cannot be read: the key is seeded by the
/// migration, and a half-applied migration that silently locked every directory
/// account out would be diagnosed as "LDAP is broken" rather than as what it is.
/// Turning directories off is an explicit act.
pub async fn login_enabled(db: &DbPool) -> bool {
    crate::settings::instance_value(db, KEY_LOGIN_ENABLED)
        .await
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// May a successful bind by somebody unknown create an account?
pub async fn provision_on_login(db: &DbPool) -> bool {
    crate::settings::instance_value(db, KEY_PROVISION_ON_LOGIN)
        .await
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Every enabled directory, in the order an operator arranged them. Sign-in
/// walks this list, so the order is the order of attempts.
pub async fn enabled_directories(db: &DbPool) -> Result<Vec<LdapDirectory>, AppError> {
    db.fetch_all_as::<LdapDirectory>(
        "SELECT * FROM core.ldap_directories WHERE enabled = TRUE ORDER BY position, display_name",
        params![],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "annuaire : lecture des annuaires actifs");
        AppError::Database(e)
    })
}

/// One directory by id, whatever its state.
pub async fn load(db: &DbPool, id: uuid::Uuid) -> Result<LdapDirectory, AppError> {
    db.fetch_optional_as::<LdapDirectory>(
        "SELECT * FROM core.ldap_directories WHERE id = $1",
        params![id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "annuaire : lecture d'un annuaire");
        AppError::Database(e)
    })?
    .ok_or_else(|| AppError::NotFound("Annuaire introuvable".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_password_round_trips_and_the_blob_hides_it() {
        let blob = encrypt_password("un-secret-jwt-suffisamment-long", "hunter2").expect("chiffrement");
        assert!(!blob.contains("hunter2"));
        assert_eq!(decrypt_password("un-secret-jwt-suffisamment-long", &blob), "hunter2");
    }

    #[test]
    fn an_empty_password_stays_empty() {
        assert_eq!(encrypt_password("jwt", "").expect("vide"), "");
        assert_eq!(decrypt_password("jwt", ""), "");
    }

    #[test]
    fn a_blob_from_another_secret_yields_nothing_rather_than_garbage() {
        let blob = encrypt_password("le-premier-secret-jwt-assez-long", "hunter2").expect("chiffrement");
        // The JWT secret was rotated: no credential, no panic, no stack trace.
        assert_eq!(decrypt_password("un-tout-autre-secret-jwt-long", &blob), "");
    }

    #[test]
    fn the_directory_key_differs_from_the_relay_and_the_provider_keys() {
        let jwt = "le-meme-secret-pour-les-trois-sous-systemes";
        assert_ne!(secret_key(jwt), crate::mailer::config::secret_key(jwt));
        assert_ne!(secret_key(jwt), crate::auth::oauth::secret_key(jwt));
    }
}
