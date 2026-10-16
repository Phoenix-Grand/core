//! Administrative, whole-schema operations used by the core's database console:
//! renaming the global schema prefix in place, and copying every table of a
//! schema from one engine to another.
//!
//! These sit above the per-statement executor ([`crate::exec`]) because they act
//! on the *shape* of the database - its schemas, its tables, its rows read back
//! generically - rather than on one module's queries. Two features build on
//! them:
//!
//! * **Changing the schema prefix at run time** ([`rename_schema_prefix`]): the
//!   WordPress-style prefix ([`crate::schema::SchemaPrefix`]) is renamed on the
//!   live server so several instances can be re-namespaced without a dump/reload.
//! * **Switching a scope's engine while keeping its data** ([`copy_schema`]): a
//!   generic, type-preserving, table-by-table copy in foreign-key order, so the
//!   core (or a module) can move from PostgreSQL to MySQL or SQLite and back.
//!
//! Everything here reads rows without a target struct - the same generic path
//! the portable backup uses - and re-binds each cell as a typed [`DbValue`], so
//! the destination driver re-encodes it for its own engine.
//!
//! # Type fidelity across engines
//!
//! A value is read at the source engine's native shape and carried as a
//! [`DbValue`]; the destination coerces it into its column. PostgreSQL and MySQL
//! keep a UUID, a boolean and a timestamp as distinct types, so a copy *from*
//! one of them stays richly typed. SQLite has only storage classes (a UUID and a
//! hash are both `BLOB`, a boolean and a count both `INTEGER`, a timestamp and a
//! label both `TEXT`), and MariaDB reports a `JSON` column as `LONGTEXT` in its
//! catalog, so a value read from either engine can arrive *ambiguously typed*.
//!
//! To copy faithfully out of such a "type-poor" source, the copy is
//! **destination-directed**: it also reads the destination catalog (freshly
//! migrated, so its columns carry the real logical types) and, when the source
//! codec is ambiguous while the destination column is strict, it *reconstructs*
//! the value from the destination type - a `BLOB(16)`/`TEXT` becomes a `uuid`, an
//! `INTEGER` a `boolean`, an ISO `TEXT` a `timestamp`/`date`, and a JSON `TEXT`
//! (SQLite list column, or MariaDB `LONGTEXT`) a `json`/`jsonb`. A native
//! PostgreSQL array column (`text[]`, `uuid[]`, …) is written from the portable
//! JSON-array shape through a `$n::<elem>[]` cast. Reconstruction never guesses
//! silently: a value that cannot be parsed into the destination type is a hard
//! [`AdminError::Convert`] and rolls the whole copy back, leaving the source
//! intact. Same-engine copies and copies out of a richly-typed engine keep their
//! existing, exact path.

use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};

use crate::dialect::Backend;
use crate::exec::{DbPool, DbRow};
use crate::params;
use crate::schema::is_kubuno_schema;
use crate::value::DbValue;

/// Anything that can go wrong in a schema-wide administrative operation.
#[derive(Debug, thiserror::Error)]
pub enum AdminError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    /// A row count mismatch after a copy: the destination did not receive every
    /// source row, so the caller must not switch the pointer to it.
    #[error("copie incomplète de la table {table} : {expected} lignes attendues, {got} copiées")]
    RowCountMismatch {
        table: String,
        expected: i64,
        got: i64,
    },
    #[error("préfixe de schéma invalide : {0}")]
    BadPrefix(String),
    /// A prefix rename would land on a namespace that already exists - possibly
    /// another instance's on a shared server. Refused before anything moves.
    #[error("le schéma cible {0} existe déjà : renommage refusé pour ne pas mélanger deux instances")]
    TargetExists(String),
    /// A MySQL database holds views, routines or events, which `RENAME TABLE`
    /// cannot carry and the final `DROP DATABASE` would destroy.
    #[error("la base {schema} contient {count} vue(s), routine(s) ou évènement(s) qu'un renommage ne peut pas déplacer")]
    UnmovableObjects { schema: String, count: i64 },
    /// A type-poor source value could not be reconstructed into the destination
    /// column's strict logical type. Returned instead of mis-storing, so the copy
    /// fails safely and the source is left intact.
    #[error("conversion impossible de {table}.{column} vers {target} : {detail}")]
    Convert {
        table: String,
        column: String,
        target: &'static str,
        detail: String,
    },
}

// ─────────────────────────────────────────────────────────────────────────────
// Identifier safety
// ─────────────────────────────────────────────────────────────────────────────

