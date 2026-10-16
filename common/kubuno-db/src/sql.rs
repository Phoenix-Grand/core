//! The single place where a non-literal SQL string is handed to sqlx.
//!
//! # Why this module exists at all
//!
//! sqlx 0.9 only accepts `&'static str` as query text ([`sqlx::sql_str::SqlSafeStr`]).
//! Anything built at runtime has to be wrapped in `AssertSqlSafe`, which is an
//! explicit "I audited this" marker. Kubuno needs runtime-built SQL for exactly
//! one reason: PostgreSQL numbers its bind parameters (`$1`), MySQL and SQLite
//! do not (`?`). So the text must be transformed before execution.
//!
//! Rather than sprinkle `AssertSqlSafe` across 205 files, **every** such wrap
//! happens in [`assert_safe`] below, on a string produced by [`prepare`] from
//! SQL the developer wrote. No caller-supplied data ever reaches it: [`prepare`]
//! only ever *removes* characters (`$12` becomes `?`) and copies the rest
//! verbatim, so it cannot introduce a construct that was not already in the
//! source text.
//!
//! Dynamic fragments (column lists, `IN (...)` expansions) are produced by
//! [`crate::dialect`], whose identifier parameters are `&'static str` - a value
//! that cannot come from an HTTP request without going through a deliberate
//! leak. Bind parameters remain the only channel for user data, exactly as
//! before.
//!
//! # What `prepare` guarantees
//!
//! The scanner understands the lexical structure of SQL, so a `$1` that sits
//! inside a string literal, a quoted identifier, a comment or a dollar-quoted
//! body is left untouched.
//!
//! It also *rejects* two constructs that would silently corrupt data once
//! rewritten, and it rejects them on every backend - including PostgreSQL - so
//! that a developer working against PostgreSQL finds out immediately instead of
//! shipping a module that only breaks on MySQL:
//!
//! * **Placeholders out of order or reused.** `?` is positional: the *n*-th `?`
//!   takes the *n*-th bound value. A query written `... $2 ... $1 ...`, or one
//!   that mentions `$1` twice, cannot be expressed that way. Such SQL must be
//!   rewritten to bind each value once, in order.
//! * **A bare `?`.** In PostgreSQL that is a JSON existence operator
//!   (`jsonb ? 'key'`); after rewriting it would be mistaken for a placeholder.
//!   Use `jsonb_exists(col, 'key')`, which has an equivalent in all engines.

use std::borrow::Cow;

use crate::dialect::Backend;

/// A query text that cannot be executed as written.
///
/// Converted into [`sqlx::Error::Configuration`] by [`crate::query`] and
/// friends, so a module whose error enum already has `#[from] sqlx::Error`
/// absorbs it without a new variant.
#[derive(Debug, thiserror::Error)]
pub enum SqlError {
    #[error(
        "bind placeholder ${found} appears where ${expected} was expected (byte {at}): \
         MySQL and SQLite placeholders are positional, so $1..$n must appear once each, \
         in ascending order - bind the value again rather than reusing $n"
    )]
    PlaceholderOrder {
        found: usize,
        expected: usize,
        at: usize,
    },

    /// Refused on **every** backend, PostgreSQL included.
    ///
    /// This is not hypothetical: `forms/migrations/000009_forms_default_typeface.up.sql`
    /// contains `WHERE theme ? 'fontFamily'`, PostgreSQL's JSON key-existence
    /// operator. Rewritten blindly it would become a bind placeholder, the
    /// driver would feed it the next bound value, and every parameter after it
    /// would be off by one - a defect that only shows up in production.
    #[error(
        "a bare `?` at byte {at} would be read as a bind placeholder by MySQL and SQLite. \
         If this is one of PostgreSQL's JSON operators (`?`, `?|`, `?&`), replace it with \
         dialect::json_has_key / json_has_any_key / json_has_all_keys, which have an \
         equivalent on the three engines"
    )]
    StrayQuestionMark { at: usize },

    #[error("unterminated {kind} starting at byte {at}")]
    Unterminated { kind: &'static str, at: usize },
}

