use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;
use validator::Validate;

use kubuno_db::{params, DbRow, DbTx};

use crate::{
    authz::{keys, AdminCtx},
    audit::{redact::target, snap, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    errors::AppError,
    models::group::{CreateGroupDto, UpdateGroupDto, UserGroup},
    state::AppState,
};

/// Map a raw row (a RETURNING or reselect on `core.user_groups`) into the full
/// group struct. Used inside audited transactions, where `DbTx` cannot decode
/// structs directly.
fn group_from_row(row: &DbRow) -> Result<UserGroup, sqlx::Error> {
    Ok(UserGroup {
        id:             row.try_get("id")?,
        name:           row.try_get("name")?,
        description:    row.try_get("description")?,
        permissions:    row.try_get("permissions")?,
        is_default:     row.try_get("is_default")?,
        release_exempt: row.try_get("release_exempt")?,
        is_system:      row.try_get("is_system")?,
        created_at:     row.try_get("created_at")?,
        updated_at:     row.try_get("updated_at")?,
    })
}

pub async fn list_groups(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::GROUPS_READ)?;
    let groups = state
        .db
        .fetch_all_as::<UserGroup>(
            r#"SELECT g.id, g.name, g.description, g.permissions, g.is_default, g.release_exempt,
                      g.is_system, g.created_at, g.updated_at
               FROM core.user_groups g
               ORDER BY g.is_system DESC, g.name"#,
            params![],
        )
        .await?;

    // Enrich each group with its member count.
    let backend = state.db.backend();
    let count_sql = format!(
        "SELECT {} FROM core.user_group_members WHERE group_id = $1",
        backend.count_bigint("*"),
    );
    let mut result = Vec::with_capacity(groups.len());
    for g in groups {
        let count: i64 = state
            .db
            .fetch_scalar::<i64>(&count_sql, params![g.id])
            .await
            .unwrap_or(0);
        result.push(json!({
            "id":           g.id,
            "name":         g.name,
            "description":  g.description,
            "permissions":  g.permissions,
            "is_default":   g.is_default,
            "is_system":    g.is_system,
            "member_count": count,
            "created_at":   g.created_at,
            "updated_at":   g.updated_at,
        }));
    }

    Ok(Json(json!({ "groups": result })))
}

pub async fn get_group(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::GROUPS_READ)?;
    let group = state
        .db
        .fetch_optional_as::<UserGroup>(
            "SELECT * FROM core.user_groups WHERE id = $1",
            params![group_id],
        )
        .await?
        .ok_or_else(|| AppError::NotFound("Group not found".into()))?;

    let members = state
        .db
        .fetch_all_as::<(Uuid, String, String, String)>(
            r#"SELECT u.id, u.username, u.email,
                      COALESCE(u.display_name, u.username) as display_name
               FROM core.user_group_members m
               JOIN core.users u ON u.id = m.user_id
               WHERE m.group_id = $1
               ORDER BY u.username"#,
            params![group_id],
        )
        .await?;

    let members_json: Vec<Value> = members.iter().map(|(id, username, email, display_name)| json!({
        "id": id, "username": username, "email": email, "display_name": display_name,
    })).collect();

    Ok(Json(json!({
        "group":   group,
        "members": members_json,
    })))
}

pub async fn create_group(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<CreateGroupDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::GROUPS_MANAGE)?;
    dto.validate()
        .map_err(|e| AppError::Validation(e.to_string()))?;

    let permissions = serde_json::to_value(&dto.permissions)
        .unwrap_or(serde_json::Value::Array(vec![]));

    let mut tx = audit.begin(&state.db).await?;

    // The key is generated here rather than by the database: MySQL and SQLite
    // have no `RETURNING`, so a process-side id is the only portable way to read
    // the row back and use it as the audit target.
    let id = kubuno_db::new_id();
    let raw = kubuno_db::returning::insert_returning_row(
        &mut tx,
        r#"INSERT INTO core.user_groups (id, name, description, permissions, is_default, release_exempt)
           VALUES ($1, $2, $3, $4, $5, $6)"#,
        params![
            id,
            &dto.name,
            dto.description.as_deref(),
            permissions,
            dto.is_default,
            dto.release_exempt
        ],
        "*",
        &kubuno_db::returning::reselect_by_id("core.user_groups", "*"),
        params![id],
    )
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") {
            AppError::Conflict(format!("A group named '{}' already exists", dto.name))
        } else {
            tracing::error!(error = %e, "create_group");
            AppError::Database(e)
        }
    })?;
    let group = group_from_row(&raw)?;

    tx.commit(
        AuditEntry::new("core.groups.create")
            .target(target::GROUP, group.id, group.name.clone())
            .after(snap(target::GROUP, &group))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "group": group })))
}

