//! The PostgreSQL writer and in-process loader: a logical, data-only dump of
//! **every Kubuno schema**, produced from the connection pool as compressed
//! `COPY` text.
//!
//! ## Why `COPY` text, and why gzip
//!
//! `COPY … TO STDOUT` serialises every PostgreSQL type to text natively - the
//! same representation `pg_dump` writes - so a dump covers `bytea`, `inet`,
//! arrays, `numeric`, `timestamptz` and sequences without a per-type codec. The
//! stream is gzip-compressed on the way to disk (`.sql.gz`), streamed so a large
//! instance never sits in RAM.
//!
//! ## Restored in process, never with `psql`
//!
//! `kubuno-seccomp` forbids `execve` in the server, so the admin hot-restore
//! cannot shell out to `psql`. [`restore`] loads the archive **in process** with
//! sqlx's `copy_in` protocol: it empties the covered tables (reverse dependency
//! order, application triggers disabled) and replays each `COPY` block, all in
//! one transaction, so a failure rolls back and leaves the database as it was.
//!
//! ## The four things that make it restorable
//!
//! * **One snapshot.** Every table is read on the same connection inside one
//!   `REPEATABLE READ, READ ONLY` transaction.
//! * **Dependency order**, across schemas (Kahn over `pg_constraint`), because a
//!   foreign key is a system trigger enforced whatever else is disabled.
//! * **User triggers off during the load** (`DISABLE TRIGGER USER`, owner
//!   privilege - not the superuser-only `session_replication_role`), so the
//!   `core.settings` mirror trigger does not collide with the rows it restores.
//! * **Sequences.** Emitted as `setval` after the data.
//!
//! ## What it refuses to do
//!
//! It never spawns anything, never reads the configuration file, and never
//! writes a connection string, a password or a token into the file, the file
//! name or a log line. The dump does contain password **hashes** - that is what
//! a database backup is - which is why the directory is `0700` and the file
//! `0600`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use chrono::{DateTime, Utc};
use futures::StreamExt;
use kubuno_db::DbPool;
use sqlx::{PgConnection, PgPool, Row};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use super::archive::{self, GzFileWriter, QTable};

/// Free space required before a dump is even attempted.
pub(crate) const MIN_FREE_BYTES: u64 = 256 * 1024 * 1024;

/// Free space below which a dump in progress is abandoned.
pub(crate) const ABORT_FREE_BYTES: u64 = 64 * 1024 * 1024;

/// Suffix of a dump still being written, renamed into place only after `fsync`.
pub(crate) const PARTIAL_SUFFIX: &str = ".part";

/// What one completed dump produced.
#[derive(Debug, Clone)]
pub struct DumpOutcome {
    pub file_name: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub schemas: usize,
    pub tables: usize,
    pub rows: u64,
}

/// Recognised by the retention pass - delegated so the rule lives in one place.
pub fn is_dump_file(name: &str) -> bool {
    archive::is_dump_file(name)
}

/// Doubles embedded quotes, the only escape a quoted SQL identifier needs.
fn quote_ident(raw: &str) -> String {
    format!("\"{}\"", raw.replace('"', "\"\""))
}

/// Escapes a single-quoted SQL literal, for the `setval` calls.
fn quote_literal(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "''"))
}

/// A schema-qualified `"schema"."table"`.
fn qualified(t: &QTable) -> String {
    format!("{}.{}", quote_ident(&t.schema), quote_ident(&t.table))
}

struct TableSpec {
    table: QTable,
    columns: Vec<String>,
}

/// Creates the destination if needed, with permissions that match the content.
pub(crate) async fn ensure_directory(destination: &Path) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(destination)
        .await
        .with_context(|| format!("Création du répertoire de sauvegarde {}", destination.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 0700: the files inside carry every password hash of the instance.
        let perms = std::fs::Permissions::from_mode(0o700);
        if let Err(e) = tokio::fs::set_permissions(destination, perms).await {
            tracing::warn!(
                error = %e,
                répertoire = %destination.display(),
                "backup: droits 0700 non appliqués au répertoire de destination"
            );
        }
    }
    Ok(())
}

