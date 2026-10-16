//! The archive: where it is staged, how a module's answer is merged into it,
//! and how it is finally sealed into one `.zip`.
//!
//! ## Why a staging directory rather than one long-lived ZIP writer
//!
//! An export runs across MANY invocations of the job - a handful of accounts
//! each time, so it never approaches `jobs.job_timeout_s` and so a restart
//! costs one batch rather than the whole run. A ZIP writer cannot survive that:
//! the central directory is written at the end, and a half-written archive
//! reopened by another process is not an archive.
//!
//! So the run accumulates a plain directory tree under
//! `<destination>/.staging/<export-id>/`, and the ZIP is written **once**, at
//! the end, in a single blocking task. Three things fall out of that choice and
//! all three are worth the temporary disk:
//!
//!   * a crash leaves a staging directory, which is visibly incomplete and is
//!     removed by the cancellation path - never something that looks like a
//!     finished export;
//!   * a module answers with its own ZIP, which is expanded into the tree, so
//!     the per-file ceiling and the path checks apply to real entries rather
//!     than to a nested archive nobody inspected;
//!   * the final layout is a directory the code can simply walk, which is what
//!     makes "one folder per account, then one per service" a fact on disk
//!     instead of a naming convention held in somebody's head.
//!
//! ## Layout
//!
//! ```text
//! kubuno-export-20260814T103000Z-3f2a.zip
//! ├── MANIFESTE.json          what was asked, what was produced, what failed
//! ├── LISEZ-MOI.txt           the same thing for a human, plus the expiry date
//! ├── instance/               only when the request asked for it
//! │   ├── comptes.json  groupes.json  unites-organisationnelles.json
//! │   ├── reglages.json       secrets already redacted
//! │   └── journal-audit.csv
//! └── comptes/
//!     └── <compte>/           one folder per account
//!         ├── compte.json  appareils.json  journal-audit.csv
//!         └── <service>/      one folder per service, filled by the module
//! ```
//!
//! ## What is refused, and why it is refused HERE
//!
//! Entry paths come from a module - a separate process this crate does not
//! audit. Expanding them without checking is a directory-traversal primitive
//! with a download button on it, so [`safe_entry_path`] refuses, entry by entry:
//! an absolute path, any `..` component, a Windows drive letter or backslash, an
//! empty or over-long segment, and anything that does not start with the service
//! prefix the module declared. A refused entry is reported in the manifest; it
//! never aborts the export, because "the archive is missing one file" is a fact
//! the reader can act on and "the export failed" is not.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use chrono::{DateTime, Utc};
use uuid::Uuid;

/// Free space required before an export is even attempted. An export that fills
/// the volume the instance runs on takes the service down to copy it.
const MIN_FREE_BYTES: u64 = 512 * 1024 * 1024;

/// Suffix of an archive still being sealed. Renamed into place only once the
/// file is complete and fsynced, so a crash never leaves something that *looks*
/// like a finished export and is half an account short.
const PARTIAL_SUFFIX: &str = ".part";

/// Directory holding runs in progress. A dot-prefixed name inside the
/// destination, so an operator listing the directory sees their archives and not
/// the plumbing - and so [`is_export_file`] can never mistake it for output.
const STAGING_DIR: &str = ".staging";

/// Longest single path segment admitted into the archive. Well under every
/// filesystem's limit, and short enough that the full path stays extractable on
/// a desktop that is not this server.
const MAX_SEGMENT: usize = 120;

/// The name an archive produced at `at` for run `id` receives.
///
/// Sortable as text, and carrying nothing but a timestamp and the first block of
/// the run id - never the instance name, never a host, never an account.
pub fn file_name_for(at: DateTime<Utc>, id: Uuid) -> String {
    let short = id.simple().to_string();
    let short = short.get(..8).unwrap_or("00000000");
    format!("kubuno-export-{}-{short}.zip", at.format("%Y%m%dT%H%M%SZ"))
}