pub async fn update_group(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(group_id): Path<Uuid>,
    Json(dto): Json<UpdateGroupDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::GROUPS_MANAGE)?;
    dto.validate()
        .map_err(|e| AppError::Validation(e.to_string()))?;

    let permissions = dto.permissions.as_ref().map(|p| serde_json::to_value(p).unwrap_or_default());

    let mut tx = audit.begin(&state.db).await?;

    let for_update = tx.backend().for_update();
    let prev_raw = tx
        .fetch_optional_row(
            &format!(
                "SELECT * FROM core.user_groups WHERE id = $1{}",
                for_update
            ),
            params![group_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "update_group: lecture"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound("Group not found".into()))?;
    let previous = group_from_row(&prev_raw)?;

    // `COALESCE($n, col)` keeps the stored value when the bind is NULL, the same
    // "provided → set, absent → keep" the original `CASE ... IS NOT NULL` had,
    // without PostgreSQL's `::text` cast or reusing a placeholder.
    let updated_raw = kubuno_db::returning::update_returning_row(
        &mut tx,
        r#"UPDATE core.user_groups
           SET name           = COALESCE($1, name),
               description     = COALESCE($2, description),
               permissions     = COALESCE($3, permissions),
               is_default      = COALESCE($4, is_default),
               release_exempt  = COALESCE($5, release_exempt)
           WHERE id = $6"#,
        params![
            dto.name.as_deref(),
            dto.description.as_deref(),
            permissions,
            dto.is_default,
            dto.release_exempt,
            group_id
        ],
        "*",
        &kubuno_db::returning::reselect_by_id("core.user_groups", "*"),
        params![group_id],
    )
    .await
    .map_err(|e| { tracing::error!(error = %e, "update_group: écriture"); AppError::Database(e) })?
    .ok_or_else(|| AppError::NotFound("Group not found".into()))?;
    let group = group_from_row(&updated_raw)?;

    tx.commit(
        AuditEntry::new("core.groups.update")
            .target(target::GROUP, group.id, group.name.clone())
            .before(snap(target::GROUP, &previous))
            .after(snap(target::GROUP, &group))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "group": group })))
}

pub async fn delete_group(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::GROUPS_MANAGE)?;
    let mut tx = audit.begin(&state.db).await?;

    let for_update = tx.backend().for_update();
    let group_raw = tx
        .fetch_optional_row(
            &format!(
                "SELECT * FROM core.user_groups WHERE id = $1{}",
                for_update
            ),
            params![group_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_group: lecture"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound("Group not found".into()))?;
    let group = group_from_row(&group_raw)?;

    // System groups (Administrators, Users, Guests) cannot be deleted; the
    // refusal is journaled exactly like a success.
    if group.is_system {
        let name = group.name.clone();
        return Err(tx
            .abort(
                &state.db,
                AuditEntry::new("core.groups.delete")
                    .target(target::GROUP, group_id, name)
                    .before(snap(target::GROUP, &group)),
                AppError::Forbidden,
            )
            .await);
    }

    // Purge the group's setting overrides (the `setting_values_purge_scope`
    // trigger's job on PostgreSQL; a no-op there).
    crate::settings::store::purge_setting_values_for_scope(&mut tx, "group", group_id)
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_group: purge des réglages"); AppError::Database(e) })?;
    tx.execute("DELETE FROM core.user_groups WHERE id = $1", params![group_id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_group"); AppError::Database(e) })?;

    tx.commit(
        AuditEntry::new("core.groups.delete")
            .target(target::GROUP, group_id, group.name.clone())
            .before(snap(target::GROUP, &group))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "message": "Group deleted" })))
}

