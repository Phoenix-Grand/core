//! Full-text search made identical on the three engines by stemming in Rust.
//!
//! PostgreSQL alone has `to_tsvector`/`plainto_tsquery`/`ts_rank`, the `unaccent`
//! extension and `pg_trgm`. MySQL and SQLite have nothing equivalent that would
//! rank the same way, so a search built on them drifts per engine. Kubuno's
//! foundation targets one binary over three engines, so the language layer, not
//! the database, owns full-text search:
//!
//! * at **write** time the module stores, next to each searchable column, a
//!   plain `TEXT` column holding the output of [`normalize`] - the text
//!   lowercased, stripped of diacritics and reduced to Snowball **French**
//!   stems (the very algorithm PostgreSQL's `french` dictionary uses),
//!   separated by single spaces;
//! * at **read** time the query terms go through the same [`normalize`], and
//!   each stem is matched with a portable `LIKE '%stem%'` (the value always
//!   bound, never interpolated).
//!
//! Because the stemming happens in Rust before it ever reaches SQL, the stored
//! and searched tokens are byte-for-byte identical whatever the engine, so a
//! search returns the same rows and the same ranking on PostgreSQL, MySQL and
//! SQLite. No `unaccent`, no `pg_trgm`, no `tsvector` - a `TEXT` column and a
//! `LIKE` are all three engines share.
//!
//! # Weighting (the old `setweight A/B/C`)
//!
//! PostgreSQL's `setweight(..., 'A')` let a title outrank a body in `ts_rank`.
//! The portable replacement is **one normalized column per weight class**
//! (e.g. `search_title_norm`, `search_body_norm`, `search_tags_norm`), declared
//! with a [`Weight`]. [`Query::build`] emits both the `WHERE` filter and an
//! `ORDER BY` score that adds each column's [`Weight`] for every term it
//! contains, so a title hit ranks above a body hit - the same intent as
//! `setweight`, with no engine-specific operator.
//!
//! # What is gained and what is lost
//!
//! Gained: identical behaviour on the three engines, and portability with no DB
//! extension. Lost: `pg_trgm`'s typo tolerance - a `LIKE '%stem%'` needs the
//! stem to appear as a substring, so a misspelling that survives stemming
//! ("rechrche") will not match. Stemming already folds inflections
//! (plurals, conjugations) and [`normalize`] folds accents, so exact-but-
//! inflected and accented queries still match; only fuzzy/edit-distance
//! matching is out of scope here.

use std::sync::atomic::{AtomicUsize, Ordering};

use crate::value::DbValue;

use rust_stemmers::{Algorithm, Stemmer};
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

thread_local! {
    // `Stemmer::create` builds a small automaton; keep one per thread rather
    // than rebuilding it on every call. The French algorithm is the same one
    // PostgreSQL's `french` text-search dictionary is generated from.
    static FRENCH: Stemmer = Stemmer::create(Algorithm::French);
}

/// Lowercases `text`, tokenises, reduces every token to its Snowball French
/// stem and strips the stem's diacritics, returning the stems joined by single
/// spaces.
///
/// The result is what a module stores in its normalized `TEXT` column and what
/// a query is turned into before matching. It is deterministic and idempotent:
/// `normalize(&normalize(s))` yields the same string as `normalize(s)` (the
/// output is lowercase, ASCII-folded, space-separated stems, and a stem
/// re-stems and re-folds to itself).
///
/// # Order matters: stem, *then* deaccent
///
/// The Snowball French algorithm is accent-sensitive - its suffix rules key on
/// `é`/`è`/… - so it must see the accented word. Stemming first and folding the
/// resulting stem to ASCII afterwards keeps the stemming faithful **and** makes
/// matching accent-insensitive. (Deaccenting first, as a naive `unaccent`-then-
/// `french` pipeline would, degrades the stemmer: e.g. it stops folding some
/// inflections together.)
///
/// Diacritics are removed by NFD decomposition then dropping the combining
/// marks - no database `unaccent` extension. Ligatures NFD leaves whole (`œ`,
/// `æ`, `ß`, …) are expanded before stemming so the stemmer sees plain letters.
pub fn normalize(text: &str) -> String {
    // Lowercase and expand ligatures, but keep accents for the stemmer.
    let prepared = expand_ligatures(&text.to_lowercase());
    let mut out = String::with_capacity(prepared.len());
    let mut first = true;
    // A token is a maximal run of alphanumerics (Unicode-aware, so `é` stays in
    // the word); everything else separates.
    for token in prepared.split(|c: char| !c.is_alphanumeric()) {
        if token.is_empty() {
            continue;
        }
        let stem = FRENCH.with(|s| s.stem(token).into_owned());
        let folded = deaccent(&stem);
        if folded.is_empty() {
            continue;
        }
        if !first {
            out.push(' ');
        }
        out.push_str(&folded);
        first = false;
    }
    out
}

