//! Where the TLS key material and the ACME account actually live: **on disk**,
//! not in the database.
//!
//! ## Why not the database
//!
//! A TLS private key is the instance's identity: whoever holds it can serve as
//! this instance and read any traffic they recorded. The ACME account key is the
//! next thing down - it can mint new certificates for the instance's domains.
//! Neither belongs in a table that an administrative API can read, that a backup
//! copies wholesale, that a `SELECT` in a log can leak, or that an SQL flaw
//! anywhere in the product could reach.
//!
//! Every web server treats this the same way - Apache's `SSLCertificateKeyFile`,
//! nginx's `ssl_certificate_key`, certbot's `/etc/letsencrypt/live/…` - a file,
//! owned by the service, readable by nobody else. That is what this module does.
//! The protection is POSIX permissions rather than a cipher, which also removes
//! a real failure mode: material encrypted with the JWT secret became
//! permanently unreadable the day that secret was rotated.
//!
//! The database keeps only what the console has to display - subject, SAN,
//! validity, source - and none of it is a secret.

use std::path::{Path, PathBuf};

use crate::errors::AppError;

/// Directory holding the key material, created on demand with `0700`.
/// Configurable through `[server.tls]`; the default lives under the service's
/// own state directory, the one place it is guaranteed to be able to write.
pub fn default_dir() -> PathBuf {
    crate::config::paths::current().tls_dir()
}

/// Resolved locations of the three files this module owns.
#[derive(Debug, Clone)]
pub struct Paths {
    pub cert: PathBuf,
    pub key: PathBuf,
    pub acme_account: PathBuf,
}

impl Paths {
    /// Honours explicit `[server.tls] cert_path` / `key_path` when set, so an
    /// operator who already manages certificates with their own tooling (or
    /// certbot) keeps pointing at those files.
    pub fn from_settings(tls: &crate::config::settings::TlsSettings) -> Self {
        let dir = default_dir();
        let or_default = |configured: &str, default: &str| -> PathBuf {
            if configured.trim().is_empty() {
                dir.join(default)
            } else {
                PathBuf::from(configured.trim())
            }
        };
        Paths {
            cert: or_default(&tls.cert_path, "cert.pem"),
            key: or_default(&tls.key_path, "key.pem"),
            acme_account: dir.join("acme-account.json"),
        }
    }
}

fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        // The directory itself is closed: listing it should tell a curious local
        // account nothing either. On Windows only the core's own directory is
        // re-permissioned, never a folder an operator pointed `cert_path` at.
        if cfg!(unix) || parent == default_dir().as_path() {
            let _ = kubuno_paths::restrict_to_owner(parent);
        }
    }
    // Written aside, private from the first byte (0600, or a protected DACL on
    // Windows), then renamed: no window where half of the old key remains.
    kubuno_paths::write_private(path, contents.as_bytes())
}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> AppError {
    tracing::error!(error = %e, path = %path.display(), "réseau : {what}");
    AppError::Internal(anyhow::anyhow!(
        "{what} ({}) : {e}",
        path.display()
    ))
}

/// Writes the certificate chain and its private key, replacing whatever was
/// there. Both files are written before either is announced: a half-written pair
/// would be served at the next restart and fail the handshake.
pub fn write_material(paths: &Paths, cert_pem: &str, key_pem: &str) -> Result<(), AppError> {
    write_private(&paths.key, key_pem)
        .map_err(|e| io_err("Writing the TLS private key", &paths.key, e))?;
    // The chain is public; it is written with the same care but no secrecy is
    // implied by its mode.
    write_private(&paths.cert, cert_pem)
        .map_err(|e| io_err("Writing the TLS certificate", &paths.cert, e))?;
    Ok(())
}

/// Reads the pair back, or `None` when the instance holds no material.
pub fn read_material(paths: &Paths) -> Option<(String, String)> {
    let cert = std::fs::read_to_string(&paths.cert).ok()?;
    let key = std::fs::read_to_string(&paths.key).ok()?;
    if cert.trim().is_empty() || key.trim().is_empty() {
        return None;
    }
    Some((cert, key))
}

/// True when both files are present and non-empty.
pub fn has_material(paths: &Paths) -> bool {
    read_material(paths).is_some()
}

/// Removes the key material. Missing files are not an error - the caller's
/// intent ("there must be no certificate here") is satisfied either way.
pub fn delete_material(paths: &Paths) -> Result<(), AppError> {
    for p in [&paths.key, &paths.cert] {
        match std::fs::remove_file(p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err("Removing TLS material", p, e)),
        }
    }
    Ok(())
}

/// Stores the serialized ACME account credentials (which contain the account
/// key) with the same protection as the TLS key.
pub fn write_acme_account(paths: &Paths, json: &str) -> Result<(), AppError> {
    write_private(&paths.acme_account, json)
        .map_err(|e| io_err("Writing the ACME account", &paths.acme_account, e))
}

/// Reads the stored ACME account, or `None` on a first run.
pub fn read_acme_account(paths: &Paths) -> Option<String> {
    let raw = std::fs::read_to_string(&paths.acme_account).ok()?;
    (!raw.trim().is_empty()).then_some(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(name: &str) -> Paths {
        let dir = std::env::temp_dir().join(format!("kubuno-tls-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        Paths {
            cert: dir.join("cert.pem"),
            key: dir.join("key.pem"),
            acme_account: dir.join("acme-account.json"),
        }
    }

    #[test]
    fn material_round_trips() {
        let p = temp_paths("roundtrip");
        assert!(!has_material(&p));
        write_material(&p, "CERT", "KEY").expect("écriture");
        assert_eq!(read_material(&p), Some(("CERT".into(), "KEY".into())));
        assert!(has_material(&p));
        delete_material(&p).expect("suppression");
        assert!(!has_material(&p));
        // Deleting again is not an error.
        delete_material(&p).expect("suppression idempotente");
    }

    /// The whole point of moving off the database: nobody but the service may
    /// read the key.
    #[cfg(unix)]
    #[test]
    fn the_private_key_is_not_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let p = temp_paths("perms");
        write_material(&p, "CERT", "KEY").expect("écriture");
        let mode = std::fs::metadata(&p.key).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "clé privée en {mode:o}");
        let dir_mode = std::fs::metadata(p.key.parent().unwrap())
            .expect("stat dir")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700, "répertoire en {dir_mode:o}");
    }

    #[test]
    fn rewriting_replaces_rather_than_appends() {
        let p = temp_paths("rewrite");
        write_material(&p, "CERT-1", "KEY-LONGUE-1").expect("1");
        write_material(&p, "C2", "K2").expect("2");
        assert_eq!(read_material(&p), Some(("C2".into(), "K2".into())));
    }

    #[test]
    fn the_acme_account_round_trips() {
        let p = temp_paths("acme");
        assert_eq!(read_acme_account(&p), None);
        write_acme_account(&p, "{\"id\":1}").expect("écriture");
        assert_eq!(read_acme_account(&p).as_deref(), Some("{\"id\":1}"));
    }
}
