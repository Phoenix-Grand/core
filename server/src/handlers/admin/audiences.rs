//! Target audiences: the curated recipient lists an instance offers at share
//! time.
//!
//! ## What problem this solves
//!
//! Left to itself, a sharing dialog offers two things: one person at a time, or
//! everybody. The first is tedious enough that people reach for the second, and
//! the second is how a document meant for four people ends up readable by the
//! whole instance. An audience sits between them - "Direction", "Agence de
//! Lyon" - so that the convenient answer is also a narrow one.
//!
//! ## An audience grants nothing
//!
//! This is the single most important property and the reason audiences are not a
//! flag on `core.user_groups`. Membership of an audience confers **no access**.
//! It makes a suggestion appear in a dialog; the person sharing still decides,
//! and the permission is written by whichever module owns the resource. A group
//! carries privileges; an audience carries a proposal. Merging them would mean
//! that widening a suggestion widens rights, which is precisely the accident this
//! feature exists to prevent.
//!
//! ## Two powers, two privileges
//!
//! Composing an audience ([`keys::AUDIENCES_MANAGE`]) and deciding where it is
//! offered ([`keys::AUDIENCES_APPLY`]) are deliberately separate. The first
//! prepares a list nobody has seen yet. The second changes what every account in
//! an organisational unit is shown the next time they share something - the part
//! that can widen exposure across a whole organisation, and the part that
//! deserves to be granted on purpose.
//!
//! ## The core names no module
//!
//! A policy row carries `module_id` as free text and there is no foreign key to
//! `core.modules`. Modules that can consume audiences say so when they register;
//! the console offers those. Uninstalling a module leaves its policy in place
//! rather than silently erasing an administrator's decision - it comes back
//! intact on reinstall, and produces nothing in the meantime.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use kubuno_db::{new_id, params, DbPool};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{redact::target, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    authz::{keys, AdminCtx},
    errors::AppError,
    state::AppState,
};

/// Most an administrator may offer at once, per module and unit.
///
/// Five, matching what the reference implementations settled on, and for a
/// reason that survives the imitation: this list is read in a dropdown by
/// somebody who is trying to do something else. Past half a dozen entries it
/// stops being a shortlist and becomes a directory, which is the thing it was
/// meant to replace. The database enforces it too (`position < 5`), so a second
/// route cannot quietly disagree.
const MAX_APPLIED: usize = 5;

