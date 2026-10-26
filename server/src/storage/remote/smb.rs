use async_trait::async_trait;
use bytes::Bytes;
use futures::Stream;
use std::pin::Pin;

use super::connector::{
    ByteStream, ConnectorConfig, RemoteConnector, RemoteEntry, RemoteEntryType, RemoteError,
    RemoteQuota,
};

/// One share advertised by a server.
pub struct SmbShare {
    pub name:    String,
    pub comment: String,
}

/// Enumerates the disk shares a server advertises.
///
/// Exists because a share's NAME and its COMMENT are different things, and the
/// connection form has no other way to show that: a server whose share is called
/// `home_martinien` may describe it as "Home Martinien", and entering the
/// description gets the mount rejected with `NT_STATUS_BAD_NETWORK_NAME` - with
/// nothing on screen to explain why.
///
/// Uses `-g`, smbclient's machine-readable form (`TYPE|NAME|COMMENT`), rather
/// than the aligned table, whose column widths depend on the longest name.
pub async fn list_shares(
    host: &str, username: Option<&str>, password: Option<&str>, domain: Option<&str>,
) -> Result<Vec<SmbShare>, RemoteError> {
    let mut args: Vec<String> = vec!["-L".into(), format!("//{host}"), "-g".into()];
    match username.filter(|u| !u.is_empty()) {
        Some(u) => args.extend(["-U".into(), format!("{u}%{}", password.unwrap_or(""))]),
        None    => args.push("-N".into()),
    }
    if let Some(d) = domain.filter(|d| !d.is_empty()) {
        args.extend(["-W".into(), d.to_string()]);
    }

    let out = tokio::process::Command::new("smbclient")
        .args(&args)
        .output()
        .await
        .map_err(RemoteError::Io)?;

    // Same trap as `run_cmd`: smbclient reports failures on stdout.
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    if let Some(code) = combined.split_whitespace().find(|w| w.starts_with("NT_STATUS_")) {
        return Err(match code {
            "NT_STATUS_LOGON_FAILURE" | "NT_STATUS_ACCESS_DENIED"
            | "NT_STATUS_WRONG_PASSWORD" => RemoteError::Auth(format!("SMB: {code}")),
            other => RemoteError::Provider(format!("SMB: {other}")),
        });
    }

    let mut shares = Vec::new();
    for line in combined.lines() {
        let mut cols = line.splitn(3, '|');
        let (Some(kind), Some(name)) = (cols.next(), cols.next()) else { continue };
        if kind.trim() != "Disk" { continue }
        shares.push(SmbShare {
            name:    name.trim().to_string(),
            comment: cols.next().unwrap_or("").trim().to_string(),
        });
    }
    if shares.is_empty() && !out.status.success() {
        return Err(RemoteError::Provider(format!("SMB: {}", combined.trim())));
    }
    Ok(shares)
}

/// Connecteur SMB/CIFS utilisant `smbclient` (paquet Samba, disponible sur Linux).
/// Les partages SMB apparaissent comme des répertoires dans le VFS de Files.
pub struct SmbConnector {
    host:       String,
    share:      String,
    username:   String,
    password:   String,
    domain:     String,
    base_path:  String,
}

impl SmbConnector {
    pub fn new(config: &ConnectorConfig) -> Result<Self, RemoteError> {
        let host  = config.host.clone()
            .ok_or_else(|| RemoteError::Auth("Missing SMB host".into()))?;
        let share = config.share_name.clone()
            .ok_or_else(|| RemoteError::Auth("Nom de partage SMB manquant".into()))?;

        Ok(Self {
            host,
            share,
            username:  config.username.clone().unwrap_or_else(|| "guest".into()),
            password:  config.password.clone().unwrap_or_default(),
            domain:    config.domain.clone().unwrap_or_default(),
            base_path: config.base_path.clone().unwrap_or_else(|| "/".into()),
        })
    }

    fn smb_path(&self, path: &str) -> String {
        let base = self.base_path.trim_matches('/');
        let rel  = path.trim_start_matches('/');
        if rel.is_empty() {
            if base.is_empty() { "".into() } else { format!("/{base}") }
        } else if base.is_empty() {
            format!("/{rel}")
        } else {
            format!("/{base}/{rel}")
        }
    }

