//! What the three engines spell differently.
//!
//! Every helper here returns a SQL *fragment* meant to be interpolated into a
//! query that is then handed to the runtime executor. All identifier-shaped
//! parameters are `&'static str` on purpose: a value that cannot be produced
//! from an HTTP request without a deliberate leak. User data still goes through
//! bind parameters only.
//!
//! The fragments are written in PostgreSQL's `$n` placeholder style, because
//! that is the style [`crate::sql::prepare`] consumes.
//!
//! # Runtime, not compile time
//!
//! The engine is chosen when the process starts, from configuration, so these
//! are methods on [`Backend`] rather than functions reading a `const`. A caller
//! holds a [`crate::DbPool`] and asks it for `pool.backend()`, a cheap `Copy`
//! value. sqlx underneath does **not** translate SQL - this module produces the
//! right text per engine, and sqlx only carries it and encodes the parameters.

use std::fmt::Write as _;

/// The engine this process was configured to talk to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Postgres,
    MySql,
    Sqlite,
}

/// The target of a [`Backend::cast`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlType {
    BigInt,
    Int,
    Text,
    Double,
    /// A UUID column. PostgreSQL has a native type; MySQL stores `BINARY(16)`
    /// and SQLite a `BLOB`, where a cast is meaningless - the expression is
    /// returned unchanged there.
    Uuid,
}

/// One assignment in the update branch of an upsert.
#[derive(Debug, Clone, Copy)]
pub enum Assign {
    /// `col = <the value we tried to insert>`.
    Incoming(&'static str),
    /// `col = <expr>`, where `expr` may use two templates: `{cur}` for the
    /// column of the row already stored, and `{new}` for the column of the row
    /// we tried to insert.
    Expr {
        col: &'static str,
        expr: &'static str,
    },
}

/// The unit of a [`Backend::interval_before`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Second,
    Minute,
    Hour,
    Day,
}

impl Unit {
    fn singular(self) -> &'static str {
        match self {
            Unit::Second => "second",
            Unit::Minute => "minute",
            Unit::Hour => "hour",
            Unit::Day => "day",
        }
    }
}

impl Backend {
    /// Parses the configured engine name. Anything unrecognised is an error the
    /// caller surfaces at start-up rather than a silent default.
    pub fn parse(name: &str) -> Option<Backend> {
        match name.trim().to_ascii_lowercase().as_str() {
            "postgres" | "postgresql" | "pg" => Some(Backend::Postgres),
            "mysql" | "mariadb" => Some(Backend::MySql),
            "sqlite" | "sqlite3" => Some(Backend::Sqlite),
            _ => None,
        }
    }

    /// Whether the engine translates `$1` into `?`. PostgreSQL keeps `$n`.
    pub fn rewrites_placeholders(self) -> bool {
        !matches!(self, Backend::Postgres)
    }

    /// MySQL and MariaDB have no `RETURNING` on `UPDATE`/`DELETE`, and MariaDB's
    /// `INSERT ... RETURNING` does not survive `ON DUPLICATE KEY UPDATE`. Treat
    /// the whole family as lacking it - see [`crate::returning`].
    pub fn supports_returning(self) -> bool {
        !matches!(self, Backend::MySql)
    }

    /// Whether the upsert clause can name *which* unique constraint it
    /// arbitrates. MySQL's `ON DUPLICATE KEY UPDATE` fires on **any** unique
    /// index, a real behavioural difference on a table with more than one.
    pub fn upsert_targets_a_constraint(self) -> bool {
        !matches!(self, Backend::MySql)
    }

    // ── casts ───────────────────────────────────────────────────────────────

    /// `expr::bigint` and friends, in the local spelling.
    pub fn cast(self, expr: &'static str, ty: SqlType) -> String {
        self.cast_str(expr, ty)
    }

