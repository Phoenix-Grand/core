//! Remote-mount service - connector cache + config encryption.
//! The key derives from the shared internal_secret (SAME derivation as the former
//! drive module → migrated configs stay decryptable without a re-seal).

use std::collections::HashMap;
use std::sync::Arc;

use kubuno_db::{params, DbPool};
use tokio::sync::RwLock;
use uuid::Uuid;

use super::{build_connector, ConnectorConfig, RemoteConnector, RemoteError};

/// Domain-separating label for the remote-mount config key (HKDF `info`).
/// Versioned so a future derivation change can coexist with this one.
const HKDF_INFO_CONFIG: &[u8] = b"kubuno:v1:core:remote-mount-config-aes256";

pub struct RemoteMountService {
    db:    DbPool,
    /// Current key: HKDF-SHA256 (RFC 5869) of the internal secret. Used for every
    /// new seal, and tried first when opening.
    key:   [u8; 32],
    /// Legacy key: the former `SHA-256(secret ‖ "remotes_config_key")`. Kept for
    /// reads only, so configs sealed before the HKDF switch stay decryptable
    /// without a re-seal (AEAD authentication makes the trial unambiguous).
    key_legacy: [u8; 32],
    cache: RwLock<HashMap<Uuid, Arc<dyn RemoteConnector>>>,
}

impl RemoteMountService {
    pub fn new(db: DbPool, internal_secret: &str) -> Self {
        use hkdf::Hkdf;
        use sha2::{Digest, Sha256};

        // Current derivation: HKDF-SHA256 with a domain-separating `info`.
        // Replaces the ad-hoc `SHA-256(secret ‖ label)`, which had no clean
        // domain separation and shared its shape with other secret uses.
        let hk = Hkdf::<Sha256>::new(None, internal_secret.as_bytes());
        let mut key = [0u8; 32];
        // `expand` only errors when the output length exceeds 255×HashLen; 32 is
        // always valid, so this branch is unreachable. Stay total, no unwrap.
        if hk.expand(HKDF_INFO_CONFIG, &mut key).is_err() {
            key = [0u8; 32];
        }

        // Legacy derivation, preserved for backward-compatible reads.
        let mut hasher = Sha256::new();
        hasher.update(internal_secret.as_bytes());
        hasher.update(b"remotes_config_key");
        let key_legacy: [u8; 32] = hasher.finalize().into();

        Self { db, key, key_legacy, cache: RwLock::new(HashMap::new()) }
    }

    pub fn db(&self) -> &DbPool { &self.db }

    /// Seal a config with AES-256-GCM (96-bit random nonce, `nonce ‖ ciphertext`).
    /// Returns an error rather than an empty blob on failure: a silent
    /// `unwrap_or_default()` here used to store un-decryptable "ciphertext" that
    /// only surfaced on the next browse.
    pub fn encrypt_config(&self, config: &serde_json::Value) -> Result<Vec<u8>, RemoteError> {
        use aes_gcm::{aead::{generic_array::GenericArray, rand_core::RngCore, Aead, OsRng}, Aes256Gcm, KeyInit};
        let cipher = Aes256Gcm::new(GenericArray::from_slice(&self.key));
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = GenericArray::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, config.to_string().as_bytes())
            .map_err(|_| RemoteError::ConfigSealFailed)?;
        let mut result = nonce_bytes.to_vec();
        result.extend(ciphertext);
        Ok(result)
    }

    pub fn decrypt_config(&self, data: &[u8]) -> Option<serde_json::Value> {
        use aes_gcm::{aead::{generic_array::GenericArray, Aead}, Aes256Gcm, KeyInit};
        if data.len() < 12 { return None; }
        let (nonce_bytes, ct) = data.split_at(12);
        let nonce = GenericArray::from_slice(nonce_bytes);
        // Try the current (HKDF) key, then the legacy key. A wrong key fails the
        // GCM tag, so trial decryption is unambiguous.
        for key in [&self.key, &self.key_legacy] {
            let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
            if let Ok(bytes) = cipher.decrypt(nonce, ct) {
                if let Ok(v) = serde_json::from_slice(&bytes) {
                    return Some(v);
                }
            }
        }
        None
    }

    /// Builds a connector from a provider + a plaintext config.
    pub fn connector_from(&self, provider: &str, config: &serde_json::Value) -> Result<Arc<dyn RemoteConnector>, RemoteError> {
        let cfg: ConnectorConfig = serde_json::from_value(config.clone())
            .map_err(|e| RemoteError::Auth(format!("config invalide: {e}")))?;
        build_connector(provider, &cfg)
    }

    /// Loads (and caches) the connector of an owned mount.
    pub async fn get_connector(&self, id: Uuid, owner: Uuid) -> Result<Arc<dyn RemoteConnector>, RemoteError> {
        if let Some(c) = self.cache.read().await.get(&id) { return Ok(c.clone()); }
        let row = self.db
            .fetch_optional_as::<(String, Vec<u8>)>(
                "SELECT provider, config_enc FROM core.remote_mounts WHERE id = $1 AND owner_id = $2",
                params![id, owner],
            )
            .await
            .map_err(|e| RemoteError::Provider(e.to_string()))?
            .ok_or_else(|| RemoteError::NotFound(format!("Mount {id}")))?;

        let config = self.decrypt_config(&row.1)
            .ok_or(RemoteError::ConfigUnreadable)?;
        let conn = self.connector_from(&row.0, &config)?;
        self.cache.write().await.insert(id, conn.clone());
        Ok(conn)
    }

    pub async fn invalidate(&self, id: Uuid) {
        self.cache.write().await.remove(&id);
    }
}
