//! Connecteur NFS via `libnfs-utils` (nfs-ls / nfs-cp / nfs-stat) - userspace,
//! pas de mount privilégié. URL : `nfs://<host>/<export>/<chemin>`.
//!
//! Limites de libnfs-utils : pas d'outil CLI pour mkdir/rm/mv → les opérations
//! structurelles (création de dossier, suppression, renommage) ne sont pas
//! supportées par ce connecteur. Lecture/écriture de fichiers et navigation OK.

use async_trait::async_trait;
use bytes::Bytes;
use futures::Stream;
use std::pin::Pin;

use super::connector::{
    ByteStream, ConnectorConfig, RemoteConnector, RemoteEntry, RemoteEntryType, RemoteError, RemoteQuota,
};

pub struct NfsConnector {
    host:      String,
    export:    String, // ex: "/srv/partage" (commence par '/')
    base_path: String,
}

/// Extrait une taille (best-effort) de la sortie `nfs-stat` : 1er nombre qui suit
/// le mot « size ». Renvoie None si le format ne correspond pas (sans casse).
fn parse_nfs_size(txt: &str) -> Option<u64> {
    let low = txt.to_lowercase();
    let idx = low.find("size")? + 4;
    let num: String = txt[idx..].chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    num.parse::<u64>().ok()
}

impl NfsConnector {
    pub fn new(config: &ConnectorConfig) -> Result<Self, RemoteError> {
        let host = config.host.clone()
            .ok_or_else(|| RemoteError::Auth("Hôte NFS manquant".into()))?;
        let export = config.export_path.clone()
            .ok_or_else(|| RemoteError::Auth("Export NFS manquant (ex: /srv/partage)".into()))?;
        Ok(Self {
            host,
            export: format!("/{}", export.trim_matches('/')),
            base_path: config.base_path.clone().unwrap_or_default(),
        })
    }

    /// Construit l'URL `nfs://host/export[/base][/path]`.
    fn url(&self, path: &str) -> String {
        let base = self.base_path.trim_matches('/');
        let rel  = path.trim_start_matches('/');
        let mut p = self.export.trim_end_matches('/').to_string();
        if !base.is_empty() { p.push('/'); p.push_str(base); }
        if !rel.is_empty()  { p.push('/'); p.push_str(rel); }
        format!("nfs://{}{}", self.host, p)
    }

    async fn run(prog: &str, args: &[&str]) -> Result<std::process::Output, RemoteError> {
        tokio::process::Command::new(prog)
            .args(args)
            .output()
            .await
            .map_err(RemoteError::Io)
    }
}

#[async_trait]
impl RemoteConnector for NfsConnector {
    fn provider_name(&self) -> &'static str { "nfs" }

    async fn connect(&self) -> Result<Option<RemoteQuota>, RemoteError> {
        let out = Self::run("nfs-ls", &[&self.url("")]).await?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(RemoteError::Auth(format!("NFS: {err}")));
        }
        Ok(None)
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>, RemoteError> {
        let url = self.url(path);
        let out = Self::run("nfs-ls", &[&url]).await?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(RemoteError::NotFound(format!("NFS: {err}")));
        }
        let listing = String::from_utf8_lossy(&out.stdout);
        let mut entries = Vec::new();
        for line in listing.lines() {
            let name = line.trim().trim_end_matches('/').to_string();
            if name.is_empty() || name == "." || name == ".." { continue; }
            let child_path = if path.is_empty() { name.clone() } else { format!("{}/{}", path.trim_end_matches('/'), name) };
            // Type + taille via nfs-stat (best-effort : par défaut fichier).
            let (is_dir, size) = match Self::run("nfs-stat", &[&self.url(&child_path)]).await {
                Ok(o) => {
                    let txt = String::from_utf8_lossy(&o.stdout);
                    (txt.to_lowercase().contains("directory") || line.trim().ends_with('/'), parse_nfs_size(&txt))
                }
                Err(_) => (line.trim().ends_with('/'), None),
            };
            entries.push(RemoteEntry {
                name,
                path: child_path,
                entry_type: if is_dir { RemoteEntryType::Directory } else { RemoteEntryType::File },
                size_bytes: if is_dir { None } else { size }, modified_at: None, mime_type: None, remote_id: None, etag: None,
            });
        }
        Ok(entries)
    }

    async fn stat(&self, path: &str) -> Result<RemoteEntry, RemoteError> {
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        let out = Self::run("nfs-stat", &[&self.url(path)]).await?;
        let txt = String::from_utf8_lossy(&out.stdout);
        let is_dir = txt.to_lowercase().contains("directory");
        Ok(RemoteEntry {
            name, path: path.to_string(),
            entry_type: if is_dir { RemoteEntryType::Directory } else { RemoteEntryType::File },
            size_bytes: if is_dir { None } else { parse_nfs_size(&txt) }, modified_at: None, mime_type: None, remote_id: None, etag: None,
        })
    }

    async fn get_file(&self, path: &str) -> Result<ByteStream, RemoteError> {
        let tmp = format!("/tmp/kubuno_nfs_{}", uuid::Uuid::new_v4());
        let out = Self::run("nfs-cp", &[&self.url(path), &tmp]).await?;
        if !out.status.success() {
            return Err(RemoteError::NotFound(format!("NFS: {}", String::from_utf8_lossy(&out.stderr))));
        }
        let file = tokio::fs::File::open(&tmp).await.map_err(RemoteError::Io)?;
        use tokio_util::io::ReaderStream;
        use futures::StreamExt;
        let stream = ReaderStream::new(file);
        let mapped: ByteStream = Box::pin(stream.map(|r| r.map_err(RemoteError::Io)));
        Ok(mapped)
    }

    async fn put_file(
        &self,
        path: &str,
        mut stream: Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>,
        _size_hint: Option<u64>,
    ) -> Result<RemoteEntry, RemoteError> {
        use futures::StreamExt;
        use tokio::io::AsyncWriteExt;
        let tmp = format!("/tmp/kubuno_nfs_{}", uuid::Uuid::new_v4());
        {
            let mut f = tokio::fs::File::create(&tmp).await.map_err(RemoteError::Io)?;
            while let Some(chunk) = stream.next().await {
                f.write_all(&chunk.map_err(RemoteError::Io)?).await.map_err(RemoteError::Io)?;
            }
        }
        let out = Self::run("nfs-cp", &[&tmp, &self.url(path)]).await;
        let _ = tokio::fs::remove_file(&tmp).await;
        out?;
        self.stat(path).await
    }

    async fn create_dir(&self, _path: &str) -> Result<(), RemoteError> {
        Err(RemoteError::Unsupported("Création de dossier non supportée sur NFS (libnfs-utils)".into()))
    }

    async fn delete(&self, _path: &str) -> Result<(), RemoteError> {
        Err(RemoteError::Unsupported("Suppression non supportée sur NFS (libnfs-utils)".into()))
    }

    async fn rename(&self, _from: &str, _to: &str) -> Result<(), RemoteError> {
        Err(RemoteError::Unsupported("Renommage non supporté sur NFS (libnfs-utils)".into()))
    }
}