/// True when `name` is a file this feature produced.
///
/// Used by every deletion path, which must remove only its own output: a
/// destination directory is an operator's directory, and anything else in it is
/// somebody else's file.
pub fn is_export_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("kubuno-export-") else {
        return false;
    };
    let Some(stem) = rest.strip_suffix(".zip") else {
        return false;
    };
    let Some((stamp, short)) = stem.split_once('-') else {
        return false;
    };
    stamp.len() == 16
        && stamp.char_indices().all(|(i, c)| match i {
            8 => c == 'T',
            15 => c == 'Z',
            _ => c.is_ascii_digit(),
        })
        && short.len() == 8
        && short.chars().all(|c| c.is_ascii_hexdigit())
}

/// Where a run in progress accumulates its tree.
pub fn staging_root(destination: &Path, export_id: Uuid) -> PathBuf {
    destination
        .join(STAGING_DIR)
        .join(export_id.simple().to_string())
}

/// The folder one account receives inside the archive.
///
/// Derived from the username, reduced to characters that survive being extracted
/// on any desktop, and made unique against `taken` - two accounts whose
/// usernames differ only by an accent must not land in the same directory, which
/// would silently interleave two people's data.
pub fn folder_for(username: &str, user_id: Uuid, taken: &mut HashSet<String>) -> String {
    let mut base: String = username
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    base = base.trim_matches('-').to_string();
    base.truncate(60);
    if base.is_empty() || base.chars().all(|c| c == '.') {
        // A username made entirely of characters that did not survive. The id is
        // never pretty and always unique, which is the right trade here.
        base = format!("compte-{}", &user_id.simple().to_string()[..8]);
    }

    if taken.insert(base.clone()) {
        return base;
    }
    // Disambiguated with the account id rather than a counter: a counter depends
    // on the order accounts were listed in, so the same instance exported twice
    // would produce two different layouts.
    let unique = format!("{base}-{}", &user_id.simple().to_string()[..8]);
    taken.insert(unique.clone());
    unique
}

/// Validates one entry path coming from a module, and returns it normalised.
///
/// `service` is the directory the module declared; every entry must live under
/// it. A module that returns `../../etc/passwd`, `/etc/passwd`, or
/// `autre-service/x` gets that entry dropped and named in the manifest.
pub fn safe_entry_path(raw: &str, service: &str) -> Option<String> {
    // Backslashes are normalised first, not rejected: a module built on a
    // Windows toolchain emits them by accident, and the entry is otherwise
    // perfectly legitimate. What is rejected is what a backslash could HIDE,
    // and that is checked after the normalisation, on the segments.
    let normalised = raw.replace('\\', "/");
    let trimmed = normalised.trim_start_matches("./");

    if trimmed.is_empty() || trimmed.starts_with('/') {
        return None;
    }
    // A drive letter (`C:/…`) is neither absolute by `starts_with('/')` nor a
    // parent reference, and would land in the tree under a very odd name.
    if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
        return None;
    }

    let mut segments = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        if segment.len() > MAX_SEGMENT {
            return None;
        }
        // NUL and control characters have no business in a path, and are how a
        // name that looks safe stops being the name that is used.
        if segment.chars().any(|c| c.is_control()) {
            return None;
        }
        segments.push(segment);
    }

    if segments.len() < 2 {
        // `contacts/` alone is a directory entry, not a file, and a single
        // segment would be a file sitting at the account's root rather than
        // inside its service folder.
        return None;
    }
    if segments[0] != service {
        return None;
    }
    Some(segments.join("/"))
}

/// Prepares the destination and the staging tree of one run.
pub async fn prepare(destination: &Path, export_id: Uuid) -> anyhow::Result<PathBuf> {
    ensure_directory(destination).await?;

    if let Some(free) = crate::health::disk::usage_of(destination).map(|u| u.available_bytes) {
        if free < MIN_FREE_BYTES {
            bail!(
                "Espace disque insuffisant sur {} : {} Mio disponibles, {} Mio requis",
                destination.display(),
                free / (1024 * 1024),
                MIN_FREE_BYTES / (1024 * 1024)
            );
        }
    }

    let staging = staging_root(destination, export_id);
    ensure_directory(&staging).await?;
    Ok(staging)
}

