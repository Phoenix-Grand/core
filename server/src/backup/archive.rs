//! Compression, file naming, schema discovery and the directory listing shared
//! by both dump writers.
//!
//! ## Why a shared module
//!
//! There are two on-disk formats, one per engine family: PostgreSQL keeps its
//! `COPY` text ([`super::dump`]), MySQL and SQLite the portable NDJSON
//! ([`super::portable`]). Both now cover **every Kubuno schema** and both are
//! **gzip-compressed**, so the pieces that are the same for either - how a file
//! is named, how the retention pass recognises one, how the destination is
//! listed for the console, how schemas are discovered, and the streaming gzip
//! writer/reader - live here rather than being copied into each.
//!
//! ## Streaming, never buffered
//!
//! [`GzFileWriter`] compresses as it is fed and drains the compressed bytes to
//! the async file in bounded chunks, so a multi-gigabyte dump never sits in RAM.
//! Reading goes the other way: [`decompress_to_temp`] inflates the archive to a
//! sibling temporary file (mode `0600`, in the same directory), so the loader
//! reads plain lines with bounded memory and the temporary is removed on drop.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::Context;
use chrono::{DateTime, Utc};
use flate2::write::GzEncoder;
use flate2::Compression;
use kubuno_db::{params, Backend, DbPool};
use tokio::io::AsyncWriteExt;

/// Common file-name prefix. Historical (`core` was once the only schema); kept
/// so the retention pass keeps recognising files written by earlier versions.
pub const FILE_PREFIX: &str = "kubuno-core-";

/// Extension of a PostgreSQL `COPY` archive.
pub const SQL_GZ_EXT: &str = ".sql.gz";
/// Extension of a portable NDJSON archive.
pub const NDJSON_GZ_EXT: &str = ".ndjson.gz";

/// Every extension the retention pass recognises as one of our own - the two
/// current compressed forms and the two legacy uncompressed ones, so a
/// directory written by an earlier version is still rotated and listed.
pub const KNOWN_EXTS: &[&str] = &[SQL_GZ_EXT, NDJSON_GZ_EXT, ".sql", ".ndjson"];

/// How many compressed bytes accumulate before they are drained to the file.
const DRAIN_THRESHOLD: usize = 64 * 1024;

// ── naming ──────────────────────────────────────────────────────────────────

/// The name a dump taken at `at` receives, with the given extension.
///
/// Sortable as text (`kubuno-core-<UTC-stamp><ext>`), so the retention pass
/// orders the directory without stat-ing anything, and carrying nothing but a
/// timestamp - never a host, never anything derived from a credential.
pub fn file_name_for(at: DateTime<Utc>, ext: &str) -> String {
    // Millisecond precision, so a safety backup taken in the same second as a
    // scheduled one gets a distinct, still-sortable name.
    format!("{FILE_PREFIX}{}{ext}", at.format("%Y%m%dT%H%M%S%3fZ"))
}

/// True when `name` is a file this feature produced - used by the retention pass
/// and the console listing, which must act only on our own output.
///
/// Accepts both the millisecond stamp `YYYYMMDDThhmmssSSSZ` and the legacy
/// second stamp `YYYYMMDDThhmmssZ`, so a directory written by an earlier version
/// is still recognised.
pub fn is_dump_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(FILE_PREFIX) else {
        return false;
    };
    let Some(stamp) = KNOWN_EXTS.iter().find_map(|ext| rest.strip_suffix(ext)) else {
        return false;
    };
    let b = stamp.as_bytes();
    // At least `8 digits + 'T' + 6 digits + 'Z'`; any digits between the seconds
    // and the trailing `Z` are the fractional part.
    b.len() >= 16
        && b[8] == b'T'
        && b[b.len() - 1] == b'Z'
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[9..15].iter().all(u8::is_ascii_digit)
        && b[15..b.len() - 1].iter().all(u8::is_ascii_digit)
}

/// The archive extension a given engine writes.
pub fn extension_for(backend: Backend) -> &'static str {
    match backend {
        Backend::Postgres => SQL_GZ_EXT,
        Backend::MySql | Backend::Sqlite => NDJSON_GZ_EXT,
    }
}

// ── streaming gzip writer ─────────────────────────────────────────────────────

/// A gzip writer over an async sink that keeps only a bounded amount of
/// compressed output in memory.
///
/// `flate2`'s encoder is synchronous, so it compresses into an in-memory `Vec`
/// which is drained to the async file whenever it grows past [`DRAIN_THRESHOLD`].
/// The plaintext is fed one line/chunk at a time by the caller, so peak memory
/// is one chunk plus the compression window - never the whole dump.
pub struct GzFileWriter<W: AsyncWriteExt + Unpin> {
    inner: W,
    enc: GzEncoder<Vec<u8>>,
}

