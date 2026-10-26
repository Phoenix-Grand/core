use async_trait::async_trait;
use bytes::Bytes;
use futures::Stream;
use std::pin::Pin;

use super::connector::{
    ByteStream, ConnectorConfig, RemoteConnector, RemoteEntry, RemoteEntryType, RemoteError,
    RemoteQuota,
};

/// Connecteur FTP/FTPS utilisant le client `curl` (disponible sur tout système Linux).
/// Évite de dépendre d'une crate FTP native.
pub struct FtpConnector {
    host:      String,
    port:      u16,
    username:  String,
    password:  String,
    base_path: String,
    use_tls:   bool,
}

impl FtpConnector {
    pub fn new(config: &ConnectorConfig) -> Result<Self, RemoteError> {
        let host = config.host.clone()
            .ok_or_else(|| RemoteError::Auth("Missing FTP host".into()))?;

        Ok(Self {
            host,
            port:      config.port.unwrap_or(21),
            username:  config.username.clone().unwrap_or_else(|| "anonymous".into()),
            password:  config.password.clone().unwrap_or_default(),
            base_path: config.base_path.clone().unwrap_or_else(|| "/".into()),
            use_tls:   false,
        })
    }

    fn ftp_url(&self, path: &str) -> String {
        let base = self.base_path.trim_end_matches('/');
        let rel  = path.trim_start_matches('/');
        let full_path = if rel.is_empty() { format!("{base}/") } else { format!("{base}/{rel}") };
        format!("ftp://{}:{}{}", self.host, self.port, full_path)
    }

    fn curl_args(&self) -> Vec<String> {
        let mut args = vec![
            "--user".into(), format!("{}:{}", self.username, self.password),
            "--silent".into(),
            "--show-error".into(),
        ];
        if self.use_tls {
            args.push("--ssl-reqd".into());
        }
        args
    }
}

#[async_trait]
impl RemoteConnector for FtpConnector {
    fn provider_name(&self) -> &'static str { "ftp" }

    async fn connect(&self) -> Result<Option<RemoteQuota>, RemoteError> {
        let url = self.ftp_url("");
        let mut args = self.curl_args();
        args.push("--list-only".into());
        args.push(url);

        let out = tokio::process::Command::new("curl")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        if out.status.success() {
            Ok(None)
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(RemoteError::Auth(format!("FTP connection failed: {err}")))
        }
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>, RemoteError> {
        let url = self.ftp_url(path);
        let mut args = self.curl_args();
        args.push("--list-only".into());
        args.push("-I".into()); // Use LIST instead of NLST for details
        args.push(url);

        let out = tokio::process::Command::new("curl")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(RemoteError::Provider(err.to_string()));
        }

        let output = String::from_utf8_lossy(&out.stdout);
        let mut entries = Vec::new();

        for line in output.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 9 { continue; }
            let perms = parts[0];
            let size  = parts[4].parse::<u64>().ok();
            let name  = parts[8..].join(" ");
            if name == "." || name == ".." { continue; }

            let is_dir = perms.starts_with('d');
            let rel    = if path.is_empty() { name.clone() } else { format!("{path}/{name}") };

            entries.push(RemoteEntry {
                name,
                path: rel,
                entry_type: if is_dir { RemoteEntryType::Directory } else { RemoteEntryType::File },
                size_bytes: size,
                modified_at: None,
                mime_type: None,
                remote_id: None,
                etag: None,
            });
        }
        Ok(entries)
    }

    async fn stat(&self, path: &str) -> Result<RemoteEntry, RemoteError> {
        // FTP doesn't have a direct stat; list parent and find the entry
        let parent = path.rsplit_once('/').map(|x| x.0).unwrap_or("");
        let name   = path.rsplit('/').next().unwrap_or(path);
        let entries = self.list_dir(parent).await?;
        entries.into_iter()
            .find(|e| e.name == name)
            .ok_or_else(|| RemoteError::NotFound(format!("{path} introuvable")))
    }

    async fn get_file(&self, path: &str) -> Result<ByteStream, RemoteError> {
        let url = self.ftp_url(path);
        let mut args = self.curl_args();
        args.push(url);

        let child = tokio::process::Command::new("curl")
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .map_err(RemoteError::Io)?;

        let stdout = child.stdout.ok_or_else(|| RemoteError::Provider("Stdout manquant".into()))?;
        use tokio_util::io::ReaderStream;
        use futures::StreamExt;

        let stream = ReaderStream::new(stdout);
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

        // Write to temp file then upload
        let tmp = format!("/tmp/kubuno_ftp_{}", uuid::Uuid::new_v4());
        {
            use tokio::io::AsyncWriteExt;
            let mut f = tokio::fs::File::create(&tmp).await.map_err(RemoteError::Io)?;
            while let Some(chunk) = stream.next().await {
                let bytes = chunk.map_err(RemoteError::Io)?;
                f.write_all(&bytes).await.map_err(RemoteError::Io)?;
            }
        }

        let url = self.ftp_url(path);
        let mut args = self.curl_args();
        args.extend(["-T".into(), tmp.clone(), url]);

        let out = tokio::process::Command::new("curl")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        let _ = tokio::fs::remove_file(&tmp).await;

        if out.status.success() {
            self.stat(path).await
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(RemoteError::Provider(format!("FTP upload failed: {err}")))
        }
    }

    async fn create_dir(&self, path: &str) -> Result<(), RemoteError> {
        let url = self.ftp_url(path);
        let mut args = self.curl_args();
        args.extend(["-Q".into(), format!("MKD {path}"), url]);

        let out = tokio::process::Command::new("curl")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        if out.status.success() { Ok(()) } else {
            let err = String::from_utf8_lossy(&out.stderr);
            // 550 = already exists, treat as OK
            if err.contains("550") { Ok(()) } else {
                Err(RemoteError::Provider(err.to_string()))
            }
        }
    }

    async fn delete(&self, path: &str) -> Result<(), RemoteError> {
        // FTP distingue fichiers (DELE) et dossiers (RMD). RMD n'efface qu'un
        // dossier VIDE → la suppression récursive (vidant d'abord le contenu) est
        // gérée en amont par `delete_recursive` (par défaut du trait). Ici on ne
        // traite que la feuille : on choisit la bonne commande selon le type.
        let is_dir = matches!(self.stat(path).await, Ok(e) if e.is_dir());
        let verb = if is_dir { "RMD" } else { "DELE" };
        let url = self.ftp_url("");
        let mut args = self.curl_args();
        args.extend(["-Q".into(), format!("{verb} {path}"), url]);

        let out = tokio::process::Command::new("curl")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        if out.status.success() { Ok(()) } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(RemoteError::Provider(err.to_string()))
        }
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), RemoteError> {
        let url = self.ftp_url("");
        let mut args = self.curl_args();
        args.extend([
            "-Q".into(), format!("RNFR {from}"),
            "-Q".into(), format!("RNTO {to}"),
            url,
        ]);

        let out = tokio::process::Command::new("curl")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        if out.status.success() { Ok(()) } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(RemoteError::Provider(err.to_string()))
        }
    }
}