    fn cast_str(self, expr: &str, ty: SqlType) -> String {
        match (self, ty) {
            (Backend::Postgres, SqlType::BigInt) => format!("({expr})::bigint"),
            (Backend::Postgres, SqlType::Int) => format!("({expr})::int"),
            (Backend::Postgres, SqlType::Text) => format!("({expr})::text"),
            (Backend::Postgres, SqlType::Double) => format!("({expr})::double precision"),
            (Backend::Postgres, SqlType::Uuid) => format!("({expr})::uuid"),

            (Backend::MySql, SqlType::BigInt | SqlType::Int) => format!("CAST({expr} AS SIGNED)"),
            (Backend::MySql, SqlType::Text) => format!("CAST({expr} AS CHAR)"),
            (Backend::MySql, SqlType::Double) => format!("CAST({expr} AS DOUBLE)"),

            (Backend::Sqlite, SqlType::BigInt | SqlType::Int) => format!("CAST({expr} AS INTEGER)"),
            (Backend::Sqlite, SqlType::Text) => format!("CAST({expr} AS TEXT)"),
            (Backend::Sqlite, SqlType::Double) => format!("CAST({expr} AS REAL)"),

            // UUIDs are already binary on MySQL/SQLite: nothing to convert.
            (Backend::MySql | Backend::Sqlite, SqlType::Uuid) => expr.to_string(),
        }
    }

    // ── `= ANY($n)` ─────────────────────────────────────────────────────────

    /// A parenthesised list of placeholders for an `IN (...)`, replacing
    /// PostgreSQL's `= ANY($n)` (arrays exist in no other engine).
    ///
    /// `start` is the number of the first placeholder, 1-based. An empty list
    /// yields `NULL`, so `x IN (NULL)` matches nothing on all three engines.
    pub fn in_list(self, start: usize, count: usize) -> String {
        // The list is placeholder-only and identical on the three engines; the
        // method takes `self` for a uniform call site.
        let _ = self;
        in_list(start, count)
    }

    // ── RETURNING ─────────────────────────────────────────────────────────────

    /// `" RETURNING cols"`, or the empty string where the engine has none.
    pub fn returning(self, cols: &'static str) -> String {
        if self.supports_returning() {
            format!(" RETURNING {cols}")
        } else {
            String::new()
        }
    }

    // ── upsert ────────────────────────────────────────────────────────────────

    /// The conflict clause of an `INSERT ... ON CONFLICT DO UPDATE`.
    ///
    /// `conflict_cols` is **ignored** on MySQL, whose `ON DUPLICATE KEY UPDATE`
    /// reacts to any unique index on the table.
    pub fn upsert(
        self,
        table: &'static str,
        conflict_cols: &[&'static str],
        assigns: &[Assign],
    ) -> String {
        let set = assigns
            .iter()
            .map(|a| match a {
                Assign::Incoming(col) => format!("{col} = {}", self.incoming(col)),
                Assign::Expr { col, expr } => {
                    let body = expr
                        .replace("{cur}", &self.current(table, col))
                        .replace("{new}", &self.incoming(col));
                    format!("{col} = {body}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");

        match self {
            Backend::Postgres | Backend::Sqlite => {
                format!(" ON CONFLICT ({}) DO UPDATE SET {set}", conflict_cols.join(", "))
            }
            Backend::MySql => format!(" ON DUPLICATE KEY UPDATE {set}"),
        }
    }

    fn current(self, table: &'static str, col: &'static str) -> String {
        match self {
            Backend::Postgres | Backend::Sqlite => format!("{table}.{col}"),
            Backend::MySql => col.to_string(),
        }
    }

    fn incoming(self, col: &'static str) -> String {
        match self {
            Backend::Postgres | Backend::Sqlite => format!("excluded.{col}"),
            Backend::MySql => format!("VALUES({col})"),
        }
    }

    /// `INSERT` ... "skip it if it is already there" - the prefix half.
    pub fn insert_ignore_prefix(self) -> &'static str {
        match self {
            Backend::Postgres | Backend::Sqlite => "",
            Backend::MySql => "IGNORE ",
        }
    }

    /// The trailing half of the construct documented on
    /// [`Backend::insert_ignore_prefix`].
    pub fn on_conflict_do_nothing(self, conflict_cols: &[&'static str]) -> String {
        match self {
            Backend::Postgres | Backend::Sqlite => {
                format!(" ON CONFLICT ({}) DO NOTHING", conflict_cols.join(", "))
            }
            Backend::MySql => String::new(),
        }
    }

    // ── JSON ──────────────────────────────────────────────────────────────────

    /// Extracts a nested JSON value **as text**, PostgreSQL's `#>>`.
    pub fn json_text(self, col: &'static str, path: &[&'static str]) -> String {
        check_json_path(path);
        match self {
            Backend::Postgres => format!("{col} #>> '{{{}}}'", path.join(",")),
            Backend::MySql => format!("JSON_UNQUOTE(JSON_EXTRACT({col}, '{}'))", json_pointer(path)),
            Backend::Sqlite => format!("json_extract({col}, '{}')", json_pointer(path)),
        }
    }

    /// Extracts a nested JSON value **as JSON**, PostgreSQL's `#>`.
    pub fn json_value(self, col: &'static str, path: &[&'static str]) -> String {
        check_json_path(path);
        match self {
            Backend::Postgres => format!("{col} #> '{{{}}}'", path.join(",")),
            Backend::MySql => format!("JSON_EXTRACT({col}, '{}')", json_pointer(path)),
            Backend::Sqlite => format!("json_extract({col}, '{}')", json_pointer(path)),
        }
    }

    /// Whether a JSON object has a key - PostgreSQL's `?` operator.
    pub fn json_has_key(self, col: &'static str, key: &'static str) -> String {
        check_json_path(&[key]);
        match self {
            Backend::Postgres => format!("jsonb_exists({col}, '{key}')"),
            Backend::MySql => format!("JSON_CONTAINS_PATH({col}, 'one', '$.{key}')"),
            Backend::Sqlite => format!("json_extract({col}, '$.{key}') IS NOT NULL"),
        }
    }

    /// Whether a JSON object has **any** of these keys - PostgreSQL's `?|`.
    pub fn json_has_any_key(self, col: &'static str, keys: &[&'static str]) -> String {
        self.json_has_keys(col, keys, "one", " OR ")
    }

    /// Whether a JSON object has **all** of these keys - PostgreSQL's `?&`.
    pub fn json_has_all_keys(self, col: &'static str, keys: &[&'static str]) -> String {
        self.json_has_keys(col, keys, "all", " AND ")
    }

