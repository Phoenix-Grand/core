use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures::Stream;
use reqwest::{Client, StatusCode};
use std::pin::Pin;

use super::connector::{
    ByteStream, ConnectorConfig, RemoteConnector, RemoteEntry, RemoteEntryType, RemoteError,
    RemoteQuota,
};

pub struct WebDavConnector {
    client:    Client,
    base_url:  String,
    username:  String,
    password:  String,
    base_path: String,
}

impl WebDavConnector {
    pub fn new(config: &ConnectorConfig) -> Result<Self, RemoteError> {
        let url = config.url.as_deref()
            .ok_or_else(|| RemoteError::Auth("URL manquante".into()))?
            .trim_end_matches('/')
            .to_string();
        let username = config.username.clone().unwrap_or_default();
        let password = config.password.clone().unwrap_or_default();
        let base_path = config.base_path.clone().unwrap_or_else(|| "/".into());

        let client = Client::builder()
            .user_agent("Kubuno/1.0")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        Ok(Self { client, base_url: url, username, password, base_path })
    }

    fn full_url(&self, path: &str) -> String {
        let base = self.base_path.trim_end_matches('/');
        let rel  = path.trim_start_matches('/');
        if rel.is_empty() {
            format!("{}{}/", self.base_url, base)
        } else {
            format!("{}{}/{}", self.base_url, base, rel)
        }
    }

    async fn propfind(&self, path: &str, depth: &str) -> Result<String, RemoteError> {
        let url = self.full_url(path);
        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:getetag/>
  </d:prop>
</d:propfind>"#;

        let resp = self.client.request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
            .basic_auth(&self.username, Some(&self.password))
            .header("Depth", depth)
            .header("Content-Type", "application/xml")
            .body(body)
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        match resp.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err(RemoteError::Auth("Identifiants WebDAV invalides".into()));
            }
            StatusCode::NOT_FOUND => {
                return Err(RemoteError::NotFound(format!("Chemin {path} introuvable")));
            }
            s if !s.is_success() && s.as_u16() != 207 => {
                return Err(RemoteError::Provider(format!("PROPFIND a retourné {s}")));
            }
            _ => {}
        }

        resp.text().await.map_err(|e| RemoteError::Network(e.to_string()))
    }

    fn parse_propfind(&self, xml: &str, parent_path: &str) -> Vec<RemoteEntry> {
        let mut entries = Vec::new();
        // Simple XML parsing without pulling in a full XML crate.
        // Extract <d:response> blocks and parse key properties.
        for response_block in xml.split("<d:response>").skip(1) {
            let href = extract_xml_text(response_block, "d:href")
                .or_else(|| extract_xml_text(response_block, "href"))
                .unwrap_or_default();

            // Decode percent-encoded path
            let decoded_href = percent_decode(&href);
            let name = decoded_href.trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&decoded_href)
                .to_string();

            if name.is_empty() { continue; }

            let is_collection = response_block.contains("<d:collection/>")
                || response_block.contains("<d:collection />");

            let size_bytes = extract_xml_text(response_block, "d:getcontentlength")
                .or_else(|| extract_xml_text(response_block, "getcontentlength"))
                .and_then(|s| s.parse::<u64>().ok());

            let modified_at = extract_xml_text(response_block, "d:getlastmodified")
                .or_else(|| extract_xml_text(response_block, "getlastmodified"))
                .and_then(|s| parse_http_date(&s));

            let mime_type = if is_collection {
                None
            } else {
                extract_xml_text(response_block, "d:getcontenttype")
                    .or_else(|| extract_xml_text(response_block, "getcontenttype"))
            };

            let etag = extract_xml_text(response_block, "d:getetag")
                .or_else(|| extract_xml_text(response_block, "getetag"));

            // Chemin relatif au montage : le href du serveur contient le chemin
            // COMPLET de l'endpoint WebDAV (ex. /remote.php/dav/files/<user>/…).
            // On retire ce préfixe = (chemin de base_url) + base_path, sinon le
            // self-entry de la collection fuite en faux dossier et les chemins des
            // enfants sont pollués (navigation cassée).
            let bp = self.base_path.trim_end_matches('/');
            let endpoint = format!(
                "{}{}",
                url_path(&self.base_url).trim_end_matches('/'),
                if bp.is_empty() { "" } else { bp },
            );
            let href_path = url_path(&decoded_href);
            let rel = href_path
                .strip_prefix(&endpoint)
                .unwrap_or(href_path)
                .trim_matches('/')
                .to_string();

            // Skip the parent itself
            let clean_parent = parent_path.trim_matches('/');
            if rel == clean_parent || rel.is_empty() { continue; }

            entries.push(RemoteEntry {
                name,
                path: rel,
                entry_type: if is_collection { RemoteEntryType::Directory } else { RemoteEntryType::File },
                size_bytes,
                modified_at,
                mime_type,
                remote_id: None,
                etag,
            });
        }
        entries
    }
}