    fn smbclient_args(&self, extra: &[&str], smb_cmd: Option<&str>) -> Vec<String> {
        let unc = format!("//{}/{}", self.host, self.share);
        let mut args = vec![
            unc,
            "-U".into(), format!("{}%{}", self.username, self.password),
        ];
        if !self.domain.is_empty() {
            args.extend(["-W".into(), self.domain.clone()]);
        }
        for e in extra { args.push(e.to_string()); }
        if let Some(cmd) = smb_cmd {
            args.extend(["-c".into(), cmd.to_string()]);
        }
        args
    }

    async fn run_cmd(&self, cmd: &str) -> Result<String, RemoteError> {
        let args = self.smbclient_args(&[], Some(cmd));
        let out  = tokio::process::Command::new("smbclient")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();

        // smbclient reports its failures on STDOUT, leaving STDERR empty (checked
        // on 4.19: `tree connect failed: NT_STATUS_BAD_NETWORK_NAME`, stderr
        // empty, exit 1). Scanning stderr alone therefore caught nothing, the
        // caller filtered the NT_STATUS line out of the listing, and a refused
        // share, a wrong path and a genuinely empty folder all came back as the
        // same empty directory.
        let combined = format!("{stdout}\n{stderr}");
        if let Some(code) = combined.split_whitespace().find(|w| w.starts_with("NT_STATUS_")) {
            return Err(match code {
                "NT_STATUS_LOGON_FAILURE" | "NT_STATUS_ACCESS_DENIED"
                | "NT_STATUS_WRONG_PASSWORD" | "NT_STATUS_ACCOUNT_DISABLED"
                    => RemoteError::Auth(format!("SMB: {code}")),
                "NT_STATUS_BAD_NETWORK_NAME" | "NT_STATUS_OBJECT_PATH_NOT_FOUND"
                | "NT_STATUS_OBJECT_NAME_NOT_FOUND" | "NT_STATUS_NO_SUCH_FILE"
                    => RemoteError::NotFound(format!("SMB: {code}")),
                other => RemoteError::Provider(format!("SMB: {other}")),
            });
        }
        // Anything else that exited non-zero: report it rather than hand back a
        // listing nobody parsed.
        if !out.status.success() {
            let detail = combined.trim();
            let detail = if detail.is_empty() { "smbclient failed" } else { detail };
            return Err(RemoteError::Provider(format!("SMB: {detail}")));
        }
        Ok(stdout)
    }
}

#[async_trait]
impl RemoteConnector for SmbConnector {
    fn provider_name(&self) -> &'static str { "smb" }