pub(crate) fn free_bytes(destination: &Path) -> Option<u64> {
    crate::health::disk::usage_of(destination).map(|u| u.available_bytes)
}

/// Every table of `schemas`, in global (cross-schema) foreign-key order.
async fn ordered_tables(
    conn: &mut PgConnection,
    schemas: &[String],
) -> anyhow::Result<Vec<QTable>> {
    let rows = sqlx::query(
        "SELECT n.nspname AS schema, c.relname AS name \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = ANY($1) AND c.relkind = 'r' AND NOT c.relispartition \
          ORDER BY n.nspname, c.relname",
    )
    .bind(schemas)
    .fetch_all(&mut *conn)
    .await
    .context("Lecture de la liste des tables")?;

    let nodes: Vec<QTable> = rows
        .iter()
        .map(|r| QTable::new(r.get::<String, _>("schema"), r.get::<String, _>("name")))
        .collect();

    let edges_rows = sqlx::query(
        "SELECT np.nspname AS parent_schema, parent.relname AS parent, \
                nc.nspname AS child_schema,  child.relname  AS child \
           FROM pg_constraint con \
           JOIN pg_class child  ON child.oid  = con.conrelid \
           JOIN pg_class parent ON parent.oid = con.confrelid \
           JOIN pg_namespace nc ON nc.oid = child.relnamespace \
           JOIN pg_namespace np ON np.oid = parent.relnamespace \
          WHERE con.contype = 'f' AND nc.nspname = ANY($1) AND np.nspname = ANY($1)",
    )
    .bind(schemas)
    .fetch_all(&mut *conn)
    .await
    .context("Lecture des dépendances de clés étrangères")?;

    let edges: Vec<(QTable, QTable)> = edges_rows
        .iter()
        .map(|r| {
            (
                QTable::new(r.get::<String, _>("parent_schema"), r.get::<String, _>("parent")),
                QTable::new(r.get::<String, _>("child_schema"), r.get::<String, _>("child")),
            )
        })
        .collect();

    Ok(archive::topo_order(&nodes, &edges))
}

/// Columns of one table, in physical order, excluding dropped and generated ones.
async fn columns_of(conn: &mut PgConnection, t: &QTable) -> anyhow::Result<Vec<String>> {
    let rows = sqlx::query(
        "SELECT a.attname AS name \
           FROM pg_attribute a \
           JOIN pg_class c     ON c.oid = a.attrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = $1 AND c.relname = $2 \
            AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' \
          ORDER BY a.attnum",
    )
    .bind(&t.schema)
    .bind(&t.table)
    .fetch_all(&mut *conn)
    .await
    .with_context(|| format!("Lecture des colonnes de {}.{}", t.schema, t.table))?;

    Ok(rows.iter().map(|r| r.get::<String, _>("name")).collect())
}

/// Sequences of `schemas` with their current position.
async fn sequence_positions(
    conn: &mut PgConnection,
    schemas: &[String],
) -> anyhow::Result<Vec<(String, String, i64, bool)>> {
    let rows = sqlx::query(
        "SELECT schemaname AS schema, sequencename AS name, last_value \
           FROM pg_sequences WHERE schemaname = ANY($1) ORDER BY schemaname, sequencename",
    )
    .bind(schemas)
    .fetch_all(&mut *conn)
    .await
    .context("Lecture des séquences")?;

    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let schema: String = row.get("schema");
        let name: String = row.get("name");
        // NULL `last_value` until the sequence is first used: `setval(…, 1,
        // false)` reproduces "never called" without burning the first id.
        match row.try_get::<Option<i64>, _>("last_value") {
            Ok(Some(v)) => out.push((schema, name, v, true)),
            Ok(None) => out.push((schema, name, 1, false)),
            Err(e) => tracing::warn!(error = %e, séquence = %name, "backup: position de séquence illisible"),
        }
    }
    Ok(out)
}