/// Creates a directory with permissions that match what it will contain.
async fn ensure_directory(path: &Path) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(path)
        .await
        .with_context(|| format!("Création du répertoire {}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 0700, and re-applied on every run: a directory an operator created by
        // hand with loose permissions is tightened rather than trusted. What
        // lands here is every account's personal data.
        let perms = std::fs::Permissions::from_mode(0o700);
        if let Err(e) = tokio::fs::set_permissions(path, perms).await {
            tracing::warn!(error = %e, répertoire = %path.display(),
                "export: droits 0700 non appliqués");
        }
    }
    Ok(())
}

/// Writes one file into the staging tree, creating its parents.
pub async fn write_file(root: &Path, relative: &str, content: &[u8]) -> anyhow::Result<()> {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Création de {}", parent.display()))?;
    }
    tokio::fs::write(&path, content)
        .await
        .with_context(|| format!("Écriture de {}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) =
            tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).await
        {
            tracing::warn!(error = %e, "export: droits 0600 non appliqués à un fichier d'archive");
        }
    }
    Ok(())
}

/// What expanding one module's answer produced.
#[derive(Debug, Default)]
pub struct MergeOutcome {
    pub files: usize,
    pub bytes: u64,
    /// Entries that were refused, with the reason, in the module's own words.
    /// They end up in the manifest: an archive that quietly lost a file is worse
    /// than one that says which file it lost.
    pub skipped: Vec<String>,
}

/// Expands a module's ZIP into `target` (the account's folder), keeping only
/// entries that live under one of `services`.
///
/// Runs on the blocking pool: the `zip` crate is synchronous, and inflating a
/// gigabyte on the async executor stalls every request the server is serving.
pub async fn merge_module_zip(
    payload: PathBuf,
    target: PathBuf,
    services: Vec<String>,
    max_file_bytes: u64,
) -> anyhow::Result<MergeOutcome> {
    tokio::task::spawn_blocking(move || merge_blocking(&payload, &target, &services, max_file_bytes))
        .await
        .context("Tâche d'extraction interrompue")?
}