impl<W: AsyncWriteExt + Unpin> GzFileWriter<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner,
            enc: GzEncoder::new(Vec::with_capacity(DRAIN_THRESHOLD * 2), Compression::default()),
        }
    }

    /// Compresses `data` and drains to the file once enough has accumulated.
    pub async fn write_all(&mut self, data: &[u8]) -> anyhow::Result<()> {
        self.enc.write_all(data).context("Compression d'un bloc du dump")?;
        if self.enc.get_ref().len() >= DRAIN_THRESHOLD {
            let buf = std::mem::take(self.enc.get_mut());
            self.inner
                .write_all(&buf)
                .await
                .context("Écriture d'un bloc compressé")?;
        }
        Ok(())
    }

    /// Flushes the deflate stream and the gzip trailer, then returns the sink so
    /// the caller can `fsync` it.
    pub async fn finish(mut self) -> anyhow::Result<W> {
        // Any compressed bytes produced but not yet drained.
        let pending = std::mem::take(self.enc.get_mut());
        if !pending.is_empty() {
            self.inner.write_all(&pending).await.context("Écriture du reliquat compressé")?;
        }
        // `finish` flushes the deflate state and writes the gzip footer into the
        // (now empty) inner buffer, then hands it back.
        let tail = self.enc.finish().context("Clôture du flux gzip")?;
        if !tail.is_empty() {
            self.inner.write_all(&tail).await.context("Écriture du pied gzip")?;
        }
        Ok(self.inner)
    }
}

// ── streaming decompression ───────────────────────────────────────────────────

/// A decompressed temporary file that removes itself when dropped.
///
/// Restoring reads a plain, line-oriented stream; rather than hold the whole
/// inflated dump in memory, the archive is inflated once to a sibling temporary
/// (same directory, `0600`) and the loader reads that. The guard's `Drop` clears
/// it whatever the outcome of the restore.
pub struct DecompressedTemp {
    path: PathBuf,
}

impl DecompressedTemp {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DecompressedTemp {
    fn drop(&mut self) {
        // Best effort and synchronous: a leftover plaintext temporary is the one
        // thing that must not survive a restore, since it holds password hashes.
        if let Err(e) = std::fs::remove_file(&self.path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error = %e, fichier = %self.path.display(), "backup: nettoyage du fichier temporaire décompressé impossible");
            }
        }
    }
}

/// Inflates a `.gz` archive to a sibling temporary file and returns a guard.
///
/// A file that is not gzip (a legacy uncompressed `.sql`/`.ndjson`) is copied
/// verbatim, so the loader has a single code path whatever the on-disk form.
pub async fn decompress_to_temp(archive: &Path) -> anyhow::Result<DecompressedTemp> {
    let dir = archive.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let stem = archive.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "dump".into());
    let temp_path = dir.join(format!(".{stem}.plain-{}", uuid::Uuid::new_v4()));

    let src = archive.to_path_buf();
    let dst = temp_path.clone();
    let compressed = archive
        .extension()
        .map(|e| e.eq_ignore_ascii_case("gz"))
        .unwrap_or(false);

    // The inflate itself is synchronous CPU/IO; keep it off the async workers.
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        use std::io::Write as _;
        let input = std::fs::File::open(&src)
            .with_context(|| format!("Ouverture de {}", src.display()))?;
        let mut out = std::fs::File::create(&dst)
            .with_context(|| format!("Création du fichier temporaire {}", dst.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = out.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        if compressed {
            let mut dec = flate2::read::GzDecoder::new(std::io::BufReader::new(input));
            std::io::copy(&mut dec, &mut out).context("Décompression de l'archive")?;
        } else {
            let mut reader = std::io::BufReader::new(input);
            std::io::copy(&mut reader, &mut out).context("Copie de l'archive")?;
        }
        out.flush().ok();
        Ok(())
    })
    .await
    .context("Tâche de décompression interrompue")??;

    Ok(DecompressedTemp { path: temp_path })
}

// ── schema discovery ──────────────────────────────────────────────────────────

/// True when a bare (prefix-stripped) schema name belongs to Kubuno: exactly a
/// known primary schema or a module's listed secondary schema (`office_data`…).
/// The same test the schema admin uses, so a whole-database backup and a prefix
/// rename see the same set - and neither picks up another instance's schemas on
/// a shared server.
fn schema_is_owned(bare: &str) -> bool {
    kubuno_db::schema::is_kubuno_schema(bare)
}

