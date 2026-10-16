//! Portable equivalents of the PostgreSQL SQL functions the handlers rely on.
//!
//! The core schema historically shipped a handful of `LANGUAGE sql` / plpgsql
//! functions - `core.org_unit_descendants`, `core.org_unit_ancestors`,
//! `core.superadmin_ids`, `core.label_access`, `core.setting_chain`,
//! `core.setting_overrides` - that the request handlers call inline
//! (`FROM core.org_unit_descendants($1) d`, `WHERE ... IN (SELECT ...
//! FROM core.superadmin_ids())`). MySQL and SQLite have no such stored
//! functions, so those calls fail at run time on any non-PostgreSQL deployment.
//!
//! This module produces the same result sets as **SQL fragments** built for the
//! configured [`Backend`]: a recursive CTE for the tree walks (supported by
//! PostgreSQL, MySQL 8+ and SQLite alike) and a plain derived table for the
//! non-recursive ones. Callers interpolate the fragment where they used to name
//! the function, keep the same table alias, and bind the same values.
//!
//! # Placeholders
//!
//! [`kubuno_db::sql::prepare`] rejects reused or out-of-order `$n`, because
//! MySQL/SQLite placeholders are positional. Each helper therefore takes the
//! number of the *next* free placeholder and consumes a known, documented count
//! of them; the caller binds one value per placeholder, in order. A tree walk's
//! root id is bound once (or once per root, for the multi-root variant).
//!
//! # Depth guard
//!
//! Every recursive walk is bounded by [`MAX_TREE_DEPTH`]. A cycle stored by a
//! past bug (A → B → A) must degrade into a truncated result, never hang the
//! backend - MySQL and SQLite do not detect cycles on their own, and neither
//! does PostgreSQL's `WITH RECURSIVE` without such a guard.

use kubuno_db::dialect::Backend;

/// The ceiling on any organizational-tree walk. Matches the default the
/// PostgreSQL functions carried (`p_max_depth DEFAULT 64`); the console enforces
/// a much shallower tree, so this only ever bounds a corrupted, cyclic one.
pub const MAX_TREE_DEPTH: i32 = 64;