fn merge_blocking(
    payload: &Path,
    target: &Path,
    services: &[String],
    max_file_bytes: u64,
) -> anyhow::Result<MergeOutcome> {
    let file = std::fs::File::open(payload)
        .with_context(|| format!("Ouverture de {}", payload.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).context("La réponse du module n'est pas une archive ZIP")?;

    let mut outcome = MergeOutcome::default();

    for index in 0..archive.len() {
        let mut entry = match archive.by_index(index) {
            Ok(e) => e,
            Err(e) => {
                outcome.skipped.push(format!("entrée {index} illisible : {e}"));
                continue;
            }
        };
        if entry.is_dir() {
            continue;
        }

        let raw = entry.name().to_string();
        // The declared size is what the entry HEADER claims. It is checked here
        // to refuse cheaply, and again below on the bytes actually read - a
        // header is written by the module and a zip bomb is exactly a header
        // that lies.
        if entry.size() > max_file_bytes {
            outcome.skipped.push(format!(
                "{raw} : {} Mio, au-delà de la limite par fichier",
                entry.size() / (1024 * 1024)
            ));
            continue;
        }

        let Some(relative) = services
            .iter()
            .find_map(|service| safe_entry_path(&raw, service))
        else {
            outcome
                .skipped
                .push(format!("{raw} : chemin refusé (hors du service déclaré)"));
            continue;
        };

        let path = target.join(&relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Création de {}", parent.display()))?;
        }

        let mut out = std::fs::File::create(&path)
            .with_context(|| format!("Création de {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = out.set_permissions(std::fs::Permissions::from_mode(0o600));
        }

        // Copied through a bounded reader rather than `io::copy`: the ceiling has
        // to hold against a header that under-reports, and `take` is what makes
        // the guarantee about bytes written rather than about bytes announced.
        let mut limited = (&mut entry).take(max_file_bytes.saturating_add(1));
        let written = std::io::copy(&mut limited, &mut out)
            .with_context(|| format!("Extraction de {relative}"))?;

        if written > max_file_bytes {
            drop(out);
            let _ = std::fs::remove_file(&path);
            outcome
                .skipped
                .push(format!("{raw} : contenu au-delà de la limite par fichier"));
            continue;
        }

        outcome.files += 1;
        outcome.bytes = outcome.bytes.saturating_add(written);
    }

    Ok(outcome)
}

/// What sealing the archive produced.
#[derive(Debug, Clone)]
pub struct SealOutcome {
    pub file_name: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub entries: usize,
}

/// Seals the staging tree into one compressed archive in `destination`.
///
/// Written under a `.part` name and renamed only after a successful `fsync`, so
/// a crash never leaves a file that looks like a finished export. Runs on the
/// blocking pool, for the same reason [`merge_module_zip`] does.
pub async fn seal(
    staging: PathBuf,
    destination: PathBuf,
    export_id: Uuid,
) -> anyhow::Result<SealOutcome> {
    let file_name = file_name_for(Utc::now(), export_id);
    tokio::task::spawn_blocking(move || seal_blocking(&staging, &destination, file_name))
        .await
        .context("Tâche de compression interrompue")?
}

fn seal_blocking(
    staging: &Path,
    destination: &Path,
    file_name: String,
) -> anyhow::Result<SealOutcome> {
    let final_path = destination.join(&file_name);
    let partial_path = destination.join(format!("{file_name}{PARTIAL_SUFFIX}"));

    let out = std::fs::File::create(&partial_path)
        .with_context(|| format!("Création de {}", partial_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Before a single byte is written: the window between `create` and
        // `set_permissions` is the only moment the file is world-readable, and
        // what it holds is everybody's personal data.
        let _ = out.set_permissions(std::fs::Permissions::from_mode(0o600));
    }

    let mut zip = zip::ZipWriter::new(out);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut entries = 0usize;
    // Iterative walk rather than recursion: an account's tree is arbitrarily deep
    // once a drive module has answered, and a stack overflow while sealing would
    // destroy hours of work.
    let mut stack = vec![staging.to_path_buf()];
    let mut buffer = Vec::with_capacity(256 * 1024);

    while let Some(dir) = stack.pop() {
        let listing = std::fs::read_dir(&dir)
            .with_context(|| format!("Lecture de {}", dir.display()))?;
        for item in listing {
            let item = item.with_context(|| format!("Lecture de {}", dir.display()))?;
            let path = item.path();
            // `symlink_metadata`, never `metadata`: following a link here would
            // let a module that managed to create one pull a file from outside
            // the staging tree into the archive.
            let meta = std::fs::symlink_metadata(&path)
                .with_context(|| format!("Lecture de {}", path.display()))?;

            if meta.file_type().is_symlink() {
                tracing::warn!(chemin = %path.display(), "export: lien symbolique ignoré dans l'archive");
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
                continue;
            }

            let relative = path
                .strip_prefix(staging)
                .with_context(|| format!("Chemin hors de l'arborescence : {}", path.display()))?
                .to_string_lossy()
                .replace('\\', "/");

            zip.start_file(relative.clone(), options)
                .with_context(|| format!("Ajout de {relative} à l'archive"))?;
            buffer.clear();
            std::fs::File::open(&path)
                .with_context(|| format!("Ouverture de {}", path.display()))?
                .read_to_end(&mut buffer)
                .with_context(|| format!("Lecture de {}", path.display()))?;
            zip.write_all(&buffer)
                .with_context(|| format!("Écriture de {relative} dans l'archive"))?;
            entries += 1;
        }
    }

    let mut sealed = zip.finish().context("Fermeture de l'archive")?;
    sealed.flush().context("Vidage de l'archive")?;
    sealed.sync_all().context("Synchronisation de l'archive")?;
    let size_bytes = sealed.metadata().map(|m| m.len()).unwrap_or(0);
    drop(sealed);

    std::fs::rename(&partial_path, &final_path).with_context(|| {
        format!(
            "Publication de l'archive {} → {}",
            partial_path.display(),
            final_path.display()
        )
    })?;

    Ok(SealOutcome {
        file_name,
        path: final_path,
        size_bytes,
        entries,
    })
}

/// Removes a run's staging tree. Never fatal: a leftover directory costs disk,
/// a failed cleanup that aborts a finished export costs the export.
pub async fn discard_staging(destination: &Path, export_id: Uuid) {
    let staging = staging_root(destination, export_id);
    if let Err(e) = tokio::fs::remove_dir_all(&staging).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %e, répertoire = %staging.display(),
                "export: nettoyage de l'arborescence temporaire impossible");
        }
    }
}

