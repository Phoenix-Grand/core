//! Organizational units: the tree every scoped decision hangs from.
//!
//! ## The three invariants
//!
//! 1. **One root, and only one.** The console draws "the" organisation from the
//!    row whose `parent_id` is NULL, and `core.setting_chain` resolves a value
//!    by climbing that single chain. A second root is invisible in the tree and
//!    resolves its own parallel inheritance. Creating a unit therefore *requires*
//!    a parent, and no update may promote a unit back to root.
//! 2. **No two sisters with the same name**, compared case-insensitively - an
//!    administrator identifies a unit by reading it in a list.
//! 3. **A bounded depth.** See [`MAX_ORG_UNIT_DEPTH`].
//!
//! Invariants 1 and 2 are also enforced by two unique indexes (migration
//! 000106): the checks below produce the sentence a human reads, the indexes
//! make the rule true of the data even under concurrency or hand-written SQL.

use crate::{
    audit::{redact::target, snap, AdminAudit, AuditEntry},
    auth::middleware::AdminUser,
    authz::{keys, AdminCtx},
    errors::AppError,
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use kubuno_db::{dialect::SqlType, new_id, params, DbQueryBuilder, DbTx};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;
use sqlx::FromRow;
use uuid::Uuid;

/// Deepest level a unit may sit at, the root being level 0 - so at most 35
/// levels of units *below* the organisation itself.
///
/// The figure is parity with the reference product (Google Workspace caps its
/// organisational tree at 35 levels), but the reason it must exist at all is
/// local: `core.setting_chain` (migration 000060) ranks each ancestor with
/// `200 + (64 - LEAST(depth, 64))`. Past depth 64 every level collapses onto the
/// same specificity of 200 and "the closest unit wins" silently stops being
/// true - two units in the same chain would then tie, and the winner would be
/// whatever the planner happened to order first. 35 keeps a comfortable margin
/// under that cliff, and under the depth guard (64) built into
/// `core.org_unit_ancestors` / `core.org_unit_descendants`.
///
/// ## The single source for every walk of this tree
///
/// Anything that climbs the unit chain must bound itself by **this** constant
/// and not by a literal of its own. The rules engine used to hard-code 32
/// (`rules/store.rs`, `resolve_subject`), three levels short of what an operator
/// could build here: a unit at depth 33, 34 or 35 resolved a *truncated*
/// ancestor chain, so a rule scoped near the top silently stopped applying to
/// the deepest accounts. Silently is the operative word - nothing failed, the
/// rule simply did not fire.
///
/// Two literals describing one invariant will always drift, and the one that
/// drifts is the one nobody is looking at. `rules/store.rs` now imports this
/// constant, which is why raising the ceiling here is enough to raise it
/// everywhere.
pub const MAX_ORG_UNIT_DEPTH: i32 = 35;

/// `core.org_units.name` is `VARCHAR(255)`. Refusing above the limit turns a
/// database-level `value too long` (a 500) into the sentence written for it.
const MAX_NAME_CHARS: usize = 255;

/// Bound handed to the recursive walkers. One level past the ceiling is enough
/// to *observe* a violation: anything deeper is refused anyway, so paying for a
/// full 64-level walk would buy nothing.

#[derive(Serialize, FromRow)]
pub struct OrgUnit {
    pub id:          Uuid,
    pub name:        String,
    pub parent_id:   Option<Uuid>,
    pub description: Option<String>,
}

// ── Authorisation shared by the three writes ─────────────────────────────────

/// Every write on the tree requires `core.org_units.manage` **held over the
/// whole instance**.
///
/// `ctx.require` would only ask that the caller hold the key *somewhere*, and
/// that is the wrong question here. Migration 000044 declares
/// `core.org_units.manage` non-scopable, in as many words: *"restructuring is
/// not [scopable]: moving a unit changes the tree beyond the subtree it started
/// in."* It is literally true - reparenting a unit under a branch the caller
/// does not cover hands that branch a subtree, and deleting a unit lifts its
/// children into the parent, which is outside the deleted unit by definition.
///
/// `setting_scopes.rs` makes exactly this choice for `core.settings.manage`, and
/// spells out why it writes the check even where the declaration already makes
/// it redundant: the guard nobody adds later is the one that had to be added
/// later. Today `ensure_scopable` refuses to grant a non-scopable privilege at
/// unit scope, so no caller can reach here holding it partially - `require` and
/// `require_instance` agree on every context that exists. The day that
/// declaration is relaxed, this line is what keeps a branch administrator from
/// rearranging the organisation.
fn require_manage(ctx: &AdminCtx) -> Result<(), AppError> {
    ctx.require_instance(keys::ORG_UNITS_MANAGE)
}

/// Drops every cached administrative context after the tree has changed.
///
/// `authz::context::resolve` flattens each assignment's scope through
/// `core.org_unit_descendants` and `authz::cache` keeps the result for a few
/// seconds. That expansion is a **snapshot of the tree**, so any write here can
/// falsify it - and in the direction that matters:
///
///  * creating a unit adds it to the subtree of every assignment scoped above
///    it; until the entry expires, the operator delegated to that branch is
///    refused on a unit they do own;
///  * moving a unit takes its whole subtree out of one delegation and into
///    another - the stale half of that is a caller still acting on units they no
///    longer cover;
///  * deleting a unit cascades its assignments away, and a cached context
///    outlives them.
///
/// `guards.rs` already calls `invalidate_all` after every write to a role or an
/// assignment, for the same reason and with the same bluntness - working out the
/// exact closure is the kind of thing that is correct the day it is written. The
/// cost is one re-resolution per active administrator; the alternative is a
/// five-second window of wrong answers.
fn invalidate_authz_cache() {
    crate::authz::cache::invalidate_all();
}

// ── Validation shared by create and update ───────────────────────────────────

/// Trims and checks a submitted name.
fn clean_name(raw: &str) -> Result<&str, AppError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Nom requis".into()));
    }
    // Characters, not bytes: a 200-letter accented name is legal and a byte
    // check would reject it.
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::Validation(format!(
            "Nom trop long : {MAX_NAME_CHARS} caractères au maximum"
        )));
    }
    Ok(name)
}

