use async_trait::async_trait;
use bytes::Bytes;
use futures::Stream;
use std::pin::Pin;

use super::connector::{
    ByteStream, ConnectorConfig, RemoteConnector, RemoteEntry, RemoteEntryType, RemoteError,
    RemoteQuota,
};

/// SFTP connector built on an SSH connection, driven through subprocesses
/// (`ssh`/`sftp`/`sshpass`) to avoid a hard-to-build native dependency
/// (libssh2 needs a C build system).
///
/// ⚠️ **This connector cannot run on this platform.** Every operation below
/// shells out to a process, and `kubuno-seccomp` returns **`EPERM`** on `execve`
/// process-wide (it denies the call, it does not kill the process). So each
/// operation would fail with a cryptic `EPERM` *after* the user finished
/// configuring the mount. To turn that into an actionable, up-front error,
/// [`SftpConnector::new`] refuses construction (see there); the trait
/// implementation below is therefore never reached today.
///
/// Kept rather than deleted because deleting it would turn "SFTP is offered and
/// does not work" into "SFTP was never here". A real fix means an in-process SSH
/// client (`russh`, `ssh2`), not re-enabling a spawn - see the no-host-execution
/// rule in `CLAUDE.md`.
#[allow(dead_code)]
pub struct SftpConnector {
    host:      String,
    port:      u16,
    username:  String,
    password:  Option<String>,
    key_path:  Option<String>,
    base_path: String,
}

impl SftpConnector {
    /// Refuses construction on this platform, *before* any subprocess spawn.
    ///
    /// Every SFTP operation shells out to `ssh`/`sftp`/`sshpass`, and
    /// `kubuno-seccomp` returns `EPERM` on `execve` process-wide. Building the
    /// connector and letting the user configure a mount would only defer the
    /// failure to a cryptic `EPERM` on first use. We fail fast with a message
    /// the user can act on immediately. A future in-process SSH client
    /// (`russh`, `ssh2`) will replace this; re-enabling a spawn is barred by the
    /// no-host-execution rule in `CLAUDE.md`.
    pub fn new(_config: &ConnectorConfig) -> Result<Self, RemoteError> {
        Err(RemoteError::Unsupported(
            "SFTP n'est pas disponible sur cette plateforme \
             (exécution de processus interdite par la politique de sécurité)"
                .into(),
        ))
    }

    fn full_path(&self, rel: &str) -> String {
        let base = self.base_path.trim_end_matches('/');
        let r    = rel.trim_start_matches('/');
        if r.is_empty() { base.to_string() } else { format!("{base}/{r}") }
    }

    /// Construit les arguments SSH communs (évite la vérification stricte de clé d'hôte
    /// car on suppose une connexion interne/de confiance en dev; en prod il faudrait un
    /// known_hosts configuré).
    fn ssh_opts(&self) -> Vec<String> {
        let mut opts = vec![
            "-o".into(), "StrictHostKeyChecking=no".into(),
            "-o".into(), "BatchMode=yes".into(),
            "-p".into(), self.port.to_string(),
        ];
        if let Some(key) = &self.key_path {
            opts.push("-i".into());
            opts.push(key.clone());
        }
        opts
    }

    #[allow(dead_code)]
    async fn run_sftp_cmd(&self, sftp_cmd: &str) -> Result<String, RemoteError> {
        let mut args = self.ssh_opts();
        args.push(format!("{}@{}", self.username, self.host));

        let echo_pass = self.password.as_deref()
            .map(|p| format!("echo '{p}' | sshpass "))
            .unwrap_or_default();

        let cmd = format!("{}sftp {} {}", echo_pass, args.join(" "), sftp_cmd);
        let out = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            if err.contains("Permission denied") || err.contains("Authentication failed") {
                Err(RemoteError::Auth(err.to_string()))
            } else {
                Err(RemoteError::Provider(err.to_string()))
            }
        }
    }
}

#[async_trait]
impl RemoteConnector for SftpConnector {
    fn provider_name(&self) -> &'static str { "sftp" }

