//! Cross-module labels: user-owned labels attachable to elements of ANY module.
//!
//! A link stores a denormalized snapshot of the element ({module,
//! resource_type, resource_id, title, href, envelope}) so listing, filtering
//! and searching across modules never fans out to module backends. The
//! `envelope` is a full cross-module JSON envelope: the frontend renders it
//! through the same `core.data-card` renderers as clipboard paste.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use kubuno_db::{dialect::Assign, new_id, params, Backend, DbPool, DbQueryBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;
use validator::Validate;

use crate::{
    auth::middleware::AuthUser,
    errors::AppError,
    models::label::{
        CreateLabelDto, Label, LabelLink, SetLabelSharesDto, SetResourceLabelsDto, UpdateLabelDto,
    },
    state::AppState,
};

fn normalized_color(color: Option<&str>) -> Result<String, AppError> {
    let c = color.unwrap_or("#1a73e8").trim().to_string();
    if !c.starts_with('#') || !(4..=9).contains(&c.len()) || !c[1..].chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(AppError::Validation("Couleur invalide (attendu #rrggbb)".into()));
    }
    Ok(c)
}

/// Effective rights of `user_id` on `label_id` - `None` when the label does not
/// exist or is not shared with them. `core.label_access` folds ownership, direct
/// shares and group shares, keeping the most permissive.
async fn access(
    db: &DbPool,
    user_id: Uuid,
    label_id: Uuid,
) -> Result<Option<(bool, bool)>, AppError> {
    // Portable derived table (see `database::compat`); the user id is bound
    // three times (`$1..$3`), the label id is `$4`.
    let sql = format!(
        "SELECT la.is_owner, la.can_manage FROM {} la WHERE la.label_id = $4",
        crate::database::compat::label_access(db.backend(), 1)
    );
    let row = db
        .fetch_optional_as::<(bool, bool)>(
            &sql,
            params![user_id, user_id, user_id, label_id],
        )
        .await?;
    Ok(row)
}

/// Rejects the caller unless they may manage `label_id` (owner or a share with
/// `can_manage`). Unknown and forbidden are both 404: no existence leak.
async fn require_manage(db: &DbPool, user_id: Uuid, label_id: Uuid) -> Result<(), AppError> {
    match access(db, user_id, label_id).await? {
        Some((_, true)) => Ok(()),
        Some((_, false)) => Err(AppError::Forbidden),
        None => Err(AppError::NotFound("Étiquette introuvable".into())),
    }
}

/// GET /api/v1/labels - every label the caller may see: their own plus those
/// shared with them directly or through one of their groups.
pub async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, AppError> {
    // `link_count` follows the visibility rule: a manager counts everyone's
    // links, a plain recipient only their own. Portable `label_access` derived
    // table (see `database::compat`): `$1` is the link_count owner filter, then
    // `$2..$4` are the three copies of the user id it needs; every value is bound
    // once, in ascending order.
    let backend = state.db.backend();
    let sql = format!(
        r#"SELECT l.id, l.name, l.color, l.description,
                  a.is_owner, a.can_manage,
                  l.owner_id, COALESCE(u.display_name, u.username) AS owner_name,
                  (SELECT {count} FROM core.label_links k
                    WHERE k.label_id = l.id AND (a.can_manage OR k.owner_id = $1)) AS link_count,
                  (SELECT {count} FROM core.label_shares s WHERE s.label_id = l.id) AS share_count
           FROM {label_access} a
           JOIN core.labels l ON l.id = a.label_id
           JOIN core.users  u ON u.id = l.owner_id
           ORDER BY a.is_owner DESC, LOWER(l.name)"#,
        count = backend.count_bigint("*"),
        label_access = crate::database::compat::label_access(backend, 2),
    );
    let rows = state
        .db
        .fetch_all_as::<(Uuid, String, String, Option<String>, bool, bool, Uuid, String, i64, i64)>(
            &sql,
            params![user.id, user.id, user.id, user.id],
        )
        .await?;

    let labels: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, color, description, is_owner, can_manage, owner_id, owner_name, link_count, share_count)| {
            json!({
                "id": id, "name": name, "color": color, "description": description,
                "is_owner": is_owner, "can_manage": can_manage,
                "owner_id": owner_id, "owner_name": owner_name,
                "link_count": link_count, "share_count": share_count,
            })
        })
        .collect();
    Ok(Json(json!({ "labels": labels })))
}