/// Translates PostgreSQL-flavoured query text into the text the compiled-in
/// backend expects, and validates that it *can* be translated.
///
/// On PostgreSQL the string is returned borrowed and unchanged; the scan still
/// runs, because its job there is to catch non-portable SQL early.
pub fn prepare(sql: &str, backend: Backend) -> Result<Cow<'_, str>, SqlError> {
    let rewrites = backend.rewrites_placeholders();
    let b = sql.as_bytes();
    let mut out: Option<String> = None;
    let mut copied_upto = 0usize;
    let mut expected = 1usize;
    let mut i = 0usize;

    while i < b.len() {
        match b[i] {
            b'\'' => i = skip_single_quoted(b, i)?,
            b'"' => i = skip_delimited(b, i, b'"', "double-quoted identifier")?,
            b'`' => i = skip_delimited(b, i, b'`', "backquoted identifier")?,
            b'-' if b.get(i + 1) == Some(&b'-') => i = skip_line_comment(b, i),
            b'/' if b.get(i + 1) == Some(&b'*') => i = skip_block_comment(b, i)?,
            b'$' => {
                if let Some(tag_end) = dollar_tag_end(b, i) {
                    // `$$ … $$` / `$body$ … $body$`: a literal, never a placeholder.
                    i = skip_dollar_quoted(b, i, tag_end)?;
                } else if b.get(i + 1).is_some_and(u8::is_ascii_digit) {
                    let mut j = i + 1;
                    while j < b.len() && b[j].is_ascii_digit() {
                        j += 1;
                    }
                    // Digits only, and bounded by the query length: cannot overflow
                    // in practice, but saturate rather than panic if it ever did.
                    let n: usize = sql[i + 1..j].parse().unwrap_or(usize::MAX);
                    if n != expected {
                        return Err(SqlError::PlaceholderOrder {
                            found: n,
                            expected,
                            at: i,
                        });
                    }
                    expected += 1;
                    if rewrites {
                        let buf = out.get_or_insert_with(|| String::with_capacity(sql.len()));
                        buf.push_str(&sql[copied_upto..i]);
                        buf.push('?');
                        copied_upto = j;
                    }
                    i = j;
                } else {
                    i += 1;
                }
            }
            b'?' => return Err(SqlError::StrayQuestionMark { at: i }),
            _ => i += 1,
        }
    }

    Ok(match out {
        Some(mut buf) => {
            buf.push_str(&sql[copied_upto..]);
            Cow::Owned(buf)
        }
        None => Cow::Borrowed(sql),
    })
}

/// Turns a [`SqlError`] into the sqlx error modules already handle.
pub(crate) fn into_sqlx_error(e: SqlError) -> sqlx::Error {
    sqlx::Error::Configuration(Box::new(e))
}

// ── lexical skipping ────────────────────────────────────────────────────────
//
// Every helper takes the index of the opening delimiter and returns the index
// just past the closing one. Multi-byte UTF-8 sequences are never matched by
// accident: their bytes are all >= 0x80.

/// `'…'`, with `''` as the escape. A `E'…'` / `e'…'` prefix additionally turns
/// on backslash escapes, as in PostgreSQL.
fn skip_single_quoted(b: &[u8], start: usize) -> Result<usize, SqlError> {
    let backslash_escapes = start > 0 && matches!(b[start - 1], b'E' | b'e');
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' if backslash_escapes => i += 2,
            b'\'' if b.get(i + 1) == Some(&b'\'') => i += 2,
            b'\'' => return Ok(i + 1),
            _ => i += 1,
        }
    }
    Err(SqlError::Unterminated {
        kind: "string literal",
        at: start,
    })
}

/// `"…"` or `` `…` ``, with the delimiter doubled as its own escape.
fn skip_delimited(b: &[u8], start: usize, delim: u8, kind: &'static str) -> Result<usize, SqlError> {
    let mut i = start + 1;
    while i < b.len() {
        if b[i] == delim {
            if b.get(i + 1) == Some(&delim) {
                i += 2;
                continue;
            }
            return Ok(i + 1);
        }
        i += 1;
    }
    Err(SqlError::Unterminated { kind, at: start })
}

fn skip_line_comment(b: &[u8], start: usize) -> usize {
    let mut i = start + 2;
    while i < b.len() && b[i] != b'\n' {
        i += 1;
    }
    i
}

/// `/* … */`, nesting as PostgreSQL does (harmless for the other engines: a
/// nested block comment is not valid there anyway).
fn skip_block_comment(b: &[u8], start: usize) -> Result<usize, SqlError> {
    let mut depth = 1usize;
    let mut i = start + 2;
    while i + 1 < b.len() {
        if b[i] == b'/' && b[i + 1] == b'*' {
            depth += 1;
            i += 2;
        } else if b[i] == b'*' && b[i + 1] == b'/' {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return Ok(i);
            }
        } else {
            i += 1;
        }
    }
    Err(SqlError::Unterminated {
        kind: "block comment",
        at: start,
    })
}

/// If `b[start]` opens a dollar-quote tag (`$$` or `$tag$`), returns the index
/// just past its closing `$`. Returns `None` for `$1`, `$foo` and a lone `$`.
fn dollar_tag_end(b: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    if b.get(i) == Some(&b'$') {
        return Some(i + 1);
    }
    // A tag is an identifier: it may not start with a digit.
    if !b.get(i).is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_') {
        return None;
    }
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        i += 1;
    }
    (b.get(i) == Some(&b'$')).then_some(i + 1)
}

