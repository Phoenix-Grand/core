use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use thiserror::Error;

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, RemoteError>> + Send>>;

#[derive(Debug, Clone, PartialEq)]
pub enum RemoteEntryType {
    File,
    Directory,
}

#[derive(Debug, Clone)]
pub struct RemoteEntry {
    pub name:        String,
    pub path:        String,
    pub entry_type:  RemoteEntryType,
    pub size_bytes:  Option<u64>,
    pub modified_at: Option<DateTime<Utc>>,
    pub mime_type:   Option<String>,
    pub remote_id:   Option<String>,
    pub etag:        Option<String>,
}

impl RemoteEntry {
    pub fn is_dir(&self) -> bool {
        self.entry_type == RemoteEntryType::Directory
    }
}

#[derive(Debug, Error)]
pub enum RemoteError {
    /// The mount's stored config could not be decrypted. Its key derives from
    /// `server.internal_secret`, which is therefore the only way back: once that
    /// secret is rotated, every config sealed with the previous one is lost for
    /// good. Kept apart from [`RemoteError::Auth`] on purpose - nothing was sent
    /// to the remote here, and the only way forward is to reconnect the mount.
    #[error("Identifiants du montage illisibles")]
    ConfigUnreadable,

    /// The config could not be sealed (AES-GCM encryption failed). Distinct from
    /// [`RemoteError::ConfigUnreadable`]: nothing was stored, so the caller must
    /// not persist a row that would be unreadable forever.
    #[error("Chiffrement de la configuration échoué")]
    ConfigSealFailed,

    #[error("Authentification échouée: {0}")]
    Auth(String),

    #[error("Ressource introuvable: {0}")]
    NotFound(String),

    #[error("Accès refusé: {0}")]
    Forbidden(String),

    #[error("Erreur réseau: {0}")]
    Network(String),

    #[error("Erreur du provider: {0}")]
    Provider(String),

    #[error("Opération non supportée: {0}")]
    Unsupported(String),

    #[error("Quota dépassé")]
    QuotaExceeded,

    #[error("Erreur d'E/S: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteQuota {
    pub total_bytes: Option<u64>,
    pub used_bytes:  Option<u64>,
    pub free_bytes:  Option<u64>,
}

/// Hard cap on the number of pages a single directory listing will fetch.
/// Guards against a provider that keeps handing back a next-page cursor forever:
/// once reached, the listing stops and the caller logs a truncation warning
/// rather than looping indefinitely.
pub(crate) const MAX_LIST_PAGES: u32 = 100;

/// Decision produced by [`next_page_step`] for a paginated directory listing.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PageStep {
    /// Fetch the next page using this cursor/token.
    Next(String),
    /// The provider reported no further pages - the listing is complete.
    Done,
    /// The provider still advertises more pages but we must stop: either the
    /// hard page cap was reached or no cursor was supplied to fetch them. The
    /// caller must warn that the listing is truncated instead of pretending it
    /// is complete.
    Truncated,
}

/// Shared pagination guard for remote directory listings.
///
/// - `has_more`   = the provider still advertises further pages.
/// - `cursor`     = the token needed to fetch them (`None` ⇒ nothing to fetch).
/// - `pages_done` = pages already accumulated in this listing.
/// - `max_pages`  = hard bound (see [`MAX_LIST_PAGES`]).
///
/// Pure and network-free so the accumulation loop can be unit-tested.
pub(crate) fn next_page_step(
    has_more: bool,
    cursor: Option<String>,
    pages_done: u32,
    max_pages: u32,
) -> PageStep {
    if !has_more {
        return PageStep::Done;
    }
    match cursor {
        Some(tok) if pages_done < max_pages => PageStep::Next(tok),
        // Either the cap is hit or the provider gave no cursor: truncate.
        _ => PageStep::Truncated,
    }
}

/// Config universelle pour tous les providers.
/// Chaque provider utilise les champs dont il a besoin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorConfig {
    // WebDAV / Nextcloud / ownCloud
    pub url:           Option<String>,
    pub username:      Option<String>,
    pub password:      Option<String>,
    // SFTP
    pub host:          Option<String>,
    pub port:          Option<u16>,
    pub private_key:   Option<String>,   // PEM string
    pub known_hosts:   Option<String>,
    // OAuth (Google Drive, Dropbox)
    pub access_token:  Option<String>,
    pub refresh_token: Option<String>,
    pub client_id:     Option<String>,
    pub client_secret: Option<String>,
    pub token_expiry:  Option<DateTime<Utc>>,
    // SMB
    pub share_name:    Option<String>,
    pub domain:        Option<String>,
    // NFS
    pub export_path:   Option<String>,
    pub mount_options: Option<String>,
    // S3-compatible
    pub bucket:        Option<String>,
    pub region:        Option<String>,
    pub endpoint:      Option<String>,
    pub access_key:    Option<String>,
    pub secret_key:    Option<String>,
    // Chemin de base sur le remote (ex: "/Documents" pour ne monter qu'un sous-répertoire)
    pub base_path:     Option<String>,
}

impl ConnectorConfig {
    pub fn base_path(&self) -> &str {
        self.base_path.as_deref().unwrap_or("/")
    }
}