/// A bare identifier fragment we are willing to interpolate into DDL (schema and
/// prefix names). Lowercase ASCII letters, digits and underscore only - the same
/// rule [`crate::schema::SchemaPrefix`] enforces, so nothing user-controlled can
/// carry a quote or a dot into a statement.
fn is_safe_ident(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Double-quotes an identifier, doubling any embedded quote. Every identifier we
/// quote has already passed [`is_safe_ident`] or is a table/column name read
/// back from the catalog, so this is defence in depth rather than the only
/// guard.
fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema-prefix rename
// ─────────────────────────────────────────────────────────────────────────────

/// The effective (possibly prefixed) names of the Kubuno schemas that currently
/// exist under `prefix` on this server.
///
/// * PostgreSQL / MySQL: the server namespaces (schemas / databases) whose name
///   is `<prefix><known-schema>` for a schema in [`KUBUNO_SCHEMAS`].
/// * SQLite: always empty - a SQLite database has no server-level namespace to
///   rename (each schema is a file), so a prefix change is a no-op there.
pub async fn discover_prefixed_schemas(
    pool: &DbPool,
    prefix: &str,
) -> Result<Vec<String>, AdminError> {
    if !prefix.is_empty() && !is_safe_ident(prefix) {
        return Err(AdminError::BadPrefix(prefix.to_string()));
    }
    let existing: Vec<String> = match pool.backend() {
        Backend::Postgres => {
            // `information_schema.schemata` is not rewritten by the prefix layer
            // (it is not a Kubuno schema), so this sees the whole server.
            pool.fetch_all_as::<(String,)>(
                "SELECT schema_name FROM information_schema.schemata",
                params![],
            )
            .await?
            .into_iter()
            .map(|(n,)| n)
            .collect()
        }
        Backend::MySql => pool
            .fetch_all_as::<(String,)>(
                "SELECT schema_name FROM information_schema.schemata",
                params![],
            )
            .await?
            .into_iter()
            .map(|(n,)| n)
            .collect(),
        Backend::Sqlite => return Ok(Vec::new()),
    };

    // A server namespace belongs to this instance when, after stripping the
    // active prefix, its bare name is exactly a known Kubuno schema, primary or
    // secondary (`office_data`…). An exact list, not a `<root>_*` pattern: the
    // pattern let an instance claim another instance's schemas on a shared
    // server whenever the prefixes overlapped (see `is_kubuno_schema`).
    Ok(existing
        .into_iter()
        .filter(|n| n.strip_prefix(prefix).is_some_and(is_kubuno_schema))
        .collect())
}

/// The outcome of a prefix rename: the bare schema names that were renamed from
/// `<old>` to `<new>`.
#[derive(Debug, Default, Clone)]
pub struct PrefixRename {
    /// Bare schema names (`core`, `notes`, …) whose namespace was renamed.
    pub renamed: Vec<String>,
    /// `true` when the engine has no server-level namespace (SQLite), so the
    /// rename was a no-op and the caller only needs to persist the new value.
    pub noop: bool,
}

/// Renames every Kubuno schema present under `old_prefix` to `new_prefix` on the
/// primary server, engine by engine, rolling back on failure.
///
/// * **PostgreSQL** - `ALTER SCHEMA "<old>s" RENAME TO "<new>s"` for each schema,
///   inside one transaction. PostgreSQL DDL is transactional, so any failure
///   rolls the whole set back automatically: the database is never left half
///   renamed.
/// * **MySQL/MariaDB** - a database cannot be renamed in one statement, so each
///   `<old>s` database is recreated as `<new>s` and every table moved with
///   `RENAME TABLE`. MySQL DDL is *not* transactional, so on failure this
///   compensates by moving the already-moved tables back and dropping what it
///   created.
/// * **SQLite** - a no-op ([`PrefixRename::noop`] is set): each schema is a file,
///   there is no server namespace to rename.
///
/// `old_prefix` and `new_prefix` are validated bare identifiers (or empty). The
/// caller is responsible for persisting `new_prefix` into the configuration and
/// for restarting the modules with it.
pub async fn rename_schema_prefix(
    pool: &DbPool,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<PrefixRename, AdminError> {
    for p in [old_prefix, new_prefix] {
        if !p.is_empty() && !is_safe_ident(p) {
            return Err(AdminError::BadPrefix(p.to_string()));
        }
    }
    if old_prefix == new_prefix {
        return Ok(PrefixRename { renamed: Vec::new(), noop: false });
    }

    match pool.backend() {
        Backend::Sqlite => Ok(PrefixRename { renamed: Vec::new(), noop: true }),
        Backend::Postgres => rename_prefix_pg(pool, old_prefix, new_prefix).await,
        Backend::MySql => rename_prefix_mysql(pool, old_prefix, new_prefix).await,
    }
}

async fn rename_prefix_pg(
    pool: &DbPool,
    old: &str,
    new: &str,
) -> Result<PrefixRename, AdminError> {
    let present = discover_prefixed_schemas(pool, old).await?;
    let mut tx = pool.begin().await?;
    let mut renamed = Vec::new();
    for eff_old in &present {
        // `eff_old` is `<old><bare>`; the bare name is the tail after the prefix.
        let bare = eff_old.strip_prefix(old).unwrap_or(eff_old);
        let eff_new = format!("{new}{bare}");
        let sql = format!(
            "ALTER SCHEMA {} RENAME TO {}",
            quote_ident(eff_old),
            quote_ident(&eff_new)
        );
        if let Err(e) = tx.execute(&sql, params![]).await {
            tracing::error!(from = %eff_old, to = %eff_new, error = %e, "Renommage de schéma PostgreSQL échoué - rollback");
            // Dropping the transaction rolls every prior ALTER back.
            return Err(AdminError::Sqlx(e));
        }
        renamed.push(bare.to_string());
    }
    tx.commit().await?;
    Ok(PrefixRename { renamed, noop: false })
}

async fn rename_prefix_mysql(
    pool: &DbPool,
    old: &str,
    new: &str,
) -> Result<PrefixRename, AdminError> {
    let present = discover_prefixed_schemas(pool, old).await?;
    let plan: Vec<(String, String)> = present
        .iter()
        .map(|eff_old| {
            let bare = eff_old.strip_prefix(old).unwrap_or(eff_old);
            (eff_old.clone(), format!("{new}{bare}"))
        })
        .collect();

    // Refuse up front anything the move cannot undo. Nothing has been touched
    // yet, so a refusal here leaves the server exactly as it was.
    let existing: HashSet<String> = pool
        .fetch_all_as::<(String,)>("SELECT schema_name FROM information_schema.schemata", params![])
        .await?
        .into_iter()
        .map(|(n,)| n)
        .collect();
    for (eff_old, eff_new) in &plan {
        // A target that already exists may belong to another instance sharing
        // the server: moving tables into it would mix two instances, and the
        // compensation could not tell its tables from ours.
        if existing.contains(eff_new) {
            return Err(AdminError::TargetExists(eff_new.clone()));
        }
        // Only base tables travel with `RENAME TABLE`; a view, routine or event
        // would be destroyed by the final `DROP DATABASE` of the old name.
        let others = mysql_non_table_objects(pool, eff_old).await?;
        if others > 0 {
            return Err(AdminError::UnmovableObjects { schema: eff_old.clone(), count: others });
        }
    }

    // Each entry: (eff_old, eff_new, tables moved) - exactly the tables this
    // call moved, so a failure is undone table by table (MySQL DDL does not roll
    // back on its own) and never by dropping a database that still holds data.
    let mut done: Vec<(String, String, Vec<String>)> = Vec::new();
    for (eff_old, eff_new) in plan {
        let mut moved = Vec::new();
        if let Err(e) = move_mysql_database(pool, &eff_old, &eff_new, &mut moved).await {
            tracing::error!(from = %eff_old, to = %eff_new, error = %e, "Renommage de base MySQL échoué - compensation");
            undo_mysql_move(pool, &eff_new, &eff_old, &moved).await;
            for (done_old, done_new, tables) in done.iter().rev() {
                undo_mysql_move(pool, done_new, done_old, tables).await;
            }
            return Err(e);
        }
        done.push((eff_old, eff_new, moved));
    }

    Ok(PrefixRename {
        renamed: done
            .into_iter()
            .map(|(eff_old, _, _)| eff_old.strip_prefix(old).unwrap_or(&eff_old).to_string())
            .collect(),
        noop: false,
    })
}

/// Creates `<eff_new>`, moves every table of `<eff_old>` into it (recording each
/// one in `moved` as soon as it has moved), then drops the now-empty `<eff_old>`.
async fn move_mysql_database(
    pool: &DbPool,
    eff_old: &str,
    eff_new: &str,
    moved: &mut Vec<String>,
) -> Result<(), AdminError> {
    // No `IF NOT EXISTS`: the target was checked absent, and if it appeared
    // since, failing here is the safe outcome.
    pool.execute(&format!("CREATE DATABASE {}", quote_ident(eff_new)), params![])
        .await?;
    for table in mysql_table_names(pool, eff_old).await? {
        let sql = format!(
            "RENAME TABLE {}.{} TO {}.{}",
            quote_ident(eff_old),
            quote_ident(&table),
            quote_ident(eff_new),
            quote_ident(&table),
        );
        pool.execute(&sql, params![]).await?;
        moved.push(table);
    }
    drop_mysql_database_if_empty(pool, eff_old).await?;
    Ok(())
}

/// Best-effort inverse of [`move_mysql_database`] used during compensation:
/// moves the recorded tables back and drops `<eff_new>` only once it is empty.
async fn undo_mysql_move(pool: &DbPool, eff_new: &str, eff_old: &str, tables: &[String]) {
    if let Err(e) = pool
        .execute(&format!("CREATE DATABASE IF NOT EXISTS {}", quote_ident(eff_old)), params![])
        .await
    {
        tracing::error!(db = %eff_old, error = %e, "Compensation MySQL : recréation de la base d'origine impossible");
    }
    for table in tables {
        let sql = format!(
            "RENAME TABLE {}.{} TO {}.{}",
            quote_ident(eff_new),
            quote_ident(table),
            quote_ident(eff_old),
            quote_ident(table),
        );
        if let Err(e) = pool.execute(&sql, params![]).await {
            tracing::error!(from = %eff_new, to = %eff_old, table = %table, error = %e, "Compensation MySQL : table non replacée");
        }
    }
    if let Err(e) = drop_mysql_database_if_empty(pool, eff_new).await {
        tracing::error!(db = %eff_new, error = %e, "Compensation MySQL : suppression de la base cible impossible");
    }
}

/// Drops a database only when it holds no table or view any more. A database
/// that still has content is kept (and logged) rather than destroyed.
async fn drop_mysql_database_if_empty(pool: &DbPool, eff_db: &str) -> Result<(), AdminError> {
    let remaining = pool
        .fetch_scalar::<i64>(
            "SELECT CAST(COUNT(*) AS SIGNED) FROM information_schema.tables WHERE table_schema = $1",
            params![eff_db],
        )
        .await?;
    if remaining > 0 {
        tracing::warn!(db = %eff_db, remaining, "Base MySQL conservée : elle contient encore des tables");
        return Ok(());
    }
    pool.execute(&format!("DROP DATABASE IF EXISTS {}", quote_ident(eff_db)), params![])
        .await?;
    Ok(())
}

/// Views, routines and events of a database - the objects `RENAME TABLE` does
/// not carry to another database.
async fn mysql_non_table_objects(pool: &DbPool, eff_db: &str) -> Result<i64, AdminError> {
    Ok(pool
        .fetch_scalar::<i64>(
            "SELECT CAST((SELECT COUNT(*) FROM information_schema.tables \
                           WHERE table_schema = $1 AND table_type <> 'BASE TABLE') \
                       + (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = $2) \
                       + (SELECT COUNT(*) FROM information_schema.events WHERE event_schema = $3) \
                     AS SIGNED)",
            params![eff_db, eff_db, eff_db],
        )
        .await?)
}

async fn mysql_table_names(pool: &DbPool, eff_db: &str) -> Result<Vec<String>, AdminError> {
    Ok(pool
        .fetch_all_as::<(String,)>(
            "SELECT table_name FROM information_schema.tables \
              WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
            params![eff_db],
        )
        .await?
        .into_iter()
        .map(|(n,)| n)
        .collect())
}

impl Codec {
    /// A short, stable tag for the on-disk backup format.
    pub fn tag(self) -> &'static str {
        match self {
            Codec::Bool => "bool",
            Codec::I16 => "i16",
            Codec::I32 => "i32",
            Codec::I64 => "i64",
            Codec::F32 => "f32",
            Codec::F64 => "f64",
            Codec::Text => "text",
            Codec::Blob => "blob",
            Codec::Uuid => "uuid",
            Codec::Json => "json",
            Codec::Date => "date",
            Codec::DateTime => "datetime",
            Codec::DateTimeNaive => "datetime_naive",
        }
    }

    /// The codec for a tag written by [`Codec::tag`]. An unknown tag is `Text`,
    /// which every engine stores, so a forward-compatible file never fails to load.
    pub fn from_tag(tag: &str) -> Codec {
        match tag {
            "bool" => Codec::Bool,
            "i16" => Codec::I16,
            "i32" => Codec::I32,
            "i64" => Codec::I64,
            "f32" => Codec::F32,
            "f64" => Codec::F64,
            "blob" => Codec::Blob,
            "uuid" => Codec::Uuid,
            "json" => Codec::Json,
            "date" => Codec::Date,
            "datetime" => Codec::DateTime,
            "datetime_naive" => Codec::DateTimeNaive,
            _ => Codec::Text,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Portable backup: the same faithful cross-engine machinery, through a file
// ─────────────────────────────────────────────────────────────────────────────

/// One source column prepared for a portable export: its name, the SQL that
/// reads it into a portable shape (a PostgreSQL array/`inet`/`citext` is cast),
/// and the codec its value travels as.
pub struct ExportColumn {
    pub name: String,
    read_expr: String,
    codec: Codec,
}

impl ExportColumn {
    /// The SELECT expression that reads this column into a portable shape.
    pub fn read_expr(&self) -> &str {
        &self.read_expr
    }
    /// The codec tag to record in the backup, so restore knows the source type.
    pub fn codec_tag(&self) -> &'static str {
        self.codec.tag()
    }
}

/// The ordered export plan for a whole schema: every base table (parents first),
/// each with its copyable columns. Reuses the exact introspection a live engine
/// switch uses.
pub async fn portable_export_plan(
    pool: &DbPool,
    schema: &str,
) -> Result<Vec<(String, Vec<ExportColumn>)>, AdminError> {
    let specs = table_specs(pool, schema).await?;
    Ok(specs
        .into_iter()
        .map(|s| {
            let cols = s
                .columns
                .into_iter()
                .map(|c| ExportColumn { name: c.name, read_expr: c.read_expr, codec: c.codec })
                .collect();
            (s.name, cols)
        })
        .collect())
}

/// Reads one row's cells as typed [`DbValue`]s, per the export columns and the
/// source engine - the engine-aware read that makes the value portable.
pub fn portable_read_row(
    row: &DbRow,
    columns: &[ExportColumn],
    backend: Backend,
) -> Result<Vec<DbValue>, sqlx::Error> {
    columns.iter().map(|c| read_cell(row, &c.name, c.codec, backend)).collect()
}

/// One destination column prepared for a portable import: the strict logical type
/// to rebuild a type-poor source into, and (for a native PostgreSQL array) the
/// element type for a `$n::<elem>[]` write cast.
pub struct ImportColumn {
    codec: Codec,
    array_elem: Option<String>,
    text_cast: Option<String>,
}

/// The destination column plan for one table, keyed by column name - read from
/// the freshly-migrated destination catalog, so its columns carry the real types.
pub async fn portable_import_plan(
    pool: &DbPool,
    schema: &str,
    table: &str,
) -> Result<HashMap<String, ImportColumn>, AdminError> {
    Ok(dst_columns(pool, schema, table)
        .await?
        .into_iter()
        .map(|(name, d)| {
            (name, ImportColumn { codec: d.codec, array_elem: d.array_elem, text_cast: d.text_cast })
        })
        .collect())
}

/// Rebuilds one source cell (read on the source at `src_codec`) for a destination
/// column, exactly as a live engine switch does: an ambiguous value from a
/// type-poor source (SQLite `BLOB`/`INTEGER`/`TEXT`, MariaDB JSON-as-text) is
/// reconstructed into the destination's strict type, a PostgreSQL array into a
/// `text[]`/`uuid[]` literal, and a text value into a non-text PostgreSQL column
/// (`inet`, `citext`, an enum…). Returns the value to bind and, when set, the
/// SQL cast suffix to append after its placeholder - e.g. `::uuid[]` or `::inet`.
///
/// A value that cannot be reconstructed is a hard [`AdminError::Convert`] rather
/// than a silent mis-store - so a bad restore fails cleanly instead of corrupting.
pub fn portable_bind_cell(
    dst_backend: Backend,
    src_codec: Codec,
    dst: Option<&ImportColumn>,
    raw: DbValue,
    table: &str,
    column: &str,
) -> Result<(DbValue, Option<String>), AdminError> {
    let Some(dst) = dst else {
        // No such destination column (a dropped column): bind the raw value; the
        // INSERT will surface a real error if the column truly does not exist.
        return Ok((raw, None));
    };
    let rebuilt = match plan_rebuild(dst_backend, src_codec, dst.codec) {
        Some(t) => rebuild_cell(raw, t, table, column)?,
        None => raw,
    };
    if let Some(elem) = &dst.array_elem {
        return Ok((to_pg_array_literal(rebuilt, table, column)?, Some(format!("::{elem}[]"))));
    }
    if let Some(ty) = &dst.text_cast {
        // Only a text value needs the cast; a typed NULL of any kind is bound as
        // itself (a bare `NULL::inet` is equally fine, but the value may already
        // be a typed NULL that PostgreSQL accepts directly).
        return Ok((rebuilt, Some(format!("::{ty}"))));
    }
    Ok((rebuilt, None))
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic cross-engine copy
// ─────────────────────────────────────────────────────────────────────────────

/// How one column's values are read from the source and re-bound onto the
/// destination. The read is engine-aware; the [`DbValue`] it produces is not.
///
/// Public so the backup module can serialise a value with its source codec and,
/// on restore, rebuild it into the destination column's strict type through the
/// very same [`plan_rebuild`]/[`rebuild_cell`] path a live engine switch uses -
/// see the `portable_*` functions below. A backup taken on one engine therefore
/// restores faithfully onto any other.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Codec {
    Bool,
    /// A 16-bit integer (PostgreSQL `smallint`).
    I16,
    /// A 32-bit integer (PostgreSQL `integer`).
    I32,
    /// A 64-bit integer, and the width every MySQL/SQLite integer is read at.
    I64,
    /// A 32-bit float (PostgreSQL `real`, MySQL `float`). PostgreSQL is strict
    /// about float width, so `real` must be decoded as `f32`, not `f64`.
    F32,
    /// A 64-bit float (PostgreSQL `double precision`/`numeric`, and every
    /// SQLite float, which is always stored 8-byte).
    F64,
    Text,
    Blob,
    Uuid,
    Json,
    Date,
    /// A timestamp read as UTC. PostgreSQL `timestamptz` decodes to
    /// `DateTime<Utc>`; MySQL/SQLite decode to `NaiveDateTime` (already UTC).
    DateTime,
    /// A PostgreSQL `timestamp without time zone`, which decodes to
    /// `NaiveDateTime` even on PostgreSQL (there is no offset to apply).
    DateTimeNaive,
}

/// The strict destination logical type a type-poor source value is rebuilt into.
/// Derived from the destination column's own catalog entry, not the source's.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Target {
    Uuid,
    Bool,
    /// Any timestamp column (`timestamptz`, `timestamp`, MySQL `datetime`): the
    /// value is carried as UTC and re-encoded per engine.
    DateTime,
    Date,
    Json,
}

impl Target {
    /// A stable label for [`AdminError::Convert`].
    fn label(self) -> &'static str {
        match self {
            Target::Uuid => "uuid",
            Target::Bool => "boolean",
            Target::DateTime => "timestamp",
            Target::Date => "date",
            Target::Json => "json",
        }
    }
}

/// One destination column's real logical type, read from the freshly-migrated
/// destination catalog and used to steer reconstruction of a type-poor source.
#[derive(Clone)]
struct DstCol {
    /// The destination column's logical codec (its strict type).
    codec: Codec,
    /// For a native PostgreSQL array column (`text[]`, `uuid[]`, …), the element
    /// type name for a `$n::<elem>[]` write cast; `None` for every other column
    /// (including a `jsonb` that merely holds an array).
    array_elem: Option<String>,
    /// For a PostgreSQL column whose value travels as text but whose column type
    /// is not plain text (`inet`, `cidr`, `macaddr`, `citext`, an enum/domain, a
    /// `time`), the type name for a `$n::<type>` write cast so a bound text value
    /// lands in it. `None` for every other column and every other engine (which
    /// coerce a text value into such columns on their own).
    text_cast: Option<String>,
}

/// One copyable column: its name, the codec its values travel as, and the SQL
/// expression that reads it from the source (usually the quoted name, but a
/// PostgreSQL `citext`/`inet`/array is cast to a portable shape - `::text` or
/// `to_jsonb(...)` - so a driver that has no such type can still decode it).
struct Col {
    name: String,
    codec: Codec,
    read_expr: String,
}

/// One table's copyable columns, in order.
struct TableSpec {
    name: String,
    columns: Vec<Col>,
}

/// How many source rows one table held and how many reached the destination.
#[derive(Debug, Clone)]
pub struct TableCopy {
    pub table: String,
    pub rows: i64,
}

/// The result of [`copy_schema`].
#[derive(Debug, Clone, Default)]
pub struct CopyReport {
    pub tables: Vec<TableCopy>,
    pub total_rows: i64,
}

/// How many rows to carry per multi-row `INSERT`. Bounded so a very wide table
/// stays under any engine's bind-parameter limit (`batch * columns` parameters).
const DEFAULT_BATCH: usize = 200;

/// Copies every table of `src_schema` on `src` into `dst_schema` on `dst`,
/// preserving types, in foreign-key order, verifying row counts.
///
/// Both schema names are **effective** names - already carrying whatever prefix
/// applies - and are quoted literally, so neither pool's prefix layer rewrites
/// them a second time.
///
/// The destination tables must already exist (freshly migrated and empty is the
/// intended state): this copies data, it does not create schema. Each table is
/// emptied first (reverse foreign-key order) so a re-run is idempotent, then
/// filled in batches inside a single destination transaction with foreign-key
/// enforcement relaxed for the load. If any table's destination count does not
/// match the source, the whole transaction is rolled back and
/// [`AdminError::RowCountMismatch`] is returned - the caller must not switch to a
/// destination that did not receive everything.
///
/// `progress` is called after each table with its name and the running total of
/// rows copied, so a long copy can report where it is.
pub async fn copy_schema(
    src: &DbPool,
    src_schema: &str,
    dst: &DbPool,
    dst_schema: &str,
    progress: &mut (dyn FnMut(&str, i64) + Send),
) -> Result<CopyReport, AdminError> {
    let specs = table_specs(src, src_schema).await?;

    // Read the destination catalog too: the destination is freshly migrated, so
    // its columns carry the real logical types. Pairing source columns with these
    // by name is what lets a type-poor source (SQLite, MariaDB JSON) be rebuilt
    // faithfully into a strict destination.
    let mut dst_cols: HashMap<String, HashMap<String, DstCol>> = HashMap::new();
    for spec in &specs {
        dst_cols.insert(spec.name.clone(), dst_columns(dst, dst_schema, &spec.name).await?);
    }

    let mut tx = dst.begin().await?;
    // Relax foreign-key checks for the load, so tables can be emptied and
    // refilled without a mid-statement violation. PostgreSQL keeps its
    // non-deferrable constraints, satisfied by the parent-first copy order.
    match dst.backend() {
        Backend::MySql => {
            tx.execute("SET FOREIGN_KEY_CHECKS = 0", params![]).await?;
        }
        Backend::Sqlite => {
            tx.execute("PRAGMA defer_foreign_keys = ON", params![]).await?;
        }
        Backend::Postgres => {}
    }

    // Empty the destination in reverse dependency order first.
    for spec in specs.iter().rev() {
        let sql = format!("DELETE FROM {}.{}", quote_ident(dst_schema), quote_ident(&spec.name));
        tx.execute(&sql, params![]).await?;
    }

    let mut report = CopyReport::default();
    let empty_dst = HashMap::new();
    for spec in &specs {
        let dcols = dst_cols.get(&spec.name).unwrap_or(&empty_dst);
        let rows = copy_one_table(src, src_schema, &mut tx, dst_schema, spec, dcols).await?;
        report.total_rows += rows;
        report.tables.push(TableCopy { table: spec.name.clone(), rows });
        progress(&spec.name, report.total_rows);
    }

    if dst.backend() == Backend::MySql {
        tx.execute("SET FOREIGN_KEY_CHECKS = 1", params![]).await?;
    }
    tx.commit().await?;

    // Verify counts on the committed destination: a silent short copy must never
    // pass for a successful engine switch.
    for spec in &specs {
        let src_count = table_count(src, src_schema, &spec.name).await?;
        let dst_count = table_count(dst, dst_schema, &spec.name).await?;
        if src_count != dst_count {
            return Err(AdminError::RowCountMismatch {
                table: spec.name.clone(),
                expected: src_count,
                got: dst_count,
            });
        }
    }

    Ok(report)
}

async fn table_count(pool: &DbPool, schema: &str, table: &str) -> Result<i64, AdminError> {
    let sql = format!("SELECT COUNT(*) FROM {}.{}", quote_ident(schema), quote_ident(table));
    Ok(pool.fetch_scalar::<i64>(&sql, params![]).await?)
}

/// Reads a table from the source in batches and writes it to the destination
/// transaction, returning the number of rows copied.
async fn copy_one_table(
    src: &DbPool,
    src_schema: &str,
    tx: &mut crate::exec::DbTx,
    dst_schema: &str,
    spec: &TableSpec,
    dst_cols: &HashMap<String, DstCol>,
) -> Result<i64, AdminError> {
    let src_backend = src.backend();
    let dst_backend = tx.backend();

    // Pair each source column with its destination column (by name, case-
    // insensitively) and decide how to carry it: pass the source value through,
    // or rebuild it into the destination's strict type. The write cast is only
    // needed for a native PostgreSQL array column.
    let plans: Vec<ColPlan> = spec
        .columns
        .iter()
        .map(|col| {
            let dst = lookup_dst(dst_cols, &col.name);
            let rebuild = dst.and_then(|d| plan_rebuild(dst_backend, col.codec, d.codec));
            let array_elem = dst.and_then(|d| d.array_elem.clone());
            ColPlan { rebuild, array_elem }
        })
        .collect();

    // The INSERT column list is the plain names; the SELECT list aliases each
    // read expression back to its column name so the row is keyed the same way.
    let insert_cols = spec
        .columns
        .iter()
        .map(|c| quote_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    let select_cols = spec
        .columns
        .iter()
        .map(|c| format!("{} AS {}", c.read_expr, quote_ident(&c.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let select = format!(
        "SELECT {select_cols} FROM {}.{}",
        quote_ident(src_schema),
        quote_ident(&spec.name)
    );
    let rows = src.fetch_all_row(&select, params![]).await?;

    let ncols = spec.columns.len();
    let mut copied: i64 = 0;
    for chunk in rows.chunks(DEFAULT_BATCH.max(1)) {
        // Build a multi-row INSERT: VALUES ($1,…,$k),($k+1,…),…
        let mut values_sql = String::new();
        let mut binds: Vec<DbValue> = Vec::with_capacity(chunk.len() * ncols);
        for (r, row) in chunk.iter().enumerate() {
            if r > 0 {
                values_sql.push_str(", ");
            }
            values_sql.push('(');
            for (c, col) in spec.columns.iter().enumerate() {
                if c > 0 {
                    values_sql.push_str(", ");
                }
                let idx = r * ncols + c + 1;
                let plan = &plans[c];
                values_sql.push('$');
                values_sql.push_str(&idx.to_string());
                // A native PostgreSQL array column takes the portable JSON-array
                // value as an array literal through a `::<elem>[]` write cast.
                if let Some(elem) = &plan.array_elem {
                    values_sql.push_str("::");
                    values_sql.push_str(elem);
                    values_sql.push_str("[]");
                }
                let raw = read_cell(row, &col.name, col.codec, src_backend)?;
                let rebuilt = match plan.rebuild {
                    Some(t) => rebuild_cell(raw, t, &spec.name, &col.name)?,
                    None => raw,
                };
                let bound = match &plan.array_elem {
                    Some(_) => to_pg_array_literal(rebuilt, &spec.name, &col.name)?,
                    None => rebuilt,
                };
                binds.push(bound);
            }
            values_sql.push(')');
        }
        let insert = format!(
            "INSERT INTO {}.{} ({insert_cols}) VALUES {values_sql}",
            quote_ident(dst_schema),
            quote_ident(&spec.name)
        );
        tx.execute(&insert, binds).await?;
        copied += chunk.len() as i64;
    }
    Ok(copied)
}

/// How one column is carried from source to destination.
struct ColPlan {
    /// When set, the source value is reconstructed into this destination type
    /// before binding (the source engine could not express it losslessly).
    rebuild: Option<Target>,
    /// When set (native PostgreSQL array destination), the value is written as a
    /// PostgreSQL array literal through a `::<elem>[]` cast on this element type.
    array_elem: Option<String>,
}

/// Finds a destination column by name, falling back to a case-insensitive match
/// (destination columns are the same names, freshly migrated, so this normally
/// hits directly).
fn lookup_dst<'a>(dst_cols: &'a HashMap<String, DstCol>, name: &str) -> Option<&'a DstCol> {
    dst_cols
        .get(name)
        .or_else(|| dst_cols.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v))
}

/// Decides whether a source column read at `src_codec` must be rebuilt to reach
/// the destination column's strict `dst_codec`.
///
/// Only a strict destination (PostgreSQL/MySQL) can reject an ambiguous value; a
/// SQLite destination stores every storage class as-is, so it never needs a
/// rebuild. A rebuild is required exactly when the destination is strict, the
/// column's logical type is one SQLite/MariaDB cannot express distinctly, and the
/// source did not already read it at that type (so PostgreSQL→anything, and every
/// already-matching pair, keep their exact pass-through path).
fn plan_rebuild(dst_backend: Backend, src_codec: Codec, dst_codec: Codec) -> Option<Target> {
    if dst_backend == Backend::Sqlite {
        return None;
    }
    match dst_codec {
        Codec::Uuid if src_codec != Codec::Uuid => Some(Target::Uuid),
        Codec::Bool if src_codec != Codec::Bool => Some(Target::Bool),
        Codec::Json if src_codec != Codec::Json => Some(Target::Json),
        Codec::Date if src_codec != Codec::Date => Some(Target::Date),
        Codec::DateTime | Codec::DateTimeNaive
            if !matches!(src_codec, Codec::DateTime | Codec::DateTimeNaive) =>
        {
            Some(Target::DateTime)
        }
        _ => None,
    }
}

/// Reconstructs a type-poor source value into the destination's strict logical
/// type. A `NULL` stays a typed `NULL`; a value that cannot be parsed is a hard
/// [`AdminError::Convert`] rather than a silent mis-store.
fn rebuild_cell(v: DbValue, target: Target, table: &str, column: &str) -> Result<DbValue, AdminError> {
    let err = |detail: String| AdminError::Convert {
        table: table.to_string(),
        column: column.to_string(),
        target: target.label(),
        detail,
    };
    Ok(match target {
        Target::Uuid => match v {
            DbValue::Uuid(o) => DbValue::Uuid(o),
            DbValue::Blob(Some(b)) => DbValue::Uuid(Some(
                uuid::Uuid::from_slice(&b).map_err(|e| err(format!("blob de {} octets : {e}", b.len())))?,
            )),
            DbValue::Text(Some(s)) => {
                DbValue::Uuid(Some(uuid::Uuid::parse_str(&s).map_err(|e| err(format!("« {s} » : {e}")))?))
            }
            DbValue::Blob(None) | DbValue::Text(None) | DbValue::Null => DbValue::Uuid(None),
            other => return Err(err(format!("valeur source inattendue {other:?}"))),
        },
        Target::Bool => match v {
            DbValue::Bool(o) => DbValue::Bool(o),
            DbValue::I64(Some(n)) => DbValue::Bool(Some(n != 0)),
            DbValue::I32(Some(n)) => DbValue::Bool(Some(n != 0)),
            DbValue::I16(Some(n)) => DbValue::Bool(Some(n != 0)),
            DbValue::I64(None) | DbValue::I32(None) | DbValue::I16(None) | DbValue::Null => {
                DbValue::Bool(None)
            }
            other => return Err(err(format!("valeur source inattendue {other:?}"))),
        },
        Target::Json => match v {
            DbValue::Json(o) => DbValue::Json(o),
            DbValue::Text(Some(s)) => DbValue::Json(Some(
                serde_json::from_str(&s).map_err(|e| err(format!("texte non-JSON : {e}")))?,
            )),
            DbValue::Text(None) | DbValue::Null => DbValue::Json(None),
            other => return Err(err(format!("valeur source inattendue {other:?}"))),
        },
        Target::Date => match v {
            DbValue::NaiveDate(o) => DbValue::NaiveDate(o),
            DbValue::Text(Some(s)) => DbValue::NaiveDate(Some(
                parse_date(&s).ok_or_else(|| err(format!("« {s} » n'est pas une date")))?,
            )),
            DbValue::Text(None) | DbValue::Null => DbValue::NaiveDate(None),
            other => return Err(err(format!("valeur source inattendue {other:?}"))),
        },
        Target::DateTime => match v {
            DbValue::DateTimeUtc(o) => DbValue::DateTimeUtc(o),
            DbValue::Text(Some(s)) => DbValue::DateTimeUtc(Some(
                parse_datetime_utc(&s).ok_or_else(|| err(format!("« {s} » n'est pas un horodatage")))?,
            )),
            DbValue::Text(None) | DbValue::Null => DbValue::DateTimeUtc(None),
            other => return Err(err(format!("valeur source inattendue {other:?}"))),
        },
    })
}

/// Parses the timestamp text kubuno-db writes on SQLite (`DateTime<Utc>` encodes
/// as RFC 3339) as well as the SQL `strftime`-default and other common shapes,
/// every naive form read as UTC. Mirrors sqlx-sqlite's own decoder so a value
/// this platform wrote always round-trips.
fn parse_datetime_utc(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    for fmt in [
        "%F %T%.f", "%F %T", "%FT%T%.f", "%FT%T", "%F %R", "%FT%R", "%F %T%.f%:z", "%FT%T%.f%:z",
    ] {
        if let Ok(nd) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(nd, Utc));
        }
        if let Ok(dt) = DateTime::parse_from_str(s, fmt) {
            return Some(dt.with_timezone(&Utc));
        }
    }
    None
}