    fn json_has_keys(
        self,
        col: &'static str,
        keys: &[&'static str],
        mysql_mode: &'static str,
        joiner: &'static str,
    ) -> String {
        check_json_path(keys);
        if keys.is_empty() {
            return if mysql_mode == "one" { "FALSE".into() } else { "TRUE".into() };
        }
        match self {
            Backend::MySql => {
                let paths =
                    keys.iter().map(|k| format!("'$.{k}'")).collect::<Vec<_>>().join(", ");
                format!("JSON_CONTAINS_PATH({col}, '{mysql_mode}', {paths})")
            }
            _ => {
                let parts = keys
                    .iter()
                    .map(|k| format!("({})", self.json_has_key(col, k)))
                    .collect::<Vec<_>>();
                format!("({})", parts.join(joiner))
            }
        }
    }

    /// Whether a JSON **array** column contains a scalar value - the portable
    /// replacement for PostgreSQL's `value = ANY(col)` over a `TEXT[]`/`UUID[]`.
    /// `n` is the placeholder number of the candidate, bound as plain text (for
    /// a UUID, bind `uuid.to_string()`); it is never interpolated.
    ///
    /// * PostgreSQL: `col @> jsonb_build_array($n)` - a containment test a GIN
    ///   index on the `jsonb` column can serve, so it replaces the old GIN on
    ///   the array.
    /// * MySQL/MariaDB: `JSON_CONTAINS(col, JSON_QUOTE($n))` - `JSON_QUOTE`
    ///   turns the bound string into the JSON scalar `"…"` the function needs.
    /// * SQLite: `EXISTS (SELECT 1 FROM json_each(col) WHERE value = $n)`.
    ///
    /// The column must hold a JSON array of scalars (what a `Vec<String>` /
    /// `Vec<Uuid>` bound through [`crate::DbValue`] writes). On PostgreSQL it
    /// must be `jsonb`, not `json` - see this crate's README for the migration.
    pub fn json_array_contains(self, col: &'static str, n: usize) -> String {
        match self {
            Backend::Postgres => format!("{col} @> jsonb_build_array(${n})"),
            Backend::MySql => format!("JSON_CONTAINS({col}, JSON_QUOTE(${n}))"),
            Backend::Sqlite => {
                format!("EXISTS (SELECT 1 FROM json_each({col}) WHERE value = ${n})")
            }
        }
    }

    // ── aggregates ────────────────────────────────────────────────────────────
    //
    // The return *type* of an aggregate differs between engines and sqlx
    // type-checks on decode. `numeric`/`DECIMAL` do not decode into `i64`/`f64`
    // without extra features, so the cast is not cosmetic.

    /// `SUM(expr)` decodable as `i64`, with `NULL` (no rows) turned into `0`.
    pub fn sum_bigint(self, expr: &'static str) -> String {
        self.cast_str(&format!("COALESCE(SUM({expr}), 0)"), SqlType::BigInt)
    }

    /// `COUNT(...)` decodable as `i64`. Pass `"*"` for a plain row count.
    pub fn count_bigint(self, expr: &'static str) -> String {
        self.cast_str(&format!("COUNT({expr})"), SqlType::BigInt)
    }

    /// `AVG(expr)` decodable as `f64`; `NULL` when there are no rows.
    pub fn avg_double(self, expr: &'static str) -> String {
        self.cast_str(&format!("AVG({expr})"), SqlType::Double)
    }

    // ── time ──────────────────────────────────────────────────────────────────

    /// The server-side "now". **Prefer binding `chrono::Utc::now()` from Rust.**
    pub fn now(self) -> &'static str {
        match self {
            Backend::Postgres => "NOW()",
            Backend::MySql => "CURRENT_TIMESTAMP(6)",
            Backend::Sqlite => "strftime('%Y-%m-%d %H:%M:%f', 'now')",
        }
    }

