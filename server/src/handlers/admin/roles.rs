//! Roles, assignments and the privilege catalogue.
//!
//! Two objects, deliberately kept apart (see [`crate::authz`]): a **role** is a
//! named bag of privileges, an **assignment** binds a subject to a role over a
//! scope. Everything here is audited, and every write invalidates the resolution
//! cache - a revoked privilege that keeps working for a minute is a revocation
//! that did not happen.
//!
//! ## Who may do what here
//!
//! Defining roles is **superuser-only** (guard 1): whoever can write a role can
//! write themselves a role, so no amount of per-privilege gating makes role
//! editing safely delegable. Granting an existing role needs
//! `core.roles.manage` *and* passes guard 2 - you cannot hand out what you do
//! not hold, nor over a scope wider than your own.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use kubuno_db::{new_id, params, DbPool, DbQueryBuilder, DbRow};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{redact::target, AdminAudit, AuditEntry},
    authz::{
        cache,
        guards::{self, ensure_can_grant, ensure_role_management, ensure_scopable},
        keys,
        model::{parse_key, AssignmentScope, AssignmentRow, Privilege, Role},
        AdminCtx,
    },
    errors::AppError,
    state::AppState,
};

/// Columns of `core.roles`, in the order every read below names them.
const ROLE_COLS: &str =
    "id, slug, name, description, is_system, is_superuser, created_at, updated_at";

/// Maps a hand-fetched row to a [`Role`] (the tx read paths cannot decode a
/// struct directly).
fn role_from_row(r: &DbRow) -> Result<Role, sqlx::Error> {
    Ok(Role {
        id:           r.try_get("id")?,
        slug:         r.try_get("slug")?,
        name:         r.try_get("name")?,
        description:  r.try_get("description")?,
        is_system:    r.try_get("is_system")?,
        is_superuser: r.try_get("is_superuser")?,
        created_at:   r.try_get("created_at")?,
        updated_at:   r.try_get("updated_at")?,
    })
}

/// Maps a hand-fetched row to an [`AssignmentRow`] (same reason as
/// [`role_from_row`]: no struct decode inside a transaction).
fn assignment_from_row(r: &DbRow) -> Result<AssignmentRow, sqlx::Error> {
    Ok(AssignmentRow {
        id:                  r.try_get("id")?,
        role_id:             r.try_get("role_id")?,
        role_slug:           r.try_get("role_slug")?,
        role_name:           r.try_get("role_name")?,
        subject_user_id:     r.try_get("subject_user_id")?,
        subject_group_id:    r.try_get("subject_group_id")?,
        subject_label:       r.try_get("subject_label")?,
        scope:               r.try_get("scope")?,
        scope_org_unit_id:   r.try_get("scope_org_unit_id")?,
        scope_org_unit_name: r.try_get("scope_org_unit_name")?,
        expires_at:          r.try_get("expires_at")?,
        created_at:          r.try_get("created_at")?,
        created_by:          r.try_get("created_by")?,
    })
}

/// Snapshot of a role for the trail: the definition **and** its privilege set,
/// because "the role was widened" is the change worth reading.
fn role_snapshot(role: &Role, privileges: &[String]) -> Value {
    crate::audit::redact::snapshot(
        target::ROLE,
        &json!({
            "id":           role.id,
            "slug":         role.slug,
            "name":         role.name,
            "description":  role.description,
            "is_system":    role.is_system,
            "is_superuser": role.is_superuser,
            "privileges":   privileges,
        }),
    )
}

async fn privileges_of(db: &DbPool, role_id: Uuid) -> Result<Vec<String>, AppError> {
    let rows = db
        .fetch_all_as::<(String,)>(
            "SELECT privilege_key FROM core.role_privileges WHERE role_id = $1 ORDER BY privilege_key",
            params![role_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, role_id = %role_id, "roles: reading the privileges");
            AppError::Database(e)
        })?;
    Ok(rows.into_iter().map(|(k,)| k).collect())
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

/// `GET /admin/privileges` - the catalogue, orphans included and flagged.
pub async fn list_privileges(
    State(state): State<AppState>,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ROLES_READ)?;

    let privileges = state
        .db
        .fetch_all_as::<Privilege>(
            "SELECT \"key\", namespace, domain, verb, label, description, is_ou_scopable, is_orphan \
             FROM core.privileges ORDER BY namespace, domain, verb",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "list_privileges");
            AppError::Database(e)
        })?;

    Ok(Json(json!({ "privileges": privileges })))
}

