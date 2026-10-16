//! Optional schema-name prefixing, so several Kubuno instances can share one
//! database server - WordPress-style table prefixes, but applied at the schema
//! level (a PostgreSQL schema, a MySQL/MariaDB database, or a SQLite attached
//! file/alias).
//!
//! # The default is inert
//!
//! With no prefix configured (the default) every operation here is a no-op:
//! [`SchemaPrefix::schema`] returns the schema name unchanged and
//! [`SchemaPrefix::rewrite`] returns its input borrowed and untouched. A run
//! without a prefix is therefore byte-for-byte identical to one from before this
//! module existed - no cost, no behaviour change, no risk.
//!
//! # What a prefix rewrites
//!
//! Kubuno's modules qualify their SQL with a **literal** schema name
//! (`SELECT … FROM notes.labels`, cross-schema `core.users`). When a prefix
//! `kub_` is set, every such qualifier whose head is a *known Kubuno schema*
//! (see [`KUBUNO_SCHEMAS`]) is rewritten `notes.` → `kub_notes.`,
//! `core.` → `kub_core.`, and so on. The module SQL itself is never edited: the
//! rewrite happens in one place at run time (`DbPool::prepare`) and, for the
//! qualified DDL some engines use, once more when the migrator runs.

use std::borrow::Cow;
use std::sync::Arc;

/// Every schema qualifier prefix rewriting recognises: the core plus every
/// module. A schema-qualified reference is only rewritten when its head matches
/// one of these names, which keeps an unrelated `foo.bar` - or a module writing
/// against a schema Kubuno does not own - untouched.
///
/// Kept in sync by hand with the module roster in the workspace `CLAUDE.md`.
pub const KUBUNO_SCHEMAS: &[&str] = &[
    "core",
    "app",
    "books",
    "calendar",
    "chat",
    "code",
    "contacts",
    "drive",
    "flow",
    "forms",
    "forum",
    "assistant",
    "keestore",
    "mail",
    "maps",
    "media",
    "notes",
    "office",
    "p2pnas",
    "paintsharp",
    "photos",
    "tasks",
    "wiki",
    "build",
    "stt",
];

/// The secondary schemas a module owns beyond its primary one, spelled out in
/// full. Kept as an explicit list rather than a `<root>_*` pattern on purpose:
/// on a server shared by several instances, a pattern would also claim another
/// instance's schemas whenever one prefix is a prefix of the other (an instance
/// with no prefix would read `notes_core`, which belongs to the instance
/// prefixed `notes_`, as a secondary schema of `notes`).
pub const KUBUNO_SECONDARY_SCHEMAS: &[&str] =
    &["office_data", "office_maths", "office_script", "office_wb"];

/// Whether a bare (prefix-stripped) schema name belongs to Kubuno: a primary
/// schema from [`KUBUNO_SCHEMAS`] or a secondary one from
/// [`KUBUNO_SECONDARY_SCHEMAS`]. Exact match only.
pub fn is_kubuno_schema(bare: &str) -> bool {
    KUBUNO_SCHEMAS.contains(&bare) || KUBUNO_SECONDARY_SCHEMAS.contains(&bare)
}

/// The maximum length of a prefix. Bounded so `<prefix><schema>` always stays a
/// legal identifier on every engine (PostgreSQL truncates identifiers at 63
/// bytes; the longest schema name is well under 31).
const MAX_PREFIX_LEN: usize = 32;

/// A validated, cheap-to-clone schema-name prefix.
///
/// The empty (default) value is the "no prefix" state; a non-empty value has
/// already been checked to be a bare, injection-proof identifier fragment.
#[derive(Clone, Default, Debug)]
pub struct SchemaPrefix(Option<Arc<str>>);

