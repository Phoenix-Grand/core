//! Translating MariaDB-flavoured MySQL migrations for Oracle MySQL.
//!
//! Kubuno's `migrations/mysql` files are written for the MySQL family, but a few
//! constructs MariaDB accepts are refused by Oracle MySQL 8:
//!
//! * a literal default on a `TEXT`/`BLOB`/`JSON` column (`kind TEXT NOT NULL
//!   DEFAULT 'text'`) - error 1101. MySQL ≥ 8.0.13 takes the same default as an
//!   expression: `DEFAULT ('text')`.
//! * a `TEXT`/`BLOB` column in a key without a prefix length - error 1170
//!   (MariaDB hashes long unique keys on its own). A `UNIQUE` key part becomes
//!   the functional part `(SHA2(col, 256))`, which keeps the exact uniqueness the
//!   column had; a plain index gets a prefix length instead.
//! * an index on a `JSON` column (a `LONGTEXT` alias on MariaDB) - error 3152.
//!   MySQL cannot index JSON directly, so such an index is skipped: it only ever
//!   served as a lookup accelerator.
//!
//! [`rewrite`] turns one migration's SQL into the MySQL form. It is NOT applied
//! at run time: the generator in `main.rs` writes its output as reviewable
//! `migrations/mysql-oracle/` flavour variants (see `kubuno_db::MySqlVariants`),
//! which are then committed and tested on a real server like any migration.
//!
//! The rewrite is line-oriented, matching how Kubuno writes its MySQL DDL: one
//! column, key or `CREATE INDEX` per line. Anything it does not recognise is left
//! exactly as written.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

/// The column kinds the rewrite needs to know about.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ColKind {
    /// `TEXT`/`BLOB` and their tiny/medium/long variants.
    Lob,
    Json,
}

/// Column kinds learnt so far, per table (lower-cased names). Shared across the
/// migrations of one set, applied in order, so a `CREATE INDEX` in a later
/// migration still knows the columns an earlier one created.
#[derive(Default, Debug)]
pub(crate) struct Catalog {
    tables: HashMap<String, HashMap<String, ColKind>>,
}

impl Catalog {
    fn kind(&self, table: &str, column: &str) -> Option<ColKind> {
        self.tables
            .get(&table.to_ascii_lowercase())
            .and_then(|t| t.get(&column.to_ascii_lowercase()))
            .copied()
    }

    fn learn(&mut self, table: &str, column: &str, kind: Option<ColKind>) {
        let cols = self.tables.entry(table.to_ascii_lowercase()).or_default();
        match kind {
            Some(k) => {
                cols.insert(column.to_ascii_lowercase(), k);
            }
            None => {
                cols.remove(&column.to_ascii_lowercase());
            }
        }
    }
}

/// Prefix length given to a `TEXT`/`BLOB` part of a plain (non-unique) index:
/// 191 characters × 4 bytes stays under InnoDB's 767-byte compact limit too.
const INDEX_PREFIX: u32 = 191;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

/// `CREATE TABLE [IF NOT EXISTS] [db.]name`
fn create_table_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?\w+`?\.)?`?(\w+)`?")
}

/// `ALTER TABLE [db.]name`
fn alter_table_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)^\s*ALTER\s+TABLE\s+(?:`?\w+`?\.)?`?(\w+)`?")
}

/// A column definition: `[ADD|MODIFY [COLUMN]] `name` TYPE…` - captures the lead
/// (keyword + name), the name, and the type keyword.
fn column_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)^(\s*(?:(?:ALTER\s+TABLE\s+\S+\s+)?(?:ADD|MODIFY)\s+(?:COLUMN\s+)?)?`?(\w+)`?\s+)([a-z]+)\b",
    )
}

/// A literal default: `DEFAULT 'literal'` (quotes doubled inside).
fn literal_default_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)\bDEFAULT\s+('(?:[^']|'')*')")
}

/// A key inside a table body or an `ALTER TABLE … ADD`: the head up to its
/// column list, and the list itself.
fn table_key_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)^(\s*(?:ALTER\s+TABLE\s+\S+\s+)?(?:ADD\s+)?(?:CONSTRAINT\s+`?\w+`?\s+)?(UNIQUE(?:\s+(?:KEY|INDEX))?|PRIMARY\s+KEY|KEY|INDEX)(?:\s+`?\w+`?)?\s*)\(([^()]*(?:\(\d+\)[^()]*)*)\)",
    )
}

/// `CREATE [UNIQUE] INDEX name ON [db.]table (cols)`
fn create_index_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)^(\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?\w+`?\s+ON\s+(?:`?\w+`?\.)?`?(\w+)`?\s*)\(([^()]*(?:\(\d+\)[^()]*)*)\)",
    )
}

fn lob_or_json(type_word: &str) -> Option<ColKind> {
    match type_word.to_ascii_lowercase().as_str() {
        "text" | "tinytext" | "mediumtext" | "longtext" | "blob" | "tinyblob" | "mediumblob"
        | "longblob" => Some(ColKind::Lob),
        "json" => Some(ColKind::Json),
        _ => None,
    }
}