    async fn connect(&self) -> Result<Option<RemoteQuota>, RemoteError> {
        self.run_cmd("du").await?;
        Ok(None)
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>, RemoteError> {
        let smb_p = self.smb_path(path);
        // `smbclient ls "<dir>"` ne renvoie QUE l'entrée du répertoire lui-même ;
        // pour en lister le CONTENU il faut un masque `\*` (séparateur SMB = `\`).
        let win  = smb_p.trim_start_matches('/').replace('/', "\\");
        let mask = if win.is_empty() { "\\*".to_string() } else { format!("\\{win}\\*") };
        let cmd  = format!(r#"ls "{mask}""#);
        let output = self.run_cmd(&cmd).await?;
        let mut entries = Vec::new();

        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("Domain=") || line.starts_with("NT_STATUS") {
                continue;
            }
            // smbclient output: "  filename  D  0  Mon Jan  1 00:00:00 2024"
            let parts: Vec<&str> = line.splitn(2, "  ").collect();
            if parts.len() < 2 { continue; }
            let name = parts[0].trim().to_string();
            if name == "." || name == ".." { continue; }
            let rest = parts[1].trim();
            let is_dir = rest.starts_with('D');
            // Format smbclient : "<ATTRS>  <TAILLE>  <DATE>" → la taille est le
            // 1er jeton purement numérique (les attributs sont des lettres, la date
            // vient après). Ex : "A   127891  Wed Jun 11 ...".
            let size = rest.split_whitespace().find_map(|t| t.parse::<u64>().ok());
            let rel = if path.is_empty() { name.clone() } else { format!("{path}/{name}") };

            entries.push(RemoteEntry {
                name,
                path: rel,
                entry_type: if is_dir { RemoteEntryType::Directory } else { RemoteEntryType::File },
                size_bytes: if is_dir { None } else { size },
                modified_at: None,
                mime_type: None,
                remote_id: None,
                etag: None,
            });
        }
        Ok(entries)
    }

    async fn stat(&self, path: &str) -> Result<RemoteEntry, RemoteError> {
        let parent = path.rsplit_once('/').map(|x| x.0).unwrap_or("");
        let name   = path.rsplit('/').next().unwrap_or(path);
        let entries = self.list_dir(parent).await?;
        entries.into_iter()
            .find(|e| e.name == name)
            .ok_or_else(|| RemoteError::NotFound(format!("{path} introuvable")))
    }

    async fn get_file(&self, path: &str) -> Result<ByteStream, RemoteError> {
        let smb_p = self.smb_path(path);
        let tmp   = format!("/tmp/kubuno_smb_{}", uuid::Uuid::new_v4());
        let cmd   = format!(r#"get "{smb_p}" "{tmp}""#);
        self.run_cmd(&cmd).await?;

        let file = tokio::fs::File::open(&tmp).await.map_err(RemoteError::Io)?;
        use tokio_util::io::ReaderStream;
        use futures::StreamExt;

        // Clean up tmp file after streaming (best-effort)
        let tmp_clone = tmp.clone();
        let stream = ReaderStream::new(file);
        let mapped: ByteStream = Box::pin(stream.map(move |r| {
            r.map_err(RemoteError::Io)
        }));
        // Note: tmp file cleanup is deferred - could use a wrapper that deletes on drop
        let _ = tmp_clone;
        Ok(mapped)
    }

    async fn put_file(
        &self,
        path: &str,
        mut stream: Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>,
        _size_hint: Option<u64>,
    ) -> Result<RemoteEntry, RemoteError> {
        use futures::StreamExt;

        let smb_p = self.smb_path(path);
        let tmp   = format!("/tmp/kubuno_smb_{}", uuid::Uuid::new_v4());
        {
            use tokio::io::AsyncWriteExt;
            let mut f = tokio::fs::File::create(&tmp).await.map_err(RemoteError::Io)?;
            while let Some(chunk) = stream.next().await {
                f.write_all(&chunk.map_err(RemoteError::Io)?).await.map_err(RemoteError::Io)?;
            }
        }

        let cmd = format!(r#"put "{tmp}" "{smb_p}""#);
        self.run_cmd(&cmd).await?;
        let _ = tokio::fs::remove_file(&tmp).await;
        self.stat(path).await
    }

    async fn create_dir(&self, path: &str) -> Result<(), RemoteError> {
        let smb_p = self.smb_path(path);
        let cmd   = format!(r#"mkdir "{smb_p}""#);
        self.run_cmd(&cmd).await.map(|_| ())
    }

    async fn delete(&self, path: &str) -> Result<(), RemoteError> {
        let smb_p = self.smb_path(path);
        // `smbclient` renvoie 0 même quand `del` échoue sur un dossier → on doit
        // distinguer fichier/dossier en amont (stat) pour choisir del vs rmdir.
        let is_dir = matches!(self.stat(path).await, Ok(e) if matches!(e.entry_type, RemoteEntryType::Directory));
        let cmd = if is_dir { format!(r#"rmdir "{smb_p}""#) } else { format!(r#"del "{smb_p}""#) };
        self.run_cmd(&cmd).await.map(|_| ())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), RemoteError> {
        let from_p = self.smb_path(from);
        let to_p   = self.smb_path(to);
        let cmd    = format!(r#"rename "{from_p}" "{to_p}""#);
        self.run_cmd(&cmd).await.map(|_| ())
    }
}