#[async_trait]
impl RemoteConnector for WebDavConnector {
    fn provider_name(&self) -> &'static str { "webdav" }

    async fn connect(&self) -> Result<Option<RemoteQuota>, RemoteError> {
        // Test the connection with a simple PROPFIND on root
        let xml = self.propfind("", "0").await?;
        if xml.contains("d:response") || xml.contains("<response>") {
            return Ok(None); // Connection OK, no quota info from PROPFIND
        }
        // Try Nextcloud quota endpoint
        let quota_xml = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:quota-available-bytes/>
    <d:quota-used-space/>
  </d:prop>
</d:propfind>"#;
        let url = self.full_url("");
        let resp = self.client.request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
            .basic_auth(&self.username, Some(&self.password))
            .header("Depth", "0")
            .header("Content-Type", "application/xml")
            .body(quota_xml)
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        if resp.status().is_success() || resp.status().as_u16() == 207 {
            let body = resp.text().await.unwrap_or_default();
            let free = extract_xml_text(&body, "d:quota-available-bytes")
                .and_then(|s| s.parse::<u64>().ok());
            let used = extract_xml_text(&body, "d:quota-used-space")
                .and_then(|s| s.parse::<u64>().ok());
            return Ok(Some(RemoteQuota {
                total_bytes: free.zip(used).map(|(f, u)| f + u),
                used_bytes:  used,
                free_bytes:  free,
            }));
        }
        Ok(None)
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>, RemoteError> {
        let xml = self.propfind(path, "1").await?;
        Ok(self.parse_propfind(&xml, path))
    }

    async fn stat(&self, path: &str) -> Result<RemoteEntry, RemoteError> {
        let xml = self.propfind(path, "0").await?;
        let mut entries = self.parse_propfind(&xml, "");

        // A `Depth: 0` PROPFIND answers with exactly **one** `<d:response>`: the
        // resource itself. `parse_propfind` drops it when the href ends in a
        // slash and the last segment comes out empty - a collection asked about
        // by a path the server echoes back with a trailing slash. That is the
        // only case this fallback exists for, so it reads the single block
        // directly rather than looping: there is never a second one, and the
        // previous `for … { return }` said "loop" while meaning "take the
        // first", which is also what clippy's `never_loop` was pointing at.
        if entries.is_empty() {
            if let Some(block) = xml.split("<d:response>").nth(1) {
                let href = extract_xml_text(block, "d:href").unwrap_or_default();
                let decoded = percent_decode(&href);
                let name = decoded
                    .trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .to_string();
                let is_collection = block.contains("<d:collection");
                return Ok(RemoteEntry {
                    name,
                    path: path.to_string(),
                    entry_type: if is_collection {
                        RemoteEntryType::Directory
                    } else {
                        RemoteEntryType::File
                    },
                    size_bytes: extract_xml_text(block, "d:getcontentlength")
                        .and_then(|s| s.parse::<u64>().ok()),
                    modified_at: extract_xml_text(block, "d:getlastmodified")
                        .and_then(|s| parse_http_date(&s)),
                    mime_type: None,
                    remote_id: None,
                    etag: extract_xml_text(block, "d:getetag"),
                });
            }
        }
        entries.pop().ok_or_else(|| RemoteError::NotFound(format!("Chemin {path} introuvable")))
    }

    async fn get_file(&self, path: &str) -> Result<ByteStream, RemoteError> {
        let url = self.full_url(path);
        let resp = self.client.get(&url)
            .basic_auth(&self.username, Some(&self.password))
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        match resp.status() {
            StatusCode::UNAUTHORIZED => return Err(RemoteError::Auth("Authentification échouée".into())),
            StatusCode::NOT_FOUND    => return Err(RemoteError::NotFound(format!("{path} introuvable"))),
            s if !s.is_success()    => return Err(RemoteError::Provider(format!("GET a retourné {s}"))),
            _ => {}
        }

        let stream = resp.bytes_stream();
        use futures::StreamExt;
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

        // Collect the stream into bytes (WebDAV PUT requires Content-Length for most servers)
        let mut data = Vec::new();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(RemoteError::Io)?;
            data.extend_from_slice(&bytes);
        }

        let url = self.full_url(path);
        let resp = self.client.put(&url)
            .basic_auth(&self.username, Some(&self.password))
            .body(data)
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        match resp.status() {
            StatusCode::UNAUTHORIZED => return Err(RemoteError::Auth("Authentification échouée".into())),
            StatusCode::FORBIDDEN    => return Err(RemoteError::Forbidden(path.into())),
            StatusCode::INSUFFICIENT_STORAGE => return Err(RemoteError::QuotaExceeded),
            s if !s.is_success() => return Err(RemoteError::Provider(format!("PUT a retourné {s}"))),
            _ => {}
        }

        self.stat(path).await
    }