/// POST /api/v1/labels
pub async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(dto): Json<CreateLabelDto>,
) -> Result<Json<Value>, AppError> {
    dto.validate().map_err(|e| AppError::Validation(e.to_string()))?;
    let name = dto.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Nom vide".into()));
    }
    let color = normalized_color(dto.color.as_deref())?;

    // No RETURNING: the id is generated in Rust; on conflict the stored id is
    // kept, so the row is read back by its (owner_id, name) unique key.
    let backend = state.db.backend();
    let clause = backend.upsert("core.labels", &["owner_id", "name"], &[Assign::Incoming("updated_at")]);
    let insert_sql = format!(
        r#"INSERT INTO core.labels (id, owner_id, name, color, description, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6){clause}"#
    );
    let now = chrono::Utc::now();
    state
        .db
        .execute(
            &insert_sql,
            params![new_id(), user.id, name, &color, dto.description.as_deref(), now],
        )
        .await?;
    let label = state
        .db
        .fetch_one_as::<Label>(
            r#"SELECT id, owner_id, name, color, description, created_at, updated_at
               FROM core.labels WHERE owner_id = $1 AND name = $2"#,
            params![user.id, name],
        )
        .await?;

    // Same shape as `list`, so the caller can drop the new label straight into
    // its state without inventing the access fields. A fresh label is owned,
    // manageable, unshared and unlinked by definition.
    Ok(Json(json!({ "label": {
        "id": label.id, "name": label.name, "color": label.color,
        "description": label.description,
        "is_owner": true, "can_manage": true,
        "owner_id": user.id,
        "owner_name": user.display_name.as_ref().unwrap_or(&user.username),
        "link_count": 0, "share_count": 0,
    } })))
}

/// PATCH /api/v1/labels/:id
pub async fn update(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(dto): Json<UpdateLabelDto>,
) -> Result<Json<Value>, AppError> {
    dto.validate().map_err(|e| AppError::Validation(e.to_string()))?;
    require_manage(&state.db, user.id, id).await?;
    let color = match dto.color.as_deref() {
        Some(c) => Some(normalized_color(Some(c))?),
        None => None,
    };

    // No RETURNING: apply the partial update, then read the row back by id.
    // Placeholders are renumbered so they ascend in source order.
    let affected = state
        .db
        .execute(
            r#"UPDATE core.labels
               SET name        = COALESCE($1, name),
                   color       = COALESCE($2, color),
                   description = COALESCE($3, description)
               WHERE id = $4"#,
            params![
                dto.name.as_deref().map(str::trim),
                color.as_deref(),
                dto.description.as_deref(),
                id
            ],
        )
        .await?;
    if affected == 0 {
        return Err(AppError::NotFound("Étiquette introuvable".into()));
    }
    let label = state
        .db
        .fetch_one_as::<Label>(
            r#"SELECT id, owner_id, name, color, description, created_at, updated_at
               FROM core.labels WHERE id = $1"#,
            params![id],
        )
        .await?;

    Ok(Json(json!({ "label": label })))
}