/// Trimmed, with the interior collapsed - the name is a label in a dropdown, and
/// `"Direction  générale"` and `"Direction générale"` must not coexist there.
fn clean_name(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Validates a name and description against the limits the column enforces,
/// before the database refuses them with a message nobody can act on.
fn validate_details(name: &str, description: Option<&str>) -> Result<String, AppError> {
    let name = clean_name(name);
    if name.is_empty() {
        return Err(AppError::Validation(
            "Le nom de l'audience est obligatoire.".into(),
        ));
    }
    // `chars()`, not `len()`: the limit is a label length, and a byte count would
    // reject a French name forty accented characters long.
    if name.chars().count() > 40 {
        return Err(AppError::Validation(
            "Le nom d'une audience ne peut pas dépasser 40 caractères - il s'affiche dans une liste de partage, à côté d'un nom de fichier.".into(),
        ));
    }
    if let Some(d) = description {
        if d.chars().count() > 150 {
            return Err(AppError::Validation(
                "La description ne peut pas dépasser 150 caractères.".into(),
            ));
        }
    }
    Ok(name)
}

/// Turns the unique-index violation into the sentence an administrator needs.
fn name_conflict(e: sqlx::Error, name: &str) -> AppError {
    if e.to_string().contains("idx_core_ta_name") {
        AppError::Conflict(format!("Une audience nommée « {name} » existe déjà."))
    } else {
        tracing::error!(error = %e, "audiences: écriture");
        AppError::Database(e)
    }
}

// ── Reading ──────────────────────────────────────────────────────────────────

/// `GET /admin/audiences` - every audience, with what an administrator needs to
/// judge it without opening it.
///
/// Two counts, deliberately both: `member_count` is how many entries were added
/// (what you edit), `reach` is how many distinct active accounts those entries
/// resolve to (what actually happens when the audience is used). They differ
/// whenever a member is a group, which is the recommended case - so showing only
/// the first would hide the one number that says how wide a proposal really is.
#[derive(sqlx::FromRow)]
struct AudienceListRow {
    id:           Uuid,
    name:         String,
    description:  Option<String>,
    is_everyone:  bool,
    created_at:   chrono::DateTime<chrono::Utc>,
    updated_at:   chrono::DateTime<chrono::Utc>,
    member_count: i64,
    reach:        i64,
    applied_to:   i64,
}

/// The audiences list read.
///
/// Portable across the three engines: `LEFT JOIN LATERAL` exists on neither MySQL
/// nor SQLite, so each per-audience figure is a correlated scalar subquery
/// instead - `COUNT(*)`/`COUNT(DISTINCT …)` already decode as `i64`, so the old
/// `::bigint` casts are gone, and `COUNT` returns `0` for no rows, so the
/// `COALESCE` wrappers went with them. Public so the portability test exercises
/// the exact query the handler runs on each engine.
pub const LIST_SQL: &str = r#"
        SELECT a.id,
               a.name,
               a.description,
               a.is_everyone,
               a.created_at,
               a.updated_at,
               (SELECT COUNT(*) FROM core.target_audience_members tm
                 WHERE tm.audience_id = a.id)                       AS member_count,
               CASE WHEN a.is_everyone
                    THEN (SELECT COUNT(*) FROM core.users WHERE is_active)
                    -- DISTINCT because a person reachable through two member
                    -- groups is still one person: a reach that double-counted
                    -- would overstate exactly the exposure this figure reveals.
                    ELSE (SELECT COUNT(DISTINCT u.id)
                            FROM core.target_audience_members tm
                            LEFT JOIN core.user_group_members gm
                                   ON tm.member_type = 'group' AND gm.group_id = tm.member_id
                            JOIN core.users u
                                   ON u.id = CASE tm.member_type
                                               WHEN 'user'  THEN tm.member_id
                                               WHEN 'group' THEN gm.user_id
                                             END
                           WHERE tm.audience_id = a.id
                             AND u.is_active)
               END                                                  AS reach,
               (SELECT COUNT(*) FROM core.target_audience_policies tp
                 WHERE tp.audience_id = a.id)                       AS applied_to
          FROM core.target_audiences a
         ORDER BY a.is_everyone DESC, LOWER(a.name)
        "#;

pub async fn list_audiences(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUDIENCES_READ)?;

    let rows = state
        .db
        .fetch_all_as::<AudienceListRow>(
            LIST_SQL,
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: list");
            AppError::Database(e)
        })?;

    let audiences: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":           r.id,
                "name":         r.name,
                "description":  r.description,
                "is_everyone":  r.is_everyone,
                "member_count": r.member_count,
                "reach":        r.reach,
                "applied_to":   r.applied_to,
                "created_at":   r.created_at,
                "updated_at":   r.updated_at,
            })
        })
        .collect();

    Ok(Json(json!({ "audiences": audiences, "max_applied": MAX_APPLIED })))
}

#[derive(sqlx::FromRow)]
struct AudienceHeaderRow {
    id:           Uuid,
    name:         String,
    description:  Option<String>,
    is_everyone:  bool,
    created_at:   chrono::DateTime<chrono::Utc>,
    updated_at:   chrono::DateTime<chrono::Utc>,
    member_count: i64,
    reach:        i64,
}