#[async_trait]
pub trait RemoteConnector: Send + Sync {
    fn provider_name(&self) -> &'static str;

    /// Teste la connexion et renvoie les infos de quota si disponibles.
    async fn connect(&self) -> Result<Option<RemoteQuota>, RemoteError>;

    /// Liste le contenu d'un répertoire (chemin relatif à base_path).
    async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>, RemoteError>;

    /// Récupère les métadonnées d'un fichier/dossier.
    async fn stat(&self, path: &str) -> Result<RemoteEntry, RemoteError>;

    /// Télécharge un fichier et renvoie un stream d'octets.
    async fn get_file(&self, path: &str) -> Result<ByteStream, RemoteError>;

    /// Upload un fichier (stream → remote).
    async fn put_file(
        &self,
        path: &str,
        stream: Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>,
        size_hint: Option<u64>,
    ) -> Result<RemoteEntry, RemoteError>;

    /// Crée un répertoire (récursivement si nécessaire).
    async fn create_dir(&self, path: &str) -> Result<(), RemoteError>;

    /// Supprime un fichier ou un répertoire vide.
    async fn delete(&self, path: &str) -> Result<(), RemoteError>;

    /// Supprime récursivement un répertoire et son contenu.
    async fn delete_recursive(&self, path: &str) -> Result<(), RemoteError> {
        let entries = self.list_dir(path).await?;
        for entry in entries {
            if entry.is_dir() {
                Box::pin(self.delete_recursive(&entry.path)).await?;
            } else {
                self.delete(&entry.path).await?;
            }
        }
        self.delete(path).await
    }

    /// Renomme ou déplace un fichier/dossier.
    async fn rename(&self, from: &str, to: &str) -> Result<(), RemoteError>;

    /// Copie un fichier (peut ne pas être supporté par tous les providers).
    async fn copy_file(&self, from: &str, to: &str) -> Result<RemoteEntry, RemoteError> {
        let _ = (from, to);
        Err(RemoteError::Unsupported("copy non supportée par ce provider".into()))
    }

    /// Génère une URL temporaire de téléchargement (presigned URL).
    /// Renvoie None si le provider ne supporte pas cette fonctionnalité.
    async fn presign_get(&self, _path: &str, _ttl_secs: u64) -> Option<String> {
        None
    }

    /// Renvoie true si la connexion est encore valide (sans requête réseau).
    fn is_token_valid(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_more_pages_is_done() {
        // Provider reports no further pages: listing is complete.
        assert_eq!(next_page_step(false, None, 0, MAX_LIST_PAGES), PageStep::Done);
        assert_eq!(
            next_page_step(false, Some("ignored".into()), 3, MAX_LIST_PAGES),
            PageStep::Done
        );
    }

    #[test]
    fn more_pages_within_cap_yields_next_cursor() {
        assert_eq!(
            next_page_step(true, Some("cursor-42".into()), 0, MAX_LIST_PAGES),
            PageStep::Next("cursor-42".into())
        );
        // One page below the cap must still continue.
        assert_eq!(
            next_page_step(true, Some("tok".into()), MAX_LIST_PAGES - 1, MAX_LIST_PAGES),
            PageStep::Next("tok".into())
        );
    }

    #[test]
    fn hard_cap_truncates_even_with_cursor() {
        // Cursor present but the cap is reached: stop and signal truncation.
        assert_eq!(
            next_page_step(true, Some("still-more".into()), MAX_LIST_PAGES, MAX_LIST_PAGES),
            PageStep::Truncated
        );
        assert_eq!(
            next_page_step(true, Some("still-more".into()), MAX_LIST_PAGES + 5, MAX_LIST_PAGES),
            PageStep::Truncated
        );
    }

    #[test]
    fn more_pages_but_missing_cursor_truncates() {
        // Provider claims more pages yet supplies no cursor to fetch them.
        assert_eq!(next_page_step(true, None, 0, MAX_LIST_PAGES), PageStep::Truncated);
    }

    #[test]
    fn accumulation_loop_stops_and_bounds() {
        // Simulate the accumulation loop against a fake provider that returns
        // `total_pages` pages, each advertising a next cursor until the last.
        fn run(total_pages: u32, max_pages: u32) -> (u32, bool) {
            let mut pages = 0u32;
            let mut truncated = false;
            loop {
                // A page was just fetched and accumulated.
                pages += 1;
                let has_more = pages < total_pages;
                let cursor = has_more.then(|| format!("cursor-{pages}"));
                match next_page_step(has_more, cursor, pages, max_pages) {
                    PageStep::Next(_) => continue,
                    PageStep::Done => break,
                    PageStep::Truncated => {
                        truncated = true;
                        break;
                    }
                }
            }
            (pages, truncated)
        }

        // Fits under the cap: reads every page, no truncation.
        assert_eq!(run(3, 100), (3, false));
        // Single page: stops immediately.
        assert_eq!(run(1, 100), (1, false));
        // Provider has more pages than the cap allows: bounded + truncated.
        assert_eq!(run(500, 10), (10, true));
    }
}
