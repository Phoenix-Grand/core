//! The five guards without which delegation *is* privilege escalation.
//!
//! Each one closes a path that is obvious in hindsight and invisible in a code
//! review that only checks "does this handler require a privilege":
//!
//! 1. [`ensure_role_management`] - defining roles is a superuser act. Whoever
//!    can write a role can write themselves a role.
//! 2. [`ensure_can_grant`] - you cannot grant what you do not hold, nor over a
//!    scope wider than your own.
//! 3. [`ensure_can_act_on_user`] - you cannot touch an account that holds a role
//!    you do not hold **in full**. Without this, `core.users.update` over the
//!    root unit is a password reset on a super-administrator, which is a total
//!    takeover through a privilege that reads as mundane.
//! 4. [`ensure_superadmin_remains`] - the instance must keep at least one active
//!    super-administrator. An instance with none is unrecoverable without
//!    database surgery.
//! 5. [`AdminContext::require_superuser`] at the two call sites that execute
//!    arbitrary code: installing a module and trusting a theme.
//!
//! Guards 2 and 3 are scope-aware: "holding" a privilege means holding it over
//! the unit the target actually sits in, not merely somewhere.

use std::collections::HashSet;

use kubuno_db::{params, Backend, DbPool, DbTx};
use uuid::Uuid;

use super::context::AdminContext;
use super::model::AssignmentScope;
use crate::errors::AppError;

/// One privilege key read as a single-column row. `DbPool` cannot fetch a bare
/// scalar list into a `Vec`, so each key comes back wrapped in this one-field
/// struct and is unwrapped by the caller.
#[derive(sqlx::FromRow)]
struct KeyRow {
    key: String,
}

/// A role-assignment row: whether the assigned role is a superuser role, and one
/// of the privilege keys it carries (NULL when it carries none).
#[derive(sqlx::FromRow)]
struct RoleAssignmentRow {
    is_superuser: bool,
    privilege_key: Option<String>,
}

/// Guard 1 - defining roles and their privilege sets is superuser-only.
pub fn ensure_role_management(ctx: &AdminContext) -> Result<(), AppError> {
    ctx.require_superuser("gestion des rôles")
}

/// The organisational unit an account sits in.
pub async fn user_org_unit(db: &DbPool, user_id: Uuid) -> Result<Option<Uuid>, AppError> {
    let unit: Option<Option<Uuid>> = db
        .fetch_optional_scalar::<Option<Uuid>>(
            "SELECT org_unit_id FROM core.users WHERE id = $1",
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "authz: reading the target's org unit");
            AppError::Database(e)
        })?;
    Ok(unit.flatten())
}

/// Privileges carried by a role, and whether the role is a superuser role.
async fn role_contents(db: &DbPool, role_id: Uuid) -> Result<(bool, Vec<String>), AppError> {
    let is_superuser: Option<bool> = db
        .fetch_optional_scalar::<bool>(
            "SELECT is_superuser FROM core.roles WHERE id = $1",
            params![role_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, role_id = %role_id, "authz: reading the role");
            AppError::Database(e)
        })?;
    let is_superuser =
        is_superuser.ok_or_else(|| AppError::NotFound(format!("Rôle {role_id}")))?;

    let keys: Vec<String> = db
        .fetch_all_as::<KeyRow>(
            "SELECT privilege_key AS \"key\" FROM core.role_privileges WHERE role_id = $1 ORDER BY privilege_key",
            params![role_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, role_id = %role_id, "authz: reading the role's privileges");
            AppError::Database(e)
        })?
        .into_iter()
        .map(|r| r.key)
        .collect();

    Ok((is_superuser, keys))
}