    async fn connect(&self) -> Result<Option<RemoteQuota>, RemoteError> {
        // Test SSH connectivity
        let mut args = self.ssh_opts();
        args.push(format!("{}@{}", self.username, self.host));
        args.push("echo ok".into());

        let out = tokio::process::Command::new("ssh")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        if out.status.success() {
            Ok(None)
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(RemoteError::Auth(format!("SSH: {err}")))
        }
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>, RemoteError> {
        let full = self.full_path(path);
        let cmd  = format!(r#"ls -la --time-style=+%Y-%m-%dT%H:%M:%S "{full}" 2>&1"#);

        let mut args = self.ssh_opts();
        args.push(format!("{}@{}", self.username, self.host));
        args.push(cmd);

        let out = tokio::process::Command::new("ssh")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        let output = String::from_utf8_lossy(&out.stdout);
        let mut entries = Vec::new();

        for line in output.lines().skip(1) { // skip "total N"
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 9 { continue; }
            let perms     = parts[0];
            let size_str  = parts[4];
            let date_str  = parts[5];
            let name      = parts[8..].join(" ");

            if name == "." || name == ".." { continue; }

            let is_dir    = perms.starts_with('d');
            let size_bytes = size_str.parse::<u64>().ok();
            let modified_at = chrono::DateTime::parse_from_rfc3339(date_str)
                .map(|d| d.with_timezone(&chrono::Utc))
                .ok();

            let rel_path = if path.is_empty() { name.clone() } else { format!("{path}/{name}") };

            entries.push(RemoteEntry {
                name,
                path: rel_path,
                entry_type: if is_dir { RemoteEntryType::Directory } else { RemoteEntryType::File },
                size_bytes,
                modified_at,
                mime_type: None,
                remote_id: None,
                etag: None,
            });
        }
        Ok(entries)
    }

    async fn stat(&self, path: &str) -> Result<RemoteEntry, RemoteError> {
        let full = self.full_path(path);
        let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string();
        let cmd  = format!(r#"stat -c '%F|%s|%Y' "{full}" 2>&1"#);

        let mut args = self.ssh_opts();
        args.push(format!("{}@{}", self.username, self.host));
        args.push(cmd);

        let out = tokio::process::Command::new("ssh")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        let output = String::from_utf8_lossy(&out.stdout);
        let parts: Vec<&str> = output.trim().splitn(3, '|').collect();

        let is_dir = parts.first().map(|s| s.contains("directory")).unwrap_or(false);
        let size   = parts.get(1).and_then(|s| s.parse::<u64>().ok());
        let mtime  = parts.get(2)
            .and_then(|s| s.parse::<i64>().ok())
            .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
            .map(|d| d.with_timezone(&chrono::Utc));

        Ok(RemoteEntry {
            name,
            path: path.to_string(),
            entry_type: if is_dir { RemoteEntryType::Directory } else { RemoteEntryType::File },
            size_bytes: size,
            modified_at: mtime,
            mime_type: None,
            remote_id: None,
            etag: None,
        })
    }

    async fn get_file(&self, path: &str) -> Result<ByteStream, RemoteError> {
        let full = self.full_path(path);
        let mut args = self.ssh_opts();
        args.push(format!("{}@{}", self.username, self.host));
        args.push(format!(r#"cat "{full}""#));

        let child = tokio::process::Command::new("ssh")
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

        let full = self.full_path(path);
        let mut args = self.ssh_opts();
        args.push(format!("{}@{}", self.username, self.host));
        args.push(format!(r#"cat > "{full}""#));

        let mut child = tokio::process::Command::new("ssh")
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(RemoteError::Io)?;

        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            while let Some(chunk) = stream.next().await {
                let bytes = chunk.map_err(RemoteError::Io)?;
                stdin.write_all(&bytes).await.map_err(RemoteError::Io)?;
            }
        }

        child.wait().await.map_err(RemoteError::Io)?;
        self.stat(path).await
    }

    async fn create_dir(&self, path: &str) -> Result<(), RemoteError> {
        let full = self.full_path(path);
        let mut args = self.ssh_opts();
        args.push(format!("{}@{}", self.username, self.host));
        args.push(format!(r#"mkdir -p "{full}""#));

        let out = tokio::process::Command::new("ssh")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        if out.status.success() { Ok(()) } else {
            Err(RemoteError::Provider(String::from_utf8_lossy(&out.stderr).to_string()))
        }
    }

    async fn delete(&self, path: &str) -> Result<(), RemoteError> {
        let full = self.full_path(path);
        let mut args = self.ssh_opts();
        args.push(format!("{}@{}", self.username, self.host));
        args.push(format!(r#"rm -rf "{full}""#));

        let out = tokio::process::Command::new("ssh")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        if out.status.success() { Ok(()) } else {
            Err(RemoteError::Provider(String::from_utf8_lossy(&out.stderr).to_string()))
        }
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), RemoteError> {
        let full_from = self.full_path(from);
        let full_to   = self.full_path(to);
        let mut args = self.ssh_opts();
        args.push(format!("{}@{}", self.username, self.host));
        args.push(format!(r#"mv "{full_from}" "{full_to}""#));

        let out = tokio::process::Command::new("ssh")
            .args(&args)
            .output()
            .await
            .map_err(RemoteError::Io)?;

        if out.status.success() { Ok(()) } else {
            Err(RemoteError::Provider(String::from_utf8_lossy(&out.stderr).to_string()))
        }
    }
}
