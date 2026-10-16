//! The portable backup: an engine-neutral, data-only dump of **every Kubuno
//! schema**, and the loader that reads it back onto **any** engine.
//!
//! ## One format, every engine, cross-restorable
//!
//! This is the format the scheduler writes and the admin console restores, on
//! PostgreSQL, MySQL/MariaDB and SQLite alike. A backup taken on one engine
//! restores faithfully onto another: the writer reads each value at its source
//! type into a portable JSON shape (a PostgreSQL array/`inet`/`citext` is cast on
//! the way out), and the loader is **directed by the destination column's own
//! type** - the exact reconstruction a live engine switch performs
//! ([`kubuno_db::copy_schema`]): a `BLOB`/`TEXT` becomes a `uuid`, an integer a
//! boolean, ISO text a timestamp, JSON text a `json`/`jsonb`, and a JSON array a
//! native `text[]`/`uuid[]` through a `$n::<elem>[]` cast. That machinery is
//! reused, not re-written, so what round-trips through an engine switch
//! round-trips through a backup.
//!
//! ## The format (gzip-compressed NDJSON)
//!
//! ```text
//! {"kubuno_dump":3,"engine":"sqlite","kubuno_version":"…","taken_at":"…","compressed":true,"tables":[["core","settings"]]}
//! {"schema":"core","table":"settings","columns":[["key","text"],["value","json"]]}
//! {"cells":["theme","\"dark\""]}
//! ```
//!
//! The `engine` is informational; restore adapts to the engine of the current
//! instance, never to the one the backup came from.

use std::path::Path;

use anyhow::{bail, Context};
use base64::Engine as _;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use kubuno_db::{params, Backend, Codec, DbPool, DbValue};
use serde_json::{json, Value};
use tokio::io::AsyncBufReadExt;

use super::archive::{self, GzFileWriter, QTable};
use super::dump::{ensure_directory, free_bytes, DumpOutcome, ABORT_FREE_BYTES, MIN_FREE_BYTES, PARTIAL_SUFFIX};

/// The base64 alphabet used for binary/UUID values.
const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// A `"schema"."table"` qualifier.
fn q(schema: &str, table: &str) -> String {
    format!("\"{}\".\"{}\"", schema.replace('"', "\"\""), table.replace('"', "\"\""))
}

/// The backup feature's own tables, excluded from the backup so a restore never
/// rewrites the history of backups and restores. Their `triggered_by` link to a
/// user is `ON DELETE SET NULL`, so replacing `core.users` during a restore
/// leaves these rows intact (the link simply nulls if that user is gone).
fn is_bookkeeping(table: &str) -> bool {
    matches!(table, "backup_runs" | "backup_restores")
}

fn backend_name(b: Backend) -> &'static str {
    match b {
        Backend::Postgres => "postgres",
        Backend::MySql => "mysql",
        Backend::Sqlite => "sqlite",
    }
}

/// Orders the discovered schemas so `core` comes first (modules reference
/// `core.users`; nothing in `core` references a module), then the rest by name.
/// This satisfies cross-schema foreign keys on the strict engine that keeps them
/// immediate (PostgreSQL) without disabling anything.
fn order_schemas(db: &DbPool, mut schemas: Vec<String>) -> Vec<String> {
    let core = db.schema_prefix().schema("core");
    schemas.sort();
    schemas.sort_by_key(|s| usize::from(*s != core));
    schemas
}

// ── writing ─────────────────────────────────────────────────────────────────