#[derive(sqlx::FromRow)]
struct MemberRow {
    member_type: String,
    member_id:   Uuid,
    label:       String,
    email:       Option<String>,
    group_reach: Option<i64>,
    is_dangling: bool,
    added_at:    chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct AudiencePolicyRow {
    module_id:     String,
    position:      i16,
    org_unit_id:   Uuid,
    org_unit_name: String,
}

/// `GET /admin/audiences/:id` - one audience and its members, resolved to names.
///
/// The member list carries what each entry *is* (a group or an account) and, for
/// a group, how many active accounts it currently brings in. That last figure is
/// the answer to the only question that matters before applying an audience:
/// adding "Tous les salariés" to a proposal is a different act depending on
/// whether that group holds eight people or eight hundred.
pub async fn get_audience(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUDIENCES_READ)?;

    // The two figures the sheet states next to the name, computed exactly as the
    // list computes them. They were missing here while the sheet already
    // rendered them, so it read "entrée(s), compte(s) atteint(s)" with no
    // numbers at all - the kind of defect that survives because the sentence
    // still looks like a sentence.
    // Portable across the three engines, exactly as the list above: the two
    // figures are correlated scalar subqueries rather than `LEFT JOIN LATERAL`,
    // and `COUNT` decodes as `i64` so no `::bigint` cast is needed.
    let audience = state
        .db
        .fetch_optional_as::<AudienceHeaderRow>(
            r#"
        SELECT a.id,
               a.name,
               a.description,
               a.is_everyone,
               a.created_at,
               a.updated_at,
               (SELECT COUNT(*) FROM core.target_audience_members tm
                 WHERE tm.audience_id = a.id)                       AS member_count,
               CASE WHEN a.is_everyone
                    THEN (SELECT COUNT(*) FROM core.users WHERE is_active)
                    -- DISTINCT for the same reason as in the list: somebody
                    -- reachable through two member groups is still one person.
                    ELSE (SELECT COUNT(DISTINCT u.id)
                            FROM core.target_audience_members tm
                            LEFT JOIN core.user_group_members gm
                                   ON tm.member_type = 'group' AND gm.group_id = tm.member_id
                            JOIN core.users u
                                   ON u.id = CASE tm.member_type
                                               WHEN 'user'  THEN tm.member_id
                                               WHEN 'group' THEN gm.user_id
                                             END
                           WHERE tm.audience_id = a.id
                             AND u.is_active)
               END                                                  AS reach
          FROM core.target_audiences a
         WHERE a.id = $1
        "#,
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: read");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Audience introuvable".into()))?;

    // Portable: the `CASE` yields a `COUNT` for a group and `NULL` for a user,
    // decoded as `Option<i64>` on every engine, so the `::bigint` cast is gone.
    let member_rows = state
        .db
        .fetch_all_as::<MemberRow>(
            r#"
        SELECT tm.member_type,
               tm.member_id,
               tm.added_at,
               COALESCE(g.name, u.display_name, u.username, '')      AS label,
               u.email                                               AS email,
               CASE WHEN tm.member_type = 'group'
                    THEN (SELECT COUNT(*)
                            FROM core.user_group_members gm
                            JOIN core.users gu ON gu.id = gm.user_id AND gu.is_active
                           WHERE gm.group_id = tm.member_id)
               END                                                   AS group_reach,
               (g.id IS NULL AND u.id IS NULL)                       AS is_dangling
          FROM core.target_audience_members tm
          LEFT JOIN core.user_groups g ON tm.member_type = 'group' AND g.id = tm.member_id
          LEFT JOIN core.users       u ON tm.member_type = 'user'  AND u.id = tm.member_id
         WHERE tm.audience_id = $1
         ORDER BY tm.member_type, label
        "#,
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: members");
            AppError::Database(e)
        })?;

    let members: Vec<Value> = member_rows
        .iter()
        .map(|r| {
            json!({
                "member_type": r.member_type,
                "member_id":   r.member_id,
                "label":       r.label,
                "email":       r.email,
                "group_reach": r.group_reach,
                // Triggers prune members whose account or group was deleted, so
                // this should always be false. It is surfaced rather than assumed
                // because a row the UI cannot name is better shown as broken than
                // rendered as an empty line nobody can explain or remove.
                "is_dangling": r.is_dangling,
                "added_at":    r.added_at,
            })
        })
        .collect();

    let applied_rows = state
        .db
        .fetch_all_as::<AudiencePolicyRow>(
            r#"SELECT tp.module_id, tp.position, tp.org_unit_id, ou.name AS org_unit_name
             FROM core.target_audience_policies tp
             JOIN core.org_units ou ON ou.id = tp.org_unit_id
            WHERE tp.audience_id = $1
            ORDER BY tp.module_id, ou.name"#,
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: applications");
            AppError::Database(e)
        })?;

    let applied: Vec<Value> = applied_rows
        .iter()
        .map(|r| {
            json!({
                "module_id":     r.module_id,
                "org_unit_id":   r.org_unit_id,
                "org_unit_name": r.org_unit_name,
                "position":      r.position,
            })
        })
        .collect();

    Ok(Json(json!({
        "audience": {
            "id":           audience.id,
            "name":         audience.name,
            "description":  audience.description,
            "is_everyone":  audience.is_everyone,
            "member_count": audience.member_count,
            "reach":        audience.reach,
            "created_at":   audience.created_at,
            "updated_at":   audience.updated_at,
        },
        "members": members,
        "applied": applied,
    })))
}