/// Depth the tree would reach once a subtree of height `subtree_height`
/// (0 for a leaf) is attached under a parent sitting at `parent_depth`.
///
/// Creating a leaf is the same computation with a height of 0, which is why
/// creation and reparenting share it.
fn resulting_depth(parent_depth: i32, subtree_height: i32) -> i32 {
    parent_depth.saturating_add(1).saturating_add(subtree_height)
}

/// Refuses an attachment that would push the tree past [`MAX_ORG_UNIT_DEPTH`].
fn check_depth(parent_depth: i32, subtree_height: i32) -> Result<(), AppError> {
    let depth = resulting_depth(parent_depth, subtree_height);
    if depth > MAX_ORG_UNIT_DEPTH {
        return Err(AppError::Validation(format!(
            "Profondeur maximale dépassée : l'arborescence est limitée à \
             {MAX_ORG_UNIT_DEPTH} niveaux sous l'unité racine, cette opération en demanderait {depth}"
        )));
    }
    Ok(())
}

/// Turns a unique-index violation into the 409 that names the offending sister,
/// and leaves every other database error to the generic path (logged, 500).
fn map_write_error(e: sqlx::Error, name: &str, context: &'static str) -> AppError {
    if matches!(&e, sqlx::Error::Database(db) if db.is_unique_violation()) {
        AppError::Conflict(format!(
            "Une unité nommée « {name} » existe déjà sous la même unité parente"
        ))
    } else {
        tracing::error!(error = %e, "{context}");
        AppError::from(e)
    }
}

/// Depth of `id` measured from the root, or `None` when the unit does not exist.
async fn unit_depth(conn: &mut DbTx, id: Uuid) -> Result<Option<i32>, AppError> {
    // A single aggregate row always comes back; its value is NULL for a missing
    // unit, so it is decoded as `Option<i32>` and the outer option flattened.
    // The ancestor walk is the portable recursive CTE of `database::compat`.
    let sql = format!(
        "SELECT MAX(a.depth) FROM {} a",
        crate::database::compat::org_unit_ancestors(1)
    );
    conn.fetch_optional_scalar::<Option<i32>>(&sql, params![id])
    .await
    .map(Option::flatten)
    .map_err(|e| {
        tracing::error!(error = %e, %id, "org_units: computing the depth");
        AppError::Database(e)
    })
}

/// Height of the subtree rooted at `id`: 0 for a leaf.
async fn subtree_height(conn: &mut DbTx, id: Uuid) -> Result<i32, AppError> {
    // Portable recursive CTE (see `database::compat`).
    let sql = format!(
        "SELECT COALESCE(MAX(d.depth), 0) FROM {} d",
        crate::database::compat::org_unit_descendants(1)
    );
    conn.fetch_optional_scalar::<i32>(&sql, params![id])
    .await
    .map(|v| v.unwrap_or(0))
    .map_err(|e| {
        tracing::error!(error = %e, %id, "org_units: subtree height");
        AppError::Database(e)
    })
}