/// Lowercases nothing (the caller already did) but expands the Latin ligatures
/// NFD does not split, so the stemmer and the fold see plain letters.
fn expand_ligatures(lowered: &str) -> String {
    let mut out = String::with_capacity(lowered.len());
    for c in lowered.chars() {
        match c {
            'œ' => out.push_str("oe"),
            'æ' => out.push_str("ae"),
            'ß' => out.push_str("ss"),
            'ø' => out.push('o'),
            'đ' => out.push('d'),
            'ł' => out.push('l'),
            other => out.push(other),
        }
    }
    out
}

/// Removes diacritics from an already-lowercased token, in Rust, with no DB
/// extension: NFD decomposition with the combining marks dropped.
fn deaccent(text: &str) -> String {
    text.nfd().filter(|c| !is_combining_mark(*c)).collect()
}

/// The `LIKE` pattern for one already-normalized stem: `%stem%`.
///
/// [`normalize`] only ever emits runs of alphanumeric characters (ASCII after
/// folding for Latin text, but a non-Latin letter is kept as is), so a stem can
/// carry no `%`, `_` or backslash - the pattern needs no `ESCAPE` clause and no metacharacter
/// stripping. The value is meant to be **bound**, never interpolated.
pub fn like_pattern(stem: &str) -> String {
    let mut p = String::with_capacity(stem.len() + 2);
    p.push('%');
    p.push_str(stem);
    p.push('%');
    p
}

/// One normalized column and how much a hit in it counts.
///
/// The replacement for a `setweight(..., 'A' | 'B' | 'C')` class: the column
/// holding the [`normalize`]d text, plus its [`Weight`].
#[derive(Debug, Clone, Copy)]
pub struct Field {
    /// A normalized `TEXT` column. Like every identifier in [`crate::dialect`]
    /// it is `&'static str` - never built from request data.
    pub column: &'static str,
    /// How much a term found in this column adds to the rank.
    pub weight: Weight,
}

impl Field {
    /// A searchable normalized column with the given weight class.
    pub fn new(column: &'static str, weight: Weight) -> Field {
        Field { column, weight }
    }
}

/// A ranking weight class, mirroring PostgreSQL's `setweight` labels A > B > C > D.
///
/// The numeric values only need to keep that order for `ORDER BY`; they are the
/// integer amount each hit in the class adds to the score.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Weight {
    A,
    B,
    C,
    D,
}

impl Weight {
    /// The score one term-hit in this class contributes.
    pub fn score(self) -> i32 {
        match self {
            Weight::A => 8,
            Weight::B => 4,
            Weight::C => 2,
            Weight::D => 1,
        }
    }
}

/// The portable `WHERE` filter, `ORDER BY` score and bind values for a search.
///
/// Produced by [`Query::build`]. The two SQL fragments are written in the `$n`
/// placeholder style [`crate::sql::prepare`] consumes, numbered contiguously
/// from the `start` given to [`Query::build`]: the `WHERE` block first, then the
/// `ORDER BY` block. [`binds`](Self::binds) is in that same order, so the caller
/// appends it between its pre-condition binds and its `LIMIT`/`OFFSET` binds.
///
/// Canonical assembly (see the crate tests for a running example):
///
/// ```text
/// SELECT ...
///   FROM notes
///  WHERE owner_id = $1 AND is_trashed = $2      -- pre-conditions, binds 1..=2
///    AND {where_sql}                            -- binds start..
///  ORDER BY {order_sql} DESC                     -- binds ..next
///  LIMIT ${next} OFFSET ${next+1}
/// ```
#[derive(Debug, Clone)]
pub struct SearchSql {
    /// The `WHERE` fragment: every term must appear in at least one field.
    pub where_sql: String,
    /// The `ORDER BY` score: higher means more/heavier hits. Sort it `DESC`.
    pub order_sql: String,
    /// Bind values, in placeholder order: the `WHERE` block then the `ORDER BY`
    /// block. Each is a `%stem%` [`DbValue::Text`].
    pub binds: Vec<DbValue>,
    /// The next free placeholder number, for the caller's `LIMIT`/`OFFSET`.
    pub next: usize,
    /// The stems the query reduced to, in order - handy for logging/highlighting.
    pub terms: Vec<String>,
}