/// Writes one complete dump into `destination` and returns what it contains.
///
/// Only PostgreSQL takes this path; MySQL and SQLite go through the portable
/// writer (see [`super::portable`]).
pub async fn write_dump(db: &DbPool, destination: &Path) -> anyhow::Result<DumpOutcome> {
    let pg = match db.as_pg() {
        Some(pool) => pool,
        None => return super::portable::write_dump(db, destination).await,
    };

    ensure_directory(destination).await?;

    if let Some(free) = free_bytes(destination) {
        if free < MIN_FREE_BYTES {
            bail!(
                "Espace disque insuffisant sur {} : {} Mio disponibles, {} Mio requis",
                destination.display(),
                free / (1024 * 1024),
                MIN_FREE_BYTES / (1024 * 1024)
            );
        }
    }

    let schemas = archive::discover_schemas(db).await?;
    if schemas.is_empty() {
        bail!("Aucun schéma Kubuno trouvé à sauvegarder");
    }

    let started = Utc::now();
    let file_name = archive::file_name_for(started, archive::SQL_GZ_EXT);
    let final_path = destination.join(&file_name);
    let partial_path = destination.join(format!("{file_name}{PARTIAL_SUFFIX}"));

    match write_into(pg, destination, &partial_path, &schemas, started).await {
        Ok((tables, rows)) => {
            tokio::fs::rename(&partial_path, &final_path)
                .await
                .with_context(|| format!("Publication de {}", final_path.display()))?;
            let size_bytes = tokio::fs::metadata(&final_path).await.map(|m| m.len()).unwrap_or(0);
            Ok(DumpOutcome {
                file_name,
                path: final_path,
                size_bytes,
                schemas: schemas.len(),
                tables,
                rows,
            })
        }
        Err(e) => {
            if let Err(rm) = tokio::fs::remove_file(&partial_path).await {
                tracing::warn!(error = %rm, fichier = %partial_path.display(), "backup: fragment non supprimé");
            }
            Err(e)
        }
    }
}

