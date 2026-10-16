//! The caller's administrative context: what they hold, and over what.
//!
//! Resolved **once per HTTP request** by the `/admin/*` layer guard (see
//! [`super::guard`]) and handed to the handlers through the request extensions.
//! A handler therefore never issues a second authorisation query.
//!
//! ## Scopes are pre-resolved
//!
//! An assignment scoped to an organisational unit covers that unit **and its
//! whole subtree**. Expanding the subtree at check time would mean a recursive
//! query per privilege test; instead the resolution query expands it once, using
//! the `core.org_unit_descendants` function shipped with migration `000041`
//! (depth-guarded - a cycle in the tree truncates the walk instead of hanging
//! the backend). What lands in [`PrivilegeScope::units`] is the flat set of unit
//! ids the caller may act on.
//!
//! ## The default is "no"
//!
//! [`AdminContext::allows_unit`] answers `false` for a target with **no**
//! organisational unit unless the privilege is held at instance scope. An
//! account outside the tree is not "in every subtree"; treating it as such would
//! make every delegated administrator an instance administrator for exactly the
//! accounts nobody bothered to place.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

use super::model::AssignmentScope;
use crate::audit::ActorOrigin;
use crate::errors::AppError;

/// Where one privilege is held.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrivilegeScope {
    /// Held over the whole instance.
    pub instance: bool,
    /// Organisational units, subtrees already expanded.
    pub units: HashSet<Uuid>,
}

impl PrivilegeScope {
    /// True when the privilege covers `unit`.
    ///
    /// `None` (an account attached to no unit) is covered by instance scope
    /// only - see the module note on why that default is not negotiable.
    pub fn covers(&self, unit: Option<Uuid>) -> bool {
        if self.instance {
            return true;
        }
        match unit {
            Some(id) => self.units.contains(&id),
            None => false,
        }
    }
}

/// Everything the authorisation layer knows about the caller.
#[derive(Debug, Clone)]
pub struct AdminContext {
    pub user_id: Uuid,
    /// Holds every privilege implicitly, present and future.
    pub is_superuser: bool,
    /// How the caller authenticated (browser session, personal API token…).
    pub origin: ActorOrigin,
    /// `core.api_tokens.id` when `origin == ApiToken`. Never the token itself.
    pub token_id: Option<Uuid>,
    /// The caller's own organisational unit, for "no scope broader than yours".
    pub org_unit_id: Option<Uuid>,
    /// Explicitly granted privileges, keyed by privilege key.
    pub privileges: HashMap<String, PrivilegeScope>,
    /// Keys the **credential** may never exercise, whatever the subject holds.
    ///
    /// Populated by [`crate::auth::token_scope::narrow`] when the caller
    /// presented a personal API token. A deny-list rather than a removal from
    /// `privileges` because a super-user holds privileges implicitly: there is
    /// no entry to take away, so "everything except these three" can only be
    /// expressed by naming the three.
    pub denied: HashSet<String>,
}

impl AdminContext {
    /// A context holding nothing at all - an ordinary user.
    pub fn empty(user_id: Uuid, origin: ActorOrigin, token_id: Option<Uuid>) -> Self {
        Self {
            user_id,
            is_superuser: false,
            origin,
            token_id,
            org_unit_id: None,
            privileges: HashMap::new(),
            denied: HashSet::new(),
        }
    }

    /// True when the caller may enter the administration surface at all.
    ///
    /// This is what the `/admin/*` layer enforces: "at least an administrator".
    /// The per-handler privilege check is what narrows it down.
    pub fn is_admin(&self) -> bool {
        self.is_superuser || !self.privileges.is_empty()
    }

    /// Does the caller hold `key` anywhere?
    pub fn has(&self, key: &str) -> bool {
        !self.denied.contains(key) && (self.is_superuser || self.privileges.contains_key(key))
    }

    /// Does the caller hold `key` over the whole instance?
    pub fn has_at_instance(&self, key: &str) -> bool {
        !self.denied.contains(key)
            && (self.is_superuser
                || self.privileges.get(key).map(|s| s.instance).unwrap_or(false))
    }

    /// Does the caller hold `key` over `unit` (the target's organisational unit)?
    pub fn has_for_unit(&self, key: &str, unit: Option<Uuid>) -> bool {
        !self.denied.contains(key)
            && (self.is_superuser
                || self
                    .privileges
                    .get(key)
                    .map(|s| s.covers(unit))
                    .unwrap_or(false))
    }