// ── Reading ──────────────────────────────────────────────────────────────────

/// `GET /admin/org-units` - **confined to the caller's organisational subtree**.
///
/// `core.org_units.read` is declared scopable (migration 000044), and
/// `list_users` has confined its own listing to `subtree_filter` from the day
/// delegation landed. This one did not: it read the table whole. An
/// administrator delegated to a single branch therefore obtained the entire
/// organisation chart - every department, every team, every reorganisation in
/// progress. That is not an incidental leak: the chart *is* the shape of the
/// company, and it was handed out by the endpoint whose whole job is to describe
/// a scope.
///
/// `subtree_filter` returns `None` for an instance-wide holder or a super-user
/// (no restriction), and otherwise the already-flattened set of unit ids the
/// caller covers - empty for a caller holding nothing, which correctly yields an
/// empty tree rather than the whole one.
///
/// A delegated caller therefore receives a **forest**: the units they cover, and
/// no ancestor to hang them from. That is deliberate - the names of the units
/// above are precisely what the scope excludes - and the console already renders
/// any row whose `parent_id` is absent from the payload as a top-level entry.
pub async fn list_org_units(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::ORG_UNITS_READ)?;
    let scope_units = ctx.subtree_filter(keys::ORG_UNITS_READ);

    // No restriction lists every unit; a scoped caller lists only the ids they
    // cover (an empty set yields `IN (NULL)`, i.e. nothing - the intended
    // outcome for a caller holding no scope).
    let mut qb = DbQueryBuilder::new(
        state.db.backend(),
        "SELECT id, name, parent_id, description FROM core.org_units",
    );
    if let Some(ids) = scope_units.as_deref() {
        qb.push(" WHERE id").push_in(ids.iter().copied());
    }
    qb.push_order_by("name");
    let units: Vec<OrgUnit> = qb
        .fetch_all_as(&state.db)
        .await
        .map_err(|e| { tracing::error!(error = %e, "list_org_units"); AppError::Database(e) })?;

    Ok(Json(json!({ "org_units": units })))
}

/// What a deletion would touch.
///
/// Kubuno deletes a unit by lifting its children and its members up to the
/// parent - deliberately, rather than refusing the deletion outright as the
/// reference product does: an administrator reorganising a tree should not have
/// to dismantle it leaf by leaf. But a silent reparenting is its own trap, and
/// the reparenting is only the *announced* half. Three other things go away with
/// the row, none of them recoverable by moving anything back:
///
///  * `core.role_assignments.scope_org_unit_id` is `ON DELETE CASCADE`
///    (migration 000044) - every delegation granted **over** this unit
///    disappears. Someone loses their administration rights, and the only trace
///    is this entry;
///  * `core.target_audience_policies.org_unit_id` is `ON DELETE CASCADE`
///    (migration 000105) - the module rollout policies of the unit;
///  * `core.setting_values` rows for the unit are purged by the
///    `org_units_purge_setting_values` trigger (migration 000060).
///
/// Every one of them is counted here so the number is on screen *before* the
/// click, not in a support ticket afterwards.
#[derive(Serialize, FromRow)]
pub struct DeletionImpact {
    /// Direct children, which the deletion moves up to the parent.
    pub children:          i64,
    /// The whole subtree below the unit, children included - the units whose
    /// settings inheritance changes, even though only the direct children are
    /// rewritten.
    pub descendants:       i64,
    /// Accounts attached to this unit, which the deletion moves up to the parent.
    pub users:             i64,
    /// Delegations scoped to this unit, destroyed by the cascade of 000044.
    pub role_assignments:  i64,
    /// Module rollout policies of this unit, destroyed by the cascade of 000105.
    pub audience_policies: i64,
    /// Per-unit setting overrides, dropped by the
    /// `org_units_purge_setting_values` trigger (migration 000060).
    pub setting_overrides: i64,
}