// ── Roles ─────────────────────────────────────────────────────────────────────

/// `GET /admin/roles`
pub async fn list_roles(
    State(state): State<AppState>,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ROLES_READ)?;

    let backend = state.db.backend();

    let roles = state
        .db
        .fetch_all_as::<Role>(
            &format!("SELECT {ROLE_COLS} FROM core.roles ORDER BY is_superuser DESC, is_system DESC, name"),
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "list_roles"); AppError::Database(e) })?;

    // Privileges and assignment counts in two set-based queries rather than one
    // per role: the console lists every role on one screen.
    let pairs: Vec<(Uuid, String)> = state
        .db
        .fetch_all_as(
            "SELECT role_id, privilege_key FROM core.role_privileges ORDER BY privilege_key",
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "list_roles: privileges"); AppError::Database(e) })?;

    // Live assignments (not yet expired) counted per role. The "not expired"
    // cutoff is bound from Rust rather than spelled `NOW()` in SQL.
    let counts_sql = format!(
        "SELECT role_id, {} FROM core.role_assignments \
         WHERE expires_at IS NULL OR expires_at > $1 GROUP BY role_id",
        backend.count_bigint("*"),
    );
    let counts: Vec<(Uuid, i64)> = state
        .db
        .fetch_all_as(&counts_sql, params![Utc::now()])
        .await
        .map_err(|e| { tracing::error!(error = %e, "list_roles: assignments"); AppError::Database(e) })?;

    // A role is delegable to an organisational unit only when *every* one of its
    // privileges is scopable - surfaced here so the console can say so before
    // the operator discovers it on a refusal.
    let non_scopable_sql = format!(
        "SELECT rp.role_id, {} \
           FROM core.role_privileges rp \
           JOIN core.privileges p ON p.\"key\" = rp.privilege_key \
          WHERE NOT p.is_ou_scopable GROUP BY rp.role_id",
        backend.count_bigint("*"),
    );
    let non_scopable: Vec<(Uuid, i64)> = state
        .db
        .fetch_all_as(&non_scopable_sql, params![])
        .await
        .map_err(|e| { tracing::error!(error = %e, "list_roles: scopability"); AppError::Database(e) })?;

    let out: Vec<Value> = roles
        .iter()
        .map(|r| {
            let privileges: Vec<&str> = pairs
                .iter()
                .filter(|(id, _)| *id == r.id)
                .map(|(_, k)| k.as_str())
                .collect();
            let assignments = counts.iter().find(|(id, _)| *id == r.id).map(|(_, c)| *c).unwrap_or(0);
            let blocked = non_scopable.iter().any(|(id, c)| *id == r.id && *c > 0);
            json!({
                "id":               r.id,
                "slug":             r.slug,
                "name":             r.name,
                "description":      r.description,
                "is_system":        r.is_system,
                "is_superuser":     r.is_superuser,
                "privileges":       privileges,
                "assignment_count": assignments,
                // Superuser roles are never delegable to a subtree.
                "ou_delegable":     !blocked && !r.is_superuser,
                "created_at":       r.created_at,
                "updated_at":       r.updated_at,
            })
        })
        .collect();

    Ok(Json(json!({ "roles": out })))
}

#[derive(Deserialize)]
pub struct CreateRoleDto {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub privileges: Vec<String>,
}

/// Slug shape: what appears in URLs and in the trail.
fn validate_slug(slug: &str) -> Result<(), AppError> {
    if slug.len() < 2 || slug.len() > 100 {
        return Err(AppError::Validation("Identifiant : 2 à 100 caractères".into()));
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(AppError::Validation(
            "Identifiant : minuscules, chiffres et tirets uniquement".into(),
        ));
    }
    Ok(())
}

