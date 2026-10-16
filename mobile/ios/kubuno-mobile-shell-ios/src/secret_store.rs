//! The iOS secret store: the Keychain wrapper the shell installs for the account layer.
//!
//! Each secret (a refresh token, the account book, the device key) is a Keychain generic password of the service
//! `com.kubuno.<app id>.secrets`, under the secret's key as account name — encrypted and protected by iOS, kept apart
//! per app. Pure Rust over the Security framework.

use kubuno_mobile_account::{SecretError, SecretStore};

/// `errSecItemNotFound`: no such Keychain item.
#[cfg(target_os = "ios")]
const NOT_FOUND: i32 = -25300;

/// Secrets kept as Keychain generic passwords of one service.
pub struct KeychainSecretStore {
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    service: String,
}

impl KeychainSecretStore {
    /// A store for the app `app_id` (its Keychain service is `com.kubuno.<app_id>.secrets`).
    pub fn new(app_id: &str) -> Self {
        Self { service: format!("com.kubuno.{app_id}.secrets") }
    }
}

#[cfg(target_os = "ios")]
impl SecretStore for KeychainSecretStore {
    fn load(&self, key: &str) -> Result<Option<String>, SecretError> {
        match security_framework::passwords::get_generic_password(&self.service, key) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| SecretError("secret is not UTF-8".into())),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(SecretError(format!("keychain read: {e}"))),
        }
    }

    fn store(&self, key: &str, value: &str) -> Result<(), SecretError> {
        security_framework::passwords::set_generic_password(&self.service, key, value.as_bytes())
            .map_err(|e| SecretError(format!("keychain write: {e}")))
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        match security_framework::passwords::delete_generic_password(&self.service, key) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == NOT_FOUND => Ok(()),
            Err(e) => Err(SecretError(format!("keychain delete: {e}"))),
        }
    }
}

/// Off iOS (the standalone demo built on a desktop for a quick look) there is no Keychain: nothing is stored.
#[cfg(not(target_os = "ios"))]
impl SecretStore for KeychainSecretStore {
    fn load(&self, _key: &str) -> Result<Option<String>, SecretError> {
        Ok(None)
    }

    fn store(&self, _key: &str, _value: &str) -> Result<(), SecretError> {
        Err(SecretError("no Keychain on this platform".into()))
    }

    fn delete(&self, _key: &str) -> Result<(), SecretError> {
        Ok(())
    }
}