/// The six counts, read in one round trip because they are displayed together.
///
/// Placeholders are the unit id, bound once per use (`$1..$6`): the portable
/// placeholder scanner forbids reusing `$n`. The descendant walk is the portable
/// recursive CTE of [`crate::database::compat`]; it counts the subtree including
/// the unit itself, so one is subtracted for "descendants". A unit always has a
/// row, so the count is never zero here.
fn impact_counts_sql(backend: kubuno_db::Backend) -> String {
    let c = backend.count_bigint("*");
    let descendants = crate::database::compat::org_unit_descendants(2);
    format!(
        "SELECT \
           (SELECT {c} FROM core.org_units ch WHERE ch.parent_id = $1) AS children, \
           (SELECT {c} FROM {descendants} d) - 1 AS descendants, \
           (SELECT {c} FROM core.users u WHERE u.org_unit_id = $3) AS users, \
           (SELECT {c} FROM core.role_assignments a WHERE a.scope_org_unit_id = $4) AS role_assignments, \
           (SELECT {c} FROM core.target_audience_policies p WHERE p.org_unit_id = $5) AS audience_policies, \
           (SELECT {c} FROM core.setting_values v \
             WHERE v.scope_type = 'org_unit' AND v.scope_id = $6) AS setting_overrides"
    )
}

/// `GET /admin/org-units/:id/impact` - what `DELETE` on this unit would do.
///
/// Read-only and idempotent: it exists so a console can put the consequences in
/// the confirmation dialog. `core.org_units.read` is scopable, so the unit must
/// also be inside the caller's own subtree - otherwise this endpoint would
/// answer questions about branches the listing correctly refuses to show.
pub async fn org_unit_impact(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::ORG_UNITS_READ)?;
    ctx.require_for_unit(keys::ORG_UNITS_READ, Some(id))?;

    let unit = state
        .db
        .fetch_optional_as::<OrgUnit>(
            "SELECT id, name, parent_id, description FROM core.org_units WHERE id = $1",
            params![id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "org_unit_impact: read"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("Unité {id}")))?;

    // The subtree of a legal tree never exceeds the ceiling; the bound is a
    // safety net for a tree that predates it.
    let impact = state
        .db
        .fetch_one_as::<DeletionImpact>(
            &impact_counts_sql(state.db.backend()),
            params![id, id, id, id, id, id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, %id, "org_unit_impact: count"); AppError::Database(e) })?;

    let is_root = unit.parent_id.is_none();
    Ok(Json(json!({
        "unit":              unit,
        // The root has no parent to lift anything up to: it cannot be deleted,
        // and saying so here spares the caller a refused DELETE.
        "is_root":           is_root,
        "deletable":         !is_root,
        // Moved up to the parent - recoverable by moving them back.
        "children":          impact.children,
        "descendants":       impact.descendants,
        "users":             impact.users,
        // Destroyed outright - nothing brings these back.
        "role_assignments":  impact.role_assignments,
        "audience_policies": impact.audience_policies,
        "setting_overrides": impact.setting_overrides,
    })))
}

// ── Creating ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateOrgUnitDto {
    pub name:        String,
    pub parent_id:   Option<Uuid>,
    pub description: Option<String>,
}

pub async fn create_org_unit(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Json(dto): Json<CreateOrgUnitDto>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    require_manage(&ctx)?;
    let name = clean_name(&dto.name)?;

    // A missing parent used to mean "second root". It now means "incomplete
    // request", and the message says why there is nothing to guess.
    let Some(parent_id) = dto.parent_id else {
        return Err(AppError::Validation(
            "Unité parente requise : une instance n'a qu'une seule unité racine, \
             toute nouvelle unité se crée sous une unité existante"
                .into(),
        ));
    };

    let description = dto
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty());

    let mut tx = audit.begin(&state.db).await?;

    // A refused creation has no row to point at: the target is the collection,
    // labelled with the name that was attempted.
    let refuse = || AuditEntry::new("core.org_units.create").target_kind(target::ORG_UNIT, name);

    let Some(parent_depth) = unit_depth(&mut tx, parent_id).await? else {
        let reason = format!("Unité parente {parent_id} introuvable");
        return Err(tx
            .abort(&state.db, refuse(), AppError::Validation(reason))
            .await);
    };

    // A new unit is a leaf: height 0.
    if let Err(e) = check_depth(parent_depth, 0) {
        return Err(tx.abort(&state.db, refuse(), e).await);
    }

    // The primary key is generated in Rust (no `RETURNING`, which MySQL lacks);
    // every column of the new row is already known, so the struct is built
    // directly rather than read back.
    let unit_id = new_id();
    if let Err(e) = tx
        .execute(
            "INSERT INTO core.org_units (id, name, parent_id, description) VALUES ($1, $2, $3, $4)",
            params![unit_id, name, parent_id, description],
        )
        .await
    {
        let err = map_write_error(e, name, "create_org_unit");
        return Err(tx.abort(&state.db, refuse(), err).await);
    }
    let unit = OrgUnit {
        id:          unit_id,
        name:        name.to_string(),
        parent_id:   Some(parent_id),
        description: description.map(str::to_string),
    };

    tx.commit(
        AuditEntry::new("core.org_units.create")
            .target(target::ORG_UNIT, unit.id, unit.name.clone())
            .after(snap(target::ORG_UNIT, &unit))
            .reversible(),
    )
    .await?;

    // The new unit belongs to the subtree of every assignment scoped above it.
    invalidate_authz_cache();

    Ok((StatusCode::CREATED, Json(json!({ "org_unit": unit }))))
}