/// Writes one complete portable dump of every Kubuno schema into `destination`.
pub async fn write_dump(db: &DbPool, destination: &Path) -> anyhow::Result<DumpOutcome> {
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

    let started = Utc::now();
    let file_name = archive::file_name_for(started, archive::NDJSON_GZ_EXT);
    let final_path = destination.join(&file_name);
    let partial_path = destination.join(format!("{file_name}{PARTIAL_SUFFIX}"));

    match write_into(db, destination, &partial_path, started).await {
        Ok((schemas, tables, rows)) => {
            tokio::fs::rename(&partial_path, &final_path)
                .await
                .with_context(|| format!("Publication de {}", final_path.display()))?;
            let size_bytes = tokio::fs::metadata(&final_path).await.map(|m| m.len()).unwrap_or(0);
            Ok(DumpOutcome { file_name, path: final_path, size_bytes, schemas, tables, rows })
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
    db: &DbPool,
    destination: &Path,
    partial_path: &Path,
    started: DateTime<Utc>,
) -> anyhow::Result<(usize, usize, u64)> {
    let schemas = order_schemas(db, archive::discover_schemas(db).await?);
    if schemas.is_empty() {
        bail!("Aucun schéma Kubuno trouvé à sauvegarder");
    }

    // The ordered table plan across every schema (parents first, core first).
    let mut plan: Vec<(QTable, Vec<kubuno_db::ExportColumn>)> = Vec::new();
    for schema in &schemas {
        for (table, cols) in kubuno_db::portable_export_plan(db, schema).await? {
            // The backup's own bookkeeping is left out of the backup: a restore
            // must not overwrite the log of backups and restores with an older
            // one - that would erase the record of the restore being performed,
            // and of every backup taken since the one being restored.
            if is_bookkeeping(&table) {
                continue;
            }
            if !cols.is_empty() {
                plan.push((QTable::new(schema.clone(), table), cols));
            }
        }
    }

    let file = tokio::fs::File::create(partial_path)
        .await
        .with_context(|| format!("Création de {}", partial_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The dump carries password hashes; lock it down before the first byte.
        if let Err(e) = file.set_permissions(std::fs::Permissions::from_mode(0o600)).await {
            tracing::warn!(error = %e, "backup: droits 0600 non appliqués au fichier");
        }
    }
    let buffered = tokio::io::BufWriter::with_capacity(256 * 1024, file);
    let mut out = GzFileWriter::new(buffered);

    let header = json!({
        "kubuno_dump": 3,
        "engine": backend_name(db.backend()),
        "kubuno_version": env!("CARGO_PKG_VERSION"),
        "taken_at": started.to_rfc3339(),
        "compressed": true,
        "schemas": schemas,
        "tables": plan.iter().map(|(t, _)| json!([t.schema, t.table])).collect::<Vec<_>>(),
    });
    write_line(&mut out, &header).await?;

    let backend = db.backend();
    let mut total_rows: u64 = 0;
    for (table, cols) in &plan {
        if let Some(free) = free_bytes(destination) {
            if free < ABORT_FREE_BYTES {
                bail!(
                    "Sauvegarde interrompue : il ne reste que {} Mio sur {}",
                    free / (1024 * 1024),
                    destination.display()
                );
            }
        }

        let columns_meta: Vec<Value> =
            cols.iter().map(|c| json!([c.name, c.codec_tag()])).collect();
        write_line(
            &mut out,
            &json!({ "schema": table.schema, "table": table.table, "columns": columns_meta }),
        )
        .await?;

        // The SELECT reads each column through its portable expression, aliased
        // back to its name so `portable_read_row` keys it correctly.
        let select_cols = cols
            .iter()
            .map(|c| format!("{} AS \"{}\"", c.read_expr(), c.name.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("SELECT {select_cols} FROM {}", q(&table.schema, &table.table));
        let rows = db
            .fetch_all_row(&sql, params![])
            .await
            .with_context(|| format!("Export de {}.{}", table.schema, table.table))?;

        for row in &rows {
            let values = kubuno_db::portable_read_row(row, cols, backend)
                .with_context(|| format!("Lecture d'une ligne de {}.{}", table.schema, table.table))?;
            let cells: Vec<Value> = values.iter().map(value_to_json).collect();
            write_line(&mut out, &json!({ "cells": cells })).await?;
            total_rows += 1;
        }
    }

    let mut buffered = out.finish().await?;
    use tokio::io::AsyncWriteExt as _;
    buffered.flush().await.context("Vidage du tampon d'écriture")?;
    buffered.into_inner().sync_all().await.context("Synchronisation du fichier de sauvegarde")?;
    Ok((schemas.len(), plan.len(), total_rows))
}

async fn write_line<W: tokio::io::AsyncWriteExt + Unpin>(
    out: &mut GzFileWriter<W>,
    value: &Value,
) -> anyhow::Result<()> {
    let mut line = serde_json::to_vec(value).context("Sérialisation d'une ligne du dump")?;
    line.push(b'\n');
    out.write_all(&line).await.context("Écriture d'une ligne du dump")?;
    Ok(())
}

/// Serialises one typed [`DbValue`] into its portable JSON form. Binary and UUID
/// travel base64/string; a timestamp as RFC 3339; a date as `YYYY-MM-DD`.
fn value_to_json(v: &DbValue) -> Value {
    match v {
        DbValue::Null => Value::Null,
        DbValue::Bool(o) => o.map_or(Value::Null, Value::from),
        DbValue::I16(o) => o.map_or(Value::Null, |n| Value::from(i64::from(n))),
        DbValue::I32(o) => o.map_or(Value::Null, |n| Value::from(i64::from(n))),
        DbValue::I64(o) => o.map_or(Value::Null, Value::from),
        DbValue::F32(o) => o.map_or(Value::Null, |f| Value::from(f64::from(f))),
        DbValue::F64(o) => o.map_or(Value::Null, Value::from),
        DbValue::Text(o) => o.clone().map_or(Value::Null, Value::from),
        DbValue::Blob(o) => o.as_ref().map_or(Value::Null, |b| Value::String(B64.encode(b))),
        DbValue::Uuid(o) => o.map_or(Value::Null, |u| Value::String(u.to_string())),
        // A JSON value travels as the STRING of its compact JSON, so a genuine
        // JSON `null` (a present value) stays distinct from a SQL NULL (an absent
        // cell): the first becomes the string "null", the second stays `null`.
        // Without this a `NOT NULL jsonb` column holding `'null'` would restore as
        // a SQL NULL and be rejected.
        DbValue::Json(o) => o.as_ref().map_or(Value::Null, |v| Value::String(v.to_string())),
        DbValue::DateTimeUtc(o) => o.map_or(Value::Null, |dt| Value::String(dt.to_rfc3339())),
        DbValue::NaiveDate(o) => o.map_or(Value::Null, |d| Value::String(d.format("%Y-%m-%d").to_string())),
    }
}

/// Rebuilds the raw [`DbValue`] the source recorded, in the variant its codec
/// dictates, so the destination-directed reconstruction ([`kubuno_db::portable_bind_cell`])
/// sees the true source type.
fn json_to_raw(codec: Codec, v: &Value) -> DbValue {
    if v.is_null() {
        return match codec {
            Codec::Bool => DbValue::Bool(None),
            Codec::I16 => DbValue::I16(None),
            Codec::I32 => DbValue::I32(None),
            Codec::I64 => DbValue::I64(None),
            Codec::F32 => DbValue::F32(None),
            Codec::F64 => DbValue::F64(None),
            Codec::Blob => DbValue::Blob(None),
            Codec::Uuid => DbValue::Uuid(None),
            Codec::Json => DbValue::Json(None),
            Codec::Date => DbValue::NaiveDate(None),
            Codec::DateTime | Codec::DateTimeNaive => DbValue::DateTimeUtc(None),
            Codec::Text => DbValue::Text(None),
        };
    }
    match codec {
        Codec::Bool => DbValue::Bool(v.as_bool()),
        Codec::I16 => DbValue::I16(v.as_i64().map(|n| n as i16)),
        Codec::I32 => DbValue::I32(v.as_i64().map(|n| n as i32)),
        Codec::I64 => DbValue::I64(v.as_i64()),
        Codec::F32 => DbValue::F32(v.as_f64().map(|f| f as f32)),
        Codec::F64 => DbValue::F64(v.as_f64()),
        Codec::Text => DbValue::Text(v.as_str().map(str::to_owned)),
        Codec::Blob => DbValue::Blob(v.as_str().and_then(|s| B64.decode(s).ok())),
        Codec::Uuid => DbValue::Uuid(v.as_str().and_then(|s| uuid::Uuid::parse_str(s).ok())),
        // The JSON value travelled as the string of its compact JSON (see
        // `value_to_json`); a raw JSON value (a legacy file) is accepted too.
        Codec::Json => DbValue::Json(Some(match v {
            Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
            other => other.clone(),
        })),
        Codec::Date => DbValue::NaiveDate(v.as_str().and_then(parse_date)),
        Codec::DateTime | Codec::DateTimeNaive => DbValue::DateTimeUtc(v.as_str().and_then(parse_dt)),
    }
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .ok()
        .or_else(|| parse_dt(s).map(|dt| dt.date_naive()))
}

fn parse_dt(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    for fmt in ["%F %T%.f", "%F %T", "%FT%T%.f", "%FT%T"] {
        if let Ok(nd) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(nd, Utc));
        }
    }
    None
}

// ── restore ─────────────────────────────────────────────────────────────────

/// Loads a portable dump (`.ndjson.gz` or a legacy `.ndjson`) onto `db`,
/// replacing the current contents of every table it names - on **any** engine.
/// Returns the number of rows inserted.
pub async fn restore(db: &DbPool, archive_path: &Path) -> anyhow::Result<u64> {
    let temp = archive::decompress_to_temp(archive_path).await?;

    let file = tokio::fs::File::open(temp.path())
        .await
        .with_context(|| format!("Ouverture de {}", temp.path().display()))?;
    let mut lines = tokio::io::BufReader::with_capacity(256 * 1024, file).lines();

    let first = lines
        .next_line()
        .await
        .context("Lecture de l'en-tête du dump")?
        .context("Dump vide : en-tête manquant")?;
    let header: Value = serde_json::from_str(&first).context("En-tête du dump illisible")?;
    if header.get("kubuno_dump").is_none() {
        bail!("Ce fichier n'est pas un dump portable Kubuno");
    }
    // v2/v3 tables are `[schema, table]`; v1 tables are bare names in `core`.
    let tables: Vec<QTable> = header
        .get("tables")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| match entry {
                    Value::Array(pair) => {
                        let schema = pair.first()?.as_str()?.to_string();
                        let table = pair.get(1)?.as_str()?.to_string();
                        Some(QTable::new(schema, table))
                    }
                    Value::String(name) => Some(QTable::new("core", name.clone())),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();

    let backend = db.backend();

    // Load every covered table's destination plan up front. A table the
    // destination does not have (a module the current instance has not installed,
    // or a schema not attached) is **skipped** - a cross-engine restore adapts to
    // the instance it runs on rather than failing on a table it cannot hold.
    let mut plans: std::collections::HashMap<QTable, std::collections::HashMap<String, kubuno_db::ImportColumn>> =
        std::collections::HashMap::new();
    let mut present: Vec<QTable> = Vec::new();
    for t in &tables {
        // An absent schema/table is skipped, not fatal: on some engines the
        // catalog lookup returns empty, on SQLite it errors ("unknown database"
        // for a schema this instance has not attached). Both mean the same thing -
        // this instance does not hold that table - so a cross-engine restore
        // adapts to what it can hold rather than failing.
        let plan = match kubuno_db::portable_import_plan(db, &t.schema, &t.table).await {
            Ok(plan) if !plan.is_empty() => plan,
            Ok(_) => {
                tracing::warn!(table = %format!("{}.{}", t.schema, t.table), "backup: table absente de cette instance - ignorée à la restauration");
                continue;
            }
            Err(e) => {
                tracing::warn!(error = %e, table = %format!("{}.{}", t.schema, t.table), "backup: table injoignable sur cette instance - ignorée à la restauration");
                continue;
            }
        };
        present.push(t.clone());
        plans.insert(t.clone(), plan);
    }

    let inserted;
    {
        let mut tx = db.begin().await.context("Ouverture de la transaction de restauration")?;

        // Relax foreign-key enforcement for the load - the strict engine keeps
        // its immediate constraints, satisfied by the core-first, parent-first
        // order the dump was written in.
        match backend {
            Backend::MySql => {
                tx.execute("SET FOREIGN_KEY_CHECKS = 0", params![]).await?;
            }
            Backend::Sqlite => {
                tx.execute("PRAGMA defer_foreign_keys = ON", params![]).await?;
            }
            Backend::Postgres => {}
        }

        // PostgreSQL: disable application triggers for the load (owner privilege).
        // `core.settings` carries an AFTER INSERT trigger that mirrors rows into
        // `core.setting_values` (migration 000060); left live, restoring both
        // tables makes the second insert collide with the row the first caused.
        if backend == Backend::Postgres {
            for t in &present {
                let sql = format!("ALTER TABLE {} DISABLE TRIGGER USER", q(&t.schema, &t.table));
                if let Err(e) = tx.execute(&sql, params![]).await {
                    tracing::warn!(error = %e, table = %t.table, "backup: désactivation des triggers impossible");
                }
            }
        }

        // Empty every present covered table, in reverse of the dump order.
        for t in present.iter().rev() {
            let sql = format!("DELETE FROM {}", q(&t.schema, &t.table));
            tx.execute(&sql, params![])
                .await
                .with_context(|| format!("Vidage de {}.{}", t.schema, t.table))?;
        }

        // Stream: a table marker sets the current schema/columns; each row is
        // rebuilt for the destination and inserted. Rows for an absent table are
        // dropped along with it.
        let mut current: Option<TableCtx> = None;
        let mut n: u64 = 0;
        while let Some(line) = lines.next_line().await.context("Lecture d'une ligne du dump")? {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(&line).context("Ligne du dump illisible")?;
            if let Some(table) = value.get("table").and_then(|t| t.as_str()) {
                let schema = value.get("schema").and_then(|s| s.as_str()).unwrap_or("core").to_string();
                let qt = QTable::new(schema.clone(), table.to_string());
                current = plans.remove(&qt).map(|plan| TableCtx {
                    schema,
                    table: table.to_string(),
                    columns: parse_columns(value.get("columns")),
                    plan,
                });
            } else if let Some(cells) = value.get("cells").and_then(|c| c.as_array()) {
                if let Some(ctx) = current.as_ref() {
                    insert_row(&mut tx, backend, ctx, cells).await?;
                    n += 1;
                }
            }
        }

        // Application triggers back on, inside the same transaction.
        if backend == Backend::Postgres {
            for t in &present {
                let sql = format!("ALTER TABLE {} ENABLE TRIGGER USER", q(&t.schema, &t.table));
                if let Err(e) = tx.execute(&sql, params![]).await {
                    tracing::warn!(error = %e, table = %t.table, "backup: réactivation des triggers impossible");
                }
            }
        }
        if backend == Backend::MySql {
            tx.execute("SET FOREIGN_KEY_CHECKS = 1", params![]).await?;
        }
        tx.commit().await.context("Validation de la restauration")?;
        inserted = n;
    }

    // Auto-increment counters are not part of the row data; realign them so the
    // next insert does not collide with a restored identifier. Best-effort and
    // post-commit (sequences are non-transactional).
    if let Err(e) = realign_autoincrement(db, &present).await {
        tracing::warn!(error = %format!("{e:#}"), "backup: réalignement des séquences incomplet");
    }

    Ok(inserted)
}

/// The current table being loaded: its identity, the source codecs (from the
/// dump), and the destination column plan (from the live catalog).
struct TableCtx {
    schema: String,
    table: String,
    columns: Vec<(String, Codec)>,
    plan: std::collections::HashMap<String, kubuno_db::ImportColumn>,
}

fn parse_columns(value: Option<&Value>) -> Vec<(String, Codec)> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|pair| {
                    let p = pair.as_array()?;
                    let name = p.first()?.as_str()?.to_string();
                    let codec = Codec::from_tag(p.get(1).and_then(|t| t.as_str()).unwrap_or("text"));
                    Some((name, codec))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn insert_row(
    tx: &mut kubuno_db::DbTx,
    backend: Backend,
    ctx: &TableCtx,
    cells: &[Value],
) -> anyhow::Result<()> {
    if ctx.columns.is_empty() {
        return Ok(());
    }
    let mut column_list = String::new();
    let mut placeholders = String::new();
    let mut binds: Vec<DbValue> = Vec::with_capacity(ctx.columns.len());

    for (i, (name, src_codec)) in ctx.columns.iter().enumerate() {
        let raw = json_to_raw(*src_codec, cells.get(i).unwrap_or(&Value::Null));
        // Destination-directed: rebuild the value into the destination column's
        // strict type (or pass through), exactly as an engine switch would.
        let (bound, cast) = kubuno_db::portable_bind_cell(
            backend,
            *src_codec,
            ctx.plan.get(name),
            raw,
            &ctx.table,
            name,
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?;

        if i > 0 {
            column_list.push_str(", ");
            placeholders.push_str(", ");
        }
        column_list.push('"');
        column_list.push_str(&name.replace('"', "\"\""));
        column_list.push('"');
        placeholders.push('$');
        placeholders.push_str(&(i + 1).to_string());
        // A write cast the destination column needs (`::uuid[]`, `::inet`, …).
        if let Some(suffix) = cast {
            placeholders.push_str(&suffix);
        }
        binds.push(bound);
    }

    let sql = format!(
        "INSERT INTO {} ({column_list}) VALUES ({placeholders})",
        q(&ctx.schema, &ctx.table)
    );
    tx.execute(&sql, binds)
        .await
        .with_context(|| format!("Insertion dans {}.{}", ctx.schema, ctx.table))?;
    Ok(())
}

/// Realigns identity generators after a restore that inserted explicit ids:
/// PostgreSQL sequences and MySQL `AUTO_INCREMENT`. SQLite's `rowid` self-heals
/// (it always picks `max + 1`), so nothing is needed there.
async fn realign_autoincrement(db: &DbPool, tables: &[QTable]) -> anyhow::Result<()> {
    match db.backend() {
        Backend::Postgres => realign_pg_sequences(db, tables).await,
        Backend::MySql => realign_mysql_autoincrement(db, tables).await,
        Backend::Sqlite => Ok(()),
    }
}

#[derive(sqlx::FromRow)]
struct SeqRow {
    schema: String,
    seq: String,
    tbl: String,
    col: String,
}

async fn realign_pg_sequences(db: &DbPool, tables: &[QTable]) -> anyhow::Result<()> {
    let Some(pg) = db.as_pg() else { return Ok(()) };
    let schemas: Vec<String> = {
        let mut s: Vec<String> = tables.iter().map(|t| t.schema.clone()).collect();
        s.sort();
        s.dedup();
        s
    };
    // Every sequence owned by a column of a covered schema, with that column. The
    // `= ANY($1)` array is bound on the raw PostgreSQL pool as a real `text[]`.
    let rows: Vec<SeqRow> = sqlx::query_as::<_, SeqRow>(
        "SELECT n.nspname AS schema, s.relname AS seq, t.relname AS tbl, a.attname AS col \
           FROM pg_class s \
           JOIN pg_depend d  ON d.objid = s.oid AND d.deptype = 'a' \
           JOIN pg_class t   ON t.oid = d.refobjid \
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
           JOIN pg_namespace n ON n.oid = s.relnamespace \
          WHERE s.relkind = 'S' AND n.nspname = ANY($1)",
    )
    .bind(&schemas)
    .fetch_all(pg)
    .await
    .context("Lecture des séquences PostgreSQL")?;

    for r in rows {
        let seq_lit = format!("'{}.{}'", r.schema.replace('\'', "''"), r.seq.replace('\'', "''"));
        let tbl = q(&r.schema, &r.tbl);
        let col = format!("\"{}\"", r.col.replace('"', "\"\""));
        let sql = format!(
            "SELECT setval({seq_lit}, COALESCE((SELECT MAX({col}) FROM {tbl}), 1), \
                    (SELECT MAX({col}) FROM {tbl}) IS NOT NULL)"
        );
        if let Err(e) = db.execute(&sql, params![]).await {
            tracing::warn!(error = %e, séquence = %r.seq, "backup: setval d'une séquence impossible");
        }
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct MyAutoRow {
    tbl: String,
    col: String,
}

async fn realign_mysql_autoincrement(db: &DbPool, tables: &[QTable]) -> anyhow::Result<()> {
    for t in tables {
        let cols: Vec<MyAutoRow> = db
            .fetch_all_as(
                "SELECT table_name AS tbl, column_name AS col FROM information_schema.columns \
                  WHERE table_schema = $1 AND table_name = $2 AND extra LIKE '%auto_increment%'",
                params![&t.schema, &t.table],
            )
            .await
            .unwrap_or_default();
        let Some(c) = cols.into_iter().next() else { continue };
        // MAX+1, or 1 for an empty table.
        let next: i64 = db
            .fetch_scalar::<i64>(
                &format!(
                    "SELECT COALESCE(MAX(`{}`), 0) + 1 FROM {}",
                    c.col.replace('`', "``"),
                    q(&t.schema, &t.table)
                ),
                params![],
            )
            .await
            .unwrap_or(1);
        let sql = format!("ALTER TABLE {} AUTO_INCREMENT = {next}", q(&t.schema, &c.tbl));
        if let Err(e) = db.execute(&sql, params![]).await {
            tracing::warn!(error = %e, table = %t.table, "backup: réalignement AUTO_INCREMENT impossible");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_json_round_trips_each_codec() {
        // A UUID travels as its canonical string, a blob as base64, a timestamp
        // as RFC 3339 - and comes back the same raw variant.
        let u = uuid::Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let j = value_to_json(&DbValue::Uuid(Some(u)));
        assert_eq!(json_to_raw(Codec::Uuid, &j), DbValue::Uuid(Some(u)));

        let blob = vec![0u8, 1, 2, 255];
        let j = value_to_json(&DbValue::Blob(Some(blob.clone())));
        assert_eq!(json_to_raw(Codec::Blob, &j), DbValue::Blob(Some(blob)));

        // A typed NULL stays a typed NULL of the same variant.
        assert_eq!(json_to_raw(Codec::Uuid, &Value::Null), DbValue::Uuid(None));
        assert_eq!(json_to_raw(Codec::Bool, &Value::Null), DbValue::Bool(None));
    }

    #[test]
    fn dates_and_times_parse_back() {
        assert!(parse_date("2026-09-22").is_some());
        assert!(parse_dt("2026-09-22T03:04:05+00:00").is_some());
        assert!(parse_dt("2026-09-22 03:04:05.123456").is_some());
        assert!(parse_dt("nope").is_none());
    }
}