    /// `NOW() - INTERVAL 'n unit'`, in the local spelling.
    pub fn interval_before(self, n: u32, unit: Unit) -> String {
        let u = unit.singular();
        match self {
            Backend::Postgres => format!("NOW() - INTERVAL '{n} {u}'"),
            Backend::MySql => format!("CURRENT_TIMESTAMP(6) - INTERVAL {n} {}", u.to_uppercase()),
            Backend::Sqlite => format!("strftime('%Y-%m-%d %H:%M:%f', 'now', '-{n} {u}s')"),
        }
    }

    // ── assorted ──────────────────────────────────────────────────────────────

    /// Case-insensitive `LIKE`. `n` is the placeholder number of the pattern.
    pub fn ilike(self, col: &'static str, n: usize) -> String {
        match self {
            Backend::Postgres => format!("{col} ILIKE ${n}"),
            Backend::MySql | Backend::Sqlite => format!("LOWER({col}) LIKE LOWER(${n})"),
        }
    }

    /// A `" FOR UPDATE"` row lock, or the empty string on SQLite, which has no
    /// such clause. SQLite serializes writes at the database level (a write
    /// transaction holds an exclusive lock), so the pessimistic lock a
    /// `SELECT ... FOR UPDATE` takes on PostgreSQL/MySQL is already implied there -
    /// dropping the clause keeps the same "no concurrent writer sees a stale
    /// row" guarantee. Where the lock backs a work-queue claim, keep the
    /// `UPDATE ... WHERE status = 'pending'` + `rows_affected == 1` check as the
    /// real arbiter; this clause is only an optimization on the engines that have
    /// it.
    pub fn for_update(self) -> &'static str {
        match self {
            Backend::Postgres | Backend::MySql => " FOR UPDATE",
            Backend::Sqlite => "",
        }
    }

    /// The client address as text. PostgreSQL stores it as `inet`, whose
    /// canonical text form is reached through `host(col)::text`; MySQL and SQLite
    /// keep it as a plain string column, so the column is returned unchanged.
    pub fn inet_text(self, col: &'static str) -> String {
        match self {
            Backend::Postgres => format!("host({col})::text"),
            Backend::MySql | Backend::Sqlite => col.to_string(),
        }
    }

    /// The domain half of an email address - everything after the `@`, the
    /// portable stand-in for PostgreSQL's `SPLIT_PART(col, '@', 2)`.
    ///
    /// `col` is a column reference written in source (`&'static str`); no request
    /// data is spliced. A well-formed address has exactly one `@`, so all three
    /// spellings agree on it - the second field is the part after the separator.
    ///
    /// * PostgreSQL: `SPLIT_PART(col, '@', 2)`.
    /// * MySQL/MariaDB: `SUBSTRING_INDEX(SUBSTRING_INDEX(col, '@', 2), '@', -1)` -
    ///   the outer `-1` trims the first field the inner call keeps, so a value
    ///   with no `@` yields the empty string rather than the whole address.
    /// * SQLite: `substr(col, instr(col, '@') + 1)`.
    pub fn email_domain(self, col: &'static str) -> String {
        match self {
            Backend::Postgres => format!("SPLIT_PART({col}, '@', 2)"),
            Backend::MySql => {
                format!("SUBSTRING_INDEX(SUBSTRING_INDEX({col}, '@', 2), '@', -1)")
            }
            Backend::Sqlite => format!("substr({col}, instr({col}, '@') + 1)"),
        }
    }

    /// Wraps a bound text value as a JSON **string** scalar (`"…"`), for storing
    /// it in a JSON column - PostgreSQL's `to_jsonb($n::text)`. `n` is the
    /// placeholder number, bound as plain text; it is never interpolated.
    ///
    /// * PostgreSQL: `to_jsonb($n::text)`.
    /// * MySQL/MariaDB: `JSON_QUOTE($n)`.
    /// * SQLite: `json_quote($n)` (the column is `TEXT` holding JSON text).
    pub fn json_string(self, n: usize) -> String {
        match self {
            Backend::Postgres => format!("to_jsonb(${n}::text)"),
            Backend::MySql => format!("JSON_QUOTE(${n})"),
            Backend::Sqlite => format!("json_quote(${n})"),
        }
    }

    /// Boolean OR over a group - PostgreSQL's `bool_or`. MySQL and SQLite store
    /// booleans as `0`/`1` and have no `bool_or`, but `MAX` over those integers
    /// is the same fold and decodes back to `bool`. PostgreSQL rejects
    /// `MAX(boolean)`, so the spelling genuinely differs.
    pub fn bool_or(self, expr: &'static str) -> String {
        match self {
            Backend::Postgres => format!("bool_or({expr})"),
            Backend::MySql | Backend::Sqlite => format!("MAX({expr})"),
        }
    }

    /// Concatenation of a group's values. `separator` is a literal.
    pub fn string_agg(self, expr: &'static str, separator: &'static str) -> String {
        debug_assert!(!separator.contains('\''), "separator must not contain a quote");
        match self {
            Backend::Postgres => format!("string_agg({expr}, '{separator}')"),
            Backend::MySql => format!("GROUP_CONCAT({expr} SEPARATOR '{separator}')"),
            Backend::Sqlite => format!("group_concat({expr}, '{separator}')"),
        }
    }

    // ── migration column types ─────────────────────────────────────────────────

    /// `uuid::Uuid` - native on PostgreSQL, `BINARY(16)` on MySQL, `BLOB` on SQLite.
    pub fn col_uuid(self) -> &'static str {
        match self {
            Backend::Postgres => "UUID",
            Backend::MySql => "BINARY(16)",
            Backend::Sqlite => "BLOB",
        }
    }

    /// `chrono::DateTime<Utc>`.
    pub fn col_timestamptz(self) -> &'static str {
        match self {
            Backend::Postgres => "TIMESTAMPTZ",
            Backend::MySql => "DATETIME(6)",
            Backend::Sqlite => "TEXT",
        }
    }

    /// `serde_json::Value`.
    pub fn col_json(self) -> &'static str {
        match self {
            Backend::Postgres => "JSONB",
            Backend::MySql => "JSON",
            Backend::Sqlite => "TEXT",
        }
    }

    /// `Vec<u8>`.
    pub fn col_bytes(self) -> &'static str {
        match self {
            Backend::Postgres => "BYTEA",
            Backend::MySql => "LONGBLOB",
            Backend::Sqlite => "BLOB",
        }
    }
}