/// How a key's column list must change on MySQL.
enum KeyRewrite {
    /// Nothing to do.
    Keep,
    /// The rewritten column list.
    Columns(String),
    /// The key cannot exist on MySQL (it covers a JSON column).
    Drop,
}

fn rewrite_key_columns(cols: &str, unique: bool, table: &str, catalog: &Catalog) -> KeyRewrite {
    let mut changed = false;
    let mut out = Vec::new();
    for part in cols.split(',') {
        let trimmed = part.trim();
        // The column a key part names, before any prefix length or ASC/DESC.
        let ident = trimmed.split(['(', ' ']).next().unwrap_or("");
        let name = ident.trim_matches('`');
        // Only a bare column (no prefix length, no ASC/DESC, no expression).
        let bare = ident.len() == trimmed.len()
            && !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        match (bare, catalog.kind(table, name)) {
            (_, Some(ColKind::Json)) => return KeyRewrite::Drop,
            (true, Some(ColKind::Lob)) => {
                changed = true;
                if unique {
                    out.push(format!("(SHA2(`{name}`, 256))"));
                } else {
                    out.push(format!("`{name}`({INDEX_PREFIX})"));
                }
            }
            _ => out.push(trimmed.to_string()),
        }
    }
    if changed {
        KeyRewrite::Columns(out.join(", "))
    } else {
        KeyRewrite::Keep
    }
}

/// Rewrites one migration for Oracle MySQL, learning column kinds into `catalog`
/// as it goes. SQL that needs no change comes back byte-identical.
pub(crate) fn rewrite(sql: &str, catalog: &mut Catalog) -> String {
    let mut current_table: Option<String> = None;
    let mut out = String::with_capacity(sql.len() + 64);
    for (i, line) in sql.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&rewrite_line(line, &mut current_table, catalog));
    }
    out
}