async fn write_into(
    db: &PgPool,
    destination: &Path,
    partial_path: &Path,
    schemas: &[String],
    started: DateTime<Utc>,
) -> anyhow::Result<(usize, u64)> {
    let file = tokio::fs::File::create(partial_path)
        .await
        .with_context(|| format!("Création de {}", partial_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = file.set_permissions(std::fs::Permissions::from_mode(0o600)).await {
            tracing::warn!(error = %e, "backup: droits 0600 non appliqués au fichier");
        }
    }

    let buffered = tokio::io::BufWriter::with_capacity(256 * 1024, file);
    let mut out = GzFileWriter::new(buffered);

    // One connection, one snapshot: REPEATABLE READ makes the file internally
    // consistent, READ ONLY makes this path unable to write anything at all.
    let mut conn = db.acquire().await.context("Réservation d'une connexion pour la sauvegarde")?;
    sqlx::query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *conn)
        .await
        .context("Ouverture de la transaction de sauvegarde")?;

    let ordered = ordered_tables(&mut conn, schemas).await?;
    let mut tables: Vec<TableSpec> = Vec::with_capacity(ordered.len());
    for table in ordered {
        let columns = columns_of(&mut conn, &table).await?;
        if columns.is_empty() {
            tracing::warn!(table = %table.table, "backup: table sans colonne exportable, ignorée");
            continue;
        }
        tables.push(TableSpec { table, columns });
    }
    let sequences = sequence_positions(&mut conn, schemas).await?;

    // ── Header ────────────────────────────────────────────────────────────────
    let header = format!(
        "--\n\
         -- Kubuno - logical DATA-ONLY backup of every Kubuno schema (PostgreSQL COPY)\n\
         -- Kubuno - sauvegarde logique des DONNÉES de tous les schémas Kubuno\n\
         --\n\
         -- Version Kubuno : {}\n\
         -- Produite le / taken at : {}\n\
         -- Schémas : {}\n\
         -- Tables  : {}\n\
         --\n\
         -- CONTENU : les lignes de chaque table des schémas Kubuno + la position des\n\
         --           séquences.\n\
         -- NON INCLUS : les fichiers stockés (téléversements), la structure (DDL) et le\n\
         --           fichier de configuration.\n\
         --\n\
         -- RESTAURATION À CHAUD : depuis le panneau d'administration (100 %% Rust, sans\n\
         --           psql). Chargement in-process via le protocole COPY.\n\
         --\n\
         SET statement_timeout = 0;\n\
         SET lock_timeout = 0;\n\
         SET client_encoding = 'UTF8';\n\
         SET standard_conforming_strings = on;\n\
         SET check_function_bodies = false;\n\
         SET client_min_messages = warning;\n\
         \n\
         BEGIN;\n\
         \n",
        env!("CARGO_PKG_VERSION"),
        started.to_rfc3339(),
        schemas.join(", "),
        tables.len(),
    );
    out.write_all(header.as_bytes()).await?;

    // ── Triggers off ──────────────────────────────────────────────────────────
    out.write_all(b"-- Deferred application triggers during the load.\n").await?;
    for spec in &tables {
        let stmt = format!("ALTER TABLE {} DISABLE TRIGGER USER;\n", qualified(&spec.table));
        out.write_all(stmt.as_bytes()).await?;
    }
    out.write_all(b"\n").await?;

    // ── Data ──────────────────────────────────────────────────────────────────
    let mut total_rows: u64 = 0;
    for spec in &tables {
        if let Some(free) = free_bytes(destination) {
            if free < ABORT_FREE_BYTES {
                bail!(
                    "Sauvegarde interrompue : il ne reste que {} Mio sur {}",
                    free / (1024 * 1024),
                    destination.display()
                );
            }
        }

        let column_list = spec.columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
        let q = qualified(&spec.table);

        out.write_all(format!("COPY {q} ({column_list}) FROM stdin;\n").as_bytes()).await?;

        let statement = format!("COPY {q} ({column_list}) TO STDOUT");
        let mut stream = conn.copy_out_raw(&statement).await.with_context(|| format!("Export de {q}"))?;

        let mut rows: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.with_context(|| format!("Lecture du flux de {q}"))?;
            // In COPY text format each value's own newline is escaped, so a raw
            // newline is exactly one row terminator.
            rows += chunk.iter().filter(|b| **b == b'\n').count() as u64;
            out.write_all(&chunk).await?;
        }
        drop(stream);

        out.write_all(b"\\.\n\n").await?;
        total_rows += rows;
    }

    // ── Sequences ─────────────────────────────────────────────────────────────
    if !sequences.is_empty() {
        out.write_all(b"-- Sequence positions.\n").await?;
        for (schema, name, last_value, is_called) in &sequences {
            let stmt = format!(
                "SELECT pg_catalog.setval({}, {}, {});\n",
                quote_literal(&format!("{schema}.{name}")),
                last_value,
                if *is_called { "true" } else { "false" }
            );
            out.write_all(stmt.as_bytes()).await?;
        }
        out.write_all(b"\n").await?;
    }

    // ── Triggers back on ──────────────────────────────────────────────────────
    for spec in &tables {
        let stmt = format!("ALTER TABLE {} ENABLE TRIGGER USER;\n", qualified(&spec.table));
        out.write_all(stmt.as_bytes()).await?;
    }
    out.write_all(b"\nCOMMIT;\n").await?;

    if let Err(e) = sqlx::query("COMMIT").execute(&mut *conn).await {
        tracing::warn!(error = %e, "backup: clôture de la transaction de lecture");
    }
    drop(conn);

    let mut buffered = out.finish().await?;
    buffered.flush().await.context("Vidage du tampon d'écriture")?;
    buffered
        .into_inner()
        .sync_all()
        .await
        .context("Synchronisation du fichier de sauvegarde")?;

    Ok((tables.len(), total_rows))
}

// ── in-process restore (no psql) ─────────────────────────────────────────────

