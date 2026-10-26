use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures::Stream;
use reqwest::Client;
use serde::Deserialize;
use std::pin::Pin;

use super::connector::{
    next_page_step, ByteStream, ConnectorConfig, PageStep, RemoteConnector, RemoteEntry,
    RemoteEntryType, RemoteError, RemoteQuota, MAX_LIST_PAGES,
};

const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct DriveFile {
    id:               String,
    name:             String,
    #[serde(rename = "mimeType")]
    mime_type:        String,
    size:             Option<String>,
    #[serde(rename = "modifiedTime")]
    modified_time:    Option<String>,
    // Parsed to document the payload; not used by any read path yet.
    #[serde(rename = "parents")]
    parents:          Option<Vec<String>>,
    #[serde(rename = "webContentLink")]
    web_content_link: Option<String>,
}

/// One page of a `files.list` response. `next_page_token`, when present, is the
/// `pageToken` to pass on the next request to fetch the following page; `list_dir`
/// loops on it (bounded by [`MAX_LIST_PAGES`]) so a folder larger than one API
/// page is returned in full.
#[derive(Debug, Deserialize)]
struct DriveList {
    files:             Option<Vec<DriveFile>>,
    #[serde(rename = "nextPageToken")]
    next_page_token:   Option<String>,
}

#[derive(Debug, Deserialize)]
struct DriveAbout {
    #[serde(rename = "storageQuota")]
    storage_quota: Option<DriveStorageQuota>,
}

#[derive(Debug, Deserialize)]
struct DriveStorageQuota {
    limit:   Option<String>,
    usage:   Option<String>,
}

pub struct GDriveConnector {
    client:       Client,
    access_token: String,
    base_path:    String, // treated as a folder ID or path root
}

impl GDriveConnector {
    pub fn new(config: &ConnectorConfig) -> Result<Self, RemoteError> {
        let access_token = config.access_token.clone()
            .ok_or_else(|| RemoteError::Auth("Token Google Drive manquant".into()))?;

        let client = Client::builder()
            .user_agent("Kubuno/1.0")
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        Ok(Self {
            client,
            access_token,
            base_path: config.base_path.clone().unwrap_or_else(|| "root".into()),
        })
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.access_token)
    }

    fn entry_from_file(&self, f: DriveFile, parent_path: &str) -> RemoteEntry {
        let is_dir = f.mime_type == "application/vnd.google-apps.folder";
        let size   = f.size.as_deref().and_then(|s| s.parse::<u64>().ok());
        let mtime  = f.modified_time.as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc));

        let rel_path = if parent_path.is_empty() || parent_path == "root" {
            f.name.clone()
        } else {
            format!("{parent_path}/{}", f.name)
        };

        RemoteEntry {
            name: f.name,
            path: rel_path,
            entry_type: if is_dir { RemoteEntryType::Directory } else { RemoteEntryType::File },
            size_bytes: size,
            modified_at: mtime,
            mime_type: if is_dir { None } else { Some(f.mime_type) },
            remote_id: Some(f.id),
            etag: None,
        }
    }

    // Resolve a virtual path to a Google Drive file/folder ID
    async fn resolve_path(&self, path: &str) -> Result<String, RemoteError> {
        if path.is_empty() || path == "/" {
            return Ok(self.base_path.clone());
        }

        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        let mut current_id = self.base_path.clone();

        for segment in segments {
            let query = format!(
                "name = '{}' and '{}' in parents and trashed = false",
                segment.replace('\'', "\\'"), current_id
            );
            let resp = self.client
                .get(format!("{DRIVE_API}/files"))
                .header("Authorization", self.auth_header())
                .query(&[("q", &query), ("fields", &"files(id,name,mimeType)".to_string())])
                .send()
                .await
                .map_err(|e| RemoteError::Network(e.to_string()))?;

            if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
                return Err(RemoteError::Auth("Google Drive token expired".into()));
            }

            let list: DriveList = resp.json().await
                .map_err(|e| RemoteError::Provider(e.to_string()))?;

            let file = list.files
                .and_then(|f| f.into_iter().next())
                .ok_or_else(|| RemoteError::NotFound(format!("{path} introuvable sur Drive")))?;

            current_id = file.id;
        }
        Ok(current_id)
    }
}