/// **The scopability rule.** An org-unit-scoped assignment is refused when its
/// role carries even one privilege that cannot be confined to a subtree.
///
/// This is what makes the scope a boundary rather than a label. A role mixing
/// `core.users.update` (scopable) with `core.settings.manage` (not) cannot be
/// "restricted to the Marketing unit": the settings privilege would still apply
/// to the whole instance, and the person granting it would believe otherwise.
pub async fn ensure_scopable(
    db: &DbPool,
    role_id: Uuid,
    scope: AssignmentScope,
) -> Result<(), AppError> {
    if scope != AssignmentScope::OrgUnit {
        return Ok(());
    }

    let (is_superuser, _) = role_contents(db, role_id).await?;
    if is_superuser {
        return Err(AppError::Validation(
            "Un rôle super-utilisateur ne peut pas être restreint à une unité organisationnelle : \
             il détient tout, présent et futur."
                .into(),
        ));
    }

    let blocking: Vec<String> = db
        .fetch_all_as::<KeyRow>(
            r#"SELECT p."key"
                 FROM core.role_privileges rp
                 JOIN core.privileges p ON p."key" = rp.privilege_key
                WHERE rp.role_id = $1 AND NOT p.is_ou_scopable
                ORDER BY p."key""#,
            params![role_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, role_id = %role_id, "authz: scopability check");
            AppError::Database(e)
        })?
        .into_iter()
        .map(|r| r.key)
        .collect();

    if blocking.is_empty() {
        return Ok(());
    }

    Err(AppError::Validation(format!(
        "Affectation impossible à une unité organisationnelle : ce rôle contient {} privilège(s) \
         non restreignable(s) ({}). Une portée d'unité serait une illusion de sécurité.",
        blocking.len(),
        blocking.join(", ")
    )))
}

/// Guard 2 - you cannot grant a privilege you do not hold, nor over a scope
/// wider than the one you hold it at.
pub async fn ensure_can_grant(
    db: &DbPool,
    ctx: &AdminContext,
    role_id: Uuid,
    scope: AssignmentScope,
    unit: Option<Uuid>,
) -> Result<(), AppError> {
    if ctx.is_superuser {
        return Ok(());
    }

    let (is_superuser_role, keys) = role_contents(db, role_id).await?;
    if is_superuser_role {
        tracing::warn!(
            actor = %ctx.user_id,
            role_id = %role_id,
            "Tentative d'octroi d'un rôle super-utilisateur par un non-super-utilisateur"
        );
        return Err(AppError::Forbidden);
    }

    // Granting over a subtree the caller does not administer is granting outside
    // one's own scope even when every privilege is held.
    if scope == AssignmentScope::OrgUnit {
        let Some(target_unit) = unit else {
            return Err(AppError::Validation("Unité organisationnelle requise".into()));
        };
        let covered = keys
            .iter()
            .all(|k| ctx.has_for_unit(k, Some(target_unit)));
        if !covered {
            tracing::warn!(
                actor = %ctx.user_id,
                role_id = %role_id,
                org_unit = %target_unit,
                "Octroi refusé : le rôle dépasse le périmètre de l'appelant"
            );
            return Err(AppError::Forbidden);
        }
        return Ok(());
    }

    // Instance scope demands the privilege at instance scope: an operator
    // confined to a unit must not be able to hand out instance-wide power.
    let missing: Vec<&String> = keys.iter().filter(|k| !ctx.has_at_instance(k)).collect();
    if !missing.is_empty() {
        tracing::warn!(
            actor = %ctx.user_id,
            role_id = %role_id,
            missing = ?missing,
            "Octroi refusé : privilèges non détenus à portée instance"
        );
        return Err(AppError::Forbidden);
    }
    Ok(())
}