/// Parses a date, accepting a plain `YYYY-MM-DD` or a fuller timestamp truncated
/// to its date part.
fn parse_date(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    if let Ok(d) = NaiveDate::parse_from_str(s, "%F") {
        return Some(d);
    }
    parse_datetime_utc(s).map(|dt| dt.date_naive())
}

/// Turns a portable JSON-array value into a PostgreSQL array literal (`{a,b}`)
/// bound as text, so a `$n::<elem>[]` cast lands it in a native array column. A
/// `NULL` stays a typed `NULL`; a non-array JSON value is a hard error rather
/// than a mis-store.
fn to_pg_array_literal(v: DbValue, table: &str, column: &str) -> Result<DbValue, AdminError> {
    let json = match v {
        DbValue::Json(Some(j)) => j,
        DbValue::Json(None) | DbValue::Null => return Ok(DbValue::Text(None)),
        other => {
            return Err(AdminError::Convert {
                table: table.to_string(),
                column: column.to_string(),
                target: "array",
                detail: format!("valeur source inattendue {other:?}"),
            })
        }
    };
    match json_to_pg_array_literal(&json) {
        Some(lit) => Ok(DbValue::Text(Some(lit))),
        None => Err(AdminError::Convert {
            table: table.to_string(),
            column: column.to_string(),
            target: "array",
            detail: "la valeur JSON n'est pas un tableau".to_string(),
        }),
    }
}