fn rewrite_line(line: &str, current_table: &mut Option<String>, catalog: &mut Catalog) -> String {
    let code = line.trim_start();
    if code.starts_with("--") || code.starts_with('#') || code.is_empty() {
        return line.to_string();
    }

    // Track the table a body or an ALTER TABLE line belongs to.
    if let Some(c) = create_table_re().captures(line) {
        *current_table = Some(c[1].to_string());
        // A one-line `CREATE TABLE t (...)` holds its columns on this line too;
        // the multi-line form (the norm) is handled line by line below.
        return line.to_string();
    }
    let alter_table = alter_table_re().captures(line).map(|c| c[1].to_string());
    if let Some(t) = &alter_table {
        *current_table = Some(t.clone());
    }

    // `CREATE [UNIQUE] INDEX … ON t (cols)`
    if let Some(c) = create_index_re().captures(line) {
        let unique = c.get(2).is_some();
        let table = c[3].to_string();
        return match rewrite_key_columns(&c[4], unique, &table, catalog) {
            KeyRewrite::Keep => line.to_string(),
            KeyRewrite::Columns(cols) => {
                let whole = c.get(0).map(|m| m.range()).unwrap_or(0..0);
                format!("{}{}({cols}){}", &line[..whole.start], &c[1], &line[whole.end..])
            }
            KeyRewrite::Drop => format!(
                "-- kubuno-db: index skipped on MySQL (a JSON column cannot be indexed): {}",
                line.trim()
            ),
        };
    }

    let Some(table) = current_table.clone() else {
        return line.to_string();
    };

    // A key inside the table body (or added by ALTER TABLE … ADD).
    if let Some(c) = table_key_re().captures(line) {
        let head = c[2].to_ascii_uppercase();
        // A primary key cannot hold a functional part: it is left for the server
        // to judge (no Kubuno schema keys a primary key on TEXT).
        if head.starts_with("PRIMARY") {
            return line.to_string();
        }
        let unique = head.starts_with("UNIQUE");
        return match rewrite_key_columns(&c[3], unique, &table, catalog) {
            KeyRewrite::Keep => line.to_string(),
            KeyRewrite::Columns(cols) => {
                let whole = c.get(0).map(|m| m.range()).unwrap_or(0..0);
                format!("{}{}({cols}){}", &line[..whole.start], &c[1], &line[whole.end..])
            }
            // Dropping a key line would break the surrounding comma list; neutralise
            // it as a plain index on nothing is impossible, so keep it and let the
            // server report it (no Kubuno schema does this today).
            KeyRewrite::Drop => line.to_string(),
        };
    }

    // A column definition: learn its kind, and turn a literal default on a
    // TEXT/BLOB/JSON column into an expression default.
    if let Some(c) = column_re().captures(line) {
        let name = c[2].to_string();
        let kind = lob_or_json(&c[3]);
        // `KEY`, `CONSTRAINT`, `PRIMARY`… are not columns; they never reach here
        // with a type keyword the catalog cares about, and `learn(None)` on them
        // is harmless.
        let is_keyword = matches!(
            name.to_ascii_uppercase().as_str(),
            "PRIMARY" | "UNIQUE" | "KEY" | "INDEX" | "CONSTRAINT" | "FOREIGN" | "CHECK" | "FULLTEXT"
        );
        if !is_keyword {
            catalog.learn(&table, &name, kind);
        }
        if kind.is_some() && !is_keyword {
            let after_type = c.get(0).map(|m| m.end()).unwrap_or(0);
            let (head, tail) = line.split_at(after_type);
            if literal_default_re().is_match(tail) {
                let tail = literal_default_re().replace(tail, "DEFAULT ($1)");
                return format!("{head}{tail}");
            }
        }
    }
    line.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(sql: &str) -> String {
        rewrite(sql, &mut Catalog::default())
    }

    #[test]
    fn literal_text_default_becomes_an_expression() {
        let sql = "CREATE TABLE `c` (\n    `kind` TEXT NOT NULL DEFAULT 'text',\n    `n` VARCHAR(5) NOT NULL DEFAULT 'text'\n);";
        let out = run(sql);
        assert!(out.contains("`kind` TEXT NOT NULL DEFAULT ('text'),"), "{out}");
        // A VARCHAR keeps its literal default: MySQL accepts it.
        assert!(out.contains("`n` VARCHAR(5) NOT NULL DEFAULT 'text'"), "{out}");
    }

    #[test]
    fn escaped_quotes_and_empty_defaults_are_kept_whole() {
        let out = run("CREATE TABLE t (\n  `a` TEXT NOT NULL DEFAULT '',\n  `b` MEDIUMTEXT DEFAULT 'it''s'\n);");
        assert!(out.contains("`a` TEXT NOT NULL DEFAULT (''),"), "{out}");
        assert!(out.contains("`b` MEDIUMTEXT DEFAULT ('it''s')"), "{out}");
    }

    #[test]
    fn expression_defaults_are_left_alone() {
        let line = "CREATE TABLE t (\n  `scopes` JSON NOT NULL DEFAULT ('[]'),\n  `c` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)\n);";
        assert_eq!(run(line), line);
    }

    #[test]
    fn unique_key_on_text_uses_a_hash_part() {
        let sql = "CREATE TABLE `push_devices` (\n    `provider` VARCHAR(20) NOT NULL,\n    `device_token` TEXT NOT NULL,\n    UNIQUE (`provider`, `device_token`),\n    PRIMARY KEY (`id`)\n);";
        let out = run(sql);
        assert!(out.contains("UNIQUE (`provider`, (SHA2(`device_token`, 256))),"), "{out}");
        assert!(out.contains("PRIMARY KEY (`id`)"), "{out}");
    }

    #[test]
    fn plain_index_on_text_gets_a_prefix_and_existing_prefixes_stay() {
        let sql = "CREATE TABLE t (\n  `body` TEXT,\n  `name` VARCHAR(10),\n  INDEX `i` (`body`, `name`),\n  KEY `k` (`body`(50))\n);\nCREATE INDEX `j` ON `t` (`body`);";
        let out = run(sql);
        assert!(out.contains("INDEX `i` (`body`(191), `name`),"), "{out}");
        assert!(out.contains("KEY `k` (`body`(50))"), "{out}");
        assert!(out.contains("CREATE INDEX `j` ON `t` (`body`(191));"), "{out}");
    }

    #[test]
    fn index_on_json_is_skipped_even_with_a_prefix() {
        let sql = "CREATE TABLE `api_tokens` (\n  `scopes` JSON NOT NULL DEFAULT ('[]')\n);\nCREATE INDEX `idx_scopes` ON `api_tokens` (`scopes`(191));";
        let out = run(sql);
        assert!(out.contains("-- kubuno-db: index skipped on MySQL"), "{out}");
        assert!(!out.lines().any(|l| l.trim_start().starts_with("CREATE INDEX")), "{out}");
    }

    #[test]
    fn catalog_spans_migrations_and_alter_table_add_column() {
        let mut cat = Catalog::default();
        rewrite("CREATE TABLE `docs` (\n  `id` BIGINT\n);", &mut cat);
        let out = rewrite(
            "ALTER TABLE `docs` ADD COLUMN `note` TEXT NOT NULL DEFAULT 'x';\nCREATE UNIQUE INDEX `u` ON `docs` (`note`);",
            &mut cat,
        );
        assert!(out.contains("ADD COLUMN `note` TEXT NOT NULL DEFAULT ('x');"), "{out}");
        assert!(out.contains("CREATE UNIQUE INDEX `u` ON `docs` ((SHA2(`note`, 256)));"), "{out}");
    }

    #[test]
    fn mysql_ready_sql_is_byte_identical() {
        let sql = "CREATE TABLE `a` (\n  `id` BINARY(16) NOT NULL,\n  `v` VARCHAR(20) DEFAULT 'x',\n  PRIMARY KEY (`id`)\n) DEFAULT CHARSET=utf8mb4;\n-- TEXT DEFAULT 'comment'\nCREATE INDEX `i` ON `a` (`v`);\n";
        assert_eq!(run(sql), sql);
    }
}