/// Checks that every key exists in the catalogue. An unknown key would be
/// rejected by the foreign key anyway; catching it here turns a 500 into a
/// message naming the offender.
async fn validate_privileges(db: &DbPool, keys_in: &[String]) -> Result<(), AppError> {
    for key in keys_in {
        parse_key(key)?;
    }
    if keys_in.is_empty() {
        return Ok(());
    }
    // The catalogue is static reference data, so it is read on the pool even when
    // a caller runs this mid-transaction. `= ANY($1)` becomes a variadic `IN`.
    let mut qb = DbQueryBuilder::new(db.backend(), "SELECT \"key\" FROM core.privileges WHERE \"key\"");
    qb.push_in(keys_in.iter().cloned());
    let known: Vec<String> = qb
        .fetch_all_as::<(String,)>(db)
        .await
        .map_err(|e| { tracing::error!(error = %e, "roles: validating the privileges"); AppError::Database(e) })?
        .into_iter()
        .map(|(k,)| k)
        .collect();

    let unknown: Vec<&String> = keys_in.iter().filter(|k| !known.contains(k)).collect();
    if !unknown.is_empty() {
        return Err(AppError::Validation(format!(
            "Privilège(s) inconnu(s) du catalogue : {}",
            unknown
                .iter()
                .map(|k| k.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    Ok(())
}

/// `POST /admin/roles` - superuser only (guard 1).
pub async fn create_role(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Json(dto): Json<CreateRoleDto>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    ensure_role_management(&ctx)?;
    validate_slug(&dto.slug)?;
    if dto.name.trim().is_empty() {
        return Err(AppError::Validation("Nom requis".into()));
    }

    // The catalogue check reads static reference data, so it runs on the pool
    // before the write transaction opens.
    validate_privileges(&state.db, &dto.privileges).await?;

    let mut tx = audit.begin(&state.db).await?;

    // The primary key and timestamps are produced in Rust (no `RETURNING`, and no
    // reliance on DB-side defaults for portability).
    let id = new_id();
    let now = Utc::now();
    let name = dto.name.trim().to_string();
    tx.execute(
        "INSERT INTO core.roles (id, slug, name, description, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        params![id, &dto.slug, &name, dto.description.as_deref(), now, now],
    )
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") {
            AppError::Conflict(format!("Un rôle « {} » existe déjà", dto.slug))
        } else {
            tracing::error!(error = %e, "create_role");
            AppError::Database(e)
        }
    })?;

    let role = Role {
        id,
        slug: dto.slug.clone(),
        name,
        description: dto.description.clone(),
        is_system: false,
        is_superuser: false,
        created_at: now,
        updated_at: now,
    };

    for key in &dto.privileges {
        tx.execute(
            "INSERT INTO core.role_privileges (role_id, privilege_key) VALUES ($1, $2)",
            params![role.id, key],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, key = %key, "create_role: privilege"); AppError::Database(e) })?;
    }

    tx.commit(
        AuditEntry::new("core.roles.create")
            .target(target::ROLE, role.id, role.name.clone())
            .after(role_snapshot(&role, &dto.privileges))
            .reversible(),
    )
    .await?;

    cache::invalidate_all();
    Ok((StatusCode::CREATED, Json(json!({ "role": role, "privileges": dto.privileges }))))
}

#[derive(Deserialize)]
pub struct UpdateRoleDto {
    pub name: Option<String>,
    pub description: Option<String>,
    /// Full replacement of the privilege set when present.
    pub privileges: Option<Vec<String>>,
}