/// Every role held by an account, directly or through a group, not expired.
async fn roles_held_by(
    db: &DbPool,
    user_id: Uuid,
) -> Result<(bool, HashSet<String>), AppError> {
    // `NOW()` is bound from Rust so the comparison is engine-agnostic, and the
    // user id feeds two placeholders (bound twice: one per `$n`).
    let now = chrono::Utc::now();
    let rows: Vec<RoleAssignmentRow> = db
        .fetch_all_as::<RoleAssignmentRow>(
            r#"SELECT r.is_superuser, rp.privilege_key
                 FROM core.role_assignments a
                 JOIN core.roles r ON r.id = a.role_id
                 LEFT JOIN core.role_privileges rp ON rp.role_id = r.id
                WHERE (a.expires_at IS NULL OR a.expires_at > $1)
                  AND (
                        a.subject_user_id = $2
                     OR a.subject_group_id IN (
                            SELECT m.group_id FROM core.user_group_members m WHERE m.user_id = $3
                        )
                      )"#,
            params![now, user_id, user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "authz: reading the target's roles");
            AppError::Database(e)
        })?;

    let mut superuser = false;
    let mut keys = HashSet::new();
    for row in rows {
        superuser |= row.is_superuser;
        if let Some(k) = row.privilege_key {
            keys.insert(k);
        }
    }
    Ok((superuser, keys))
}

/// Guard 3 - refuse to act on an account holding a role the caller does not
/// hold in full.
///
/// The attack this closes: an operator delegated `core.users.update` and
/// `core.user_password.execute` over the **root** unit holds them over every
/// account, including the super-administrators - and a password reset on a
/// super-administrator is a complete takeover through a privilege that looks
/// like account maintenance. The rule is not "do not touch admins", it is the
/// general form: whatever the target holds, the caller must hold too.
pub async fn ensure_can_act_on_user(
    db: &DbPool,
    ctx: &AdminContext,
    target_user_id: Uuid,
) -> Result<(), AppError> {
    if ctx.is_superuser {
        return Ok(());
    }
    // Acting on oneself is always within one's own perimeter by construction,
    // and refusing it would lock an operator out of their own account page.
    if ctx.user_id == target_user_id {
        return Ok(());
    }

    let (target_is_superuser, target_keys) = roles_held_by(db, target_user_id).await?;

    if target_is_superuser {
        tracing::warn!(
            actor = %ctx.user_id,
            target = %target_user_id,
            "Action refusée : la cible détient un rôle super-utilisateur"
        );
        return Err(AppError::Forbidden);
    }

    let target_unit = user_org_unit(db, target_user_id).await?;
    let missing: Vec<&String> = target_keys
        .iter()
        .filter(|k| !ctx.has_for_unit(k, target_unit))
        .collect();

    if !missing.is_empty() {
        tracing::warn!(
            actor = %ctx.user_id,
            target = %target_user_id,
            missing = ?missing,
            "Action refusée : la cible détient des privilèges que l'appelant ne détient pas"
        );
        return Err(AppError::Forbidden);
    }
    Ok(())
}

/// Number of active super-administrators, evaluated on the given connection -
/// so it can be called **inside** a transaction, after the mutation, and see its
/// effect.
pub async fn superadmin_count(tx: &mut DbTx) -> Result<i64, AppError> {
    let backend = tx.backend();
    // Portable derived table (see `database::compat`): the set-returning
    // function `core.superadmin_ids()` exists only on PostgreSQL.
    let sql = format!(
        "SELECT {} FROM {} s",
        backend.count_bigint("*"),
        crate::database::compat::superadmin_ids(backend)
    );
    let count = tx
        .fetch_optional_scalar::<i64>(&sql, params![])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "authz: counting super-administrators");
            AppError::Database(e)
        })?;
    // COUNT always returns exactly one row.
    Ok(count.unwrap_or(0))
}

/// Guard 4 - refuse a mutation that would leave the instance with no active
/// super-administrator.
///
/// Called **after** the write, inside the same transaction: "would this leave
/// zero" is a question about the post-state, and predicting it from the
/// pre-state is where off-by-one mistakes live. The caller rolls back on `Err`.
pub async fn ensure_superadmin_remains(tx: &mut DbTx) -> Result<(), AppError> {
    if superadmin_count(tx).await? > 0 {
        return Ok(());
    }
    tracing::warn!("Refus : l'opération retirerait le dernier super-administrateur de l'instance");
    Err(AppError::Validation(
        "Opération refusée : l'instance doit conserver au moins un super-administrateur actif.".into(),
    ))
}