// ── Composing ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AudienceDetailsDto {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// `POST /admin/audiences`
pub async fn create_audience(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<AudienceDetailsDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUDIENCES_MANAGE)?;
    let name = validate_details(&dto.name, dto.description.as_deref())?;
    let description = dto.description.as_deref().map(str::trim).filter(|d| !d.is_empty());

    let mut tx = audit.begin(&state.db).await?;

    // The primary key is generated in Rust (no `RETURNING`, which MySQL lacks).
    let id = new_id();
    tx.execute(
        "INSERT INTO core.target_audiences (id, name, description, created_by)
         VALUES ($1, $2, $3, $4)",
        params![id, &name, description, audit.admin.id],
    )
    .await
    .map_err(|e| name_conflict(e, &name))?;

    tx.commit(
        AuditEntry::new("core.audiences.create")
            .target(target::AUDIENCE, id, name.clone())
            .after(json!({ "name": name, "description": description }))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({
        "audience": {
            "id": id, "name": name, "description": description,
            "is_everyone": false, "member_count": 0, "reach": 0, "applied_to": 0,
        }
    })))
}

/// `PATCH /admin/audiences/:id` - name and description, the only mutable fields.
///
/// `is_everyone` is not among them: it is not a label but a membership rule, and
/// letting it be toggled would turn a named list into "everyone" without a single
/// member row changing - the least visible way imaginable to widen a proposal.
pub async fn update_audience(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<AudienceDetailsDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUDIENCES_MANAGE)?;
    let name = validate_details(&dto.name, dto.description.as_deref())?;
    let description = dto.description.as_deref().map(str::trim).filter(|d| !d.is_empty());

    let mut tx = audit.begin(&state.db).await?;

    let before = tx
        .fetch_optional_row(
            "SELECT name, description FROM core.target_audiences WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: reading before modification");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Audience introuvable".into()))?;

    let before_json = json!({
        "name":        before.try_get::<String>("name")?,
        "description": before.try_get::<Option<String>>("description")?,
    });

    tx.execute(
        "UPDATE core.target_audiences SET name = $1, description = $2 WHERE id = $3",
        params![&name, description, id],
    )
    .await
    .map_err(|e| name_conflict(e, &name))?;

    tx.commit(
        AuditEntry::new("core.audiences.update")
            .target(target::AUDIENCE, id, name.clone())
            .before(before_json)
            .after(json!({ "name": name, "description": description }))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

/// `DELETE /admin/audiences/:id`
///
/// Refused for the everyone audience: an instance with no applicable audience
/// would show an empty proposal list, which reads as "this feature is broken"
/// rather than "somebody turned it off".
///
/// Deleting an applied audience removes it from every policy by cascade. That is
/// the intended behaviour and the audit entry says how many places it was
/// offered in, because "I removed one list" and "I changed what four departments
/// see when they share" are the same click and deserve not to be.
pub async fn delete_audience(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUDIENCES_MANAGE)?;

    let mut tx = audit.begin(&state.db).await?;

    let applied_count = tx.backend().count_bigint("*");
    let head_sql = format!(
        "SELECT a.name, a.is_everyone, \
                (SELECT {applied_count} FROM core.target_audience_policies p WHERE p.audience_id = a.id) AS applied_to \
           FROM core.target_audiences a WHERE a.id = $1"
    );
    let row = tx
        .fetch_optional_row(&head_sql, params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: reading before deletion");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Audience introuvable".into()))?;

    let name: String = row.try_get("name")?;
    if row.try_get::<bool>("is_everyone")? {
        return Err(AppError::Validation(
            "L'audience « toute l'organisation » ne peut pas être supprimée : une instance doit toujours pouvoir proposer au moins une audience.".into(),
        ));
    }
    let applied_to: i64 = row.try_get("applied_to")?;

    tx.execute("DELETE FROM core.target_audiences WHERE id = $1", params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: deletion");
            AppError::Database(e)
        })?;

    tx.commit(
        AuditEntry::new("core.audiences.delete")
            .target(target::AUDIENCE, id, name.clone())
            .before(json!({ "name": name, "applied_to": applied_to })),
    )
    .await?;

    Ok(Json(json!({ "ok": true, "was_applied_to": applied_to })))
}