/// `PATCH /admin/roles/:id` - superuser only (guard 1).
pub async fn update_role(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Path(role_id): Path<Uuid>,
    Json(dto): Json<UpdateRoleDto>,
) -> Result<Json<Value>, AppError> {
    ensure_role_management(&ctx)?;

    let mut tx = audit.begin(&state.db).await?;

    let for_update = tx.backend().for_update();
    let previous_row = tx
        .fetch_optional_row(
            &format!(
                "SELECT {ROLE_COLS} FROM core.roles WHERE id = $1{}",
                for_update
            ),
            params![role_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "update_role: read"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("Rôle {role_id}")))?;
    let previous = role_from_row(&previous_row)?;

    // Read on the pool: no write has happened in this transaction yet, so the
    // committed state is the correct "before" snapshot.
    let before_privileges = privileges_of(&state.db, role_id).await?;

    // A system role's privilege set is frozen: the four seeded roles are what
    // the escalation guards and the documentation reason about, and silently
    // redefining "administrateur en lecture seule" to include
    // `core.settings.manage` is a rename attack, not a configuration change.
    if previous.is_system && dto.privileges.is_some() {
        let name = previous.name.clone();
        return Err(tx
            .abort(
                &state.db,
                AuditEntry::new("core.roles.update")
                    .target(target::ROLE, role_id, name)
                    .before(role_snapshot(&previous, &before_privileges)),
                AppError::Validation(
                    "Les privilèges d'un rôle système ne sont pas modifiables".into(),
                ),
            )
            .await);
    }

    if let Some(privileges) = dto.privileges.as_ref() {
        validate_privileges(&state.db, privileges).await?;
    }

    // Whether the description is touched is decided in Rust, so the statement
    // needs no NULL-typed cast and reuses no placeholder.
    let name_opt = dto.name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let now = Utc::now();
    if dto.description.is_some() {
        tx.execute(
            "UPDATE core.roles SET name = COALESCE($1, name), updated_at = $2, description = $3 WHERE id = $4",
            params![name_opt, now, dto.description.as_deref(), role_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "update_role: write"); AppError::Database(e) })?;
    } else {
        tx.execute(
            "UPDATE core.roles SET name = COALESCE($1, name), updated_at = $2 WHERE id = $3",
            params![name_opt, now, role_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "update_role: write"); AppError::Database(e) })?;
    }

    // No portable `RETURNING`: read the updated row back within the transaction.
    let role = {
        let row = tx
            .fetch_optional_row(
                &format!("SELECT {ROLE_COLS} FROM core.roles WHERE id = $1"),
                params![role_id],
            )
            .await
            .map_err(|e| { tracing::error!(error = %e, "update_role: reselect"); AppError::Database(e) })?
            .ok_or_else(|| AppError::NotFound(format!("Rôle {role_id}")))?;
        role_from_row(&row)?
    };

    if let Some(privileges) = dto.privileges.as_ref() {
        tx.execute(
            "DELETE FROM core.role_privileges WHERE role_id = $1",
            params![role_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "update_role: purge"); AppError::Database(e) })?;
        for key in privileges {
            tx.execute(
                "INSERT INTO core.role_privileges (role_id, privilege_key) VALUES ($1, $2)",
                params![role_id, key],
            )
            .await
            .map_err(|e| { tracing::error!(error = %e, key = %key, "update_role: privilege"); AppError::Database(e) })?;
        }

        // Widening a role can make an existing org-unit-scoped assignment carry a
        // non-scopable privilege - the exact situation the scopability rule
        // exists to prevent, arrived at by the back door. Refuse the edit rather
        // than leave the instance in a state the rule says is impossible.
        let broken_sql = format!(
            "SELECT {} \
               FROM core.role_assignments a \
              WHERE a.role_id = $1 AND a.scope = 'org_unit' \
                AND EXISTS (SELECT 1 FROM core.role_privileges rp \
                              JOIN core.privileges p ON p.\"key\" = rp.privilege_key \
                             WHERE rp.role_id = a.role_id AND NOT p.is_ou_scopable)",
            tx.backend().count_bigint("*"),
        );
        let broken: i64 = tx
            .fetch_optional_scalar::<i64>(&broken_sql, params![role_id])
            .await
            .map_err(|e| { tracing::error!(error = %e, "update_role: assignment check"); AppError::Database(e) })?
            .unwrap_or(0);

        if broken > 0 {
            let name = role.name.clone();
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.roles.update")
                        .target(target::ROLE, role_id, name)
                        .before(role_snapshot(&previous, &before_privileges)),
                    AppError::Validation(format!(
                        "Modification refusée : {broken} affectation(s) de ce rôle sont restreintes \
                         à une unité organisationnelle, et le nouvel ensemble contient un privilège \
                         non restreignable."
                    )),
                )
                .await);
        }
    }

    // The resulting privilege set is known without another read: it is either the
    // freshly written list (sorted as the old `ORDER BY privilege_key` read it) or -
    // when the request left privileges untouched - the "before" set.
    let after_privileges = match dto.privileges.as_ref() {
        Some(p) => {
            let mut v: Vec<String> = p.clone();
            v.sort();
            v
        }
        None => before_privileges.clone(),
    };

    tx.commit(
        AuditEntry::new("core.roles.update")
            .target(target::ROLE, role.id, role.name.clone())
            .before(role_snapshot(&previous, &before_privileges))
            .after(role_snapshot(&role, &after_privileges))
            .reversible(),
    )
    .await?;

    cache::invalidate_all();
    Ok(Json(json!({ "role": role, "privileges": after_privileges })))
}