/// A parenthesised list `$start, $start+1, …` of `count` placeholders. Never
/// empty here: callers only build a multi-root walk from a non-empty set.
fn placeholder_list(start: usize, count: usize) -> String {
    (0..count)
        .map(|i| format!("${}", start + i))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Portable replacement for `core.org_unit_descendants($root)`.
///
/// A derived table with columns `(id, name, parent_id, depth)` - the same shape
/// the PostgreSQL function returned. `depth` is `0` for the root itself, `1` for
/// its direct children, and so on; a unit reachable by several paths (a cycle)
/// keeps its shallowest depth. `root` is the placeholder number of the root id,
/// bound once.
///
/// Interpolate it where the function call sat and keep the alias:
/// `FROM core.org_unit_descendants($1) d` → `FROM {} d`.
pub fn org_unit_descendants(root: usize) -> String {
    subtree(
        "SELECT u.id, u.name, u.parent_id, 0 AS depth \
           FROM core.org_units u \
          WHERE u.id = $root",
        // A child links to a parent already in the frontier.
        "c.parent_id = s.id",
        &root.to_string(),
    )
}

/// Portable replacement for `core.org_unit_descendants(...)` over a **set** of
/// roots (the delegated-listing filter, which walks the subtree of every unit a
/// grant covers). `start` is the first of `count` placeholders, each a root id
/// bound in order. Panics on an empty set - callers must not build one.
pub fn org_unit_descendants_many(start: usize, count: usize) -> String {
    assert!(count > 0, "org_unit_descendants_many needs at least one root");
    let anchor = format!(
        "SELECT u.id, u.name, u.parent_id, 0 AS depth \
           FROM core.org_units u \
          WHERE u.id IN ({})",
        placeholder_list(start, count)
    );
    subtree(&anchor, "c.parent_id = s.id", "")
}

/// Portable expansion of **several** subtrees at once, each row tagged with the
/// root it descends from - the shape the effective-privilege resolver needs (it
/// expands every unit a grant is scoped to and maps the descendants back to that
/// grant). Columns `(root, id)`. `start` is the first of `count` placeholders,
/// each a root id bound in order. Panics on an empty set.
pub fn org_unit_descendants_with_root(start: usize, count: usize) -> String {
    assert!(count > 0, "org_unit_descendants_with_root needs at least one root");
    let roots = placeholder_list(start, count);
    let depth = MAX_TREE_DEPTH;
    format!(
        "(WITH RECURSIVE _kb_roots(root, id, depth) AS ( \
             SELECT u.id AS root, u.id AS id, 0 AS depth \
               FROM core.org_units u WHERE u.id IN ({roots}) \
             UNION ALL \
             SELECT s.root, c.id, s.depth + 1 \
               FROM core.org_units c JOIN _kb_roots s ON c.parent_id = s.id \
              WHERE s.depth < {depth} \
         ) \
         SELECT DISTINCT root, id FROM _kb_roots)"
    )
}

/// Portable replacement for `core.org_unit_ancestors($root)`.
///
/// Columns `(id, name, parent_id, depth)`: `depth` 0 is the unit itself, 1 its
/// parent, up to the root. `root` is the placeholder number of the start id,
/// bound once.
pub fn org_unit_ancestors(root: usize) -> String {
    subtree(
        "SELECT u.id, u.name, u.parent_id, 0 AS depth \
           FROM core.org_units u \
          WHERE u.id = $root",
        // The parent of a unit already in the frontier.
        "c.id = s.parent_id",
        &root.to_string(),
    )
}

/// Shared body of the two walks: the anchor query, the join condition that adds
/// the next ring, and the root placeholder to substitute into the anchor.
///
/// The recursive CTE is spelled identically on the three engines. The outer
/// `GROUP BY … MIN(depth)` deduplicates a unit reached by several paths and
/// keeps the shallowest depth, matching the PostgreSQL function's `DISTINCT ON`.
fn subtree(anchor: &str, step_join: &str, root_placeholder: &str) -> String {
    let anchor = anchor.replace("$root", &format!("${root_placeholder}"));
    let depth = MAX_TREE_DEPTH;
    format!(
        "(WITH RECURSIVE _kb_walk(id, name, parent_id, depth) AS ( \
             {anchor} \
             UNION ALL \
             SELECT c.id, c.name, c.parent_id, s.depth + 1 \
               FROM core.org_units c \
               JOIN _kb_walk s ON {step_join} \
              WHERE s.depth < {depth} \
         ) \
         SELECT id, name, parent_id, MIN(depth) AS depth \
           FROM _kb_walk GROUP BY id, name, parent_id)"
    )
}

/// Portable replacement for `core.superadmin_ids()`: active accounts holding an
/// instance-scoped super-user role (directly or through a group), the grant not
/// expired. A derived table with a single column `user_id`. No placeholders;
/// interpolate and give it an alias - `FROM core.superadmin_ids() s` →
/// `FROM {} s`.
pub fn superadmin_ids(backend: Backend) -> String {
    let now = backend.now();
    format!(
        "(SELECT DISTINCT u.id AS user_id \
            FROM core.users u \
            JOIN core.role_assignments a \
              ON a.subject_user_id = u.id \
              OR a.subject_group_id IN ( \
                     SELECT m.group_id FROM core.user_group_members m WHERE m.user_id = u.id \
                 ) \
            JOIN core.roles r ON r.id = a.role_id \
           WHERE u.is_active \
             AND r.is_superuser \
             AND a.scope = 'instance' \
             AND (a.expires_at IS NULL OR a.expires_at > {now}))"
    )
}

/// Portable replacement for `core.label_access($user)`: the labels a user can
/// reach, owned or shared (directly or through a group), with the effective
/// `is_owner` / `can_manage` flags. A derived table
/// `(label_id, is_owner, can_manage)`.
///
/// The user id is referenced three times; `user` is the first of **three**
/// consecutive placeholders, all bound to that same id in order. The per-flag
/// fold is [`Backend::bool_or`] (`bool_or` on PostgreSQL, `MAX` over the
/// boolean-as-integer columns on MySQL/SQLite).
pub fn label_access(backend: Backend, user: usize) -> String {
    let owner = user;
    let shared = user + 1;
    let group = user + 2;
    format!(
        "(SELECT a.label_id, {is_owner} AS is_owner, {can_manage} AS can_manage \
            FROM ( \
                SELECT l.id AS label_id, TRUE AS is_owner, TRUE AS can_manage \
                  FROM core.labels l WHERE l.owner_id = ${owner} \
                UNION ALL \
                SELECT s.label_id, FALSE, s.can_manage \
                  FROM core.label_shares s WHERE s.user_id = ${shared} \
                UNION ALL \
                SELECT s.label_id, FALSE, s.can_manage \
                  FROM core.label_shares s \
                  JOIN core.user_group_members m ON m.group_id = s.group_id \
                 WHERE m.user_id = ${group} \
            ) a \
           GROUP BY a.label_id)",
        is_owner = backend.bool_or("a.is_owner"),
        can_manage = backend.bool_or("a.can_manage"),
    )
}

/// How many placeholders [`label_access`] consumes.
pub const LABEL_ACCESS_BINDS: usize = 3;

#[cfg(test)]
mod tests {
    use super::*;
    use kubuno_db::dialect::Backend;

    const ALL: [Backend; 3] = [Backend::Postgres, Backend::MySql, Backend::Sqlite];

    /// Every generated fragment must survive the placeholder scanner on every
    /// engine (ascending, each used once) inside a representative statement.
    #[test]
    fn fragments_survive_prepare() {
        for b in ALL {
            let cases = [
                format!("SELECT d.id FROM {} d", org_unit_descendants(1)),
                format!("SELECT a.id FROM {} a", org_unit_ancestors(1)),
                format!(
                    "SELECT d.id FROM {} d",
                    org_unit_descendants_many(1, 3)
                ),
                format!("SELECT user_id FROM {} s", superadmin_ids(b)),
                format!("SELECT label_id FROM {} a WHERE a.label_id = $4", label_access(b, 1)),
            ];
            for sql in cases {
                assert!(
                    kubuno_db::sql::prepare(&sql, b).is_ok(),
                    "{b:?}: fragment breaks prepare: {sql}"
                );
            }
        }
    }

    #[test]
    fn descendants_many_lists_each_root() {
        let f = org_unit_descendants_many(2, 3);
        assert!(f.contains("IN ($2, $3, $4)"), "{f}");
    }

    #[test]
    fn superadmin_ids_uses_the_engine_now() {
        assert!(superadmin_ids(Backend::Postgres).contains("NOW()"));
        assert!(superadmin_ids(Backend::Sqlite).contains("strftime"));
    }
}