// ── Membres ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AddMemberDto {
    pub user_id: Uuid,
}

/// Group name and member username, for a readable membership entry.
async fn membership_labels(
    conn: &mut DbTx,
    group_id: Uuid,
    user_id: Uuid,
) -> Result<(String, String), AppError> {
    let group_name: Option<String> = conn
        .fetch_optional_scalar::<String>(
            "SELECT name FROM core.user_groups WHERE id = $1",
            params![group_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "membership_labels: groupe"); AppError::Database(e) })?;
    let group_name = group_name.ok_or_else(|| AppError::NotFound("Group not found".into()))?;

    let username: Option<String> = conn
        .fetch_optional_scalar::<String>(
            "SELECT username FROM core.users WHERE id = $1",
            params![user_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "membership_labels: utilisateur"); AppError::Database(e) })?;

    Ok((group_name, username.unwrap_or_else(|| user_id.to_string())))
}

pub async fn add_member(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(group_id): Path<Uuid>,
    Json(dto): Json<AddMemberDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::GROUPS_MANAGE)?;
    let mut tx = audit.begin(&state.db).await?;
    let (group_name, username) = membership_labels(&mut tx, group_id, dto.user_id).await?;

    let backend = state.db.backend();
    let insert_sql = format!(
        r#"INSERT {}INTO core.user_group_members (group_id, user_id, added_by)
           VALUES ($1, $2, $3){}"#,
        backend.insert_ignore_prefix(),
        backend.on_conflict_do_nothing(&["group_id", "user_id"]),
    );
    tx.execute(&insert_sql, params![group_id, dto.user_id, audit.admin.id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "add_member"); AppError::Database(e) })?;

    tx.commit(
        AuditEntry::new("core.groups.member_add")
            .target(target::GROUP, group_id, group_name.clone())
            .after(crate::audit::redact::snapshot(
                target::GROUP_MEMBER,
                &json!({
                    "group_id": group_id, "group_name": group_name,
                    "user_id": dto.user_id, "username": username,
                }),
            ))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "message": "Member added" })))
}

pub async fn remove_member(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path((group_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::GROUPS_MANAGE)?;
    let mut tx = audit.begin(&state.db).await?;
    let (group_name, username) = membership_labels(&mut tx, group_id, user_id).await?;

    let affected = tx
        .execute(
            "DELETE FROM core.user_group_members WHERE group_id = $1 AND user_id = $2",
            params![group_id, user_id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "remove_member"); AppError::Database(e) })?;

    if affected == 0 {
        return Err(AppError::NotFound("Member not found in this group".into()));
    }

    tx.commit(
        AuditEntry::new("core.groups.member_remove")
            .target(target::GROUP, group_id, group_name.clone())
            .before(crate::audit::redact::snapshot(
                target::GROUP_MEMBER,
                &json!({
                    "group_id": group_id, "group_name": group_name,
                    "user_id": user_id, "username": username,
                }),
            ))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "message": "Member removed" })))
}

/// Lists a user's groups (used by other handlers).
pub async fn user_groups(db: &kubuno_db::DbPool, user_id: Uuid) -> Result<Vec<UserGroup>, sqlx::Error> {
    db.fetch_all_as::<UserGroup>(
        r#"SELECT g.* FROM core.user_groups g
           JOIN core.user_group_members m ON m.group_id = g.id
           WHERE m.user_id = $1"#,
        params![user_id],
    )
    .await
}

/// Checks whether a user has a given permission (via their role or their groups).
/// `allowed_roles` comes from the `auth.api_token_allowed_roles` setting.
pub async fn user_has_permission(
    db: &kubuno_db::DbPool,
    user_role: &str,
    user_id: Uuid,
    permission: &str,
    allowed_roles: &[String],
) -> bool {
    // 1. Via le rôle système
    if allowed_roles.iter().any(|r| r == user_role) {
        return true;
    }
    // 2. Via les groupes
    let groups = user_groups(db, user_id).await.unwrap_or_default();
    groups.iter().any(|g| {
        g.permissions
            .as_array()
            .map(|arr| arr.iter().any(|p| p.as_str() == Some(permission)))
            .unwrap_or(false)
    })
}