impl SchemaPrefix {
    /// Validates and builds a prefix from configuration. `None` or an empty
    /// string yields the inert default.
    ///
    /// A non-empty prefix must match `^[a-z0-9_]{1,32}$` - lowercase ASCII
    /// letters, digits and underscore only. That guarantees it is a legal bare
    /// identifier on PostgreSQL, MySQL and SQLite and that it can never carry a
    /// quote, a dot or whitespace into a schema name, so no configuration value
    /// can turn into SQL injection.
    pub fn new(raw: Option<&str>) -> Result<Self, String> {
        match raw {
            None | Some("") => Ok(Self(None)),
            Some(s) => {
                let ok = s.len() <= MAX_PREFIX_LEN
                    && s.bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
                if !ok {
                    return Err(format!(
                        "database.schema_prefix `{s}` is invalid: it must match \
                         ^[a-z0-9_]{{1,{MAX_PREFIX_LEN}}}$ (lowercase ASCII letters, digits \
                         and underscore)"
                    ));
                }
                Ok(Self(Some(Arc::from(s))))
            }
        }
    }

    /// The raw prefix string, or `""` when none is set.
    pub fn as_str(&self) -> &str {
        self.0.as_deref().unwrap_or("")
    }

    /// Whether no prefix is set (the default). When true, every method here is a
    /// pass-through.
    pub fn is_empty(&self) -> bool {
        self.0.is_none()
    }

    /// The effective schema name: `<prefix><schema>`, or just `schema` when no
    /// prefix is set.
    ///
    /// This is the name used for the PostgreSQL `search_path`, the
    /// `CREATE SCHEMA`/`CREATE DATABASE` in [`crate::pool::ensure_schema`], the
    /// MySQL connection database, the SQLite file name and its `ATTACH` alias,
    /// and the migration bookkeeping table.
    pub fn schema(&self, schema: &str) -> String {
        match &self.0 {
            Some(p) => format!("{p}{schema}"),
            None => schema.to_string(),
        }
    }

    /// Rewrites every known Kubuno schema qualifier `<schema>.` in `sql` to
    /// `<prefix><schema>.`.
    ///
    /// A no-op (the input, borrowed and unchanged) when no prefix is set, so the
    /// default configuration pays nothing.
    ///
    /// The match is anchored by a word boundary on the left, so `mynotes.` is
    /// left alone while `notes.` is rewritten. It is deliberately *lexical*, not
    /// semantic: a string literal that itself contains `core.` would be rewritten
    /// too. Prefixing is opt-in and modules bind user data as parameters rather
    /// than splicing a bare `<schema>.` into a literal, so this caveat is
    /// acceptable in exchange for a rewrite that is trivial to audit.
    pub fn rewrite<'a>(&self, sql: &'a str) -> Cow<'a, str> {
        let Some(prefix) = self.0.as_deref() else {
            return Cow::Borrowed(sql);
        };
        let bytes = sql.as_bytes();
        let mut out: Option<String> = None;
        let mut copied_upto = 0usize;
        let mut i = 0usize;

        while i < bytes.len() {
            // A schema qualifier can only start where the preceding byte is not
            // itself part of an identifier: this is the left word boundary.
            let at_boundary = i == 0 || !is_ident_byte(bytes[i - 1]);
            if at_boundary {
                if let Some(name) = matched_schema(sql, bytes, i) {
                    let buf = out.get_or_insert_with(|| String::with_capacity(sql.len() + 16));
                    buf.push_str(&sql[copied_upto..i]);
                    buf.push_str(prefix);
                    buf.push_str(name);
                    // Leave the trailing `.` and the rest to be copied verbatim.
                    copied_upto = i + name.len();
                    i = copied_upto;
                    continue;
                }
            }
            i += 1;
        }

        match out {
            Some(mut buf) => {
                buf.push_str(&sql[copied_upto..]);
                Cow::Owned(buf)
            }
            None => Cow::Borrowed(sql),
        }
    }
}