/// Every Kubuno-owned schema present for this pool, by its **effective**
/// (possibly prefixed) name - the name to qualify SQL with directly.
///
/// * PostgreSQL / MySQL: every server namespace whose prefix-stripped name is a
///   Kubuno schema or a module's secondary schema. `public`, `information_schema`
///   and the engine's own namespaces never match the ownership test, so they are
///   excluded without a hard-coded deny-list.
/// * SQLite: the schemas attached to the connection (`PRAGMA database_list`),
///   which is `core` in the standard layout - each module keeps its own file, out
///   of this connection's reach, so the core backs up what it can actually see.
pub async fn discover_schemas(db: &DbPool) -> anyhow::Result<Vec<String>> {
    let prefix = db.schema_prefix().as_str().to_string();
    let mut names: Vec<String> = match db.backend() {
        Backend::Postgres | Backend::MySql => db
            .fetch_all_as::<(String,)>(
                "SELECT schema_name FROM information_schema.schemata",
                params![],
            )
            .await
            .context("Lecture de la liste des schémas")?
            .into_iter()
            .map(|(n,)| n)
            .collect(),
        Backend::Sqlite => {
            // `database_list` columns: (seq, name, file). `name` is the attach
            // alias, which is the effective schema name.
            db.fetch_all_as::<(i64, String, Option<String>)>("PRAGMA database_list", params![])
                .await
                .context("Lecture des bases attachées (SQLite)")?
                .into_iter()
                .map(|(_, name, _)| name)
                .collect()
        }
    };

    names.retain(|n| match n.strip_prefix(prefix.as_str()) {
        Some(bare) => !bare.is_empty() && schema_is_owned(bare),
        None => false,
    });
    names.sort();
    names.dedup();
    Ok(names)
}

// ── global topological order across schemas ───────────────────────────────────

/// A schema-qualified table.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct QTable {
    pub schema: String,
    pub table: String,
}

impl QTable {
    pub fn new(schema: impl Into<String>, table: impl Into<String>) -> Self {
        Self { schema: schema.into(), table: table.into() }
    }
}

/// Kahn's algorithm over the whole set of tables, `edges` being `(parent,
/// child)`. Parents come out before children so foreign keys - including
/// cross-schema ones (a module row referencing `core.users`) - are satisfied on
/// load. Self-references are skipped and a genuine cycle degrades into "emit the
/// rest in the given order" with a warning: an incomplete backup that says
/// nothing is the one outcome to avoid.
pub fn topo_order(nodes: &[QTable], edges: &[(QTable, QTable)]) -> Vec<QTable> {
    let known: HashSet<&QTable> = nodes.iter().collect();
    let mut children: HashMap<&QTable, Vec<&QTable>> = HashMap::new();
    let mut indegree: HashMap<&QTable, usize> = nodes.iter().map(|n| (n, 0usize)).collect();
    let mut seen: HashSet<(&QTable, &QTable)> = HashSet::new();

    for (parent, child) in edges {
        if parent == child || !known.contains(parent) || !known.contains(child) {
            continue;
        }
        if !seen.insert((parent, child)) {
            continue;
        }
        children.entry(parent).or_default().push(child);
        if let Some(d) = indegree.get_mut(child) {
            *d += 1;
        }
    }

    let mut queue: VecDeque<&QTable> =
        nodes.iter().filter(|n| indegree.get(n).copied().unwrap_or(0) == 0).collect();
    let mut ordered: Vec<QTable> = Vec::with_capacity(nodes.len());
    while let Some(node) = queue.pop_front() {
        ordered.push(node.clone());
        for child in children.get(node).into_iter().flatten() {
            if let Some(d) = indegree.get_mut(*child) {
                *d -= 1;
                if *d == 0 {
                    queue.push_back(child);
                }
            }
        }
    }

    if ordered.len() < nodes.len() {
        let missing: Vec<QTable> =
            nodes.iter().filter(|n| !ordered.contains(n)).cloned().collect();
        tracing::warn!(tables = ?missing, "backup: cycle de clés étrangères - ces tables sont traitées en dernier");
        ordered.extend(missing);
    }
    ordered
}

// ── directory listing (for the console) ───────────────────────────────────────

/// One backup file present in the destination, as the console lists it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackupFile {
    /// Base name only - never a path. The restore endpoint re-joins it to the
    /// configured destination and refuses anything else.
    pub name: String,
    pub size_bytes: u64,
    /// Modification time, RFC3339. The name already carries the UTC stamp, but a
    /// copied-in file keeps only its mtime, so both are surfaced.
    pub modified_at: Option<DateTime<Utc>>,
    /// The engine family the archive can be restored onto, derived from the
    /// extension: `postgres` for `.sql`, portable (`mysql`/`sqlite`) for
    /// `.ndjson`.
    pub format: &'static str,
}