// ── Updating ─────────────────────────────────────────────────────────────────

/// Distinguishes an absent field from a field explicitly set to `null`.
///
/// `Option<T>` cannot: `serde` deserialises both into `None`, which is why the
/// previous `SET description = COALESCE($3, description)` made a description
/// impossible to clear - sending `null` was indistinguishable from not sending
/// the field. With `Option<Option<T>>` plus `#[serde(default)]`, absent is the
/// outer `None` and `null` is `Some(None)`.
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
pub struct UpdateOrgUnitDto {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub parent_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
}

pub async fn update_org_unit(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
    Json(dto): Json<UpdateOrgUnitDto>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_manage(&ctx)?;
    let name = dto.name.as_deref().map(clean_name).transpose()?;

    // An empty description is not a description: it clears the field, exactly
    // like an explicit `null`.
    let description = dto
        .description
        .as_ref()
        .map(|d| d.as_deref().map(str::trim).filter(|d| !d.is_empty()));

    let mut tx = audit.begin(&state.db).await?;

    // Snapshot taken inside the transaction, row locked: the `before` side of
    // the diff cannot drift between the read and the write. A struct read in a
    // transaction is mapped column by column (a `DbTx` reads rows, not structs).
    let for_update = tx.backend().for_update();
    let previous_row = tx
        .fetch_optional_row(
            &format!(
                "SELECT id, name, parent_id, description FROM core.org_units WHERE id = $1{}",
                for_update
            ),
            params![id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "update_org_unit: read"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("Unité {id}")))?;
    let previous = OrgUnit {
        id:          previous_row.try_get("id")?,
        name:        previous_row.try_get("name")?,
        parent_id:   previous_row.try_get("parent_id")?,
        description: previous_row.try_get("description")?,
    };

    // A refused move is a signal of its own: record it, then roll back.
    // `abort` fills in the outcome and the reason from the error.
    let refuse = || {
        AuditEntry::new("core.org_units.update")
            .target(target::ORG_UNIT, id, previous.name.clone())
            .before(snap(target::ORG_UNIT, &previous))
    };

    match dto.parent_id {
        // `"parent_id": null` asks for a second root. There is exactly one, and
        // it is the one migration 000036 seeded.
        Some(None) => {
            let reason = "Une instance n'a qu'une seule unité racine : une unité ne peut pas être promue racine";
            return Err(tx
                .abort(&state.db, refuse(), AppError::Validation(reason.into()))
                .await);
        }
        Some(Some(new_parent)) => {
            if new_parent == id {
                let reason = "Une unité ne peut pas être son propre parent";
                return Err(tx
                    .abort(&state.db, refuse(), AppError::Validation(reason.into()))
                    .await);
            }
            // Reparenting a unit under one of its own descendants would create a
            // cycle (A → B → A): the tree would stop being a tree, and every
            // recursive traversal would only be saved by its depth guard. Refuse
            // before writing.
            let cycle_sql = format!(
                "SELECT EXISTS (SELECT 1 FROM {} d WHERE d.id = $2)",
                crate::database::compat::org_unit_descendants(1)
            );
            let creates_cycle: bool = tx
                .fetch_optional_scalar::<bool>(&cycle_sql, params![id, new_parent])
                .await
                .map_err(|e| { tracing::error!(error = %e, "update_org_unit cycle check"); AppError::Database(e) })?
                .unwrap_or(false);

            if creates_cycle {
                let reason =
                    "Parent invalide : cette unité fait partie du sous-arbre de l'unité déplacée (cycle)";
                return Err(tx
                    .abort(&state.db, refuse(), AppError::Validation(reason.into()))
                    .await);
            }

            // A move carries the whole subtree with it, so the ceiling applies
            // to its deepest leaf - not to the unit being dragged.
            let Some(parent_depth) = unit_depth(&mut tx, new_parent).await? else {
                let reason = format!("Unité parente {new_parent} introuvable");
                return Err(tx
                    .abort(&state.db, refuse(), AppError::Validation(reason))
                    .await);
            };
            let height = subtree_height(&mut tx, id).await?;
            if let Err(e) = check_depth(parent_depth, height) {
                return Err(tx.abort(&state.db, refuse(), e).await);
            }
        }
        None => {}
    }

    // `COALESCE` cannot express "set this to NULL": the flags do. `$2` / `$4`
    // say whether the field was present at all, `$3` / `$5` carry the value -
    // which may legitimately be NULL. The row was locked above (`previous`), so
    // it certainly still exists: the resulting row is composed in Rust rather
    // than read back through a portable `RETURNING` we do not have.
    let backend = state.db.backend();
    let update_sql = format!(
        "UPDATE core.org_units \
            SET name        = COALESCE($1, name), \
                parent_id   = CASE WHEN $2 THEN {parent_cast} ELSE parent_id END, \
                description = CASE WHEN $4 THEN {desc_cast} ELSE description END \
          WHERE id = $6",
        parent_cast = backend.cast("$3", SqlType::Uuid),
        desc_cast = backend.cast("$5", SqlType::Text),
    );
    if let Err(e) = tx
        .execute(
            &update_sql,
            params![
                name,
                dto.parent_id.is_some(),
                dto.parent_id.flatten(),
                description.is_some(),
                description.flatten(),
                id,
            ],
        )
        .await
    {
        let attempted = name.unwrap_or(previous.name.as_str());
        let err = map_write_error(e, attempted, "update_org_unit");
        return Err(tx.abort(&state.db, refuse(), err).await);
    }

    let unit = OrgUnit {
        id,
        name:        name.map(str::to_string).unwrap_or_else(|| previous.name.clone()),
        parent_id:   if dto.parent_id.is_some() {
            dto.parent_id.flatten()
        } else {
            previous.parent_id
        },
        description: if description.is_some() {
            description.flatten().map(str::to_string)
        } else {
            previous.description.clone()
        },
    };

    // A move shows up in the diff as `parent_id` before → after: same entry,
    // no separate action to look for when reading the trail.
    tx.commit(
        AuditEntry::new("core.org_units.update")
            .target(target::ORG_UNIT, unit.id, unit.name.clone())
            .before(snap(target::ORG_UNIT, &previous))
            .after(snap(target::ORG_UNIT, &unit))
            .reversible(),
    )
    .await?;

    // A rename cannot move anything, but a move rewrites whole subtrees; the
    // cache cannot tell the two apart from here and the write is rare enough
    // that distinguishing them would only buy a bug.
    invalidate_authz_cache();

    Ok(Json(json!({ "org_unit": unit })))
}