/// Renders a JSON array as a PostgreSQL array literal, quoting and escaping every
/// element. Returns `None` when the value is not a JSON array.
fn json_to_pg_array_literal(v: &serde_json::Value) -> Option<String> {
    let arr = v.as_array()?;
    let mut out = String::from("{");
    for (i, el) in arr.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        match el {
            serde_json::Value::Null => out.push_str("NULL"),
            serde_json::Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            serde_json::Value::Number(n) => out.push_str(&n.to_string()),
            serde_json::Value::String(s) => push_pg_array_element(&mut out, s),
            // A nested array/object has no array-literal spelling of its own; carry
            // its compact JSON text as a quoted element (round-trips as text).
            other => push_pg_array_element(&mut out, &other.to_string()),
        }
    }
    out.push('}');
    Some(out)
}

/// Appends one double-quoted, backslash-escaped PostgreSQL array element.
fn push_pg_array_element(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
}

/// Reads one column of one row into a typed [`DbValue`], choosing the concrete
/// Rust type by the source engine so the decode succeeds (PostgreSQL is strict
/// about integer width and timestamp offset; the others are lenient).
fn read_cell(
    row: &DbRow,
    name: &str,
    codec: Codec,
    backend: Backend,
) -> Result<DbValue, sqlx::Error> {
    Ok(match codec {
        Codec::Bool => DbValue::Bool(row.try_get::<Option<bool>>(name)?),
        Codec::I16 => DbValue::I16(row.try_get::<Option<i16>>(name)?),
        Codec::I32 => DbValue::I32(row.try_get::<Option<i32>>(name)?),
        Codec::I64 => DbValue::I64(row.try_get::<Option<i64>>(name)?),
        Codec::F32 => DbValue::F32(row.try_get::<Option<f32>>(name)?),
        Codec::F64 => DbValue::F64(row.try_get::<Option<f64>>(name)?),
        Codec::Text => DbValue::Text(row.try_get::<Option<String>>(name)?),
        Codec::Blob => DbValue::Blob(row.try_get::<Option<Vec<u8>>>(name)?),
        Codec::Uuid => DbValue::Uuid(row.try_get::<Option<uuid::Uuid>>(name)?),
        Codec::Json => DbValue::Json(row.try_get::<Option<serde_json::Value>>(name)?),
        Codec::Date => DbValue::NaiveDate(row.try_get::<Option<NaiveDate>>(name)?),
        Codec::DateTime => {
            // PostgreSQL's `timestamptz` decodes to `DateTime<Utc>`; MySQL's
            // `DATETIME` and SQLite's text timestamp decode to `NaiveDateTime`
            // (read as UTC - the session/write policy keeps every value UTC).
            let dt = match backend {
                Backend::Postgres => row.try_get::<Option<DateTime<Utc>>>(name)?,
                _ => row
                    .try_get::<Option<NaiveDateTime>>(name)?
                    .map(|n| DateTime::<Utc>::from_naive_utc_and_offset(n, Utc)),
            };
            DbValue::DateTimeUtc(dt)
        }
        Codec::DateTimeNaive => {
            let dt = row
                .try_get::<Option<NaiveDateTime>>(name)?
                .map(|n| DateTime::<Utc>::from_naive_utc_and_offset(n, Utc));
            DbValue::DateTimeUtc(dt)
        }
    })
}