    /// Does the caller hold `key` over `scope`?
    pub fn has_for_scope(
        &self,
        key: &str,
        scope: AssignmentScope,
        unit: Option<Uuid>,
    ) -> bool {
        match scope {
            AssignmentScope::Instance => self.has_at_instance(key),
            AssignmentScope::OrgUnit => self.has_for_unit(key, unit),
        }
    }

    /// `Ok` when the caller holds `key` anywhere, `Forbidden` otherwise.
    pub fn require(&self, key: &str) -> Result<(), AppError> {
        if self.has(key) {
            return Ok(());
        }
        tracing::warn!(
            user_id = %self.user_id,
            privilege = %key,
            "Privilège requis absent : appel refusé"
        );
        Err(AppError::Forbidden)
    }

    /// `Ok` when the caller holds `key` over the whole instance.
    pub fn require_instance(&self, key: &str) -> Result<(), AppError> {
        if self.has_at_instance(key) {
            return Ok(());
        }
        tracing::warn!(
            user_id = %self.user_id,
            privilege = %key,
            "Privilège requis à portée instance absent : appel refusé"
        );
        Err(AppError::Forbidden)
    }

    /// `Ok` when the caller holds `key` over the unit `unit`.
    pub fn require_for_unit(&self, key: &str, unit: Option<Uuid>) -> Result<(), AppError> {
        if self.has_for_unit(key, unit) {
            return Ok(());
        }
        tracing::warn!(
            user_id = %self.user_id,
            privilege = %key,
            target_org_unit = ?unit,
            "Cible hors du périmètre de l'appelant : appel refusé"
        );
        Err(AppError::Forbidden)
    }

    /// `Ok` only for a super-user. Used by the operations that grant power or
    /// run arbitrary code.
    ///
    /// A personal API token is refused outright, whatever its owner holds. These
    /// are precisely the operations reserved to a person - granting a role,
    /// installing a module, approving a theme - and a bearer has no second factor
    /// and nobody at the keyboard to answer a challenge. A *scoped* token has
    /// already lost the flag through the intersection; this closes the same door
    /// for a **legacy** token, which keeps its owner's flag during the grace
    /// window and would otherwise walk straight through.
    pub fn require_superuser(&self, what: &str) -> Result<(), AppError> {
        if self.origin == ActorOrigin::ApiToken {
            tracing::warn!(
                user_id = %self.user_id,
                token_id = ?self.token_id,
                operation = %what,
                "Opération réservée à une personne : un jeton d'API ne peut pas la réaliser"
            );
            return Err(AppError::ReauthImpossible);
        }
        if self.is_superuser {
            return Ok(());
        }
        tracing::warn!(
            user_id = %self.user_id,
            operation = %what,
            "Opération réservée aux super-utilisateurs : appel refusé"
        );
        Err(AppError::Forbidden)
    }

    /// The organisational subtree a listing must be confined to for `key`.
    ///
    /// `None` means "no restriction" (instance scope or superuser). `Some(set)`
    /// is the exact set of unit ids to filter on - never empty, because a caller
    /// with an empty set does not hold the privilege at all.
    pub fn subtree_filter(&self, key: &str) -> Option<Vec<Uuid>> {
        // A denied key is not held at all: the listing must match nothing rather
        // than fall through to "no restriction" below.
        if self.denied.contains(key) {
            return Some(Vec::new());
        }
        if self.is_superuser {
            return None;
        }
        match self.privileges.get(key) {
            Some(scope) if scope.instance => None,
            Some(scope) => Some(scope.units.iter().copied().collect()),
            // No privilege at all: an empty filter matches nothing, which is the
            // right answer for a caller that should not be listing anything.
            None => Some(Vec::new()),
        }
    }