// ── Deleting ─────────────────────────────────────────────────────────────────

pub async fn delete_org_unit(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_manage(&ctx)?;
    let mut tx = audit.begin(&state.db).await?;

    let for_update = tx.backend().for_update();
    let unit_row = tx
        .fetch_optional_row(
            &format!(
                "SELECT id, name, parent_id, description FROM core.org_units WHERE id = $1{}",
                for_update
            ),
            params![id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_org_unit: read"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("Unité {id}")))?;
    let unit = OrgUnit {
        id:          unit_row.try_get("id")?,
        name:        unit_row.try_get("name")?,
        parent_id:   unit_row.try_get("parent_id")?,
        description: unit_row.try_get("description")?,
    };

    // The root unit (parent_id IS NULL) cannot be deleted - there is nowhere to
    // lift its children and members to. Since creation now requires a parent and
    // no update may promote a unit to root, the only row this can ever refuse is
    // the organisation itself, never an accidental second root. The refusal is
    // journalled like any other attempt.
    let Some(parent_id) = unit.parent_id else {
        let reason = "Impossible de supprimer l'unité racine";
        return Err(tx
            .abort(
                &state.db,
                AuditEntry::new("core.org_units.delete")
                    .target(target::ORG_UNIT, id, unit.name.clone())
                    .before(snap(target::ORG_UNIT, &unit)),
                AppError::Validation(reason.into()),
            )
            .await);
    };

    // Everything the row takes with it, counted while it still exists and while
    // the row is locked. Read *before* the writes below because reparenting the
    // children changes two of these numbers, and the audit entry has to describe
    // what was destroyed, not what survived.
    // Read as a row and mapped by hand: a `DbTx` reads rows, not structs.
    let impact_sql = impact_counts_sql(tx.backend());
    let impact_row = tx
        .fetch_optional_row(&impact_sql, params![id, id, id, id, id, id])
        .await
        .map_err(|e| { tracing::error!(error = %e, %id, "delete_org_unit: count"); AppError::Database(e) })?
        .ok_or_else(|| AppError::NotFound(format!("Unité {id}")))?;
    let impact = DeletionImpact {
        children:          impact_row.try_get("children")?,
        descendants:       impact_row.try_get("descendants")?,
        users:             impact_row.try_get("users")?,
        role_assignments:  impact_row.try_get("role_assignments")?,
        audience_policies: impact_row.try_get("audience_policies")?,
        setting_overrides: impact_row.try_get("setting_overrides")?,
    };

    // Reparent children and move users up to the parent, then delete - the
    // three writes and the audit entry land in the same commit.
    //
    // Lifting a child up can collide with an existing sister of the same name
    // (unique index of migration 000106). That is a 409 the caller can act on,
    // not a 500: `GET /org-units/:id/impact` tells them how many children are
    // about to move.
    let children = match tx
        .execute(
            "UPDATE core.org_units SET parent_id = $1 WHERE parent_id = $2",
            params![parent_id, id],
        )
        .await
    {
        Ok(done) => done,
        Err(e) => {
            let err = if matches!(&e, sqlx::Error::Database(db) if db.is_unique_violation()) {
                AppError::Conflict(
                    "Suppression impossible : une sous-unité porterait le même nom qu'une unité déjà présente sous le parent. Renommez-la d'abord."
                        .into(),
                )
            } else {
                tracing::error!(error = %e, "delete_org_unit: réaffectation des sous-unités");
                AppError::from(e)
            };
            return Err(tx
                .abort(
                    &state.db,
                    AuditEntry::new("core.org_units.delete")
                        .target(target::ORG_UNIT, id, unit.name.clone())
                        .before(snap(target::ORG_UNIT, &unit)),
                    err,
                )
                .await);
        }
    };
    let members = tx
        .execute(
            "UPDATE core.users SET org_unit_id = $1 WHERE org_unit_id = $2",
            params![parent_id, id],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_org_unit: reassigning accounts"); AppError::Database(e) })?;
    // Purge the unit's own setting overrides - the `setting_values_purge_scope`
    // trigger does this on PostgreSQL; the helper is a no-op there.
    crate::settings::store::purge_setting_values_for_scope(&mut tx, "org_unit", id)
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_org_unit: purge des réglages d'unité"); AppError::Database(e) })?;
    tx.execute("DELETE FROM core.org_units WHERE id = $1", params![id])
        .await
        .map_err(|e| { tracing::error!(error = %e, "delete_org_unit"); AppError::Database(e) })?;

    // The entry says everything the deletion did, split the way an auditor needs
    // to read it: what merely moved, and what no longer exists.
    //
    // It is deliberately **not** `.reversible()`. It used to be, and that was a
    // false promise: replaying the `before` snapshot backwards re-inserts one
    // row and nothing else. The delegations cascaded away by
    // `core.role_assignments` (000044), the rollout policies cascaded away by
    // `core.target_audience_policies` (000105) and the setting overrides purged
    // by the 000060 trigger are gone with no snapshot anywhere, and the children
    // and accounts lifted into the parent would stay there. Marking the entry
    // reversible offered an "undo" that would have restored an empty shell and
    // told the operator the tree was back.
    tx.commit(
        AuditEntry::new("core.org_units.delete")
            .target(target::ORG_UNIT, id, unit.name.clone())
            .before(snap(target::ORG_UNIT, &unit))
            .detail(format!(
                "Remontés au parent : {children} sous-unité(s), {members} compte(s). \
                 Détruits sans retour : {} délégation(s) portant sur l'unité, \
                 {} règle(s) de déploiement, {} réglage(s) spécifiques à l'unité",
                impact.role_assignments, impact.audience_policies, impact.setting_overrides
            )),
    )
    .await?;

    // The cascade removed assignments, and the lifted children moved between
    // subtrees: every cached context describing either is now wrong.
    invalidate_authz_cache();

    Ok(Json(json!({
        "message":           "Unité supprimée",
        // Echoed back so a caller that skipped `/impact` still learns what it
        // did - the same numbers, in the same names.
        "children":          impact.children,
        "users":             impact.users,
        "role_assignments":  impact.role_assignments,
        "audience_policies": impact.audience_policies,
        "setting_overrides": impact.setting_overrides,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_trimmed_and_an_empty_one_refused() {
        assert_eq!(clean_name("  Équipe support  ").ok(), Some("Équipe support"));
        assert!(clean_name("   ").is_err());
        assert!(clean_name("").is_err());
    }

    /// The limit counts characters, not bytes: 255 accented letters fit in the
    /// column and a byte check would reject them.
    #[test]
    fn the_name_limit_counts_characters_not_bytes() {
        let full = "é".repeat(MAX_NAME_CHARS);
        assert_eq!(full.len(), MAX_NAME_CHARS * 2, "prérequis : 2 octets par é");
        assert!(clean_name(&full).is_ok());
        assert!(clean_name(&"é".repeat(MAX_NAME_CHARS + 1)).is_err());
    }

    #[test]
    fn a_new_leaf_sits_one_level_below_its_parent() {
        assert_eq!(resulting_depth(0, 0), 1);
        assert_eq!(resulting_depth(7, 0), 8);
    }

    /// The whole moved subtree counts, not just the unit being dragged: moving a
    /// three-level branch under a unit at depth 10 lands its deepest leaf at 14.
    #[test]
    fn a_move_accounts_for_the_height_of_the_subtree() {
        assert_eq!(resulting_depth(10, 3), 14);
    }

    #[test]
    fn the_ceiling_is_reachable_but_not_exceeded() {
        // Deepest legal parent: its child lands exactly on the ceiling.
        assert!(check_depth(MAX_ORG_UNIT_DEPTH - 1, 0).is_ok());
        assert!(check_depth(MAX_ORG_UNIT_DEPTH, 0).is_err());
        // A subtree that would overshoot is refused even though its own root
        // would fit.
        assert!(check_depth(MAX_ORG_UNIT_DEPTH - 2, 0).is_ok());
        assert!(check_depth(MAX_ORG_UNIT_DEPTH - 2, 2).is_err());
    }

    /// The message must name both the ceiling and what the request asked for -
    /// "too deep" alone leaves an administrator guessing.
    #[test]
    fn the_refusal_states_the_ceiling_and_the_attempted_depth() {
        let Err(AppError::Validation(msg)) = check_depth(MAX_ORG_UNIT_DEPTH, 4) else {
            panic!("une profondeur de 40 doit être refusée");
        };
        assert!(msg.contains("35"), "message sans le plafond : {msg}");
        assert!(msg.contains("40"), "message sans la profondeur demandée : {msg}");
    }

    /// `core.setting_chain` ranks ancestors with `200 + (64 - LEAST(depth, 64))`.
    /// Two distinct depths must yield two distinct ranks, otherwise "the closest
    /// unit wins" is decided by the planner. This test is what pins the ceiling
    /// to that arithmetic rather than to taste.
    #[test]
    fn every_legal_depth_keeps_a_distinct_setting_specificity() {
        let specificity = |depth: i32| 200 + (64 - depth.min(64));
        let ranks: std::collections::HashSet<i32> =
            (0..=MAX_ORG_UNIT_DEPTH).map(specificity).collect();
        assert_eq!(ranks.len() as i32, MAX_ORG_UNIT_DEPTH + 1);
        const { assert!(MAX_ORG_UNIT_DEPTH < 64, "le plafond doit rester sous la falaise de 000060") };
    }

    /// The portable walker's depth guard must let a violation be *seen*:
    /// stopping at the ceiling would report the ceiling and accept the write.
    #[test]
    fn the_walk_limit_sees_one_level_past_the_ceiling() {
        const {
            assert!(
                crate::database::compat::MAX_TREE_DEPTH > MAX_ORG_UNIT_DEPTH,
                "le garde-fou de la marche doit dépasser le plafond pour voir une violation"
            )
        };
    }

    // ── The double option, which is the whole point of the update DTO ────────

    #[test]
    fn an_absent_description_is_not_a_null_one() {
        let absent: UpdateOrgUnitDto = serde_json::from_str(r#"{"name":"X"}"#)
            .expect("JSON valide");
        assert!(absent.description.is_none(), "champ absent = ne pas toucher");

        let cleared: UpdateOrgUnitDto = serde_json::from_str(r#"{"description":null}"#)
            .expect("JSON valide");
        assert_eq!(cleared.description, Some(None), "null = effacer");

        let set: UpdateOrgUnitDto = serde_json::from_str(r#"{"description":"Niveau 1"}"#)
            .expect("JSON valide");
        assert_eq!(set.description, Some(Some("Niveau 1".to_string())));
    }

    #[test]
    fn a_null_parent_is_distinguishable_from_an_untouched_one() {
        let absent: UpdateOrgUnitDto = serde_json::from_str(r#"{"name":"X"}"#)
            .expect("JSON valide");
        assert!(absent.parent_id.is_none());

        let promoted: UpdateOrgUnitDto = serde_json::from_str(r#"{"parent_id":null}"#)
            .expect("JSON valide");
        assert_eq!(promoted.parent_id, Some(None), "null = promotion en racine, à refuser");
    }
}