// ── Members ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct MemberRefDto {
    /// `"user"` or `"group"`.
    pub member_type: String,
    pub member_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct MembersDto {
    pub members: Vec<MemberRefDto>,
}

/// `POST /admin/audiences/:id/members` - add one or several at once.
///
/// The whole batch is one transaction: a half-applied "add these six groups"
/// leaves an administrator unable to tell what the audience now contains without
/// re-reading it, and they would re-run the call, which must therefore also be
/// idempotent. `ON CONFLICT DO NOTHING` makes it so.
pub async fn add_members(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<MembersDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUDIENCES_MANAGE)?;
    if dto.members.is_empty() {
        return Err(AppError::Validation("Aucun membre à ajouter.".into()));
    }

    let mut tx = audit.begin(&state.db).await?;

    let row = tx
        .fetch_optional_row(
            "SELECT name, is_everyone FROM core.target_audiences WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: reading before adding members");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Audience introuvable".into()))?;

    if row.try_get::<bool>("is_everyone")? {
        return Err(AppError::Validation(
            "L'audience « toute l'organisation » n'a pas de membres explicites : elle désigne tous les comptes actifs.".into(),
        ));
    }
    let name: String = row.try_get("name")?;

    // The conflict target (the composite primary key) is spelled once so the
    // insert stays idempotent on every engine.
    let member_conflict =
        tx.backend().on_conflict_do_nothing(&["audience_id", "member_type", "member_id"]);
    let insert_member_sql = format!(
        "INSERT INTO core.target_audience_members (audience_id, member_type, member_id, added_by) \
         VALUES ($1, $2, $3, $4){member_conflict}"
    );

    let mut added = 0u32;
    for m in &dto.members {
        // Existence is checked rather than trusted: `member_id` has no foreign
        // key (it points at one of two tables), so an identifier that matches
        // nothing would insert cleanly and show up as a member nobody can name.
        let exists: bool = match m.member_type.as_str() {
            "user" => {
                tx.fetch_optional_scalar::<bool>(
                    "SELECT EXISTS(SELECT 1 FROM core.users WHERE id = $1)",
                    params![m.member_id],
                )
                .await
            }
            "group" => {
                tx.fetch_optional_scalar::<bool>(
                    "SELECT EXISTS(SELECT 1 FROM core.user_groups WHERE id = $1)",
                    params![m.member_id],
                )
                .await
            }
            other => {
                return Err(AppError::Validation(format!(
                    "Type de membre inconnu : « {other} ». Attendu : user, group."
                )))
            }
        }
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: verifying a member");
            AppError::Database(e)
        })?
        .unwrap_or(false);

        if !exists {
            return Err(AppError::Validation(
                "Un des membres indiqués n'existe pas (ou plus).".into(),
            ));
        }

        let done = tx
            .execute(&insert_member_sql, params![id, &m.member_type, m.member_id, audit.admin.id])
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "audiences: adding a member");
                AppError::Database(e)
            })?;
        added += done as u32;
    }

    tx.commit(
        AuditEntry::new("core.audiences.members_add")
            .target(target::AUDIENCE, id, name)
            .after(json!({
                "added": added,
                "members": dto.members.iter()
                    .map(|m| json!({ "type": m.member_type, "id": m.member_id }))
                    .collect::<Vec<_>>(),
            }))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "ok": true, "added": added })))
}