    /// The wire form of this context: what the holder may exercise, scopes
    /// resolved.
    ///
    /// Used both by `GET /api/v1/me` (the caller looking at themselves, which
    /// needs no privilege) and by `GET /admin/users/:id/privileges` (an operator
    /// looking at someone else). One shape for both so a console reading the
    /// first cannot drift from an operator reading the second.
    ///
    /// [`denied`](Self::denied) travels with the rest on purpose: a legacy API
    /// token keeps its owner's super-user flag while it may still read, and the
    /// only thing that says "not this key" is the deny-list. Dropping it here
    /// would put actions in the interface that the server refuses.
    pub fn effective(&self) -> EffectivePrivileges {
        let mut privileges: Vec<EffectivePrivilege> = self
            .privileges
            .iter()
            .map(|(key, scope)| EffectivePrivilege {
                key: key.clone(),
                instance: scope.instance,
                org_units: scope.units.iter().copied().collect(),
            })
            .collect();
        privileges.sort_by(|a, b| a.key.cmp(&b.key));

        let mut denied: Vec<String> = self.denied.iter().cloned().collect();
        denied.sort();

        EffectivePrivileges {
            user_id: self.user_id,
            is_superuser: self.is_superuser,
            is_admin: self.is_admin(),
            org_unit_id: self.org_unit_id,
            privileges,
            denied,
        }
    }
}

/// One privilege and the scope it is held over, subtrees already expanded.
#[derive(Debug, Serialize)]
pub struct EffectivePrivilege {
    pub key: String,
    pub instance: bool,
    pub org_units: Vec<Uuid>,
}

/// What an account effectively holds, as the API returns it.
#[derive(Debug, Serialize)]
pub struct EffectivePrivileges {
    pub user_id: Uuid,
    pub is_superuser: bool,
    /// May enter the administration surface at all.
    pub is_admin: bool,
    pub org_unit_id: Option<Uuid>,
    pub privileges: Vec<EffectivePrivilege>,
    /// Keys the presented credential may never exercise, whatever is above.
    pub denied: Vec<String>,
}

/// Above this many holders the roster is not kept: see [`cache::Roster::Unbounded`].
///
/// An instance has a handful of administrators; the only way to reach this number
/// is an assignment carried by a group that half the company belongs to, and in
/// that case a process-global set of every member is the wrong thing to hold in
/// memory. Falling back to the plain resolution is always correct - it is what
/// happened before this fast path existed.
///
/// [`cache::Roster::Unbounded`]: super::cache::Roster::Unbounded
const MAX_HOLDERS: usize = 4096;

/// Does `user_id` hold any assignment at all?
///
/// Answered from the process-global roster, which costs one query per instance
/// per TTL rather than one per caller. A `false` here means the caller's context
/// is empty and needs no resolution - the fast path `/me` relies on.
pub async fn holds_any_assignment(db: &DbPool, user_id: Uuid) -> Result<bool, AppError> {
    use super::cache::Roster;

    let roster = match super::cache::get_roster() {
        Some(r) => r,
        None => {
            let loaded = load_roster(db).await?;
            super::cache::put_roster(loaded.clone());
            loaded
        }
    };

    Ok(match roster {
        Roster::Holders(set) => set.contains(&user_id),
        // Unknown: answer "yes" so the caller is resolved properly. The fast path
        // may only ever skip work it can prove is unnecessary.
        Roster::Unbounded => true,
    })
}

/// Loads the set of accounts holding at least one live assignment.
async fn load_roster(db: &DbPool) -> Result<super::cache::Roster, AppError> {
    use super::cache::Roster;

    // `NOW()` is spelled per engine by the dialect layer (structural text, not a
    // bind), so no engine-specific date function is hard-coded.
    let now = db.backend().now();
    // One row over the cap is enough to know the cap is exceeded.
    let sql = format!(
        "SELECT a.subject_user_id \
          FROM core.role_assignments a \
         WHERE a.subject_user_id IS NOT NULL \
           AND (a.expires_at IS NULL OR a.expires_at > {now}) \
        UNION \
        SELECT m.user_id \
          FROM core.role_assignments a \
          JOIN core.user_group_members m ON m.group_id = a.subject_group_id \
         WHERE (a.expires_at IS NULL OR a.expires_at > {now}) \
         LIMIT $1"
    );
    let rows: Vec<Uuid> = db
        .fetch_all_as::<HolderRow>(&sql, params![MAX_HOLDERS as i64 + 1])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "authz: chargement du registre des détenteurs d'affectation");
            AppError::Database(e)
        })?
        .into_iter()
        .map(|r| r.subject_user_id)
        .collect();

    if rows.len() > MAX_HOLDERS {
        tracing::warn!(
            holders = rows.len(),
            "authz: trop de détenteurs d'affectation, la voie rapide de /me est désactivée"
        );
        return Ok(Roster::Unbounded);
    }

    Ok(Roster::Holders(Arc::new(rows.into_iter().collect())))
}