/// A byte that may appear inside an SQL identifier (so a schema name touching one
/// on its left is not a standalone qualifier).
fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// If a known schema name sits at `i` and is immediately followed by a `.`,
/// returns that name. The `.` disambiguates `forms.` from `forum.` without a
/// separate right-boundary check.
fn matched_schema<'s>(sql: &'s str, bytes: &[u8], i: usize) -> Option<&'s str> {
    // Secondary schemas are matched too, otherwise a prefixed instance would
    // keep reading and writing the *unprefixed* `office_data.` shared with every
    // other instance on the server.
    KUBUNO_SCHEMAS.iter().chain(KUBUNO_SECONDARY_SCHEMAS).copied().find(|name| {
        let end = i + name.len();
        end < bytes.len()
            && bytes[end] == b'.'
            && sql.as_bytes()[i..end] == *name.as_bytes()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_prefix_is_inert() {
        let p = SchemaPrefix::new(None).unwrap();
        assert!(p.is_empty());
        assert_eq!(p.schema("notes"), "notes");
        assert_eq!(p.rewrite("SELECT * FROM notes.labels"), "SELECT * FROM notes.labels");
        // A borrowed, untouched string - no allocation on the hot path.
        assert!(matches!(p.rewrite("SELECT * FROM notes.labels"), Cow::Borrowed(_)));

        let p = SchemaPrefix::new(Some("")).unwrap();
        assert!(p.is_empty());
    }

    #[test]
    fn validation_rejects_bad_prefixes() {
        assert!(SchemaPrefix::new(Some("kub_")).is_ok());
        assert!(SchemaPrefix::new(Some("a1_2")).is_ok());
        assert!(SchemaPrefix::new(Some("Kub")).is_err()); // uppercase
        assert!(SchemaPrefix::new(Some("kub-")).is_err()); // dash
        assert!(SchemaPrefix::new(Some("kub.")).is_err()); // dot
        assert!(SchemaPrefix::new(Some("kub ")).is_err()); // space
        assert!(SchemaPrefix::new(Some(&"x".repeat(33))).is_err()); // too long
    }

    #[test]
    fn secondary_schemas_are_rewritten_too() {
        let p = SchemaPrefix::new(Some("kub_")).unwrap();
        assert_eq!(
            p.rewrite("SELECT 1 FROM office_data.datasets JOIN office.docs d ON TRUE"),
            "SELECT 1 FROM kub_office_data.datasets JOIN kub_office.docs d ON TRUE"
        );
    }

    #[test]
    fn ownership_is_exact_not_a_pattern() {
        assert!(is_kubuno_schema("notes"));
        assert!(is_kubuno_schema("office_data"));
        // Another instance prefixed `notes_` owns `notes_core`: not ours.
        assert!(!is_kubuno_schema("notes_core"));
        assert!(!is_kubuno_schema("office_unknown"));
    }

    #[test]
    fn schema_is_prefixed() {
        let p = SchemaPrefix::new(Some("kub_")).unwrap();
        assert_eq!(p.schema("notes"), "kub_notes");
        assert_eq!(p.schema("core"), "kub_core");
        assert_eq!(p.as_str(), "kub_");
    }

    #[test]
    fn rewrite_known_qualifiers() {
        let p = SchemaPrefix::new(Some("kub_")).unwrap();
        assert_eq!(
            p.rewrite("SELECT * FROM notes.labels JOIN core.users ON true"),
            "SELECT * FROM kub_notes.labels JOIN kub_core.users ON true"
        );
        // Qualified DDL (the SQLite migration form).
        assert_eq!(
            p.rewrite("CREATE INDEX notes.idx_a ON notebooks(x)"),
            "CREATE INDEX kub_notes.idx_a ON notebooks(x)"
        );
    }

    #[test]
    fn rewrite_respects_word_boundary() {
        let p = SchemaPrefix::new(Some("kub_")).unwrap();
        // `mynotes` is not `notes`.
        assert_eq!(p.rewrite("SELECT * FROM mynotes.x"), "SELECT * FROM mynotes.x");
        // `forms` and `forum` share a prefix but the trailing dot disambiguates.
        assert_eq!(p.rewrite("FROM forms.a, forum.b"), "FROM kub_forms.a, kub_forum.b");
        // An unknown schema is left alone.
        assert_eq!(p.rewrite("FROM public.x, information_schema.y"), "FROM public.x, information_schema.y");
    }

    #[test]
    fn rewrite_documented_caveat_literal() {
        // The documented false positive: a literal containing `core.` is rewritten
        // too. This test pins the behaviour so a future change is a deliberate one.
        let p = SchemaPrefix::new(Some("kub_")).unwrap();
        assert_eq!(p.rewrite("SELECT 'see core.users'"), "SELECT 'see kub_core.users'");
    }
}
