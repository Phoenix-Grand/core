//! Keeping `users.role = 'admin'` and the super-administrator assignment in step.
//!
//! Since migration `000044`, what an administrator may do comes from a role
//! ASSIGNMENT; `core.users.role` is only a denormalised cache of "holds an
//! instance-scoped superuser role", kept because the module proxy forwards it
//! and the frontend reads it. The console derives every one of its entries from
//! the assignment, never from the cache.
//!
//! That left the very first administrator with nothing. The migration's backfill
//! granted the assignment to the accounts existing WHEN IT RAN, and on a fresh
//! installation there are none: the administrator is created afterwards, by the
//! installation wizard or by the headless seed, both of which wrote the cache
//! alone. The result was an account flagged administrator, admitted to the
//! console, and holding zero privileges - a console showing only the handful of
//! pages that require none, and a 403 on everything else.
//!
//! Two answers, both here: [`grant_instance_superadmin`] for the accounts being
//! created, and [`reconcile_superadmins`] at every start for those already out
//! there, whose instance cannot be repaired by a migration that has already run.

use kubuno_db::{params, Backend, DbPool};
use uuid::Uuid;

/// The "skip a duplicate" spelling for the current engine: MySQL uses
/// `INSERT IGNORE`, PostgreSQL and SQLite a bare `ON CONFLICT DO NOTHING` (valid
/// with no target on both). Returned as the `(prefix, suffix)` pair to splice
/// into the statement.
fn insert_ignore(backend: Backend) -> (&'static str, &'static str) {
    match backend {
        Backend::MySql => ("IGNORE ", ""),
        _ => ("", " ON CONFLICT DO NOTHING"),
    }
}

/// Grants the instance-scoped super-administrator role. Idempotent.
///
/// Returns whether an assignment was actually created, so a caller can say so.
pub async fn grant_instance_superadmin(db: &DbPool, user_id: Uuid) -> Result<bool, sqlx::Error> {
    let (ignore, on_conflict) = insert_ignore(db.backend());
    // The id is minted in Rust: `role_assignments.id` carries a `gen_random_uuid`
    // default on PostgreSQL only, and MySQL/SQLite would reject the NULL. A fresh
    // random primary key never collides; the natural-key conflict (the same user
    // already holding the role) is what `{on_conflict}`/`IGNORE` absorbs.
    let assignment_id = kubuno_db::new_id();
    let sql = format!(
        "INSERT {ignore}INTO core.role_assignments (id, role_id, subject_user_id, scope) \
         SELECT $1, r.id, $2, 'instance' FROM core.roles r WHERE r.slug = 'super-admin'{on_conflict}"
    );
    let created = db.execute(&sql, params![assignment_id, user_id]).await? > 0;

    if created {
        super::cache::invalidate_all();
    }
    Ok(created)
}

/// Grants the assignment to every active account flagged `role = 'admin'` that
/// holds no superuser role at all.
///
/// Runs at every start, and does nothing on an instance that is already
/// coherent - which is every instance but the ones installed while the gap was
/// open. It only ever ADDS what the flag already claims: an account reaches
/// `role = 'admin'` through a path that demands super-administration to begin
/// with, so this widens no door. Accounts holding it through a group are left
/// alone: `core.superadmin_ids()` already counts them.
pub async fn reconcile_superadmins(db: &DbPool) -> Result<u64, sqlx::Error> {
    // Portable derived table (see `database::compat`) in place of the
    // PostgreSQL-only `core.superadmin_ids()`. The caller (main bootstrap) logs
    // and continues on error.
    let superadmins = crate::database::compat::superadmin_ids(db.backend());
    // The candidates are read first, then granted one by one: an `INSERT … SELECT`
    // over several rows cannot mint a per-row primary key in Rust, and
    // `role_assignments.id` has no default outside PostgreSQL. Each grant reuses
    // the single-row path above, which mints its id and dedups.
    let sql = format!(
        "SELECT u.id FROM core.users u \
          WHERE u.role = 'admin' AND u.is_active \
            AND u.id NOT IN (SELECT user_id FROM {superadmins} sa)"
    );
    let candidates: Vec<UserIdRow> = db.fetch_all_as(&sql, params![]).await?;

    let mut n = 0u64;
    for row in candidates {
        if grant_instance_superadmin(db, row.id).await? {
            n += 1;
        }
    }

    if n > 0 {
        // `grant_instance_superadmin` already invalidated the cache on each
        // insert; the warning is emitted once for the batch.
        tracing::warn!(
            comptes = n,
            "Administrateur(s) sans attribution de rôle : super-administration instance rétablie \
             (compte créé par l'assistant d'installation ou le semis avant le correctif - la \
              console n'affichait alors qu'une poignée de pages)"
        );
    }
    Ok(n)
}

/// A single `id` column, for the reconcile scan.
#[derive(sqlx::FromRow)]
struct UserIdRow {
    id: Uuid,
}