fn skip_dollar_quoted(b: &[u8], start: usize, tag_end: usize) -> Result<usize, SqlError> {
    let tag = &b[start..tag_end];
    let mut i = tag_end;
    while i + tag.len() <= b.len() {
        if &b[i..i + tag.len()] == tag {
            return Ok(i + tag.len());
        }
        i += 1;
    }
    Err(SqlError::Unterminated {
        kind: "dollar-quoted string",
        at: start,
    })
}

// ── portability lint ────────────────────────────────────────────────────────

/// One non-portable construct found by [`lint`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lint {
    /// The text that was matched, lower-cased.
    pub found: &'static str,
    /// What to write instead.
    pub advice: &'static str,
}

/// Flags PostgreSQL-only constructs that [`prepare`] cannot translate on its
/// own. Meant for unit tests over a module's SQL constants, not for the request
/// path - the whole point is to fail a `cargo test`, not a user request.
///
/// It is deliberately a substring scan: a false positive costs one comment, a
/// missed construct costs a production incident on another engine.
pub fn lint(sql: &str) -> Vec<Lint> {
    const RULES: &[(&str, &str)] = &[
        ("::", "use dialect::cast(); `::` is PostgreSQL-only"),
        (" any(", "use dialect::in_list() and bind each element; arrays are PostgreSQL-only"),
        ("returning", "use dialect::returning() / returning::insert_returning_scalar(); MySQL has no RETURNING"),
        ("on conflict", "use dialect::upsert() / dialect::on_conflict_do_nothing()"),
        ("excluded.", "use dialect::upsert(); MySQL spells it VALUES(col)"),
        ("ilike", "use dialect::ilike()"),
        ("now()", "bind chrono::Utc::now() from Rust, or use dialect::now()"),
        ("interval '", "bind a computed timestamp from Rust, or use dialect::interval_before()"),
        ("jsonb", "JSONB is PostgreSQL-only; declare the column as JSON/TEXT and use dialect::json_text()"),
        ("avg(", "AVG() returns numeric on PostgreSQL (sqlx cannot decode it as f64), DOUBLE on MySQL, REAL on SQLite: use dialect::avg_double()"),
        ("sum(", "SUM() of a bigint returns numeric on PostgreSQL: use dialect::sum_bigint()"),
        ("count(", "COUNT() returns BIGINT UNSIGNED on MySQL, INTEGER on SQLite: use dialect::count_bigint()"),
        ("->>", "use dialect::json_text(); the path syntax differs per engine"),
        ("pg_notify", "use kubuno_db::events::notify()"),
        ("skip locked", "SQLite has no SKIP LOCKED; a job queue needs an engine-specific strategy"),
        ("serial", "use an application-generated UUID primary key"),
        ("gen_random_uuid", "generate the UUID in Rust (uuid::Uuid::new_v4)"),
        ("uuid_generate_v4", "generate the UUID in Rust (uuid::Uuid::new_v4)"),
        ("timestamptz", "per-engine column type; see the migration guide in README.md"),
        ("distinct on", "DISTINCT ON is PostgreSQL-only; use a window function or GROUP BY"),
        ("string_agg", "use dialect::string_agg()"),
        ("array_agg", "no portable equivalent; aggregate in Rust"),
        ("generated always as identity", "use an application-generated UUID primary key"),
    ];
    let lower = sql.to_ascii_lowercase();
    RULES
        .iter()
        .filter(|(needle, _)| lower.contains(needle))
        .map(|(found, advice)| Lint {
            found,
            advice,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `prepare` produces on a rewriting engine (MySQL/SQLite turn `$n`
    /// into `?`); `prepare_pg` keeps PostgreSQL's `$n`.
    fn ok(sql: &str) -> String {
        prepare(sql, Backend::MySql).expect("should be portable").into_owned()
    }

    fn expected(_pg: &str, rewritten: &str) -> String {
        rewritten.to_string()
    }

    #[test]
    fn rewrites_placeholders_in_order() {
        assert_eq!(
            ok("SELECT * FROM t WHERE a = $1 AND b = $2"),
            expected(
                "SELECT * FROM t WHERE a = $1 AND b = $2",
                "SELECT * FROM t WHERE a = ? AND b = ?",
            )
        );
    }

    #[test]
    fn handles_two_digit_placeholders() {
        let sql = (1..=12).map(|n| format!("c{n} = ${n}")).collect::<Vec<_>>().join(" AND ");
        let got = ok(&format!("SELECT 1 WHERE {sql}"));
        assert_eq!(got.matches('?').count(), 12, "{got}");
        assert!(!got.contains('$'), "{got}");
    }

    #[test]
    fn leaves_string_literals_alone() {
        assert_eq!(
            ok("SELECT '$1 is not a placeholder', $1"),
            expected(
                "SELECT '$1 is not a placeholder', $1",
                "SELECT '$1 is not a placeholder', ?",
            )
        );
    }

    #[test]
    fn handles_doubled_quote_escape() {
        assert_eq!(
            ok("SELECT 'it''s $1', $1"),
            expected("SELECT 'it''s $1', $1", "SELECT 'it''s $1', ?")
        );
    }

    #[test]
    fn handles_e_string_backslash_escape() {
        assert_eq!(
            ok(r"SELECT E'a\'$1', $1"),
            expected(r"SELECT E'a\'$1', $1", r"SELECT E'a\'$1', ?")
        );
    }

    #[test]
    fn leaves_quoted_identifiers_alone() {
        assert_eq!(
            ok(r#"SELECT "weird $1 column" FROM t WHERE a = $1"#),
            expected(
                r#"SELECT "weird $1 column" FROM t WHERE a = $1"#,
                r#"SELECT "weird $1 column" FROM t WHERE a = ?"#,
            )
        );
    }

    #[test]
    fn leaves_comments_alone() {
        assert_eq!(
            ok("-- $1 here\nSELECT $1 /* and $2 */"),
            expected("-- $1 here\nSELECT $1 /* and $2 */", "-- $1 here\nSELECT ? /* and $2 */")
        );
    }

    #[test]
    fn handles_nested_block_comments() {
        assert_eq!(
            ok("/* a /* $9 */ b */ SELECT $1"),
            expected("/* a /* $9 */ b */ SELECT $1", "/* a /* $9 */ b */ SELECT ?")
        );
    }

    #[test]
    fn leaves_dollar_quoted_bodies_alone() {
        let sql = "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN $1; END; $$ LANGUAGE plpgsql";
        assert_eq!(ok(sql), sql, "a dollar-quoted body is a literal");
    }

    #[test]
    fn leaves_tagged_dollar_quoted_bodies_alone() {
        let sql = "SELECT $body$ $1 $2 $body$";
        assert_eq!(ok(sql), sql);
    }

    #[test]
    fn rejects_out_of_order_placeholders() {
        let err = prepare("SELECT * FROM t WHERE a = $2 AND b = $1", Backend::Postgres).unwrap_err();
        assert!(matches!(err, SqlError::PlaceholderOrder { found: 2, expected: 1, .. }), "{err}");
    }

    #[test]
    fn rejects_reused_placeholders() {
        let err = prepare("SELECT * FROM t WHERE a = $1 OR b = $1", Backend::Postgres).unwrap_err();
        assert!(matches!(err, SqlError::PlaceholderOrder { found: 1, expected: 2, .. }), "{err}");
    }

    /// The real statement from `forms/migrations/000009_forms_default_typeface.up.sql`.
    #[test]
    fn rejects_the_postgres_json_existence_operator() {
        let err = prepare(
            "UPDATE forms.themes SET theme = $1 \
             WHERE theme ? 'fontFamily' AND theme->>'fontFamily' LIKE '%Some Sans%'",
            Backend::Postgres,
        )
        .unwrap_err();
        assert!(matches!(err, SqlError::StrayQuestionMark { .. }), "{err}");
    }

    #[test]
    fn rejects_the_other_json_operators() {
        for sql in ["SELECT 1 WHERE m ?| array['a']", "SELECT 1 WHERE m ?& array['a']"] {
            assert!(
                matches!(prepare(sql, Backend::Postgres).unwrap_err(), SqlError::StrayQuestionMark { .. }),
                "{sql} should be refused"
            );
        }
    }

    #[test]
    fn accepts_question_mark_inside_a_literal() {
        assert_eq!(ok("SELECT 'why?'"), "SELECT 'why?'");
    }

    #[test]
    fn rejects_unterminated_literal() {
        assert!(matches!(
            prepare("SELECT 'oops", Backend::Postgres).unwrap_err(),
            SqlError::Unterminated { kind: "string literal", .. }
        ));
    }

    #[test]
    fn postgres_output_is_borrowed() {
        let sql = "SELECT * FROM t WHERE a = $1";
        let got = prepare(sql, Backend::Postgres).unwrap();
        assert!(matches!(got, Cow::Borrowed(_)), "PostgreSQL keeps $n, so no copy");
    }

    #[test]
    fn lint_flags_the_usual_suspects() {
        let found = lint("INSERT INTO t VALUES ($1) ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a RETURNING id::text");
        let names: Vec<_> = found.iter().map(|l| l.found).collect();
        assert!(names.contains(&"on conflict"), "{names:?}");
        assert!(names.contains(&"excluded."), "{names:?}");
        assert!(names.contains(&"returning"), "{names:?}");
        assert!(names.contains(&"::"), "{names:?}");
    }

    #[test]
    fn lint_is_quiet_on_portable_sql() {
        assert_eq!(lint("SELECT id, name FROM keestore.vaults WHERE owner_id = $1"), vec![]);
    }
}