// ── introspection ────────────────────────────────────────────────────────────

/// Tables that belong to one engine's plumbing rather than to the scope's data,
/// so a copy, a portable backup and their verification all leave them out:
/// `_sqlx_migrations` (each engine has its own migration history) and
/// `kubuno_event_outbox` (the MySQL/SQLite event transport, created at startup
/// and absent from a PostgreSQL target - copying it broke a switch back to
/// PostgreSQL).
const ENGINE_LOCAL_TABLES: [&str; 2] = ["_sqlx_migrations", "kubuno_event_outbox"];

/// Every base table of `schema`, in a portable foreign-key order (parents
/// before children), each with its copyable columns and their codecs.
async fn table_specs(pool: &DbPool, schema: &str) -> Result<Vec<TableSpec>, AdminError> {
    let (mut names, edges) = match pool.backend() {
        Backend::Postgres => pg_tables_and_edges(pool, schema).await?,
        Backend::MySql => mysql_tables_and_edges(pool, schema).await?,
        Backend::Sqlite => sqlite_tables_and_edges(pool, schema).await?,
    };
    names.retain(|n| !ENGINE_LOCAL_TABLES.contains(&n.as_str()));
    let ordered = topo_order(&names, &edges);

    let mut specs = Vec::with_capacity(ordered.len());
    for name in ordered {
        let columns = match pool.backend() {
            Backend::Postgres => pg_columns(pool, schema, &name).await?,
            Backend::MySql => mysql_columns(pool, schema, &name).await?,
            Backend::Sqlite => sqlite_columns(pool, schema, &name).await?,
        };
        if !columns.is_empty() {
            specs.push(TableSpec { name, columns });
        }
    }
    Ok(specs)
}