#[async_trait]
impl RemoteConnector for GDriveConnector {
    fn provider_name(&self) -> &'static str { "gdrive" }

    async fn connect(&self) -> Result<Option<RemoteQuota>, RemoteError> {
        let resp = self.client
            .get(format!("{DRIVE_API}/about"))
            .header("Authorization", self.auth_header())
            .query(&[("fields", "storageQuota")])
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(RemoteError::Auth("Token Google Drive invalide".into()));
        }

        let about: DriveAbout = resp.json().await
            .map_err(|e| RemoteError::Provider(e.to_string()))?;

        if let Some(quota) = about.storage_quota {
            let total = quota.limit.as_deref().and_then(|s| s.parse::<u64>().ok());
            let used  = quota.usage.as_deref().and_then(|s| s.parse::<u64>().ok());
            return Ok(Some(RemoteQuota {
                total_bytes: total,
                used_bytes:  used,
                free_bytes:  total.zip(used).map(|(t, u)| t.saturating_sub(u)),
            }));
        }
        Ok(None)
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>, RemoteError> {
        let folder_id = self.resolve_path(path).await?;
        let query = format!("'{}' in parents and trashed = false", folder_id);

        let mut entries = Vec::new();
        let mut page_token: Option<String> = None;
        let mut pages: u32 = 0;

        loop {
            // `pageToken` is added only from the second page onwards; it carries
            // the cursor Drive returned as `nextPageToken` on the previous page.
            let mut params: Vec<(&str, &str)> = vec![
                ("q", query.as_str()),
                ("fields", "files(id,name,mimeType,size,modifiedTime,parents),nextPageToken"),
                ("pageSize", "1000"),
            ];
            if let Some(tok) = page_token.as_deref() {
                params.push(("pageToken", tok));
            }

            let resp = self.client
                .get(format!("{DRIVE_API}/files"))
                .header("Authorization", self.auth_header())
                .query(&params)
                .send()
                .await
                .map_err(|e| RemoteError::Network(e.to_string()))?;

            if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
                return Err(RemoteError::Auth("Google Drive token expired".into()));
            }

            let list: DriveList = resp.json().await
                .map_err(|e| RemoteError::Provider(e.to_string()))?;

            if let Some(files) = list.files {
                entries.extend(files.into_iter().map(|f| self.entry_from_file(f, path)));
            }
            pages += 1;

            let has_more = list.next_page_token.is_some();
            match next_page_step(has_more, list.next_page_token, pages, MAX_LIST_PAGES) {
                PageStep::Next(tok) => page_token = Some(tok),
                PageStep::Done => break,
                PageStep::Truncated => {
                    // Never lie by silence: the folder holds more than the cap.
                    // `path` carries no credentials, unlike the request URL.
                    tracing::warn!(
                        path = %path,
                        pages,
                        "Listing Google Drive tronqué (plafond de pages atteint) : des entrées sont omises"
                    );
                    break;
                }
            }
        }