/// `DELETE /admin/audiences/:id/members` - remove one or several at once.
pub async fn remove_members(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<MembersDto>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUDIENCES_MANAGE)?;
    if dto.members.is_empty() {
        return Err(AppError::Validation("Aucun membre à retirer.".into()));
    }

    let mut tx = audit.begin(&state.db).await?;

    let name: String = tx
        .fetch_optional_scalar::<String>(
            "SELECT name FROM core.target_audiences WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: reading before removing members");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Audience introuvable".into()))?;

    let mut removed = 0u32;
    for m in &dto.members {
        let done = tx
            .execute(
                "DELETE FROM core.target_audience_members
                  WHERE audience_id = $1 AND member_type = $2 AND member_id = $3",
                params![id, &m.member_type, m.member_id],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "audiences: removing a member");
                AppError::Database(e)
            })?;
        removed += done as u32;
    }

    tx.commit(
        AuditEntry::new("core.audiences.members_remove")
            .target(target::AUDIENCE, id, name)
            .before(json!({
                "members": dto.members.iter()
                    .map(|m| json!({ "type": m.member_type, "id": m.member_id }))
                    .collect::<Vec<_>>(),
            }))
            .after(json!({ "removed": removed })),
    )
    .await?;

    Ok(Json(json!({ "ok": true, "removed": removed })))
}

// ── Applying ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PolicyQuery {
    pub org_unit_id: Uuid,
    pub module_id: String,
}

#[derive(sqlx::FromRow)]
struct PolicyEntryRow {
    audience_id: Uuid,
    position:    i16,
    name:        String,
    description: Option<String>,
    is_everyone: bool,
}

/// Reads the rows written **on one unit exactly**, in display order.
async fn policy_rows(
    db: &DbPool,
    org_unit_id: Uuid,
    module_id: &str,
) -> Result<Vec<Value>, AppError> {
    let rows = db
        .fetch_all_as::<PolicyEntryRow>(
            r#"SELECT tp.audience_id, tp.position, a.name, a.description, a.is_everyone
             FROM core.target_audience_policies tp
             JOIN core.target_audiences a ON a.id = tp.audience_id
            WHERE tp.org_unit_id = $1 AND tp.module_id = $2
            ORDER BY tp.position"#,
            params![org_unit_id, module_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: reading the policy");
            AppError::Database(e)
        })?;

    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "audience_id": r.audience_id,
                "position":    r.position,
                "name":        r.name,
                "description": r.description,
                "is_everyone": r.is_everyone,
            })
        })
        .collect())
}