/// The destination columns of one table, keyed by name, with their strict
/// logical codec and (for a native PostgreSQL array) the element type for the
/// write cast. Used to steer reconstruction of a type-poor source.
async fn dst_columns(
    pool: &DbPool,
    schema: &str,
    table: &str,
) -> Result<HashMap<String, DstCol>, AdminError> {
    let mut map = HashMap::new();
    match pool.backend() {
        Backend::Postgres => {
            let rows: Vec<(String, String, String)> = pool
                .fetch_all_as(
                    "SELECT column_name, data_type, udt_name FROM information_schema.columns \
                      WHERE table_schema = $1 AND table_name = $2 AND is_generated = 'NEVER' ORDER BY ordinal_position",
                    params![schema, table],
                )
                .await?;
            for (name, data_type, udt) in rows {
                let codec = pg_col(name.clone(), &data_type, &udt).codec;
                // A PostgreSQL array reports data_type 'ARRAY' and an element type
                // in `udt_name` spelled `_<elem>` (e.g. `_text`, `_uuid`).
                let array_elem = if data_type.eq_ignore_ascii_case("array") {
                    safe_pg_type(&udt)
                } else {
                    None
                };
                let text_cast = pg_text_cast(&data_type, &udt);
                map.insert(name, DstCol { codec, array_elem, text_cast });
            }
        }
        Backend::MySql => {
            let rows: Vec<(String, String, String)> = pool
                .fetch_all_as(
                    "SELECT column_name, data_type, column_type FROM information_schema.columns \
                      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
                    params![schema, table],
                )
                .await?;
            for (name, data_type, column_type) in rows {
                map.insert(
                    name,
                    DstCol { codec: mysql_codec(&data_type, &column_type), array_elem: None, text_cast: None },
                );
            }
        }
        Backend::Sqlite => {
            let sql = format!(
                "PRAGMA {}.table_info({})",
                quote_ident(schema),
                quote_ident(table)
            );
            for row in &pool.fetch_all_row(&sql, params![]).await? {
                let name: String = row.try_get("name")?;
                let decl: String = row.try_get("type")?;
                map.insert(name, DstCol { codec: sqlite_codec(&decl), array_elem: None, text_cast: None });
            }
        }
    }
    Ok(map)
}

/// The PostgreSQL type a text value must be cast to (`$n::<type>`) to land in a
/// column whose type is not plain text - `inet`/`cidr`/`macaddr`, a `time`, or a
/// `citext`/enum/domain (`USER-DEFINED`). `None` for a plain text column (no cast
/// needed) and for an array (handled by the element cast instead).
fn pg_text_cast(data_type: &str, udt: &str) -> Option<String> {
    match data_type.to_ascii_lowercase().as_str() {
        "inet" | "cidr" | "macaddr" | "macaddr8" => safe_pg_type(&format!("_{}", udt.trim_start_matches('_'))),
        "time without time zone" => Some("time".to_string()),
        "time with time zone" => Some("timetz".to_string()),
        "user-defined" => safe_pg_type(&format!("_{}", udt.trim_start_matches('_'))),
        // Any other exotic-but-text-representable type (e.g. `tsvector`): read as
        // text on export, cast back to its own type on import (`$n::tsvector`).
        // Native character types report a `data_type` with a space (`character
        // varying`), which `safe_pg_type` rejects, so they keep binding as raw
        // text - exactly right.
        other => safe_pg_type(other),
    }
}

/// Validates a PostgreSQL element type name from a catalog `udt_name` (stripping
/// the array's leading `_`), so it can be interpolated into a `::<elem>[]` cast.
/// Anything unexpected returns `None`, which falls the column back to a direct
/// bind that fails safely rather than injecting text.
fn safe_pg_type(udt: &str) -> Option<String> {
    let t = udt.trim_start_matches('_');
    if !t.is_empty()
        && t.len() <= 64
        && t.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        Some(t.to_string())
    } else {
        None
    }
}

/// Kahn's algorithm: parents before children. Self-references are ignored and a
/// genuine cycle degrades to name order for the remainder.
fn topo_order(names: &[String], edges: &[(String, String)]) -> Vec<String> {
    let known: HashSet<&str> = names.iter().map(String::as_str).collect();
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    let mut indegree: HashMap<&str, usize> = names.iter().map(|n| (n.as_str(), 0)).collect();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for (parent, child) in edges {
        if parent == child || !known.contains(parent.as_str()) || !known.contains(child.as_str()) {
            continue;
        }
        if !seen.insert((parent.clone(), child.clone())) {
            continue;
        }
        children.entry(parent.clone()).or_default().push(child.clone());
        if let Some(d) = indegree.get_mut(child.as_str()) {
            *d += 1;
        }
    }

    let mut queue: VecDeque<String> = names
        .iter()
        .filter(|n| indegree.get(n.as_str()).copied().unwrap_or(0) == 0)
        .cloned()
        .collect();
    let mut ordered = Vec::with_capacity(names.len());
    while let Some(name) = queue.pop_front() {
        ordered.push(name.clone());
        for child in children.get(&name).into_iter().flatten() {
            if let Some(d) = indegree.get_mut(child.as_str()) {
                *d -= 1;
                if *d == 0 {
                    queue.push_back(child.clone());
                }
            }
        }
    }
    if ordered.len() < names.len() {
        for n in names {
            if !ordered.contains(n) {
                ordered.push(n.clone());
            }
        }
    }
    ordered
}

// PostgreSQL ------------------------------------------------------------------

async fn pg_tables_and_edges(
    pool: &DbPool,
    schema: &str,
) -> Result<(Vec<String>, Vec<(String, String)>), AdminError> {
    let names: Vec<String> = pool
        .fetch_all_as::<(String,)>(
            "SELECT table_name FROM information_schema.tables \
              WHERE table_schema = $1 AND table_type = 'BASE TABLE' \
                AND table_name <> '_sqlx_migrations'",
            params![schema],
        )
        .await?
        .into_iter()
        .map(|(n,)| n)
        .collect();

    let edges: Vec<(String, String)> = pool
        .fetch_all_as::<(String, String)>(
            "SELECT ccu.table_name AS parent, tc.table_name AS child \
               FROM information_schema.table_constraints tc \
               JOIN information_schema.constraint_column_usage ccu \
                 ON tc.constraint_name = ccu.constraint_name \
                AND tc.table_schema = ccu.table_schema \
              WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1",
            params![schema],
        )
        .await?;
    Ok((names, edges))
}

async fn pg_columns(
    pool: &DbPool,
    schema: &str,
    table: &str,
) -> Result<Vec<Col>, AdminError> {
    let rows: Vec<(String, String, String)> = pool
        .fetch_all_as(
            "SELECT column_name, data_type, udt_name FROM information_schema.columns \
              WHERE table_schema = $1 AND table_name = $2 AND is_generated = 'NEVER' ORDER BY ordinal_position",
            params![schema, table],
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|(name, data_type, udt)| pg_col(name, &data_type, &udt))
        .collect())
}