/// Keeps `core.users.role` in step with "holds an instance-scoped superuser
/// role".
///
/// The column is **not** the source of truth any more, and its `CHECK` is
/// frozen - but the module proxy forwards it in `X-Kubuno-User-Role` and the
/// frontend reads it, so it is maintained as a denormalised cache of exactly one
/// fact. Delegated administrators keep `role = 'user'`: their power is scoped to
/// the core's console and does not travel to the modules.
pub async fn sync_role_cache(tx: &mut DbTx, user_id: Uuid) -> Result<(), AppError> {
    // Portable derived table (see `database::compat`) in place of the
    // PostgreSQL-only `core.superadmin_ids()`.
    let sql = format!(
        r#"UPDATE core.users u
              SET role = CASE
                             WHEN EXISTS (SELECT 1 FROM {} s WHERE s.user_id = u.id)
                                 THEN 'admin'
                             WHEN u.role = 'admin' THEN 'user'
                             ELSE u.role
                         END
            WHERE u.id = $1"#,
        crate::database::compat::superadmin_ids(tx.backend())
    );
    tx.execute(&sql, params![user_id])
    .await
    .map_err(|e| {
        tracing::error!(error = %e, user_id = %user_id, "authz: syncing the users.role cache");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Grants (or revokes) the instance-scoped super-administrator assignment behind
/// a direct write to `core.users.role`.
///
/// The legacy `PATCH /admin/users/:id { role }` surface predates this model and
/// the console still uses it. Left alone it would create administrators with no
/// assignment - invisible to the whole delegation model, and to guard 4. So the
/// two representations are written together.
pub async fn apply_legacy_role_change(
    tx: &mut DbTx,
    user_id: Uuid,
    new_role: &str,
    granted_by: Uuid,
) -> Result<(), AppError> {
    let backend = tx.backend();
    if new_role == "admin" {
        // `ON CONFLICT DO NOTHING` with no target list has no portable target,
        // so it is spliced as (prefix, suffix): MySQL uses `INSERT IGNORE`, the
        // others a trailing `ON CONFLICT DO NOTHING`.
        let (ignore, on_conflict) = match backend {
            Backend::MySql => ("IGNORE ", ""),
            _ => ("", " ON CONFLICT DO NOTHING"),
        };
        let sql = format!(
            r#"INSERT {ignore}INTO core.role_assignments (role_id, subject_user_id, scope, created_by)
               SELECT r.id, $1, 'instance', $2 FROM core.roles r WHERE r.slug = 'super-admin'{on_conflict}"#
        );
        tx.execute(&sql, params![user_id, granted_by])
            .await
            .map_err(|e| {
                tracing::error!(error = %e, user_id = %user_id, "authz: granting the super-admin assignment");
                AppError::Database(e)
            })?;
    } else {
        // Rewritten from PostgreSQL's `DELETE ... USING` (unsupported on
        // SQLite, differently spelled on MySQL) to a portable subquery. The
        // subquery targets `core.roles`, not the delete target, so MySQL
        // accepts it too.
        tx.execute(
            r#"DELETE FROM core.role_assignments
                WHERE subject_user_id = $1
                  AND scope = 'instance'
                  AND role_id IN (SELECT r.id FROM core.roles r WHERE r.is_superuser)"#,
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "authz: revoking the super-admin assignment");
            AppError::Database(e)
        })?;
    }
    super::cache::invalidate_all();
    Ok(())
}

/// Convenience wrapper for callers holding a pool rather than a transaction.
pub async fn superadmin_count_pool(db: &DbPool) -> Result<i64, AppError> {
    // A short read-only transaction so the count reuses the tx-based helper;
    // it is rolled back (nothing was written).
    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "authz: acquiring a connection");
        AppError::Database(e)
    })?;
    let count = superadmin_count(&mut tx).await?;
    tx.rollback().await.map_err(|e| {
        tracing::error!(error = %e, "authz: releasing the connection");
        AppError::Database(e)
    })?;
    Ok(count)
}