/// `GET /admin/audiences/policy?org_unit_id=…&module_id=…`
///
/// The ordered list offered in that module, for accounts of that unit. First
/// entry is the primary one - the proposal shown by default.
///
/// ## Inheritance, and why the answer has two halves
///
/// A unit with no rows of its own does **not** fall back to nothing: it falls
/// back to the nearest ancestor that has a policy for this module, exactly like
/// a setting resolves through `core.setting_chain`. One tree must not carry two
/// contradictory inheritance rules - an administrator who learns that settings
/// flow downwards will assume the same of audiences, and be wrong in a way that
/// only shows up as "why does nobody in Support see the Direction option?".
///
/// So the response separates what was *written here* (`applied`, what the form
/// edits and what `PUT` replaces) from what is *in force* (`effective`, plus the
/// unit it comes from). When a unit has its own rows the two are identical and
/// `inherited_from` is null. This mirrors `ProvenanceLine`'s "inherited from X"
/// versus "overridden here", which the console already speaks elsewhere.
pub async fn get_policy(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Query(q): Query<PolicyQuery>,
) -> Result<Json<Value>, AppError> {
    ctx.require(keys::AUDIENCES_READ)?;

    let applied = policy_rows(&state.db, q.org_unit_id, &q.module_id).await?;
    if !applied.is_empty() {
        return Ok(Json(json!({
            "applied":        applied,
            "effective":      applied,
            "inherited_from": Value::Null,
            "max_applied":    MAX_APPLIED,
        })));
    }

    // `core.org_unit_ancestors` returns the chain nearest-first and carries its
    // own depth guard, so a cycle stored by a past bug truncates the walk
    // instead of hanging the request. Reusing it rather than writing a second
    // recursive CTE is what keeps "nearest wins" meaning the same thing here as
    // it does for settings.
    // Portable recursive CTE (see `database::compat`) in place of the
    // PostgreSQL-only `core.org_unit_ancestors(...)`.
    let sql = format!(
        "SELECT a.id, a.name \
           FROM {} a \
          WHERE a.id <> $2 \
          ORDER BY a.depth",
        crate::database::compat::org_unit_ancestors(1)
    );
    let ancestors: Vec<(Uuid, String)> = state
        .db
        .fetch_all_as::<(Uuid, String)>(&sql, params![q.org_unit_id, q.org_unit_id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: walking up parent units");
            AppError::Database(e)
        })?;

    for (unit_id, unit_name) in ancestors {
        let rows = policy_rows(&state.db, unit_id, &q.module_id).await?;
        if !rows.is_empty() {
            return Ok(Json(json!({
                "applied":        [],
                "effective":      rows,
                "inherited_from": { "org_unit_id": unit_id, "org_unit_name": unit_name },
                "max_applied":    MAX_APPLIED,
            })));
        }
    }

    Ok(Json(json!({
        "applied":        [],
        "effective":      [],
        "inherited_from": Value::Null,
        "max_applied":    MAX_APPLIED,
    })))
}

#[derive(Debug, Deserialize)]
pub struct SetPolicyDto {
    pub org_unit_id: Uuid,
    pub module_id: String,
    /// In display order. The first is the primary audience; an empty list turns
    /// the feature off for that unit and module.
    pub audience_ids: Vec<Uuid>,
}