/// Maps one PostgreSQL column to a [`Col`], reading types a foreign driver has
/// no equivalent for through a portable cast so the copy still decodes them:
/// arrays become `jsonb`, and `citext`/`inet`/enums/domains become `text`.
fn pg_col(name: String, data_type: &str, udt: &str) -> Col {
    let q = quote_ident(&name);
    let (codec, read_expr) = match data_type.to_ascii_lowercase().as_str() {
        "boolean" => (Codec::Bool, q.clone()),
        "smallint" => (Codec::I16, q.clone()),
        "integer" => (Codec::I32, q.clone()),
        "bigint" => (Codec::I64, q.clone()),
        "real" => (Codec::F32, q.clone()),
        "double precision" => (Codec::F64, q.clone()),
        // sqlx refuses to decode a PostgreSQL `numeric` straight into `f64`
        // (NUMERIC maps to a decimal type, not FLOAT8), so read it through a
        // `::double precision` cast. Precision beyond f64 is dropped - the same
        // parity the portable format already accepts for numeric values.
        "numeric" => (Codec::F64, format!("{q}::double precision")),
        "uuid" => (Codec::Uuid, q.clone()),
        "json" | "jsonb" => (Codec::Json, q.clone()),
        "bytea" => (Codec::Blob, q.clone()),
        "date" => (Codec::Date, q.clone()),
        "timestamp with time zone" => (Codec::DateTime, q.clone()),
        "timestamp without time zone" => (Codec::DateTimeNaive, q.clone()),
        "time without time zone" | "time with time zone" => (Codec::Text, format!("{q}::text")),
        // A PostgreSQL array (`text[]`, `uuid[]`, …) has no equivalent on MySQL
        // or SQLite; `to_jsonb` turns it into a JSON array, the portable shape
        // the schema already uses for lists on the other engines.
        "array" => (Codec::Json, format!("to_jsonb({q})")),
        // An `inet` reads through `abbrev()`, its display form: a host address
        // stays `192.0.2.1`, a network keeps its mask (`10.0.0.0/8`). The text
        // cast always spells the mask (`192.0.2.1/32`), which then landed in the
        // VARCHAR/TEXT column of MySQL/SQLite and no longer compared equal to the
        // addresses the application writes there.
        "inet" => (Codec::Text, format!("abbrev({q})")),
        // `citext`, `cidr`/`macaddr`, and any enum/domain: no generic decode, but
        // a `::text` cast reads faithfully into a text column.
        "cidr" | "macaddr" | "macaddr8" | "user-defined" => {
            (Codec::Text, format!("{q}::text"))
        }
        // character varying / text / char / and anything else travels as text.
        // The `::text` cast is a no-op for character types but is what lets an
        // exotic-but-text-representable type (e.g. `tsvector`, ranges) be read at
        // all - decoding it into a `String` directly is refused by the driver.
        _ => {
            let _ = udt;
            (Codec::Text, format!("{q}::text"))
        }
    };
    Col { name, codec, read_expr }
}

// MySQL -----------------------------------------------------------------------

async fn mysql_tables_and_edges(
    pool: &DbPool,
    schema: &str,
) -> Result<(Vec<String>, Vec<(String, String)>), AdminError> {
    let names: Vec<String> = pool
        .fetch_all_as::<(String,)>(
            "SELECT table_name FROM information_schema.tables \
              WHERE table_schema = $1 AND table_type = 'BASE TABLE' \
                AND table_name <> '_sqlx_migrations'",
            params![schema],
        )
        .await?
        .into_iter()
        .map(|(n,)| n)
        .collect();

    let edges: Vec<(String, String)> = pool
        .fetch_all_as::<(String, String)>(
            "SELECT referenced_table_name AS parent, table_name AS child \
               FROM information_schema.key_column_usage \
              WHERE table_schema = $1 AND referenced_table_name IS NOT NULL",
            params![schema],
        )
        .await?;
    Ok((names, edges))
}

async fn mysql_columns(
    pool: &DbPool,
    schema: &str,
    table: &str,
) -> Result<Vec<Col>, AdminError> {
    let rows: Vec<(String, String, String)> = pool
        .fetch_all_as(
            "SELECT column_name, data_type, column_type FROM information_schema.columns \
              WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
            params![schema, table],
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|(name, data_type, column_type)| {
            let q = quote_ident(&name);
            // A MySQL/MariaDB `DECIMAL`/`NUMERIC` does not decode into `f64`
            // directly, so read it through a `CAST(... AS DOUBLE)` - mirroring the
            // PostgreSQL `numeric` handling.
            let read_expr = match data_type.to_ascii_lowercase().as_str() {
                "decimal" | "numeric" => format!("CAST({q} AS DOUBLE)"),
                _ => q,
            };
            Col { codec: mysql_codec(&data_type, &column_type), name, read_expr }
        })
        .collect())
}

fn mysql_codec(data_type: &str, column_type: &str) -> Codec {
    match data_type.to_ascii_lowercase().as_str() {
        // Fixed-width BINARY(16) is Kubuno's UUID (always exactly 16 bytes). A
        // VARBINARY(16) is variable and holds opaque bytes shorter than 16 (an
        // AES-GCM nonce is 12), so it must NOT be read as a UUID or the decode
        // fails on the short value - it is a blob.
        "binary" if column_type.to_ascii_lowercase().contains("(16)") => Codec::Uuid,
        "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob" => Codec::Blob,
        // tinyint(1) is the boolean convention.
        "tinyint" if column_type.to_ascii_lowercase().contains("(1)") => Codec::Bool,
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" => Codec::I64,
        "float" => Codec::F32,
        "decimal" | "numeric" | "double" => Codec::F64,
        "json" => Codec::Json,
        "datetime" | "timestamp" => Codec::DateTime,
        "date" => Codec::Date,
        _ => Codec::Text,
    }
}

// SQLite ----------------------------------------------------------------------

async fn sqlite_tables_and_edges(
    pool: &DbPool,
    schema: &str,
) -> Result<(Vec<String>, Vec<(String, String)>), AdminError> {
    let sql = format!(
        "SELECT name FROM {}.sqlite_master \
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations'",
        quote_ident(schema)
    );
    let names: Vec<String> = pool
        .fetch_all_as::<(String,)>(&sql, params![])
        .await?
        .into_iter()
        .map(|(n,)| n)
        .collect();

    let mut edges = Vec::new();
    for child in &names {
        // PRAGMA foreign_key_list returns: id, seq, table(parent), from, to, …
        let sql = format!(
            "PRAGMA {}.foreign_key_list({})",
            quote_ident(schema),
            quote_ident(child)
        );
        let fk_rows = pool.fetch_all_row(&sql, params![]).await?;
        for row in &fk_rows {
            if let Ok(parent) = row.try_get::<String>("table") {
                edges.push((parent, child.clone()));
            }
        }
    }
    Ok((names, edges))
}

async fn sqlite_columns(
    pool: &DbPool,
    schema: &str,
    table: &str,
) -> Result<Vec<Col>, AdminError> {
    let sql = format!(
        "PRAGMA {}.table_info({})",
        quote_ident(schema),
        quote_ident(table)
    );
    let rows = pool.fetch_all_row(&sql, params![]).await?;
    let mut out = Vec::new();
    for row in &rows {
        // table_info columns: cid, name, type, notnull, dflt_value, pk.
        let name: String = row.try_get("name")?;
        let decl: String = row.try_get("type")?;
        let read_expr = quote_ident(&name);
        out.push(Col { codec: sqlite_codec(&decl), name, read_expr });
    }
    Ok(out)
}