/// The default number of distinct terms a search keeps; later words are
/// ignored. Overridden per process by [`set_max_terms`] (the core's
/// `[search] max_terms`, carried to modules through [`MAX_TERMS_ENV`]) or per
/// call by [`Query::build_with_max_terms`].
pub const MAX_TERMS: usize = 16;

/// The highest value [`set_max_terms`] accepts. Past it the cap would stop
/// protecting anything: each term costs `2 × fields` binds and as many
/// `LIKE '%…%'` scans.
pub const MAX_TERMS_CEILING: usize = 256;

static CONFIGURED_MAX_TERMS: AtomicUsize = AtomicUsize::new(MAX_TERMS);

/// Sets the process-wide term cap used by [`Query::build`], clamped to
/// `1..=MAX_TERMS_CEILING`, and returns the value kept.
pub fn set_max_terms(n: usize) -> usize {
    let kept = n.clamp(1, MAX_TERMS_CEILING);
    CONFIGURED_MAX_TERMS.store(kept, Ordering::Relaxed);
    kept
}

/// The environment variable a module reads its term cap from. The core sets it
/// on every module it starts, from its own `[search] max_terms`, so the whole
/// instance shares one value without any module-side code.
pub const MAX_TERMS_ENV: &str = "KUBUNO_DB_SEARCH_MAX_TERMS";

/// Applies [`MAX_TERMS_ENV`] when it is set (called by [`crate::connect`]). A
/// value that does not parse is ignored with a warning; one out of bounds is
/// clamped with a warning.
pub fn apply_env_max_terms() {
    let Ok(raw) = std::env::var(MAX_TERMS_ENV) else {
        return;
    };
    match raw.trim().parse::<usize>() {
        Ok(n) => {
            let kept = set_max_terms(n);
            if kept != n {
                tracing::warn!(requested = n, kept, "{MAX_TERMS_ENV} hors bornes, valeur ramenée");
            }
        }
        Err(_) => tracing::warn!(value = %raw, "{MAX_TERMS_ENV} illisible, plafond par défaut conservé"),
    }
}

/// The term cap [`Query::build`] currently applies.
pub fn max_terms() -> usize {
    CONFIGURED_MAX_TERMS.load(Ordering::Relaxed)
}

/// The longest query text normalized, in bytes, at the default cap; the rest is
/// ignored. A higher term cap raises it to 64 bytes per term, so the text never
/// runs out before the configured number of terms is reached.
pub const MAX_QUERY_BYTES: usize = 1024;

fn truncate_on_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// A full-text query over one or more weighted normalized columns.
pub struct Query;

impl Query {
    /// Builds the portable search SQL for `query` over `fields`.
    ///
    /// `start` is the first `$n` placeholder to use (1 for a query with no
    /// pre-conditions, or one past the last pre-condition placeholder). Returns
    /// `None` when `query` reduces to no stems (all stop characters / blank):
    /// the caller then runs its plain, unfiltered listing.
    ///
    /// A term matches when it is a substring of a normalized column, so a stored
    /// stem `cheval` is found by the query word `chevaux` (which stems to
    /// `cheval`). Every term must be present (`AND` across terms); within a term
    /// any field may satisfy it (`OR` across fields). The score adds each
    /// field's [`Weight::score`] once per term it contains.
    pub fn build(query: &str, fields: &[Field], start: usize) -> Option<SearchSql> {
        Self::build_with_max_terms(query, fields, start, max_terms())
    }