/// DELETE /api/v1/labels/:id - links and shares go with it (ON DELETE CASCADE).
/// A co-manager may delete: full co-ownership, so this wipes the label for
/// EVERYONE, including the links of the other members.
pub async fn delete(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    require_manage(&state.db, user.id, id).await?;
    state
        .db
        .execute("DELETE FROM core.labels WHERE id = $1", params![id])
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct ResourceQuery {
    pub resource_type: String,
    pub resource_id:   String,
}

/// GET /api/v1/labels/resource?resource_type=&resource_id= - the label ids of
/// one element (the picker's initial state).
pub async fn labels_for_resource(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<ResourceQuery>,
) -> Result<Json<Value>, AppError> {
    let ids: Vec<Uuid> = state
        .db
        .fetch_all_as::<(Uuid,)>(
            r#"SELECT label_id FROM core.label_links
               WHERE owner_id = $1 AND resource_type = $2 AND resource_id = $3"#,
            params![user.id, &q.resource_type, &q.resource_id],
        )
        .await?
        .into_iter()
        .map(|(id,)| id)
        .collect();
    Ok(Json(json!({ "label_ids": ids })))
}

/// PUT /api/v1/labels/resource - replaces the label set of one element in a
/// single atomic call (what the picker saves).
pub async fn set_resource_labels(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(dto): Json<SetResourceLabelsDto>,
) -> Result<Json<Value>, AppError> {
    dto.validate().map_err(|e| AppError::Validation(e.to_string()))?;

    let backend = state.db.backend();

    // Any label the caller may see can be linked - their own, and those shared
    // with them (a share is a shared vocabulary, so plain recipients may label
    // their own elements too). The links themselves stay owned by the caller.
    // Resolved before the transaction: it is a read only. Portable `label_access`
    // derived table (see `database::compat`); `= ANY(...)` becomes a portable
    // `IN (...)`. The user id is bound three times, in ascending order, before
    // the `IN` list.
    let mut owned_qb = DbQueryBuilder::new(backend, "SELECT la.label_id FROM ");
    let n = owned_qb.bind_only(user.id);
    owned_qb.bind_only(user.id);
    owned_qb.bind_only(user.id);
    owned_qb
        .push(crate::database::compat::label_access(backend, n))
        .push(" la WHERE la.label_id");
    owned_qb.push_in(dto.label_ids.iter().copied());
    let owned: Vec<Uuid> = owned_qb
        .fetch_all_as::<(Uuid,)>(&state.db)
        .await?
        .into_iter()
        .map(|(id,)| id)
        .collect();

    let mut tx = state.db.begin().await?;

    // Delete the links this resource no longer carries. When `owned` is empty the
    // picker cleared every label, so every link of the resource is removed; the
    // former `<> ALL(array)` (empty = keep none) is expressed by omitting the
    // `NOT IN` guard in that case.
    let mut del_qb = DbQueryBuilder::new(backend, "DELETE FROM core.label_links WHERE owner_id = ");
    del_qb
        .push_bind(user.id)
        .push(" AND resource_type = ")
        .push_bind(&dto.resource_type)
        .push(" AND resource_id = ")
        .push_bind(&dto.resource_id);
    if !owned.is_empty() {
        del_qb.push(" AND label_id NOT").push_in(owned.iter().copied());
    }
    del_qb.tx_execute(&mut tx).await?;

    // No RETURNING and a generated id per link; the upsert keeps a link's stored
    // id on conflict.
    let link_clause = backend.upsert(
        "core.label_links",
        &["label_id", "resource_type", "resource_id"],
        &[
            Assign::Incoming("title"),
            Assign::Incoming("href"),
            Assign::Incoming("envelope"),
        ],
    );
    let link_sql = format!(
        r#"INSERT INTO core.label_links
             (id, label_id, owner_id, module, resource_type, resource_id, title, href, envelope)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9){link_clause}"#
    );
    for label_id in &owned {
        tx.execute(
            &link_sql,
            params![
                new_id(),
                label_id,
                user.id,
                &dto.module,
                &dto.resource_type,
                &dto.resource_id,
                dto.title.as_deref(),
                dto.href.as_deref(),
                dto.envelope.clone()
            ],
        )
        .await?;
    }

    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "linked": owned.len() })))
}

#[derive(Debug, Deserialize)]
pub struct BrowseQuery {
    /// Comma-separated label ids - an element must carry ALL of them.
    pub labels: Option<String>,
    /// Free-text search over the link titles (trigram-indexed).
    pub q:      Option<String>,
    /// Restrict to one module.
    pub module: Option<String>,
}