/// Resolves the caller's whole administrative context in **one** query.
///
/// Direct assignments ∪ assignments carried by the caller's groups, expiry
/// filtered out, org-unit subtrees expanded. The superuser flag rides along as a
/// marker row rather than a second statement.
pub async fn resolve(
    db: &DbPool,
    user_id: Uuid,
    origin: ActorOrigin,
    token_id: Option<Uuid>,
) -> Result<AdminContext, AppError> {
    // Rebuilt as a few portable steps rather than one PostgreSQL query: the
    // original expanded each grant's org-unit subtree through
    // `LEFT JOIN LATERAL core.org_unit_descendants(...)`, and neither the
    // set-returning function nor `LATERAL` exists on MySQL/SQLite. The subtree
    // expansion now runs through the portable multi-root recursive CTE of
    // `database::compat`, and the privilege/superuser rows through plain joins.
    let now = db.backend().now();
    let fail = |e: sqlx::Error| {
        tracing::error!(error = %e, user_id = %user_id, "authz: résolution des privilèges effectifs");
        AppError::Database(e)
    };

    let mut ctx = AdminContext::empty(user_id, origin, token_id);

    // The caller's own unit, needed by scope comparisons even with no grant.
    ctx.org_unit_id = db
        .fetch_optional_scalar::<Option<Uuid>>(
            "SELECT org_unit_id FROM core.users WHERE id = $1",
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "authz: lecture de l'unité de l'appelant");
            AppError::Database(e)
        })?
        .flatten();

    // The caller's non-expired assignments - direct or carried by a group -
    // joined to the privilege keys of each assignment's role. `$1`/`$2` are both
    // the caller (a positional placeholder is never reused across engines).
    let mine_cte = format!(
        "WITH mine AS ( \
            SELECT a.role_id, a.scope, a.scope_org_unit_id \
              FROM core.role_assignments a \
             WHERE (a.expires_at IS NULL OR a.expires_at > {now}) \
               AND ( a.subject_user_id = $1 \
                  OR a.subject_group_id IN ( \
                        SELECT m.group_id FROM core.user_group_members m WHERE m.user_id = $2 ) ) \
        ) "
    );
    let priv_sql = format!(
        "{mine_cte} SELECT rp.privilege_key, mine.scope, mine.scope_org_unit_id \
           FROM mine JOIN core.role_privileges rp ON rp.role_id = mine.role_id"
    );
    let priv_rows: Vec<PrivilegeRow> = db
        .fetch_all_as::<PrivilegeRow>(&priv_sql, params![user_id, user_id])
        .await
        .map_err(fail)?;

    // A super-user role only counts at instance scope: confining "holds
    // everything" to a subtree is meaningless and would be a trap.
    let su_sql = format!(
        "{mine_cte} SELECT DISTINCT mine.scope \
           FROM mine JOIN core.roles r ON r.id = mine.role_id WHERE r.is_superuser"
    );
    let su_scopes: Vec<(String,)> = db
        .fetch_all_as::<(String,)>(&su_sql, params![user_id, user_id])
        .await
        .map_err(fail)?;
    for (scope,) in su_scopes {
        if scope == AssignmentScope::Instance.as_str() {
            ctx.is_superuser = true;
        }
    }

    // Expand the subtree of every unit a scoped grant covers, in one recursive
    // walk, then map each descendant back to the grant's root unit.
    let roots: Vec<Uuid> = priv_rows
        .iter()
        .filter(|r| r.scope != AssignmentScope::Instance.as_str())
        .filter_map(|r| r.scope_org_unit_id)
        .collect::<HashSet<Uuid>>()
        .into_iter()
        .collect();
    let mut subtree: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    if !roots.is_empty() {
        let sql = format!(
            "SELECT root, id FROM {} w",
            crate::database::compat::org_unit_descendants_with_root(1, roots.len())
        );
        let binds: Vec<kubuno_db::DbValue> = roots.iter().map(|u| (*u).into()).collect();
        let pairs: Vec<(Uuid, Uuid)> =
            db.fetch_all_as::<(Uuid, Uuid)>(&sql, binds).await.map_err(fail)?;
        for (root, id) in pairs {
            subtree.entry(root).or_default().push(id);
        }
    }

    for r in priv_rows {
        let entry = ctx.privileges.entry(r.privilege_key).or_default();
        if r.scope == AssignmentScope::Instance.as_str() {
            entry.instance = true;
        } else if let Some(root) = r.scope_org_unit_id {
            // The walk includes the root itself at depth 0, so the grant's own
            // unit and every descendant are covered.
            if let Some(ids) = subtree.get(&root) {
                for id in ids {
                    entry.units.insert(*id);
                }
            }
        }
    }

    Ok(ctx)
}