/// Removes one produced archive.
///
/// Refuses anything that is not a file this feature named, whatever the row
/// says: the deletion path is reachable from an HTTP handler, and a `file_name`
/// column is not a capability to unlink arbitrary paths.
pub async fn delete_archive(destination: &Path, file_name: &str) -> anyhow::Result<()> {
    if !is_export_file(file_name) {
        bail!("Nom d'archive non reconnu : suppression refusée");
    }
    let path = destination.join(file_name);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        // Already gone is the desired state, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow::Error::from(e))
            .with_context(|| format!("Suppression de {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uid() -> Uuid {
        Uuid::parse_str("3f2a1b4c-0000-0000-0000-000000000000").expect("uuid de test")
    }

    /// The check that stands between a module and the rest of the filesystem.
    #[test]
    fn traversal_and_absolute_paths_are_refused() {
        assert_eq!(
            safe_entry_path("contacts/carnet.vcf", "contacts").as_deref(),
            Some("contacts/carnet.vcf")
        );
        assert_eq!(
            safe_entry_path("./contacts/avatars/a.webp", "contacts").as_deref(),
            Some("contacts/avatars/a.webp")
        );
        // A Windows-style separator is normalised, not refused.
        assert_eq!(
            safe_entry_path("contacts\\avatars\\a.webp", "contacts").as_deref(),
            Some("contacts/avatars/a.webp")
        );

        assert_eq!(safe_entry_path("../etc/passwd", "contacts"), None);
        assert_eq!(safe_entry_path("contacts/../../etc/passwd", "contacts"), None);
        assert_eq!(safe_entry_path("/etc/passwd", "contacts"), None);
        assert_eq!(safe_entry_path("C:/windows/x", "contacts"), None);
        assert_eq!(safe_entry_path("", "contacts"), None);
        assert_eq!(safe_entry_path("carnet.vcf", "contacts"), None, "hors dossier de service");
        assert_eq!(safe_entry_path("mail/boite.eml", "contacts"), None, "autre service");
        assert_eq!(safe_entry_path("contacts/\u{0}x", "contacts"), None);
        assert_eq!(
            safe_entry_path(&format!("contacts/{}", "x".repeat(200)), "contacts"),
            None
        );
    }

    /// Every deletion path goes through this. A name it accepts that it did not
    /// produce is an arbitrary-unlink primitive.
    #[test]
    fn only_our_own_archives_are_recognised() {
        assert!(is_export_file("kubuno-export-20260814T103000Z-3f2a1b4c.zip"));

        assert!(!is_export_file("kubuno-export-20260814T103000Z-3f2a1b4c.zip.part"));
        assert!(!is_export_file("kubuno-core-20260814T103000Z.sql"), "une sauvegarde");
        assert!(!is_export_file("../../etc/passwd"));
        assert!(!is_export_file("notes-perso.zip"));
        assert!(!is_export_file("kubuno-export-pas-une-date-3f2a1b4c.zip"));
        assert!(!is_export_file("kubuno-export-20260814T103000Z-zzzz.zip"));
    }

    #[test]
    fn a_produced_name_is_recognised_by_its_own_reader() {
        let name = file_name_for(Utc::now(), uid());
        assert!(is_export_file(&name), "{name}");
    }

    #[test]
    fn account_folders_are_readable_and_unique() {
        let mut taken = HashSet::new();
        let a = Uuid::parse_str("aaaaaaaa-0000-0000-0000-000000000000").expect("uuid");
        let b = Uuid::parse_str("bbbbbbbb-0000-0000-0000-000000000000").expect("uuid");

        assert_eq!(folder_for("marie.dupont", a, &mut taken), "marie.dupont");
        assert_eq!(folder_for("Élodie R", a, &mut taken), "lodie-r");
        // The same name twice never collapses two people into one folder.
        let first = folder_for("jean", a, &mut taken);
        let second = folder_for("jean", b, &mut taken);
        assert_eq!(first, "jean");
        assert_ne!(first, second);
        assert!(second.starts_with("jean-"));

        // A username that survives nothing still gets a usable folder.
        let odd = folder_for("///", a, &mut taken);
        assert!(odd.starts_with("compte-"), "{odd}");
    }
}