/// GET /api/v1/labels/browse - cross-module search & filter through labels.
/// Returns one entry per element, with the ids of ALL its labels.
pub async fn browse(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<BrowseQuery>,
) -> Result<Json<Value>, AppError> {
    let wanted: Vec<Uuid> = q
        .labels
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter_map(|s| Uuid::parse_str(s.trim()).ok())
        .collect();
    let text = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());

    // One row per element: aggregate its label ids, keep the newest snapshot.
    // Visibility: the caller's own links always, plus everyone's links on the
    // labels they co-manage (`can_manage`) - a plain share stays private.
    // `other_owners` names the members who labelled an element that is not the
    // caller's, so the browser can attribute it.
    //
    // Fetch the visible links flat (newest first) and fold them into one entry
    // per element in Rust. The original relied on `core.label_access(...)` (a
    // set-returning function), `ARRAY_AGG ... FILTER (WHERE ...)` and the array
    // subscript `[1]`, none of which MySQL/SQLite have. The portable
    // `compat::label_access` derived table replaces the function; the grouping,
    // "newest snapshot wins", the distinct id/owner sets and the "carries ALL
    // wanted labels" filter are all done here.
    //
    // `label_access` takes `$1..$3` (the caller id, thrice); those three binds
    // are recorded first (via `bind_only`) so the fragment's placeholders come
    // ahead of every filter's, keeping the final `$n` sequence ascending.
    let backend = state.db.backend();
    let la = crate::database::compat::label_access(backend, 1);
    let mut qb = DbQueryBuilder::new(
        backend,
        "SELECT k.module, k.resource_type, k.resource_id, k.title, k.href, \
                k.envelope, k.label_id, k.owner_id, \
                COALESCE(u.display_name, u.username) AS owner_name \
           FROM core.label_links k \
           JOIN ",
    );
    // Record $1,$2,$3 (the caller id) for `label_access`, then interpolate it.
    qb.bind_only(user.id);
    qb.bind_only(user.id);
    qb.bind_only(user.id);
    qb.push(la);
    qb.push(" a ON a.label_id = k.label_id JOIN core.users u ON u.id = k.owner_id WHERE (k.owner_id = ");
    qb.push_bind(user.id);
    qb.push(" OR a.can_manage)");
    if let Some(m) = q.module.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        qb.push(" AND k.module = ").push_bind(m);
    }
    if let Some(t) = text {
        let n = qb.bind_only(format!("%{t}%"));
        qb.push(" AND ").push(backend.ilike("k.title", n));
    }
    // Newest first so the first row seen for a group is its newest snapshot, and
    // groups surface in "newest link first" order without a second sort.
    qb.push(" ORDER BY k.created_at DESC");

    let rows = qb
        .fetch_all_as::<(String, String, String, Option<String>, Option<String>, Option<Value>, Uuid, Uuid, String)>(
            &state.db,
        )
        .await?;

    // One accumulator per element, in first-seen (i.e. newest-link-first) order.
    struct Agg {
        module: String,
        resource_type: String,
        resource_id: String,
        title: Option<String>,
        href: Option<String>,
        envelope: Option<Value>,
        label_ids: Vec<Uuid>,
        seen_labels: std::collections::HashSet<Uuid>,
        other_owners: Vec<String>,
        seen_owners: std::collections::HashSet<String>,
    }
    let mut order: Vec<Agg> = Vec::new();
    let mut index: std::collections::HashMap<(String, String, String), usize> =
        std::collections::HashMap::new();
    for (module, resource_type, resource_id, title, href, envelope, label_id, owner_id, owner_name) in
        rows
    {
        let key = (module.clone(), resource_type.clone(), resource_id.clone());
        let idx = *index.entry(key).or_insert_with(|| {
            // First row of the group is the newest link: its envelope wins.
            order.push(Agg {
                module,
                resource_type,
                resource_id,
                title: title.clone(),
                href: href.clone(),
                envelope,
                label_ids: Vec::new(),
                seen_labels: std::collections::HashSet::new(),
                other_owners: Vec::new(),
                seen_owners: std::collections::HashSet::new(),
            });
            order.len() - 1
        });
        let agg = &mut order[idx];
        // MAX(title)/MAX(href): keep the lexicographically largest non-null.
        if let Some(t) = title {
            if agg.title.as_deref().is_none_or(|cur| t.as_str() > cur) {
                agg.title = Some(t);
            }
        }
        if let Some(h) = href {
            if agg.href.as_deref().is_none_or(|cur| h.as_str() > cur) {
                agg.href = Some(h);
            }
        }
        if agg.seen_labels.insert(label_id) {
            agg.label_ids.push(label_id);
        }
        if owner_id != user.id && agg.seen_owners.insert(owner_name.clone()) {
            agg.other_owners.push(owner_name);
        }
    }

    // "Element must carry ALL wanted labels": keep a group only when every
    // requested label is present (matches the old `COUNT(DISTINCT ...) FILTER`
    // equalling the requested count). Then cap at 500, first-seen order.
    let items: Vec<Value> = order
        .into_iter()
        .filter(|agg| {
            wanted.is_empty()
                || wanted
                    .iter()
                    .filter(|w| agg.seen_labels.contains(w))
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    == wanted.len()
        })
        .take(500)
        .map(|agg| {
            json!({
                "module": agg.module, "resource_type": agg.resource_type,
                "resource_id": agg.resource_id, "title": agg.title, "href": agg.href,
                "envelope": agg.envelope, "label_ids": agg.label_ids,
                "other_owners": agg.other_owners,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// GET /api/v1/labels/:id/links - the raw links of one label, under the same
/// visibility rule as `browse`.
pub async fn list_links(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    if access(&state.db, user.id, id).await?.is_none() {
        return Err(AppError::NotFound("Étiquette introuvable".into()));
    }
    // Portable `label_access` derived table (see `database::compat`). It takes
    // `$1..$3` (the user id, thrice); `$4` is the label id and `$5` the owner
    // filter. Every value is bound once, ascending.
    let sql = format!(
        r#"SELECT k.id, k.label_id, k.module, k.resource_type, k.resource_id,
                  k.title, k.href, k.envelope, k.created_at
           FROM core.label_links k
           JOIN {label_access} a ON a.label_id = k.label_id
           WHERE k.label_id = $4 AND (k.owner_id = $5 OR a.can_manage)
           ORDER BY k.created_at DESC"#,
        label_access = crate::database::compat::label_access(state.db.backend(), 1),
    );
    let links = state
        .db
        .fetch_all_as::<LabelLink>(
            &sql,
            params![user.id, user.id, user.id, id, user.id],
        )
        .await?;
    Ok(Json(json!({ "links": links })))
}

/// DELETE /api/v1/labels/:id/links/:link_id - detach one element. The caller
/// detaches their own links; a co-manager may detach anyone's.
pub async fn remove_link(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, link_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, AppError> {
    let can_manage = matches!(access(&state.db, user.id, id).await?, Some((_, true)));
    let res = state
        .db
        .execute(
            r#"DELETE FROM core.label_links
               WHERE id = $1 AND label_id = $2 AND (owner_id = $3 OR $4)"#,
            params![link_id, id, user.id, can_manage],
        )
        .await?;
    if res == 0 {
        return Err(AppError::NotFound("Lien introuvable".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/v1/labels/:id/shares - the audience of a label (managers only).
pub async fn list_shares(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    require_manage(&state.db, user.id, id).await?;

    // NOTE: `ORDER BY ... NULLS LAST` is Postgres-only ordering syntax.
    let rows = state
        .db
        .fetch_all_as::<(Uuid, Option<Uuid>, Option<Uuid>, bool, Option<String>, Option<String>)>(
            r#"SELECT s.id, s.user_id, s.group_id, s.can_manage,
                      COALESCE(u.display_name, u.username) AS user_name,
                      g.name AS group_name
               FROM core.label_shares s
               LEFT JOIN core.users u       ON u.id = s.user_id
               LEFT JOIN core.user_groups g ON g.id = s.group_id
               WHERE s.label_id = $1
               ORDER BY (g.name IS NULL), g.name, COALESCE(u.display_name, u.username)"#,
            params![id],
        )
        .await?;

    let shares: Vec<Value> = rows
        .into_iter()
        .map(|(sid, user_id, group_id, can_manage, user_name, group_name)| {
            json!({
                "id": sid, "user_id": user_id, "group_id": group_id, "can_manage": can_manage,
                "name": user_name.or(group_name).unwrap_or_default(),
                "kind": if group_id.is_some() { "group" } else { "user" },
            })
        })
        .collect();
    Ok(Json(json!({ "shares": shares })))
}

/// PUT /api/v1/labels/:id/shares - replaces the whole audience atomically
/// (managers only). Sharing back to the owner is a no-op and is dropped.
pub async fn set_shares(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(dto): Json<SetLabelSharesDto>,
) -> Result<Json<Value>, AppError> {
    dto.validate().map_err(|e| AppError::Validation(e.to_string()))?;
    require_manage(&state.db, user.id, id).await?;

    let owner_id = state
        .db
        .fetch_optional_scalar::<Uuid>(
            "SELECT owner_id FROM core.labels WHERE id = $1",
            params![id],
        )
        .await?
        .ok_or_else(|| AppError::NotFound("Étiquette introuvable".into()))?;

    for s in &dto.shares {
        if s.user_id.is_some() == s.group_id.is_some() {
            return Err(AppError::Validation(
                "Chaque partage vise soit un utilisateur, soit un groupe".into(),
            ));
        }
    }

    let mut tx = state.db.begin().await?;
    tx.execute("DELETE FROM core.label_shares WHERE label_id = $1", params![id])
        .await?;

    // The two unique indexes on this table are PARTIAL (`WHERE user_id IS NOT
    // NULL` / `WHERE group_id IS NOT NULL`), so a targeted `ON CONFLICT (cols)`
    // cannot name them: keep a bare, arbiter-less "ignore duplicates". MySQL says
    // it with `INSERT IGNORE`; PostgreSQL and SQLite with `ON CONFLICT DO NOTHING`.
    let backend = tx.backend();
    let (ignore_prefix, conflict) = match backend {
        Backend::MySql => ("IGNORE ", ""),
        _ => ("", " ON CONFLICT DO NOTHING"),
    };
    let insert_sql = format!(
        "INSERT {ignore_prefix}INTO core.label_shares \
             (id, label_id, user_id, group_id, can_manage, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6){conflict}"
    );

    let mut kept = 0usize;
    for s in &dto.shares {
        if s.user_id == Some(owner_id) {
            continue; // the owner already has full rights
        }
        // Unknown users/groups are rejected by the FKs - surface a clean 422.
        tx.execute(
            &insert_sql,
            params![new_id(), id, s.user_id, s.group_id, s.can_manage, user.id],
        )
        .await
        .map_err(|e| {
            tracing::error!(label_id = %id, error = %e, "insertion d'un partage d'étiquette");
            AppError::Validation("Destinataire inconnu".into())
        })?;
        kept += 1;
    }

    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "shares": kept })))
}

#[derive(Debug, Deserialize)]
pub struct ShareTargetsQuery {
    pub q: Option<String>,
}

/// GET /api/v1/labels/share-targets?q= - users and groups the share picker can
/// offer. Public fields only (no email), like `/users/search`.
pub async fn share_targets(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<ShareTargetsQuery>,
) -> Result<Json<Value>, AppError> {
    let text = q.q.as_deref().map(str::trim).unwrap_or("");
    let backend = state.db.backend();

    // The `$n = '' OR ...` match-all trick is replaced by branching in Rust, so
    // the search predicate is only present (and its pattern only bound) when there
    // is text to match. `ILIKE` is emitted per engine by `Backend::ilike`.
    let users = if text.is_empty() {
        state
            .db
            .fetch_all_as::<(Uuid, String, Option<String>)>(
                r#"SELECT id, COALESCE(display_name, username), avatar_url
                   FROM core.users
                   WHERE is_active = TRUE AND id <> $1
                   ORDER BY COALESCE(display_name, username)
                   LIMIT 25"#,
                params![user.id],
            )
            .await?
    } else {
        let pattern = format!("%{text}%");
        let sql = format!(
            r#"SELECT id, COALESCE(display_name, username), avatar_url
               FROM core.users
               WHERE is_active = TRUE AND id <> $1
                 AND ({} OR {})
               ORDER BY COALESCE(display_name, username)
               LIMIT 25"#,
            backend.ilike("username", 2),
            backend.ilike("display_name", 3),
        );
        state
            .db
            .fetch_all_as::<(Uuid, String, Option<String>)>(
                &sql,
                params![user.id, pattern.clone(), pattern],
            )
            .await?
    };

    let count_expr = backend.count_bigint("m.user_id");
    let groups = if text.is_empty() {
        let sql = format!(
            r#"SELECT g.id, g.name, {count_expr}
               FROM core.user_groups g
               LEFT JOIN core.user_group_members m ON m.group_id = g.id
               GROUP BY g.id
               ORDER BY g.name
               LIMIT 25"#
        );
        state.db.fetch_all_as::<(Uuid, String, i64)>(&sql, params![]).await?
    } else {
        let sql = format!(
            r#"SELECT g.id, g.name, {count_expr}
               FROM core.user_groups g
               LEFT JOIN core.user_group_members m ON m.group_id = g.id
               WHERE {}
               GROUP BY g.id
               ORDER BY g.name
               LIMIT 25"#,
            backend.ilike("g.name", 1),
        );
        state
            .db
            .fetch_all_as::<(Uuid, String, i64)>(&sql, params![format!("%{text}%")])
            .await?
    };

    Ok(Json(json!({
        "users": users.into_iter()
            .map(|(id, name, avatar_url)| json!({ "id": id, "name": name, "avatar_url": avatar_url }))
            .collect::<Vec<_>>(),
        "groups": groups.into_iter()
            .map(|(id, name, members)| json!({ "id": id, "name": name, "member_count": members }))
            .collect::<Vec<_>>(),
    })))
}