fn sqlite_codec(decl: &str) -> Codec {
    let d = decl.to_ascii_uppercase();
    if d.contains("INT") {
        Codec::I64
    } else if d.contains("BLOB") {
        Codec::Blob
    } else if d.contains("REAL") || d.contains("FLOA") || d.contains("DOUB") || d.contains("NUMERIC")
        || d.contains("DECIMAL")
    {
        Codec::F64
    } else {
        Codec::Text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn safe_ident_rules() {
        assert!(is_safe_ident("kub_"));
        assert!(is_safe_ident("core"));
        assert!(!is_safe_ident("Kub"));
        assert!(!is_safe_ident("a.b"));
        assert!(!is_safe_ident(""));
    }

    #[test]
    fn pg_codecs_by_type() {
        let codec = |dt: &str, udt: &str| pg_col("c".into(), dt, udt).codec;
        assert_eq!(codec("boolean", "bool"), Codec::Bool);
        assert_eq!(codec("smallint", "int2"), Codec::I16);
        assert_eq!(codec("integer", "int4"), Codec::I32);
        assert_eq!(codec("bigint", "int8"), Codec::I64);
        assert_eq!(codec("real", "float4"), Codec::F32);
        assert_eq!(codec("double precision", "float8"), Codec::F64);
        assert_eq!(codec("uuid", "uuid"), Codec::Uuid);
        assert_eq!(codec("jsonb", "jsonb"), Codec::Json);
        assert_eq!(codec("bytea", "bytea"), Codec::Blob);
        assert_eq!(codec("timestamp with time zone", "timestamptz"), Codec::DateTime);
        assert_eq!(codec("character varying", "varchar"), Codec::Text);
    }

    #[test]
    fn pg_exotic_types_are_cast_to_a_portable_shape() {
        // An array reads through `to_jsonb`, and citext/inet through `::text`,
        // so a driver without those types can still decode the copy.
        let arr = pg_col("tags".into(), "ARRAY", "_text");
        assert_eq!(arr.codec, Codec::Json);
        assert!(arr.read_expr.contains("to_jsonb"));
        let em = pg_col("email".into(), "USER-DEFINED", "citext");
        assert_eq!(em.codec, Codec::Text);
        assert!(em.read_expr.ends_with("::text"));
        // `inet` keeps its display form (no `/32` on a host address).
        let ip = pg_col("ip".into(), "inet", "inet");
        assert_eq!(ip.codec, Codec::Text);
        assert_eq!(ip.read_expr, "abbrev(\"ip\")");
        let net = pg_col("net".into(), "cidr", "cidr");
        assert!(net.read_expr.ends_with("::text"));
    }

    #[test]
    fn mysql_codecs_by_type() {
        assert_eq!(mysql_codec("binary", "binary(16)"), Codec::Uuid);
        assert_eq!(mysql_codec("binary", "binary(32)"), Codec::Blob);
        assert_eq!(mysql_codec("tinyint", "tinyint(1)"), Codec::Bool);
        assert_eq!(mysql_codec("int", "int"), Codec::I64);
        assert_eq!(mysql_codec("json", "json"), Codec::Json);
        assert_eq!(mysql_codec("datetime", "datetime(6)"), Codec::DateTime);
    }

    #[test]
    fn sqlite_codecs_by_decl() {
        assert_eq!(sqlite_codec("INTEGER"), Codec::I64);
        assert_eq!(sqlite_codec("BLOB"), Codec::Blob);
        assert_eq!(sqlite_codec("REAL"), Codec::F64);
        assert_eq!(sqlite_codec("TEXT"), Codec::Text);
    }

    #[test]
    fn plan_rebuild_only_helps_a_strict_destination() {
        // A SQLite destination is lenient - never rebuilt.
        assert_eq!(plan_rebuild(Backend::Sqlite, Codec::Blob, Codec::Uuid), None);
        // SQLite→PostgreSQL: the poor storage classes are rebuilt to the strict type.
        assert_eq!(plan_rebuild(Backend::Postgres, Codec::Blob, Codec::Uuid), Some(Target::Uuid));
        assert_eq!(plan_rebuild(Backend::Postgres, Codec::Text, Codec::Uuid), Some(Target::Uuid));
        assert_eq!(plan_rebuild(Backend::Postgres, Codec::I64, Codec::Bool), Some(Target::Bool));
        assert_eq!(plan_rebuild(Backend::Postgres, Codec::Text, Codec::Json), Some(Target::Json));
        assert_eq!(plan_rebuild(Backend::Postgres, Codec::Text, Codec::Date), Some(Target::Date));
        assert_eq!(
            plan_rebuild(Backend::Postgres, Codec::Text, Codec::DateTime),
            Some(Target::DateTime)
        );
        assert_eq!(
            plan_rebuild(Backend::Postgres, Codec::Text, Codec::DateTimeNaive),
            Some(Target::DateTime)
        );
        // MariaDB LONGTEXT (read as Text) → PostgreSQL jsonb is the JSON rebuild.
        assert_eq!(plan_rebuild(Backend::MySql, Codec::Text, Codec::Json), Some(Target::Json));
        // Already-matching pairs (PostgreSQL source, or same type) stay pass-through.
        assert_eq!(plan_rebuild(Backend::Postgres, Codec::Uuid, Codec::Uuid), None);
        assert_eq!(plan_rebuild(Backend::Postgres, Codec::Json, Codec::Json), None);
        assert_eq!(plan_rebuild(Backend::Postgres, Codec::DateTime, Codec::DateTime), None);
        assert_eq!(plan_rebuild(Backend::MySql, Codec::Uuid, Codec::Uuid), None);
    }

    #[test]
    fn rebuild_reconstructs_each_strict_type() {
        let u = uuid::Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        // uuid from a 16-byte blob and from text.
        assert_eq!(
            rebuild_cell(DbValue::Blob(Some(u.as_bytes().to_vec())), Target::Uuid, "t", "id").unwrap(),
            DbValue::Uuid(Some(u))
        );
        assert_eq!(
            rebuild_cell(DbValue::Text(Some(u.to_string())), Target::Uuid, "t", "id").unwrap(),
            DbValue::Uuid(Some(u))
        );
        // boolean from integer.
        assert_eq!(
            rebuild_cell(DbValue::I64(Some(1)), Target::Bool, "t", "a").unwrap(),
            DbValue::Bool(Some(true))
        );
        assert_eq!(
            rebuild_cell(DbValue::I64(Some(0)), Target::Bool, "t", "a").unwrap(),
            DbValue::Bool(Some(false))
        );
        // json from text.
        assert_eq!(
            rebuild_cell(DbValue::Text(Some(r#"{"k":3}"#.into())), Target::Json, "t", "m").unwrap(),
            DbValue::Json(Some(serde_json::json!({ "k": 3 })))
        );
        // NULLs stay typed NULLs.
        assert_eq!(rebuild_cell(DbValue::Blob(None), Target::Uuid, "t", "id").unwrap(), DbValue::Uuid(None));
        assert_eq!(rebuild_cell(DbValue::I64(None), Target::Bool, "t", "a").unwrap(), DbValue::Bool(None));
        assert_eq!(rebuild_cell(DbValue::Text(None), Target::Json, "t", "m").unwrap(), DbValue::Json(None));

        // A bad blob length or non-JSON text is a hard error, not a mis-store.
        assert!(rebuild_cell(DbValue::Blob(Some(vec![1, 2, 3])), Target::Uuid, "t", "id").is_err());
        assert!(rebuild_cell(DbValue::Text(Some("not json".into())), Target::Json, "t", "m").is_err());
    }

    #[test]
    fn parses_the_timestamp_shapes_sqlite_holds() {
        // sqlx-sqlite writes DateTime<Utc> as RFC 3339.
        let want = Utc.with_ymd_and_hms(2024, 3, 15, 12, 34, 56).unwrap()
            + chrono::Duration::microseconds(123_456);
        assert_eq!(parse_datetime_utc("2024-03-15T12:34:56.123456+00:00"), Some(want));
        // The `strftime('%Y-%m-%d %H:%M:%f')` SQL default (space, millis, no zone).
        assert_eq!(
            parse_datetime_utc("2024-03-15 12:34:56.123"),
            Some(Utc.with_ymd_and_hms(2024, 3, 15, 12, 34, 56).unwrap() + chrono::Duration::milliseconds(123))
        );
        // Seconds only.
        assert_eq!(
            parse_datetime_utc("2020-01-02 03:04:05"),
            Some(Utc.with_ymd_and_hms(2020, 1, 2, 3, 4, 5).unwrap())
        );
        assert_eq!(parse_datetime_utc("nonsense"), None);

        assert_eq!(parse_date("1990-05-20"), NaiveDate::from_ymd_opt(1990, 5, 20));
        assert_eq!(parse_date("1990-05-20T00:00:00"), NaiveDate::from_ymd_opt(1990, 5, 20));
        assert_eq!(parse_date("bad"), None);
    }

    #[test]
    fn json_array_becomes_a_pg_array_literal() {
        assert_eq!(
            json_to_pg_array_literal(&serde_json::json!(["x", "y", "z"])).as_deref(),
            Some(r#"{"x","y","z"}"#)
        );
        // Empty array, embedded quotes/backslashes, and non-string elements.
        assert_eq!(json_to_pg_array_literal(&serde_json::json!([])).as_deref(), Some("{}"));
        assert_eq!(
            json_to_pg_array_literal(&serde_json::json!([r#"a"b\c"#])).as_deref(),
            Some(r#"{"a\"b\\c"}"#)
        );
        assert_eq!(
            json_to_pg_array_literal(&serde_json::json!([1, 2, null, true])).as_deref(),
            Some("{1,2,NULL,true}")
        );
        // A non-array JSON value has no array-literal spelling.
        assert_eq!(json_to_pg_array_literal(&serde_json::json!({ "k": 1 })), None);
    }

    #[test]
    fn safe_pg_type_accepts_element_names_only() {
        assert_eq!(safe_pg_type("_text").as_deref(), Some("text"));
        assert_eq!(safe_pg_type("_uuid").as_deref(), Some("uuid"));
        assert_eq!(safe_pg_type("_int4").as_deref(), Some("int4"));
        assert_eq!(safe_pg_type("_var char"), None);
        assert_eq!(safe_pg_type("_"), None);
    }

    #[test]
    fn topo_puts_parents_first() {
        let names = vec!["child".to_string(), "parent".to_string()];
        let edges = vec![("parent".to_string(), "child".to_string())];
        let ordered = topo_order(&names, &edges);
        let pi = ordered.iter().position(|n| n == "parent").unwrap();
        let ci = ordered.iter().position(|n| n == "child").unwrap();
        assert!(pi < ci, "parent must be ordered before child");
    }
}