    /// [`Query::build`] with an explicit term cap for this call only (clamped to
    /// `1..=MAX_TERMS_CEILING`), for a caller that needs a different bound than
    /// the process-wide one.
    pub fn build_with_max_terms(
        query: &str,
        fields: &[Field],
        start: usize,
        max_terms: usize,
    ) -> Option<SearchSql> {
        assert!(!fields.is_empty(), "search needs at least one field");
        let max_terms = max_terms.clamp(1, MAX_TERMS_CEILING);

        // Distinct stems, order preserved: a repeated word adds nothing.
        // Bounded both in input and in terms: every term costs a `LIKE '%…%'`
        // per field, twice (filter and score), so an unbounded query is a cheap
        // way to make the database scan and to blow past the engine's bind
        // limit. Extra words past the cap are ignored.
        let query = truncate_on_char_boundary(query, MAX_QUERY_BYTES.max(max_terms * 64));
        let mut terms: Vec<String> = Vec::new();
        for stem in normalize(query).split(' ') {
            if terms.len() == max_terms {
                break;
            }
            if !stem.is_empty() && !terms.iter().any(|t| t == stem) {
                terms.push(stem.to_owned());
            }
        }
        if terms.is_empty() {
            return None;
        }

        let mut binds: Vec<DbValue> = Vec::with_capacity(terms.len() * fields.len() * 2);
        let mut n = start;

        // WHERE: AND over terms, OR over fields. Placeholders and binds are
        // produced in lockstep so the numbering matches the bind order.
        let mut where_groups: Vec<String> = Vec::with_capacity(terms.len());
        for term in &terms {
            let mut ors: Vec<String> = Vec::with_capacity(fields.len());
            for f in fields {
                ors.push(format!("{} LIKE ${n}", f.column));
                binds.push(DbValue::Text(Some(like_pattern(term))));
                n += 1;
            }
            where_groups.push(format!("({})", ors.join(" OR ")));
        }
        let where_sql = where_groups.join(" AND ");

        // ORDER BY: a second, non-overlapping block of placeholders (reusing a
        // placeholder is rejected by `sql::prepare`), same iteration order.
        let mut score_terms: Vec<String> = Vec::with_capacity(terms.len() * fields.len());
        for term in &terms {
            for f in fields {
                score_terms.push(format!(
                    "CASE WHEN {} LIKE ${n} THEN {} ELSE 0 END",
                    f.column,
                    f.weight.score()
                ));
                binds.push(DbValue::Text(Some(like_pattern(term))));
                n += 1;
            }
        }
        let order_sql = score_terms.join(" + ");

        Some(SearchSql {
            where_sql,
            order_sql,
            binds,
            next: n,
            terms,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql;
    use crate::Backend;

    #[test]
    fn a_huge_query_is_capped() {
        let words: Vec<String> = (0..5000).map(|i| format!("mot{i}")).collect();
        let fields = [Field::new("a_norm", Weight::A), Field::new("b_norm", Weight::B)];
        let built = Query::build_with_max_terms(&words.join(" "), &fields, 1, 16).expect("terms");
        assert_eq!(built.terms.len(), 16);
        assert_eq!(built.binds.len(), 16 * fields.len() * 2);
        // A configured cap is honoured, and clamped into its bounds.
        let few = Query::build_with_max_terms(&words.join(" "), &fields, 1, 3).expect("terms");
        assert_eq!(few.terms.len(), 3);
        let huge = Query::build_with_max_terms(&words.join(" "), &fields, 1, usize::MAX).expect("terms");
        assert_eq!(huge.terms.len(), MAX_TERMS_CEILING);
        let zero = Query::build_with_max_terms(&words.join(" "), &fields, 1, 0).expect("terms");
        assert_eq!(zero.terms.len(), 1);
        // A multi-byte character straddling the byte cap must not panic.
        let accents = "é".repeat(MAX_QUERY_BYTES);
        assert!(Query::build(&accents, &fields, 1).is_some());
    }

    #[test]
    fn deaccenting_strips_diacritics_and_ligatures() {
        assert_eq!(deaccent("résumé"), "resume");
        assert_eq!(deaccent(&expand_ligatures("élève à l'œuvre")), "eleve a l'oeuvre");
        assert_eq!(deaccent("çà coûte, garçon"), "ca coute, garcon");
        // Idempotent on already-folded text.
        assert_eq!(deaccent(&deaccent("élève")), deaccent("élève"));
    }

    #[test]
    fn stemming_folds_inflections() {
        // Plurals and conjugations collapse to a shared stem; the singular /
        // other inflected forms normalize to the very same token. (These are
        // families rust-stemmers reduces cleanly; see the report for the
        // present-3rd-plural "-ent" it leaves whole.)
        assert_eq!(normalize("chevaux"), normalize("cheval"));
        assert_eq!(normalize("développée"), normalize("développer"));
        assert_eq!(normalize("nationaux"), normalize("nationale"));
        assert_eq!(normalize("rapidement"), normalize("rapides"));
        // The stem is non-trivial (something was actually removed).
        assert_ne!(normalize("chevaux"), "chevaux");
    }

    #[test]
    fn shared_words_share_lemmas() {
        // The two phrases must agree on their shared words after normalization.
        let a: Vec<String> = normalize("Les chevaux bien développés")
            .split(' ')
            .map(str::to_owned)
            .collect();
        let b: Vec<String> = normalize("un cheval à développer")
            .split(' ')
            .map(str::to_owned)
            .collect();
        let cheval = normalize("cheval");
        let develop = normalize("développé");
        assert!(a.contains(&cheval) && b.contains(&cheval), "cheval shared: {a:?} / {b:?}");
        assert!(a.contains(&develop) && b.contains(&develop), "develop shared: {a:?} / {b:?}");
    }

    #[test]
    fn accent_folding_makes_resume_findable() {
        // "resume" (no accents) reduces to the same stem as "résumé".
        assert_eq!(normalize("resume"), normalize("résumé"));
    }

    #[test]
    fn normalize_is_idempotent() {
        for s in ["Les chevaux d'André", "RÉSUMÉ de l'Œuvre", "  ", "café-crème!!"] {
            assert_eq!(normalize(&normalize(s)), normalize(s), "not idempotent: {s:?}");
        }
    }

    #[test]
    fn blank_query_builds_nothing() {
        let fields = [Field::new("t", Weight::A)];
        assert!(Query::build("", &fields, 1).is_none());
        assert!(Query::build("   !!  ", &fields, 1).is_none());
    }

    #[test]
    fn build_numbers_placeholders_and_survives_prepare() {
        let fields = [
            Field::new("title_norm", Weight::A),
            Field::new("body_norm", Weight::B),
        ];
        let s = Query::build("chevaux rapides", &fields, 3).expect("some");
        // 2 terms x 2 fields = 4 WHERE binds + 4 ORDER binds.
        assert_eq!(s.binds.len(), 8);
        assert_eq!(s.next, 11); // 3 + 8
        // The assembled statement must pass prepare on all three engines
        // (contiguous, non-reused $n; LIMIT/OFFSET after the ORDER block).
        let full = format!(
            "SELECT id FROM notes WHERE owner_id = $1 AND is_trashed = $2 \
             AND {} ORDER BY {} DESC LIMIT ${} OFFSET ${}",
            s.where_sql,
            s.order_sql,
            s.next,
            s.next + 1
        );
        for b in [Backend::Postgres, Backend::MySql, Backend::Sqlite] {
            assert!(sql::prepare(&full, b).is_ok(), "{b:?}: {full}");
        }
        // And no lint complaint (LIKE is portable; no PG-only construct).
        assert!(sql::lint(&full).is_empty(), "unexpected lint: {:?}", sql::lint(&full));
    }

    // ── end-to-end against a real engine ────────────────────────────────────────

    /// A searchable document, stored with a normalized column per weight class.
    #[derive(Debug, sqlx::FromRow)]
    struct Hit {
        title: String,
    }

    fn sqlite_settings(dir: &std::path::Path) -> crate::DbSettings {
        crate::DbSettings {
            engine: "sqlite".to_owned(),
            url: None,
            host: None,
            port: None,
            user: None,
            password: None,
            database: None,
            path: Some(dir.to_string_lossy().into_owned()),
            schema_prefix: None,
            max_connections: 2,
            min_connections: 0,
            connect_timeout: std::time::Duration::from_secs(10),
            run_migrations: false,
        }
    }

    const SCHEMA: &str = "kbsearchtest";
    const TABLE: &str = "kbsearchtest.docs";

    /// Creates the table, inserts the documents (title/body normalized in Rust),
    /// and returns the titles a search for `query` finds, best-ranked first.
    async fn search_titles(pool: &crate::DbPool, query: &str) -> Vec<String> {
        let fields = [
            Field::new("title_norm", Weight::A),
            Field::new("body_norm", Weight::B),
        ];
        let s = Query::build(query, &fields, 1).expect("query has stems");
        let sql = format!(
            "SELECT title FROM {TABLE} WHERE {} ORDER BY {} DESC, title ASC",
            s.where_sql, s.order_sql
        );
        pool.fetch_all_as::<Hit>(&sql, s.binds)
            .await
            .expect("search runs")
            .into_iter()
            .map(|h| h.title)
            .collect()
    }

    /// Creates the table, inserts the corpus (normalized in Rust), and asserts
    /// the stemmed/deaccented search behaves as specified. Engine-agnostic:
    /// column types come from [`crate::Backend`], so the SAME body runs against
    /// SQLite and MySQL and must give the SAME rows - the homogeneity proof.
    async fn assert_search_semantics(pool: &crate::DbPool) {
        use crate::{new_id, params};

        let uuid_col = pool.backend().col_uuid();
        pool.execute(
            &format!(
                "CREATE TABLE {TABLE} (
                     id         {uuid_col} NOT NULL PRIMARY KEY,
                     title      VARCHAR(190) NOT NULL,
                     title_norm VARCHAR(190) NOT NULL,
                     body_norm  VARCHAR(190) NOT NULL
                 )"
            ),
            params![],
        )
        .await
        .expect("create table");

        // (title, body) documents. Normalization happens in Rust at write time.
        let docs = [
            ("Un cheval au galop", "Le cheval broute dans le pré développé"),
            ("Recette de café", "Boire un café le matin"),
            ("Notes de résumé", "Le résumé du projet est prêt"),
        ];
        for (title, body) in docs {
            pool.execute(
                &format!(
                    "INSERT INTO {TABLE} (id, title, title_norm, body_norm) \
                     VALUES ($1, $2, $3, $4)"
                ),
                params![new_id(), title, normalize(title), normalize(body)],
            )
            .await
            .expect("insert");
        }

        // 1. A plural query word finds the singular stored form: "chevaux"
        //    stems to "cheval", which the first document contains.
        let hits = search_titles(pool, "chevaux").await;
        assert_eq!(hits, vec!["Un cheval au galop".to_owned()], "chevaux -> cheval");

        // 2. Accent folding: "resume" (no accents) finds "résumé".
        let hits = search_titles(pool, "resume").await;
        assert_eq!(hits, vec!["Notes de résumé".to_owned()], "resume -> résumé");

        // 3. A term absent everywhere returns nothing.
        assert!(search_titles(pool, "hélicoptère").await.is_empty());
    }

    #[tokio::test]
    async fn sqlite_stemmed_search_end_to_end() {
        let dir = tempfile::tempdir().expect("tempdir");
        let settings = sqlite_settings(dir.path());
        let pool = crate::connect(&settings, SCHEMA).await.expect("connect sqlite");
        assert_search_semantics(&pool).await;
    }

    /// The same search, on a real MySQL/MariaDB, when `KUBUNO_DB_TEST_MYSQL_URL`
    /// points at a throwaway database. Proves the result is identical on a
    /// second engine - the stemming being in Rust, it cannot differ. Skipped
    /// (not failed) when the variable is unset, so `cargo test` stays green
    /// without a server; the report records a real run.
    #[tokio::test]
    async fn mysql_stemmed_search_matches_sqlite() {
        let Ok(url) = std::env::var("KUBUNO_DB_TEST_MYSQL_URL") else {
            eprintln!("KUBUNO_DB_TEST_MYSQL_URL unset - skipping the MySQL leg");
            return;
        };
        let settings = crate::DbSettings {
            engine: "mysql".to_owned(),
            url: Some(url),
            host: None,
            port: None,
            user: None,
            password: None,
            database: None,
            path: None,
            schema_prefix: None,
            max_connections: 2,
            min_connections: 0,
            connect_timeout: std::time::Duration::from_secs(10),
            run_migrations: false,
        };
        let pool = crate::connect(&settings, SCHEMA).await.expect("connect mysql");
        // Clean slate: the throwaway DB may carry a table from a previous run.
        let _ = pool
            .execute(&format!("DROP TABLE IF EXISTS {TABLE}"), crate::params![])
            .await;
        assert_search_semantics(&pool).await;
    }

    /// The heart of the "same result on every engine" claim: since stemming and
    /// folding happen in Rust before any SQL, the stored/searched tokens do not
    /// depend on the engine at all. This asserts the Rust layer is stable so the
    /// SQLite end-to-end result above transfers verbatim to MySQL/PostgreSQL.
    #[test]
    fn normalization_is_engine_independent() {
        // The heart of the "same result on every engine" claim: stemming and
        // folding happen in Rust, before any SQL, so the stored/searched tokens
        // do not depend on the engine. The SQLite end-to-end result therefore
        // transfers verbatim to MySQL and PostgreSQL.
        let stored = normalize("Un cheval au galop");
        let queried = normalize("chevaux");
        // Every query stem is a substring of the stored, deaccented tokens -
        // exactly what `LIKE '%stem%'` tests, identically on the three engines.
        for stem in queried.split(' ').filter(|s| !s.is_empty()) {
            assert!(stored.contains(stem), "{stem:?} not in {stored:?}");
        }
    }
}