/// The archive kind of a recognised file name.
pub fn format_of(name: &str) -> &'static str {
    if name.ends_with(SQL_GZ_EXT) || name.ends_with(".sql") {
        "postgres"
    } else {
        "portable"
    }
}

/// Lists the backup files present in `destination`, newest first.
///
/// Only our own files ([`is_dump_file`]); anything else in the directory belongs
/// to the operator and is never surfaced or touched.
pub async fn list_backup_files(destination: &Path) -> anyhow::Result<Vec<BackupFile>> {
    let mut entries = match tokio::fs::read_dir(destination).await {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("Lecture de {}", destination.display())),
    };

    let mut files = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .with_context(|| format!("Parcours de {}", destination.display()))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_dump_file(&name) {
            continue;
        }
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, fichier = %name, "backup: métadonnées illisibles");
                continue;
            }
        };
        let modified_at = meta
            .modified()
            .ok()
            .map(DateTime::<Utc>::from);
        files.push(BackupFile {
            format: format_of(&name),
            name,
            size_bytes: meta.len(),
            modified_at,
        });
    }

    // The name carries a sortable UTC stamp; newest first is reverse-lexicographic.
    files.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(files)
}

/// Validates a base file name coming from the console before it is joined to the
/// destination: it must be one of our own recognised names and carry no path
/// component. A restore target is never allowed to escape the configured
/// directory.
pub fn validate_backup_name(name: &str) -> Result<(), crate::errors::AppError> {
    use crate::errors::AppError;
    if name.is_empty() || name.len() > 255 {
        return Err(AppError::Validation("Invalid backup name".into()));
    }
    // No directory separators, no traversal: a name is a base name, never a path.
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains('\0') {
        return Err(AppError::Validation(
            "The backup name cannot contain a path".into(),
        ));
    }
    if !is_dump_file(name) {
        return Err(AppError::Validation(
            "This file is not a Kubuno backup".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn recognises_every_form_and_nothing_else() {
        let at = Utc.with_ymd_and_hms(2026, 8, 4, 3, 15, 0).single().expect("date");
        // Millisecond stamp on the current form.
        assert_eq!(file_name_for(at, SQL_GZ_EXT), "kubuno-core-20260804T031500000Z.sql.gz");
        for ext in KNOWN_EXTS {
            assert!(is_dump_file(&file_name_for(at, ext)), "{ext} recognised");
        }
        // The legacy second-precision stamp is still recognised.
        assert!(is_dump_file("kubuno-core-20260804T031500Z.sql"));
        assert!(is_dump_file("kubuno-core-20260804T031500Z.ndjson"));
        assert!(!is_dump_file("kubuno-core-20260804T031500000Z.sql.gz.part"));
        assert!(!is_dump_file("kubuno_backup_20260804_031500.sql"));
        assert!(!is_dump_file("notes.ndjson.gz"));
        assert!(!is_dump_file(".."));
    }

    #[test]
    fn ownership_covers_primary_and_secondary_schemas() {
        assert!(schema_is_owned("core"));
        assert!(schema_is_owned("office"));
        assert!(schema_is_owned("office_data"));
        assert!(schema_is_owned("office_maths"));
        assert!(!schema_is_owned("public"));
        assert!(!schema_is_owned("information_schema"));
        assert!(!schema_is_owned("pg_catalog"));
        assert!(!schema_is_owned("officeous")); // not `office` + `_...`
    }

    #[test]
    fn a_backup_name_may_not_escape_the_directory() {
        let ok = file_name_for(Utc.with_ymd_and_hms(2026, 8, 4, 3, 0, 0).single().unwrap(), NDJSON_GZ_EXT);
        assert!(validate_backup_name(&ok).is_ok());
        assert!(validate_backup_name("../etc/passwd").is_err());
        assert!(validate_backup_name("sub/kubuno-core-20260804T030000Z.sql.gz").is_err());
        assert!(validate_backup_name("random.txt").is_err());
        assert!(validate_backup_name("").is_err());
    }

    #[test]
    fn topo_puts_parents_before_children_across_schemas() {
        let users = QTable::new("core", "users");
        let notes = QTable::new("notes", "notes");
        let nodes = vec![notes.clone(), users.clone()];
        // notes.notes references core.users.
        let edges = vec![(users.clone(), notes.clone())];
        let ordered = topo_order(&nodes, &edges);
        let pos = |t: &QTable| ordered.iter().position(|x| x == t).unwrap();
        assert!(pos(&users) < pos(&notes));
    }
}