/// One holder id from the roster query.
#[derive(sqlx::FromRow)]
struct HolderRow {
    subject_user_id: Uuid,
}

/// One row of a role's privilege granted to the caller: the key, the assignment
/// scope, and the org unit the grant is scoped to (`NULL` at instance scope).
#[derive(sqlx::FromRow)]
struct PrivilegeRow {
    privilege_key:    String,
    scope:            String,
    scope_org_unit_id: Option<Uuid>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_with(key: &str, scope: PrivilegeScope) -> AdminContext {
        let mut ctx = AdminContext::empty(Uuid::nil(), ActorOrigin::Session, None);
        ctx.privileges.insert(key.to_string(), scope);
        ctx
    }

    #[test]
    fn an_unplaced_account_is_only_reachable_at_instance_scope() {
        let unit = Uuid::new_v4();
        let scoped = ctx_with(
            "core.users.update",
            PrivilegeScope { instance: false, units: HashSet::from([unit]) },
        );
        // In the subtree: yes.
        assert!(scoped.has_for_unit("core.users.update", Some(unit)));
        // Outside it: no.
        assert!(!scoped.has_for_unit("core.users.update", Some(Uuid::new_v4())));
        // No unit at all: NO. This is the default that must never flip.
        assert!(!scoped.has_for_unit("core.users.update", None));

        let instance = ctx_with(
            "core.users.update",
            PrivilegeScope { instance: true, ..Default::default() },
        );
        assert!(instance.has_for_unit("core.users.update", None));
    }

    #[test]
    fn a_superuser_holds_everything_including_keys_that_do_not_exist_yet() {
        let mut ctx = AdminContext::empty(Uuid::nil(), ActorOrigin::Session, None);
        ctx.is_superuser = true;
        assert!(ctx.has("core.users.read"));
        assert!(ctx.has("un.module.execute"));
        assert!(ctx.has_at_instance("core.roles.manage"));
        assert!(ctx.has_for_unit("core.users.delete", None));
        assert!(ctx.subtree_filter("core.users.read").is_none());
        assert!(ctx.is_admin());
    }

    #[test]
    fn holding_nothing_is_not_being_an_administrator() {
        let ctx = AdminContext::empty(Uuid::nil(), ActorOrigin::Session, None);
        assert!(!ctx.is_admin());
        assert!(!ctx.has("core.users.read"));
        assert!(ctx.require("core.users.read").is_err());
        // And a listing for a caller holding nothing matches nothing.
        assert_eq!(ctx.subtree_filter("core.users.read"), Some(Vec::new()));
    }

    #[test]
    fn a_scoped_privilege_confines_a_listing_but_an_instance_one_does_not() {
        let unit = Uuid::new_v4();
        let scoped = ctx_with(
            "core.users.read",
            PrivilegeScope { instance: false, units: HashSet::from([unit]) },
        );
        assert_eq!(scoped.subtree_filter("core.users.read"), Some(vec![unit]));

        let instance = ctx_with(
            "core.users.read",
            PrivilegeScope { instance: true, ..Default::default() },
        );
        assert_eq!(instance.subtree_filter("core.users.read"), None);
    }

    #[test]
    fn a_scoped_holder_cannot_act_at_instance_scope() {
        let unit = Uuid::new_v4();
        let scoped = ctx_with(
            "core.users.read",
            PrivilegeScope { instance: false, units: HashSet::from([unit]) },
        );
        assert!(scoped.has("core.users.read"));
        assert!(!scoped.has_at_instance("core.users.read"));
        assert!(scoped.require_instance("core.users.read").is_err());
        assert!(scoped
            .has_for_scope("core.users.read", AssignmentScope::OrgUnit, Some(unit)));
        assert!(!scoped
            .has_for_scope("core.users.read", AssignmentScope::Instance, None));
    }
}