    async fn create_dir(&self, path: &str) -> Result<(), RemoteError> {
        let url = self.full_url(path);
        let resp = self.client.request(
            reqwest::Method::from_bytes(b"MKCOL").unwrap(),
            &url,
        )
        .basic_auth(&self.username, Some(&self.password))
        .send()
        .await
        .map_err(|e| RemoteError::Network(e.to_string()))?;

        match resp.status() {
            s if s.is_success() || s.as_u16() == 405 => Ok(()), // 405 = already exists
            StatusCode::UNAUTHORIZED => Err(RemoteError::Auth("Authentification échouée".into())),
            StatusCode::FORBIDDEN    => Err(RemoteError::Forbidden(path.into())),
            s                        => Err(RemoteError::Provider(format!("MKCOL a retourné {s}"))),
        }
    }

    async fn delete(&self, path: &str) -> Result<(), RemoteError> {
        let url = self.full_url(path);
        let resp = self.client.delete(&url)
            .basic_auth(&self.username, Some(&self.password))
            .send()
            .await
            .map_err(|e| RemoteError::Network(e.to_string()))?;

        match resp.status() {
            s if s.is_success() || s.as_u16() == 404 => Ok(()),
            StatusCode::UNAUTHORIZED => Err(RemoteError::Auth("Authentification échouée".into())),
            StatusCode::FORBIDDEN    => Err(RemoteError::Forbidden(path.into())),
            s                        => Err(RemoteError::Provider(format!("DELETE a retourné {s}"))),
        }
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), RemoteError> {
        let from_url = self.full_url(from);
        let to_url   = self.full_url(to);

        let resp = self.client.request(
            reqwest::Method::from_bytes(b"MOVE").unwrap(),
            &from_url,
        )
        .basic_auth(&self.username, Some(&self.password))
        .header("Destination", &to_url)
        .header("Overwrite", "T")
        .send()
        .await
        .map_err(|e| RemoteError::Network(e.to_string()))?;

        match resp.status() {
            s if s.is_success() => Ok(()),
            StatusCode::UNAUTHORIZED => Err(RemoteError::Auth("Authentification échouée".into())),
            StatusCode::FORBIDDEN    => Err(RemoteError::Forbidden(from.into())),
            s                        => Err(RemoteError::Provider(format!("MOVE a retourné {s}"))),
        }
    }

    async fn copy_file(&self, from: &str, to: &str) -> Result<RemoteEntry, RemoteError> {
        let from_url = self.full_url(from);
        let to_url   = self.full_url(to);

        let resp = self.client.request(
            reqwest::Method::from_bytes(b"COPY").unwrap(),
            &from_url,
        )
        .basic_auth(&self.username, Some(&self.password))
        .header("Destination", &to_url)
        .header("Overwrite", "T")
        .send()
        .await
        .map_err(|e| RemoteError::Network(e.to_string()))?;

        match resp.status() {
            s if s.is_success() => self.stat(to).await,
            StatusCode::UNAUTHORIZED => Err(RemoteError::Auth("Authentification échouée".into())),
            StatusCode::FORBIDDEN    => Err(RemoteError::Forbidden(from.into())),
            s                        => Err(RemoteError::Provider(format!("COPY a retourné {s}"))),
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Renvoie la partie CHEMIN d'une URL ou d'un href. Si `s` est une URL absolue
/// (`scheme://host/chemin`), retire le scheme+host ; sinon renvoie `s` tel quel.
fn url_path(s: &str) -> &str {
    match s.find("://") {
        Some(i) => {
            let after = &s[i + 3..];
            match after.find('/') {
                Some(j) => &after[j..],
                None => "/",
            }
        }
        None => s,
    }
}

fn extract_xml_text(xml: &str, tag: &str) -> Option<String> {
    let open  = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end   = xml[start..].find(&close)?;
    let text  = xml[start..start + end].trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

fn percent_decode(s: &str) -> String {
    // Décode les %XX en OCTETS, puis interprète le tout en UTF-8 (sinon les noms
    // accentués sortent en mojibake, ex. « Bibliothèque » → « BibliothÃ¨que »).
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_http_date(s: &str) -> Option<DateTime<Utc>> {
    // Try RFC 2822 (most WebDAV servers)
    DateTime::parse_from_rfc2822(s)
        .map(|d| d.with_timezone(&Utc))
        .or_else(|_| DateTime::parse_from_rfc3339(s).map(|d| d.with_timezone(&Utc)))
        .ok()
}