/// `PUT /admin/audiences/policy` - replaces the whole ordered list atomically.
///
/// Replacement rather than incremental edits, because the order *is* the
/// meaning: "add this one" has no answer to "where?", and two admins reordering
/// concurrently through per-row updates would interleave into an order neither
/// of them chose. One statement, one intent, one audit entry that shows the
/// before and after lists side by side.
pub async fn set_policy(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<SetPolicyDto>,
) -> Result<Json<Value>, AppError> {
    // The narrower privilege on purpose: this is the call that changes what
    // people see.
    ctx.require(keys::AUDIENCES_APPLY)?;

    if dto.module_id.trim().is_empty() {
        return Err(AppError::Validation("Module non précisé.".into()));
    }
    if dto.audience_ids.len() > MAX_APPLIED {
        return Err(AppError::Validation(format!(
            "Au plus {MAX_APPLIED} audiences peuvent être proposées à la fois : au-delà, la liste cesse d'être un raccourci."
        )));
    }
    // A duplicate would be accepted by the primary key on (unit, module,
    // audience) only to collapse two ranks into one, silently shortening the
    // list the administrator thought they wrote.
    let mut seen = std::collections::HashSet::new();
    if !dto.audience_ids.iter().all(|id| seen.insert(*id)) {
        return Err(AppError::Validation(
            "La même audience figure deux fois dans la liste.".into(),
        ));
    }

    // The before-image is read on the pool ahead of the transaction: a `DbTx`
    // exposes no multi-row fetch, and this list only feeds the audit snapshot.
    let before: Vec<Uuid> = state
        .db
        .fetch_all_as::<(Uuid,)>(
            "SELECT audience_id FROM core.target_audience_policies
          WHERE org_unit_id = $1 AND module_id = $2 ORDER BY position",
            params![dto.org_unit_id, &dto.module_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: existing policy");
            AppError::Database(e)
        })?
        .into_iter()
        .map(|(id,)| id)
        .collect();

    let mut tx = audit.begin(&state.db).await?;

    let unit_name: String = tx
        .fetch_optional_scalar::<String>(
            "SELECT name FROM core.org_units WHERE id = $1",
            params![dto.org_unit_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audiences: reading the unit");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("Unité organisationnelle introuvable".into()))?;

    tx.execute(
        "DELETE FROM core.target_audience_policies WHERE org_unit_id = $1 AND module_id = $2",
        params![dto.org_unit_id, &dto.module_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "audiences: purging the policy");
        AppError::Database(e)
    })?;

    for (rank, audience_id) in dto.audience_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO core.target_audience_policies (org_unit_id, module_id, audience_id, position)
             VALUES ($1, $2, $3, $4)",
            params![dto.org_unit_id, &dto.module_id, audience_id, rank as i16],
        )
        .await
        .map_err(|e| {
            if e.to_string().contains("foreign key") {
                AppError::Validation("Une des audiences indiquées n'existe pas.".into())
            } else {
                tracing::error!(error = %e, "audiences: writing the policy");
                AppError::Database(e)
            }
        })?;
    }

    tx.commit(
        AuditEntry::new("core.audiences.policy_set")
            .target(
                target::AUDIENCE_POLICY,
                dto.org_unit_id,
                format!("{} - {}", unit_name, dto.module_id),
            )
            .before(json!({ "audience_ids": before }))
            .after(json!({ "audience_ids": dto.audience_ids }))
            .reversible(),
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_normalised_before_it_is_compared() {
        assert_eq!(clean_name("  Direction   générale "), "Direction générale");
        assert_eq!(clean_name("Lyon"), "Lyon");
        assert_eq!(clean_name("   "), "");
    }

    #[test]
    fn an_empty_name_is_refused() {
        assert!(validate_details("   ", None).is_err());
    }

    /// The limit counts characters, not bytes: a French name of exactly forty
    /// accented letters is legal and a byte check would reject it.
    #[test]
    fn the_name_limit_counts_characters_not_bytes() {
        let forty_accented = "é".repeat(40);
        assert_eq!(forty_accented.len(), 80, "prérequis du test : 2 octets par é");
        assert!(validate_details(&forty_accented, None).is_ok());
        assert!(validate_details(&"é".repeat(41), None).is_err());
    }

    #[test]
    fn the_description_limit_counts_characters_too() {
        assert!(validate_details("Direction", Some(&"é".repeat(150))).is_ok());
        assert!(validate_details("Direction", Some(&"é".repeat(151))).is_err());
    }

    /// The database enforces `position < 5`; this constant must not drift past
    /// it, or a legal-looking request would fail with a check-constraint error
    /// instead of the sentence written for it.
    #[test]
    fn the_ceiling_matches_the_column_constraint() {
        assert_eq!(MAX_APPLIED, 5);
    }
}
