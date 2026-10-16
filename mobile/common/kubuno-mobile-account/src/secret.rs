//! The OS secret store, where the refresh token lives.
//!
//! A refresh token is long-lived (30 days) and must never touch the logs, the JSON or ordinary app storage. On a
//! phone it belongs in the platform keystore — Android's `AndroidKeyStore` / `EncryptedSharedPreferences`, iOS's
//! Keychain — which the shell wraps and hands to the account layer as a [`SecretStore`]. This crate stays free of any
//! platform API: it only drives the trait. [`MemorySecretStore`] is the in-process fallback for tests and tools.

use std::collections::HashMap;
use std::sync::Mutex;

/// A secret store operation failed (the keystore was unavailable, locked, or refused the entry). It never carries the
/// secret itself.
#[derive(Debug, Clone, thiserror::Error)]
#[error("secret store: {0}")]
pub struct SecretError(pub String);

/// A small key→secret store backed by the OS keystore. Keys are opaque ASCII (e.g. `kubuno.refresh.<account>`);
/// values are secrets. Implemented by the shell over the platform keystore; the account layer only calls it.
pub trait SecretStore: Send + Sync {
    /// The secret stored under `key`, or `None` if there is none.
    fn load(&self, key: &str) -> Result<Option<String>, SecretError>;
    /// Store `value` under `key`, replacing any previous value.
    fn store(&self, key: &str, value: &str) -> Result<(), SecretError>;
    /// Remove the secret under `key` (a no-op if there is none).
    fn delete(&self, key: &str) -> Result<(), SecretError>;
}

/// An in-process secret store (no persistence, no encryption): the fallback for tests and tools. **Not** for a real
/// device — a real one uses the platform keystore through the shell's [`SecretStore`].
#[derive(Default)]
pub struct MemorySecretStore {
    map: Mutex<HashMap<String, String>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemorySecretStore {
    fn load(&self, key: &str) -> Result<Option<String>, SecretError> {
        Ok(self.map.lock().map_err(|_| SecretError("poisoned".into()))?.get(key).cloned())
    }

    fn store(&self, key: &str, value: &str) -> Result<(), SecretError> {
        self.map.lock().map_err(|_| SecretError("poisoned".into()))?.insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        self.map.lock().map_err(|_| SecretError("poisoned".into()))?.remove(key);
        Ok(())
    }
}

/// The secret-store key that holds the refresh token of the account on `server` (one owner per account).
pub fn refresh_key(server: &str, user_id: &str) -> String {
    format!("kubuno.refresh.{}.{}", server.trim_end_matches('/'), user_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips_and_deletes() {
        let s = MemorySecretStore::new();
        assert_eq!(s.load("k").unwrap(), None);
        s.store("k", "secret").unwrap();
        assert_eq!(s.load("k").unwrap().as_deref(), Some("secret"));
        s.store("k", "secret2").unwrap();
        assert_eq!(s.load("k").unwrap().as_deref(), Some("secret2"));
        s.delete("k").unwrap();
        assert_eq!(s.load("k").unwrap(), None);
        assert!(refresh_key("https://dev.kubuno.com/", "u-1").starts_with("kubuno.refresh.https://dev.kubuno.com."));
    }
}