fn in_list(start: usize, count: usize) -> String {
    if count == 0 {
        return "NULL".to_string();
    }
    let mut s = String::with_capacity(count * 5);
    for n in start..start + count {
        if n > start {
            s.push_str(", ");
        }
        let _ = write!(s, "${n}");
    }
    s
}

fn json_pointer(path: &[&'static str]) -> String {
    let mut s = String::from("$");
    for key in path {
        let _ = write!(s, ".{key}");
    }
    s
}

fn check_json_path(path: &[&'static str]) {
    debug_assert!(
        path.iter().all(|k| !k.is_empty()
            && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')),
        "a JSON key must be a plain identifier: {path:?}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Backend; 3] = [Backend::Postgres, Backend::MySql, Backend::Sqlite];

    #[test]
    fn parses_the_engine_name() {
        assert_eq!(Backend::parse("postgres"), Some(Backend::Postgres));
        assert_eq!(Backend::parse("MariaDB"), Some(Backend::MySql));
        assert_eq!(Backend::parse("sqlite3"), Some(Backend::Sqlite));
        assert_eq!(Backend::parse("oracle"), None);
    }

    #[test]
    fn in_list_numbers_from_the_offset() {
        assert_eq!(Backend::Postgres.in_list(3, 3), "$3, $4, $5");
        assert_eq!(Backend::Postgres.in_list(1, 0), "NULL");
    }

    #[test]
    fn for_update_is_empty_only_on_sqlite() {
        assert_eq!(Backend::Postgres.for_update(), " FOR UPDATE");
        assert_eq!(Backend::MySql.for_update(), " FOR UPDATE");
        assert_eq!(Backend::Sqlite.for_update(), "");
    }

    #[test]
    fn returning_is_empty_only_on_mysql() {
        for b in ALL {
            assert_eq!(b.returning("id").is_empty(), b == Backend::MySql);
        }
    }

    #[test]
    fn json_array_contains_spells_each_engine() {
        assert_eq!(
            Backend::Postgres.json_array_contains("tags", 3),
            "tags @> jsonb_build_array($3)"
        );
        assert_eq!(
            Backend::MySql.json_array_contains("tags", 3),
            "JSON_CONTAINS(tags, JSON_QUOTE($3))"
        );
        assert_eq!(
            Backend::Sqlite.json_array_contains("tags", 3),
            "EXISTS (SELECT 1 FROM json_each(tags) WHERE value = $3)"
        );
    }

    #[test]
    fn email_domain_spells_each_engine() {
        assert_eq!(Backend::Postgres.email_domain("u.email"), "SPLIT_PART(u.email, '@', 2)");
        assert_eq!(
            Backend::MySql.email_domain("u.email"),
            "SUBSTRING_INDEX(SUBSTRING_INDEX(u.email, '@', 2), '@', -1)"
        );
        assert_eq!(
            Backend::Sqlite.email_domain("u.email"),
            "substr(u.email, instr(u.email, '@') + 1)"
        );
    }

    #[test]
    fn json_string_wraps_a_bound_text() {
        assert_eq!(Backend::Postgres.json_string(1), "to_jsonb($1::text)");
        assert_eq!(Backend::MySql.json_string(1), "JSON_QUOTE($1)");
        assert_eq!(Backend::Sqlite.json_string(1), "json_quote($1)");
    }

    #[test]
    fn upsert_uses_the_local_spelling() {
        let assigns = [
            Assign::Incoming("kdbx_path"),
            Assign::Expr { col: "sync_version", expr: "{cur} + 1" },
        ];
        assert_eq!(
            Backend::Postgres.upsert("vaults", &["owner_id"], &assigns),
            " ON CONFLICT (owner_id) DO UPDATE SET \
             kdbx_path = excluded.kdbx_path, sync_version = vaults.sync_version + 1"
        );
        assert_eq!(
            Backend::MySql.upsert("vaults", &["owner_id"], &assigns),
            " ON DUPLICATE KEY UPDATE \
             kdbx_path = VALUES(kdbx_path), sync_version = sync_version + 1"
        );
    }

    #[test]
    fn every_fragment_survives_prepare() {
        for b in ALL {
            let fragments = vec![
                b.cast("a", SqlType::BigInt),
                b.cast("a", SqlType::Uuid),
                b.returning("id"),
                b.upsert("t", &["id"], &[Assign::Incoming("a")]),
                b.on_conflict_do_nothing(&["id"]),
                b.json_text("m", &["k"]),
                b.json_value("m", &["k"]),
                b.json_has_key("m", "k"),
                b.json_has_any_key("m", &["a", "b"]),
                b.json_has_all_keys("m", &["a", "b"]),
                b.json_array_contains("tags", 1),
                b.sum_bigint("size"),
                b.count_bigint("*"),
                b.avg_double("size"),
                b.now().to_string(),
                b.interval_before(7, Unit::Day),
                b.ilike("name", 1),
                b.string_agg("name", ", "),
                b.email_domain("u.email"),
                b.json_string(1),
                format!("SELECT 1{}", b.for_update()),
            ];
            for f in fragments {
                let sql = format!("SELECT {f}");
                assert!(crate::sql::prepare(&sql, b).is_ok(), "{b:?}: fragment breaks prepare: {f}");
            }
        }
    }
}