/// `DELETE /admin/roles/:id` - superuser only, system roles protected.
pub async fn delete_role(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Path(role_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ensure_role_management(&ctx)?;

    let mut tx = audit.begin(&state.db).await?;

    let for_update = tx.backend().for_update();
    let role_row = tx
        .fetch_optional_row(
            &format!(
                "SELECT {ROLE_COLS} FROM core.roles WHERE id = $1{}",
                for_update
            ),
            params![role_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_role: read"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("Rôle {role_id}")))?;
    let role = role_from_row(&role_row)?;

    // Committed state (no write yet in this transaction), read on the pool.
    let privileges = privileges_of(&state.db, role_id).await?;

    if role.is_system {
        let name = role.name.clone();
        return Err(tx
            .abort(
                &state.db,
                AuditEntry::new("core.roles.delete")
                    .target(target::ROLE, role_id, name)
                    .before(role_snapshot(&role, &privileges)),
                AppError::Forbidden,
            )
            .await);
    }

    tx.execute("DELETE FROM core.roles WHERE id = $1", params![role_id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_role"); AppError::Database(e) })?;

    // Deleting a role cascades to its assignments: guard 4 applies.
    guards::ensure_superadmin_remains(&mut tx).await?;

    tx.commit(
        AuditEntry::new("core.roles.delete")
            .target(target::ROLE, role_id, role.name.clone())
            .before(role_snapshot(&role, &privileges))
            .reversible(),
    )
    .await?;

    cache::invalidate_all();
    Ok(Json(json!({ "message": "Rôle supprimé" })))
}

// ── Assignments ───────────────────────────────────────────────────────────────

// A macro rather than a `const` so the reads below splice it with `concat!`
// and hand the driver one compile-time literal.
macro_rules! assignment_select {
    () => {
        r#"
    SELECT a.id, a.role_id, r.slug AS role_slug, r.name AS role_name,
           a.subject_user_id, a.subject_group_id,
           COALESCE(u.username || ' <' || u.email || '>', g.name) AS subject_label,
           a.scope, a.scope_org_unit_id, ou.name AS scope_org_unit_name,
           a.expires_at, a.created_at, a.created_by
      FROM core.role_assignments a
      JOIN core.roles r            ON r.id = a.role_id
      LEFT JOIN core.users u       ON u.id = a.subject_user_id
      LEFT JOIN core.user_groups g ON g.id = a.subject_group_id
      LEFT JOIN core.org_units ou  ON ou.id = a.scope_org_unit_id
"#
    };
}

#[derive(Deserialize)]
pub struct ListAssignmentsQuery {
    pub user_id: Option<Uuid>,
    pub group_id: Option<Uuid>,
    pub role_id: Option<Uuid>,
    /// Include assignments whose expiry has passed (default: hide them).
    #[serde(default)]
    pub include_expired: bool,
}

/// `GET /admin/role-assignments`
pub async fn list_assignments(
    State(state): State<AppState>,
    ctx: AdminCtx,
    Query(q): Query<ListAssignmentsQuery>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ROLES_READ)?;

    // Optional filters composed as a builder rather than the `$n::uuid IS NULL OR`
    // trick (which both reuses a placeholder and casts it); the expiry cutoff is
    // bound from Rust instead of spelled `NOW()`.
    let mut qb = DbQueryBuilder::new(state.db.backend(), assignment_select!());
    qb.push(" WHERE 1 = 1");
    if let Some(user_id) = q.user_id {
        qb.push(" AND a.subject_user_id = ").push_bind(user_id);
    }
    if let Some(group_id) = q.group_id {
        qb.push(" AND a.subject_group_id = ").push_bind(group_id);
    }
    if let Some(role_id) = q.role_id {
        qb.push(" AND a.role_id = ").push_bind(role_id);
    }
    if !q.include_expired {
        qb.push(" AND (a.expires_at IS NULL OR a.expires_at > ")
            .push_bind(Utc::now())
            .push(")");
    }
    qb.push_order_by("a.created_at DESC");

    let rows: Vec<AssignmentRow> = qb
        .fetch_all_as(&state.db)
        .await
        .map_err(|e| { tracing::error!(error = %e, "list_assignments"); AppError::Database(e) })?;

    Ok(Json(json!({ "assignments": rows })))
}

#[derive(Deserialize)]
pub struct CreateAssignmentDto {
    pub role_id: Uuid,
    /// Exactly one of the two.
    pub user_id: Option<Uuid>,
    pub group_id: Option<Uuid>,
    /// `"instance"` or `"org_unit"`.
    pub scope: String,
    pub org_unit_id: Option<Uuid>,
    /// Optional expiry, for a temporary delegation.
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

fn assignment_snapshot(row: &AssignmentRow) -> Value {
    crate::audit::redact::snapshot(
        target::ROLE_ASSIGNMENT,
        &serde_json::to_value(row).unwrap_or(Value::Null),
    )
}

/// `POST /admin/role-assignments` - grants a role to a subject over a scope.
///
/// Runs, in order: the privilege check, the scopability rule, and guard 2.
pub async fn create_assignment(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Json(dto): Json<CreateAssignmentDto>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    ctx.require(keys::ROLES_MANAGE)?;

    let scope = AssignmentScope::parse(&dto.scope)?;
    match (dto.user_id, dto.group_id) {
        (Some(_), Some(_)) => {
            return Err(AppError::Validation(
                "Un sujet et un seul : utilisateur OU groupe".into(),
            ))
        }
        (None, None) => return Err(AppError::Validation("Sujet requis".into())),
        _ => {}
    }
    if scope == AssignmentScope::OrgUnit && dto.org_unit_id.is_none() {
        return Err(AppError::Validation(
            "Unité organisationnelle requise pour une portée « org_unit »".into(),
        ));
    }
    if let Some(expiry) = dto.expires_at {
        if expiry <= chrono::Utc::now() {
            return Err(AppError::Validation(
                "La date d'expiration doit être dans le futur".into(),
            ));
        }
    }

    let mut tx = audit.begin(&state.db).await?;

    // The rule that makes the scope a boundary, then the rule that keeps the
    // grantor from exceeding themselves. A refused grant is recorded like any
    // other refusal: an attempt to hand oneself power is the single most
    // interesting line in the trail, and rolling back silently would erase it.
    let refusal = |reason: &AppError| {
        AuditEntry::new("core.role_assignments.create")
            .target_kind(
                target::ROLE_ASSIGNMENT,
                format!("rôle {} → portée {}", dto.role_id, scope.as_str()),
            )
            .denied(reason.to_string())
    };
    if let Err(e) = ensure_scopable(&state.db, dto.role_id, scope).await {
        return Err(tx.abort(&state.db, refusal(&e), e).await);
    }
    if let Err(e) = ensure_can_grant(&state.db, &ctx, dto.role_id, scope, dto.org_unit_id).await {
        return Err(tx.abort(&state.db, refusal(&e), e).await);
    }

    // The primary key and creation stamp are produced in Rust (no `RETURNING`).
    let id = new_id();
    tx.execute(
        r#"INSERT INTO core.role_assignments
               (id, role_id, subject_user_id, subject_group_id, scope, scope_org_unit_id, expires_at, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"#,
        params![
            id,
            dto.role_id,
            dto.user_id,
            dto.group_id,
            scope.as_str(),
            dto.org_unit_id,
            dto.expires_at,
            ctx.user_id,
            Utc::now(),
        ],
    )
    .await
    .map_err(|e| {
        if e.to_string().contains("uniq_core_assign") {
            AppError::Conflict("Cette affectation existe déjà".into())
        } else if e.to_string().contains("foreign key") {
            AppError::NotFound("Rôle, sujet ou unité introuvable".into())
        } else {
            tracing::error!(error = %e, "create_assignment");
            AppError::Database(e)
        }
    })?;

    // No portable `RETURNING`: reselect the joined row within the transaction.
    let row_data = tx
        .fetch_optional_row(&format!("{} WHERE a.id = $1", assignment_select!()), params![id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "create_assignment: reselect"); AppError::Database(e) })?
        .ok_or_else(|| { tracing::error!("create_assignment: row vanished after insert"); AppError::Database(sqlx::Error::RowNotFound) })?;
    let row = assignment_from_row(&row_data)?;

    // Keep `core.users.role` in step when the grant makes someone a
    // super-administrator.
    if let Some(user_id) = dto.user_id {
        guards::sync_role_cache(&mut tx, user_id).await?;
    }

    let label = format!(
        "{} → {}",
        row.subject_label.as_deref().unwrap_or("?"),
        row.role_name
    );
    tx.commit(
        AuditEntry::new("core.role_assignments.create")
            .target(target::ROLE_ASSIGNMENT, id, label)
            .after(assignment_snapshot(&row))
            .reversible(),
    )
    .await?;

    cache::invalidate_all();

    // Published AFTER the commit, so the rule engine never reacts to a grant
    // that was rolled back. `internal`: the bus is a broadcast to every browser,
    // and who was just made an administrator is not everybody's business.
    state
        .events
        .publish_and_log_with(
            crate::events::AppEvent::Custom {
                event_type: crate::rules::declare::events::PRIVILEGE_GRANTED.into(),
                module_id: "core".into(),
                payload: json!({
                    "user_id":        row.subject_user_id,
                    "group_id":       row.subject_group_id,
                    "role_slug":      row.role_slug,
                    "role_name":      row.role_name,
                    "scope":          row.scope,
                    "org_unit_id":    row.scope_org_unit_id,
                    "granted_by":     ctx.user_id,
                    "assignment_id":  id,
                }),
            },
            crate::events::EventMeta::internal(),
            &state.db,
        )
        .await;

    Ok((StatusCode::CREATED, Json(json!({ "assignment": row }))))
}

/// `DELETE /admin/role-assignments/:id` - revokes a grant.
///
/// Symmetric with the grant: you may only take away what you could have given
/// (guard 2), and never the last super-administrator (guard 4).
pub async fn delete_assignment(
    State(state): State<AppState>,
    ctx: AdminCtx,
    audit: AdminAudit,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ROLES_MANAGE)?;

    let mut tx = audit.begin(&state.db).await?;

    let row_data = tx
        .fetch_optional_row(&format!("{} WHERE a.id = $1", assignment_select!()), params![id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_assignment: read"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("Affectation {id}")))?;
    let row = assignment_from_row(&row_data)?;

    let scope = AssignmentScope::parse(&row.scope)?;
    if let Err(e) =
        ensure_can_grant(&state.db, &ctx, row.role_id, scope, row.scope_org_unit_id).await
    {
        let entry = AuditEntry::new("core.role_assignments.delete")
            .target(
                target::ROLE_ASSIGNMENT,
                id,
                row.subject_label.clone().unwrap_or_else(|| id.to_string()),
            )
            .before(assignment_snapshot(&row))
            .denied(e.to_string());
        return Err(tx.abort(&state.db, entry, e).await);
    }

    tx.execute("DELETE FROM core.role_assignments WHERE id = $1", params![id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_assignment"); AppError::Database(e) })?;

    // Evaluated on the post-state, inside the transaction: "would this leave
    // zero" is a question about what the instance looks like after the write.
    guards::ensure_superadmin_remains(&mut tx).await?;

    if let Some(user_id) = row.subject_user_id {
        guards::sync_role_cache(&mut tx, user_id).await?;
    }

    let label = format!(
        "{} → {}",
        row.subject_label.as_deref().unwrap_or("?"),
        row.role_name
    );
    tx.commit(
        AuditEntry::new("core.role_assignments.delete")
            .target(target::ROLE_ASSIGNMENT, id, label)
            .before(assignment_snapshot(&row))
            .reversible(),
    )
    .await?;

    cache::invalidate_all();
    Ok(Json(json!({ "message": "Affectation retirée" })))
}

/// `GET /admin/users/:id/privileges` - what one account effectively holds.
///
/// The question an operator actually asks ("why can this person do that?"), and
/// the one a flat list of assignments answers badly once groups and subtrees are
/// involved.
pub async fn user_effective_privileges(
    State(state): State<AppState>,
    ctx: AdminCtx,
    Path(user_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::ROLES_READ)?;

    let resolved = crate::authz::context::resolve(
        &state.db,
        user_id,
        crate::audit::ActorOrigin::System,
        None,
    )
    .await?;

    // Same shape as the `privileges` block of `GET /api/v1/me`, so an operator
    // inspecting an account and that account inspecting itself cannot disagree.
    Ok(Json(json!(resolved.effective())))
}