/// Loads a PostgreSQL `COPY` archive (`.sql.gz` or a legacy `.sql`) in process,
/// replacing the data of every table it covers. Returns the number of `COPY`
/// blocks loaded.
///
/// Everything runs in one transaction: application triggers are disabled, the
/// covered tables are emptied in reverse dependency order, each `COPY` block is
/// replayed with sqlx's copy-in protocol, and the sequences are repositioned. A
/// failure rolls the whole thing back, so the database is never left half-loaded
/// and the archive on disk is never touched.
pub async fn restore(db: &DbPool, archive_path: &Path) -> anyhow::Result<u64> {
    let pg = db
        .as_pg()
        .context("La restauration COPY (.sql) est réservée à PostgreSQL")?;

    // Inflate to a sibling temporary the loader reads line by line; removed on drop.
    let temp = archive::decompress_to_temp(archive_path).await?;

    let schemas = archive::discover_schemas(db).await?;
    if schemas.is_empty() {
        bail!("Aucun schéma Kubuno trouvé pour la restauration");
    }

    let mut conn = pg.acquire().await.context("Réservation d'une connexion pour la restauration")?;
    match restore_into(&mut conn, temp.path(), &schemas).await {
        Ok(n) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .context("Validation de la restauration")?;
            Ok(n)
        }
        Err(e) => {
            // The source archive is never touched; only the half-applied
            // transaction is discarded.
            if let Err(rb) = sqlx::query("ROLLBACK").execute(&mut *conn).await {
                tracing::error!(error = %rb, "backup: rollback de la restauration impossible");
            }
            Err(e)
        }
    }
}

async fn restore_into(
    conn: &mut PgConnection,
    plain_path: &Path,
    schemas: &[String],
) -> anyhow::Result<u64> {
    sqlx::query("BEGIN")
        .execute(&mut *conn)
        .await
        .context("Ouverture de la transaction de restauration")?;

    // Every covered table, in dependency order.
    let ordered = ordered_tables(&mut *conn, schemas).await?;
    let covered: HashSet<QTable> = ordered.iter().cloned().collect();

    // Disable application triggers for the load (owner privilege), then empty in
    // reverse dependency order so a foreign key never blocks a delete.
    for t in &ordered {
        let stmt = format!("ALTER TABLE {} DISABLE TRIGGER USER", qualified(t));
        if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(stmt.clone())).execute(&mut *conn).await {
            tracing::warn!(error = %e, table = %t.table, "backup: désactivation des triggers impossible");
        }
    }
    for t in ordered.iter().rev() {
        let stmt = format!("DELETE FROM {}", qualified(t));
        sqlx::query(sqlx::AssertSqlSafe(stmt.clone()))
            .execute(&mut *conn)
            .await
            .with_context(|| format!("Vidage de {}.{}", t.schema, t.table))?;
    }

    // Replay the file: COPY blocks are streamed through copy-in, setval lines are
    // executed; the archive's own SET/BEGIN/COMMIT/ALTER are ignored because this
    // path owns the transaction and the triggers.
    let file = tokio::fs::File::open(plain_path)
        .await
        .with_context(|| format!("Ouverture de {}", plain_path.display()))?;
    let mut lines = tokio::io::BufReader::with_capacity(256 * 1024, file).lines();

    let mut copy_blocks: u64 = 0;
    while let Some(line) = lines.next_line().await.context("Lecture de l'archive")? {
        if let Some(stmt) = copy_statement(&line) {
            // Guard: refuse a COPY into a table outside the covered set - an
            // archive must not steer a write anywhere else.
            if let Some(target) = copy_target(&line) {
                if !covered.contains(&target) {
                    bail!("Table hors périmètre dans l'archive : {}.{}", target.schema, target.table);
                }
            }
            let mut sink = conn.copy_in_raw(&stmt).await.context("Ouverture d'un bloc COPY")?;
            while let Some(data) = lines.next_line().await.context("Lecture d'un bloc COPY")? {
                if data == "\\." {
                    break;
                }
                let mut buf = data.into_bytes();
                buf.push(b'\n');
                sink.send(buf).await.context("Envoi d'une ligne COPY")?;
            }
            sink.finish().await.context("Clôture d'un bloc COPY")?;
            copy_blocks += 1;
        } else if is_setval_line(&line) {
            sqlx::query(sqlx::AssertSqlSafe(line.trim_end_matches(';').to_string()))
                .execute(&mut *conn)
                .await
                .context("Repositionnement d'une séquence")?;
        }
    }

    // Application triggers back on inside the same transaction.
    for t in &ordered {
        let stmt = format!("ALTER TABLE {} ENABLE TRIGGER USER", qualified(t));
        if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(stmt.clone())).execute(&mut *conn).await {
            tracing::warn!(error = %e, table = %t.table, "backup: réactivation des triggers impossible");
        }
    }

    Ok(copy_blocks)
}