        Ok(entries)
    }

    async fn stat(&self, path: &str) -> Result<RemoteEntry, RemoteError> {
        let file_id = self.resolve_path(path).await?;
        let resp = self.client
            .get(format!("{DRIVE_API}/files/{file_id}"))
            .header("Authorization", self.auth_header())
            .query(&[("fields", "id,name,mimeType,size,modifiedTime,parents")])
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        let file: DriveFile = resp.json().await
            .map_err(|e| RemoteError::Provider(e.to_string()))?;

        let parent = path.rsplit_once('/').map(|x| x.0).unwrap_or("");
        Ok(self.entry_from_file(file, parent))
    }

    async fn get_file(&self, path: &str) -> Result<ByteStream, RemoteError> {
        let file_id = self.resolve_path(path).await?;
        let resp = self.client
            .get(format!("{DRIVE_API}/files/{file_id}"))
            .header("Authorization", self.auth_header())
            .query(&[("alt", "media")])
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(RemoteError::Provider(format!("Drive download: {}", resp.status())));
        }

        use futures::StreamExt;
        let stream = resp.bytes_stream();
        let mapped: ByteStream = Box::pin(stream.map(|r| r.map_err(|e| RemoteError::Network(e.to_string()))));
        Ok(mapped)
    }

    async fn put_file(
        &self,
        path: &str,
        mut stream: Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>,
        _size_hint: Option<u64>,
    ) -> Result<RemoteEntry, RemoteError> {
        use futures::StreamExt;

        let name   = path.rsplit('/').next().unwrap_or(path).to_string();
        let parent = path.rsplit_once('/').map(|x| x.0).unwrap_or("");
        let parent_id = self.resolve_path(parent).await?;

        // Collect data
        let mut data = Vec::new();
        while let Some(chunk) = stream.next().await {
            data.extend_from_slice(&chunk.map_err(RemoteError::Io)?);
        }

        // Multipart upload
        let metadata = serde_json::json!({ "name": name, "parents": [parent_id] });
        let resp = self.client
            .post(format!("{DRIVE_UPLOAD}/files?uploadType=multipart"))
            .header("Authorization", self.auth_header())
            .multipart(
                reqwest::multipart::Form::new()
                    .part("metadata", reqwest::multipart::Part::text(metadata.to_string())
                        .mime_str("application/json").unwrap())
                    .part("file", reqwest::multipart::Part::bytes(data))
            )
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(RemoteError::Provider(format!("Drive upload: {}", resp.status())));
        }

        self.stat(path).await
    }

    async fn create_dir(&self, path: &str) -> Result<(), RemoteError> {
        let name   = path.rsplit('/').next().unwrap_or(path).to_string();
        let parent = path.rsplit_once('/').map(|x| x.0).unwrap_or("");
        let parent_id = self.resolve_path(parent).await?;

        let body = serde_json::json!({
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
        });

        let resp = self.client
            .post(format!("{DRIVE_API}/files"))
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        if resp.status().is_success() { Ok(()) } else {
            Err(RemoteError::Provider(format!("Drive mkdir: {}", resp.status())))
        }
    }

    async fn delete(&self, path: &str) -> Result<(), RemoteError> {
        let file_id = self.resolve_path(path).await?;
        let resp = self.client
            .delete(format!("{DRIVE_API}/files/{file_id}"))
            .header("Authorization", self.auth_header())
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        if resp.status().is_success() || resp.status() == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(RemoteError::Provider(format!("Drive delete: {}", resp.status())))
        }
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), RemoteError> {
        let file_id   = self.resolve_path(from).await?;
        let new_name  = to.rsplit('/').next().unwrap_or(to);
        let from_dir  = from.rsplit_once('/').map(|x| x.0).unwrap_or("");
        let to_dir    = to.rsplit_once('/').map(|x| x.0).unwrap_or("");

        let mut req = self.client
            .patch(format!("{DRIVE_API}/files/{file_id}"))
            .header("Authorization", self.auth_header())
            .json(&serde_json::json!({ "name": new_name }));

        // Déplacement entre dossiers : sur Drive, un fichier appartient à un
        // `parent` → on retire l'ancien et on ajoute le nouveau (addParents/
        // removeParents). Indispensable pour que « Déplacer » fonctionne.
        if from_dir != to_dir {
            let old_parent = self.resolve_path(from_dir).await?;
            let new_parent = self.resolve_path(to_dir).await?;
            req = req.query(&[("addParents", new_parent.as_str()), ("removeParents", old_parent.as_str())]);
        }

        let resp = req.send().await.map_err(|e| RemoteError::Network(e.to_string()))?;
        if resp.status().is_success() { Ok(()) } else {
            Err(RemoteError::Provider(format!("Drive rename: {}", resp.status())))
        }
    }
}