/// If `line` opens a COPY block (`COPY … FROM stdin;`), the statement to hand to
/// copy-in (same text, without the trailing `;`).
fn copy_statement(line: &str) -> Option<String> {
    let t = line.trim();
    if t.starts_with("COPY ") && t.to_ascii_lowercase().ends_with("from stdin;") {
        Some(t.trim_end_matches(';').to_string())
    } else {
        None
    }
}

/// The `schema.table` a COPY line targets, parsed from `COPY "s"."t" (...)`.
fn copy_target(line: &str) -> Option<QTable> {
    let rest = line.trim().strip_prefix("COPY ")?.trim_start();
    let paren = rest.find('(').unwrap_or(rest.len());
    let ident = rest[..paren].trim();
    let (schema, table) = ident.split_once('.')?;
    Some(QTable::new(unquote(schema), unquote(table)))
}

/// Strips one layer of double-quotes and undoubles `""`.
fn unquote(raw: &str) -> String {
    let r = raw.trim();
    if r.len() >= 2 && r.starts_with('"') && r.ends_with('"') {
        r[1..r.len() - 1].replace("\"\"", "\"")
    } else {
        r.to_string()
    }
}

fn is_setval_line(line: &str) -> bool {
    line.trim_start().to_ascii_lowercase().starts_with("select pg_catalog.setval")
}

/// Applies the retention policy to `destination`, keeping the newest `keep`.
///
/// Only files this feature produced are candidates ([`is_dump_file`]).
pub async fn prune(destination: &Path, keep: i64) -> anyhow::Result<Vec<String>> {
    let keep = keep.max(1) as usize;

    let mut entries = match tokio::fs::read_dir(destination).await {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("Lecture de {}", destination.display())),
    };

    let mut names: Vec<String> = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .with_context(|| format!("Parcours de {}", destination.display()))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_dump_file(&name) {
            names.push(name);
        }
    }

    // The name carries a sortable UTC stamp, so lexicographic order is
    // chronological order.
    names.sort();
    if names.len() <= keep {
        return Ok(Vec::new());
    }

    let doomed: Vec<String> = names[..names.len() - keep].to_vec();
    let mut removed = Vec::with_capacity(doomed.len());
    for name in doomed {
        let path = destination.join(&name);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => removed.push(name),
            Err(e) => tracing::error!(error = %e, fichier = %path.display(), "backup: rotation impossible"),
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_and_literals_are_escaped() {
        assert_eq!(quote_ident("users"), "\"users\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(quote_literal("core.jobs"), "'core.jobs'");
        assert_eq!(quote_literal("l'apostrophe"), "'l''apostrophe'");
    }

    #[test]
    fn a_copy_line_is_recognised_and_its_target_parsed() {
        let line = "COPY \"core\".\"users\" (id, email) FROM stdin;";
        assert_eq!(copy_statement(line).as_deref(), Some("COPY \"core\".\"users\" (id, email) FROM stdin"));
        let target = copy_target(line).expect("target");
        assert_eq!(target, QTable::new("core", "users"));
        assert!(copy_statement("SELECT 1;").is_none());
        assert!(is_setval_line("SELECT pg_catalog.setval('core.audit_id_seq', 42, true);"));
    }
}
