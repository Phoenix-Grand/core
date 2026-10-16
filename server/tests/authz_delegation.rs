//! Delegated administration, against a real PostgreSQL (see `common`).
//!
//! Covers the things that are only true if they are enforced: the scopability
//! rule, the five anti-escalation guards, resolution through groups, subtree
//! filtering of listings, expiry, and cache invalidation.

mod common;

use std::collections::HashSet;

use kubuno_core::audit::ActorOrigin;
use kubuno_core::authz::{
    cache,
    context::{self, AdminContext},
    guards,
    model::AssignmentScope,
};
use kubuno_db::{params, DbPool, DbQueryBuilder};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct IdRow {
    id: Uuid,
}

#[derive(sqlx::FromRow)]
struct KeyRow {
    key: String,
}

#[derive(sqlx::FromRow)]
struct PrivKeyRow {
    privilege_key: String,
}

#[derive(sqlx::FromRow)]
struct SystemRoleRow {
    slug: String,
    is_superuser: bool,
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// Everything a test creates is namespaced by this suffix so parallel runs - and
/// leftovers from a previous run - never collide.
fn tag() -> String {
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

async fn make_unit(db: &DbPool, name: &str, parent: Option<Uuid>) -> Uuid {
    let id = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.org_units (id, name, parent_id) VALUES ($1, $2, $3)",
        params![id, name, parent],
    )
    .await
    .expect("création d'unité");
    id
}

async fn make_user(db: &DbPool, tag: &str, who: &str, unit: Option<Uuid>) -> Uuid {
    let id = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.users (id, email, username, password_hash, role, org_unit_id) \
         VALUES ($1, $2, $3, 'x', 'user', $4)",
        params![id, format!("{who}.{tag}@test.local"), format!("{who}_{tag}"), unit],
    )
    .await
    .expect("création d'utilisateur");
    id
}

async fn make_role(db: &DbPool, tag: &str, slug: &str, privileges: &[&str]) -> Uuid {
    let id = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.roles (id, slug, name) VALUES ($1, $2, $3)",
        params![id, format!("{slug}-{tag}"), slug],
    )
    .await
    .expect("création de rôle");
    for key in privileges {
        db.execute(
            "INSERT INTO core.role_privileges (role_id, privilege_key) VALUES ($1, $2)",
            params![id, *key],
        )
        .await
        .expect("privilège du rôle");
    }
    id
}

async fn assign(
    db: &DbPool,
    role: Uuid,
    user: Option<Uuid>,
    group: Option<Uuid>,
    scope: AssignmentScope,
    unit: Option<Uuid>,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
) -> Uuid {
    let id = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.role_assignments \
             (id, role_id, subject_user_id, subject_group_id, scope, scope_org_unit_id, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        params![id, role, user, group, scope.as_str(), unit, expires_at],
    )
    .await
    .expect("affectation");
    id
}

async fn resolve(db: &DbPool, user: Uuid) -> AdminContext {
    context::resolve(db, user, ActorOrigin::Session, None)
        .await
        .expect("résolution")
}

/// Removes everything a test created, in dependency order.
async fn cleanup(db: &DbPool, tag: &str) {
    let _ = db
        .execute(
            "DELETE FROM core.role_assignments WHERE subject_user_id IN \
            (SELECT id FROM core.users WHERE username LIKE '%_' || $1)",
            params![tag],
        )
        .await;
    let _ = db
        .execute("DELETE FROM core.roles WHERE slug LIKE '%-' || $1", params![tag])
        .await;
    let _ = db
        .execute("DELETE FROM core.users WHERE username LIKE '%_' || $1", params![tag])
        .await;
    let _ = db
        .execute("DELETE FROM core.user_groups WHERE name LIKE 'grp-' || $1", params![tag])
        .await;
    let _ = db
        .execute("DELETE FROM core.org_units WHERE name LIKE 'ou-%-' || $1", params![tag])
        .await;
}

// ── The scopability rule ─────────────────────────────────────────────────────

#[tokio::test]
async fn a_role_mixing_scopable_and_non_scopable_privileges_cannot_be_scoped_to_a_unit() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();
    let unit = make_unit(&db, &format!("ou-root-{t}"), None).await;

    // All-scopable: delegable to a subtree.
    let clean = make_role(&db, &t, "clean", &["core.users.read", "core.users.update"]).await;
    // One non-scopable privilege is enough to poison the whole role.
    let mixed = make_role(
        &db,
        &t,
        "mixed",
        &["core.users.read", "core.settings.manage"],
    )
    .await;

    assert!(
        guards::ensure_scopable(&db, clean, AssignmentScope::OrgUnit)
            .await
            .is_ok(),
        "un rôle entièrement restreignable doit pouvoir être délégué sur une unité"
    );

    let refusal = guards::ensure_scopable(&db, mixed, AssignmentScope::OrgUnit)
        .await
        .expect_err("un rôle mixte doit être refusé sur une unité");
    let message = refusal.to_string();
    assert!(
        message.contains("core.settings.manage"),
        "le refus doit nommer le privilège fautif : {message}"
    );

    // The same mixed role is perfectly fine instance-wide: the rule is about the
    // scope being honest, not about the role being forbidden.
    assert!(
        guards::ensure_scopable(&db, mixed, AssignmentScope::Instance)
            .await
            .is_ok()
    );

    // And a superuser role is never confinable, whatever it contains.
    let super_role: Uuid = db
        .fetch_scalar::<Uuid>(
            "SELECT id FROM core.roles WHERE slug = 'super-admin'",
            params![],
        )
        .await
        .expect("rôle système semé");
    assert!(
        guards::ensure_scopable(&db, super_role, AssignmentScope::OrgUnit)
            .await
            .is_err()
    );

    let _ = unit;
    cleanup(&db, &t).await;
}

// ── Resolution ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn privileges_arrive_through_groups_and_subtrees_are_pre_expanded() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    // root ─┬─ branch ── leaf
    //       └─ sibling
    let root = make_unit(&db, &format!("ou-root-{t}"), None).await;
    let branch = make_unit(&db, &format!("ou-branch-{t}"), Some(root)).await;
    let leaf = make_unit(&db, &format!("ou-leaf-{t}"), Some(branch)).await;
    let sibling = make_unit(&db, &format!("ou-sibling-{t}"), Some(root)).await;

    let alice = make_user(&db, &t, "alice", Some(root)).await;
    let role = make_role(&db, &t, "readers", &["core.users.read"]).await;

    // Granted to a GROUP, not to Alice: the resolution has to find it anyway.
    let group = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.user_groups (id, name) VALUES ($1, $2)",
        params![group, format!("grp-{t}")],
    )
    .await
    .expect("groupe");
    db.execute(
        "INSERT INTO core.user_group_members (group_id, user_id) VALUES ($1, $2)",
        params![group, alice],
    )
    .await
    .expect("adhésion");

    assign(&db, role, None, Some(group), AssignmentScope::OrgUnit, Some(branch), None).await;

    let ctx = resolve(&db, alice).await;
    let scope = ctx
        .privileges
        .get("core.users.read")
        .expect("privilège hérité du groupe");

    assert!(!scope.instance, "une portée d'unité n'est pas une portée instance");
    let got: HashSet<Uuid> = scope.units.clone();
    assert!(got.contains(&branch), "l'unité elle-même");
    assert!(got.contains(&leaf), "le sous-arbre doit être pré-résolu");
    assert!(!got.contains(&root), "l'ancêtre n'est pas dans le sous-arbre");
    assert!(!got.contains(&sibling), "une branche voisine n'est pas couverte");

    // And the derived helpers agree.
    assert!(ctx.has_for_unit("core.users.read", Some(leaf)));
    assert!(!ctx.has_for_unit("core.users.read", Some(sibling)));
    assert!(!ctx.has_for_unit("core.users.read", None));
    assert!(!ctx.has_at_instance("core.users.read"));

    cleanup(&db, &t).await;
}

#[tokio::test]
async fn the_listing_filter_matches_the_subtree_and_nothing_else() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    let root = make_unit(&db, &format!("ou-root-{t}"), None).await;
    let branch = make_unit(&db, &format!("ou-branch-{t}"), Some(root)).await;
    let leaf = make_unit(&db, &format!("ou-leaf-{t}"), Some(branch)).await;
    let other = make_unit(&db, &format!("ou-other-{t}"), Some(root)).await;

    let boss = make_user(&db, &t, "boss", Some(root)).await;
    let inside = make_user(&db, &t, "inside", Some(branch)).await;
    let deep = make_user(&db, &t, "deep", Some(leaf)).await;
    let outside = make_user(&db, &t, "outside", Some(other)).await;
    let unplaced = make_user(&db, &t, "unplaced", None).await;

    let role = make_role(&db, &t, "readers", &["core.users.read"]).await;
    assign(&db, role, Some(boss), None, AssignmentScope::OrgUnit, Some(branch), None).await;

    let ctx = resolve(&db, boss).await;
    let filter = ctx
        .subtree_filter("core.users.read")
        .expect("un délégué doit être restreint");

    // The perimeter query `list_users` runs, in its engine-agnostic form: the
    // delegate is restricted, so `filter` is a non-empty subtree and the row is
    // kept only when its unit is one of those, and the account belongs to this
    // test run.
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        "SELECT id FROM core.users WHERE org_unit_id IS NOT NULL AND org_unit_id",
    );
    qb.push_in(filter.clone());
    qb.push(" AND username LIKE '%_' || ").push_bind(t.clone());
    let visible: HashSet<Uuid> = qb
        .fetch_all_as::<IdRow>(&db)
        .await
        .expect("listing filtré")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert!(visible.contains(&inside), "le compte de l'unité déléguée");
    assert!(visible.contains(&deep), "le compte d'une sous-unité");
    assert!(!visible.contains(&outside), "une branche voisine reste invisible");
    assert!(!visible.contains(&boss), "le délégué lui-même est hors sous-arbre");
    assert!(
        !visible.contains(&unplaced),
        "un compte sans unité n'est PAS dans tous les sous-arbres"
    );

    cleanup(&db, &t).await;
}

#[tokio::test]
async fn an_expired_assignment_grants_nothing() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    let unit = make_unit(&db, &format!("ou-root-{t}"), None).await;
    let temp = make_user(&db, &t, "temp", Some(unit)).await;
    let role = make_role(&db, &t, "readers", &["core.users.read"]).await;

    let past = chrono::Utc::now() - chrono::Duration::hours(1);
    let expired = assign(
        &db, role, Some(temp), None, AssignmentScope::OrgUnit, Some(unit), Some(past),
    )
    .await;

    let ctx = resolve(&db, temp).await;
    assert!(!ctx.is_admin(), "une délégation échue ne donne plus rien");
    assert!(!ctx.has("core.users.read"));

    // Pushed into the future, the very same row grants again.
    let future = chrono::Utc::now() + chrono::Duration::hours(1);
    db.execute(
        "UPDATE core.role_assignments SET expires_at = $1 WHERE id = $2",
        params![future, expired],
    )
    .await
    .expect("prolongation");

    let ctx = resolve(&db, temp).await;
    assert!(ctx.has("core.users.read"), "une délégation en cours donne le privilège");
    assert!(ctx.is_admin());

    cleanup(&db, &t).await;
}

// ── The five guards ──────────────────────────────────────────────────────────

#[tokio::test]
async fn guard_1_role_management_is_superuser_only() {
    let mut delegated = AdminContext::empty(Uuid::new_v4(), ActorOrigin::Session, None);
    delegated.privileges.insert(
        "core.roles.manage".into(),
        kubuno_core::authz::PrivilegeScope { instance: true, units: HashSet::new() },
    );
    // Holding `core.roles.manage` is NOT enough to define roles: whoever can
    // write a role can write themselves a role.
    assert!(guards::ensure_role_management(&delegated).is_err());

    let mut root = AdminContext::empty(Uuid::new_v4(), ActorOrigin::Session, None);
    root.is_superuser = true;
    assert!(guards::ensure_role_management(&root).is_ok());
}

#[tokio::test]
async fn guard_2_you_cannot_grant_what_you_do_not_hold() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    let root = make_unit(&db, &format!("ou-root-{t}"), None).await;
    let branch = make_unit(&db, &format!("ou-branch-{t}"), Some(root)).await;
    let elsewhere = make_unit(&db, &format!("ou-other-{t}"), Some(root)).await;

    let delegate = make_user(&db, &t, "delegate", Some(root)).await;
    // The delegate holds users.read + users.update over `branch` only.
    let held = make_role(&db, &t, "held", &["core.users.read", "core.users.update"]).await;
    assign(&db, held, Some(delegate), None, AssignmentScope::OrgUnit, Some(branch), None).await;

    // Two roles they must not be able to hand out.
    let wider = make_role(&db, &t, "wider", &["core.users.read", "core.users.delete"]).await;
    let same = make_role(&db, &t, "same", &["core.users.read"]).await;

    let ctx = resolve(&db, delegate).await;

    // (a) A privilege they do not hold at all.
    assert!(
        guards::ensure_can_grant(&db, &ctx, wider, AssignmentScope::OrgUnit, Some(branch))
            .await
            .is_err(),
        "core.users.delete n'est pas détenu : l'octroi doit être refusé"
    );

    // (b) A privilege they hold, over a subtree they do not administer.
    assert!(
        guards::ensure_can_grant(&db, &ctx, same, AssignmentScope::OrgUnit, Some(elsewhere))
            .await
            .is_err(),
        "hors de leur sous-arbre : refusé"
    );

    // (c) A privilege they hold, but instance-wide - strictly broader than their own scope.
    assert!(
        guards::ensure_can_grant(&db, &ctx, same, AssignmentScope::Instance, None)
            .await
            .is_err(),
        "une portée instance dépasse leur propre portée : refusé"
    );

    // (d) Exactly what they hold, where they hold it: allowed.
    assert!(
        guards::ensure_can_grant(&db, &ctx, same, AssignmentScope::OrgUnit, Some(branch))
            .await
            .is_ok()
    );

    // (e) A superuser role is never grantable by a non-superuser.
    let super_role: Uuid = db
        .fetch_scalar::<Uuid>(
            "SELECT id FROM core.roles WHERE slug = 'super-admin'",
            params![],
        )
        .await
        .expect("rôle système semé");
    assert!(
        guards::ensure_can_grant(&db, &ctx, super_role, AssignmentScope::Instance, None)
            .await
            .is_err()
    );

    cleanup(&db, &t).await;
}

#[tokio::test]
async fn guard_3_you_cannot_touch_an_account_holding_a_role_you_do_not_hold() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    let root = make_unit(&db, &format!("ou-root-{t}"), None).await;

    // The delegate administers the ROOT unit - so every account is inside their
    // perimeter. This is exactly the situation guard 3 exists for: without it,
    // "modify accounts of the root unit" is "reset the super-administrator's
    // password".
    let delegate = make_user(&db, &t, "delegate", Some(root)).await;
    let held = make_role(
        &db,
        &t,
        "held",
        &["core.users.read", "core.users.update", "core.user_password.execute"],
    )
    .await;
    assign(&db, held, Some(delegate), None, AssignmentScope::OrgUnit, Some(root), None).await;

    let ordinary = make_user(&db, &t, "ordinary", Some(root)).await;

    let boss = make_user(&db, &t, "boss", Some(root)).await;
    let super_role: Uuid = db
        .fetch_scalar::<Uuid>(
            "SELECT id FROM core.roles WHERE slug = 'super-admin'",
            params![],
        )
        .await
        .expect("rôle système semé");
    assign(&db, super_role, Some(boss), None, AssignmentScope::Instance, None, None).await;

    let peer = make_user(&db, &t, "peer", Some(root)).await;
    let stronger = make_role(&db, &t, "stronger", &["core.settings.manage"]).await;
    assign(&db, stronger, Some(peer), None, AssignmentScope::Instance, None, None).await;

    let ctx = resolve(&db, delegate).await;

    // The perimeter check alone would let all three through.
    assert!(ctx.has_for_unit("core.user_password.execute", Some(root)));

    assert!(
        guards::ensure_can_act_on_user(&db, &ctx, ordinary)
            .await
            .is_ok(),
        "un compte ordinaire du sous-arbre reste administrable"
    );
    assert!(
        guards::ensure_can_act_on_user(&db, &ctx, boss)
            .await
            .is_err(),
        "un super-administrateur n'est jamais administrable par un délégué"
    );
    assert!(
        guards::ensure_can_act_on_user(&db, &ctx, peer)
            .await
            .is_err(),
        "un compte détenant core.settings.manage, que l'appelant n'a pas"
    );

    // A superuser is bound by neither.
    let mut root_ctx = AdminContext::empty(Uuid::new_v4(), ActorOrigin::Session, None);
    root_ctx.is_superuser = true;
    assert!(guards::ensure_can_act_on_user(&db, &root_ctx, boss).await.is_ok());

    cleanup(&db, &t).await;
}

#[tokio::test]
async fn guard_4_the_last_superadmin_cannot_be_removed() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    let super_role: Uuid = db
        .fetch_scalar::<Uuid>(
            "SELECT id FROM core.roles WHERE slug = 'super-admin'",
            params![],
        )
        .await
        .expect("rôle système semé");

    // The check is evaluated on the POST-state, inside the transaction, so the
    // test does the same: mutate, ask, roll back. Everything happens in one
    // transaction so the instance is left exactly as it was found.
    let mut tx = db.begin().await.expect("transaction");

    let boss = kubuno_db::new_id();
    tx.execute(
        "INSERT INTO core.users (id, email, username, password_hash, role) \
         VALUES ($1, $2, $3, 'x', 'admin')",
        params![boss, format!("boss.{t}@test.local"), format!("boss_{t}")],
    )
    .await
    .expect("super-administrateur de test");
    tx.execute(
        "INSERT INTO core.role_assignments (id, role_id, subject_user_id, scope) \
         VALUES ($1, $2, $3, 'instance')",
        params![kubuno_db::new_id(), super_role, boss],
    )
    .await
    .expect("affectation super-admin");

    let before = guards::superadmin_count(&mut tx).await.expect("comptage");
    assert!(before > 0);
    assert!(guards::ensure_superadmin_remains(&mut tx).await.is_ok());

    // Remove every one of them: the guard must refuse.
    tx.execute(
        "DELETE FROM core.role_assignments WHERE role_id = $1",
        params![super_role],
    )
    .await
    .expect("retrait");
    assert_eq!(guards::superadmin_count(&mut tx).await.expect("comptage"), 0);
    let refusal = guards::ensure_superadmin_remains(&mut tx)
        .await
        .expect_err("retirer le dernier super-administrateur doit être refusé");
    assert!(refusal.to_string().contains("super-administrateur"));

    tx.rollback().await.expect("annulation");

    // Deactivating the account is caught too: `core.superadmin_ids()` counts
    // active accounts only, so a suspension is a removal as far as guard 4 is
    // concerned.
    let mut tx = db.begin().await.expect("transaction");
    let boss = kubuno_db::new_id();
    tx.execute(
        "INSERT INTO core.users (id, email, username, password_hash, role) \
         VALUES ($1, $2, $3, 'x', 'admin')",
        params![boss, format!("boss2.{t}@test.local"), format!("boss2_{t}")],
    )
    .await
    .expect("super-administrateur de test");
    tx.execute(
        "INSERT INTO core.role_assignments (id, role_id, subject_user_id, scope) \
         VALUES ($1, $2, $3, 'instance')",
        params![kubuno_db::new_id(), super_role, boss],
    )
    .await
    .expect("affectation super-admin");
    assert!(guards::ensure_superadmin_remains(&mut tx).await.is_ok());

    tx.execute(
        "UPDATE core.users SET is_active = FALSE \
          WHERE id IN (SELECT user_id FROM core.superadmin_ids())",
        params![],
    )
    .await
    .expect("désactivation");
    assert!(guards::ensure_superadmin_remains(&mut tx).await.is_err());
    tx.rollback().await.expect("annulation");

    cleanup(&db, &t).await;
}

// ── Cache ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn revoking_an_assignment_invalidates_the_cache() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    let unit = make_unit(&db, &format!("ou-root-{t}"), None).await;
    let user = make_user(&db, &t, "cached", Some(unit)).await;
    let role = make_role(&db, &t, "readers", &["core.users.read"]).await;
    let a = assign(&db, role, Some(user), None, AssignmentScope::OrgUnit, Some(unit), None).await;

    cache::invalidate_all();
    let ctx = resolve(&db, user).await;
    assert!(ctx.has("core.users.read"));
    cache::put(user, &ctx);
    assert!(cache::get(user).expect("mise en cache").has("core.users.read"));

    // Revoke, exactly as the handler does.
    db.execute("DELETE FROM core.role_assignments WHERE id = $1", params![a])
        .await
        .expect("révocation");
    cache::invalidate_all();

    assert!(cache::get(user).is_none(), "l'entrée périmée doit avoir disparu");
    assert!(
        !resolve(&db, user).await.has("core.users.read"),
        "le privilège révoqué ne doit plus être résolu"
    );

    cleanup(&db, &t).await;
}

// ── Catalogue ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_seeded_catalogue_and_system_roles_are_coherent() {
    let Some(db) = common::test_pool().await else { return };

    // Every seeded key parses under the grammar.
    let keys: Vec<String> = db
        .fetch_all_as::<KeyRow>(
            "SELECT key FROM core.privileges WHERE namespace = 'core'",
            params![],
        )
        .await
        .expect("catalogue")
        .into_iter()
        .map(|r| r.key)
        .collect();
    assert!(keys.len() >= 25, "socle core.* trop maigre : {}", keys.len());
    for key in &keys {
        kubuno_core::authz::model::parse_key(key)
            .unwrap_or_else(|e| panic!("clé semée invalide {key} : {e}"));
    }

    // The seven system roles exist and exactly one of them is a superuser role:
    // four seeded by migration 000044, three narrow ones by 000054.
    let system: Vec<SystemRoleRow> = db
        .fetch_all_as::<SystemRoleRow>(
            "SELECT slug, is_superuser FROM core.roles WHERE is_system ORDER BY slug",
            params![],
        )
        .await
        .expect("rôles système");
    let slugs: HashSet<&str> = system.iter().map(|r| r.slug.as_str()).collect();
    for expected in [
        "super-admin",
        "user-admin",
        "read-only-admin",
        "service-admin",
        "support-admin",
        "directory-reader",
        "group-admin",
    ] {
        assert!(slugs.contains(expected), "rôle système manquant : {expected}");
    }
    assert_eq!(system.len(), 7);
    assert_eq!(system.iter().filter(|r| r.is_superuser).count(), 1);

    // The delegable roles: every privilege they carry is scopable, which is the
    // only thing that makes their "délégable par unité" badge true.
    for slug in ["user-admin", "support-admin", "directory-reader"] {
        let non_scopable: i64 = db
            .fetch_scalar::<i64>(
                "SELECT COUNT(*)::bigint FROM core.role_privileges rp \
               JOIN core.roles r ON r.id = rp.role_id \
               JOIN core.privileges p ON p.key = rp.privilege_key \
              WHERE r.slug = $1 AND NOT p.is_ou_scopable",
                params![slug],
            )
            .await
            .expect("contrôle");
        assert_eq!(non_scopable, 0, "« {slug} » doit rester délégable sur une unité");
    }

    // `support-admin` is the narrow one: exactly the four privileges a support
    // desk needs, and none of the destructive ones. Asserted by name because
    // "narrow" is the entire point of the role - a later addition of
    // `core.users.delete` must break this test, not pass unnoticed.
    let support: Vec<String> = db
        .fetch_all_as::<PrivKeyRow>(
            "SELECT rp.privilege_key FROM core.role_privileges rp \
           JOIN core.roles r ON r.id = rp.role_id \
          WHERE r.slug = 'support-admin' ORDER BY rp.privilege_key",
            params![],
        )
        .await
        .expect("privilèges du support")
        .into_iter()
        .map(|r| r.privilege_key)
        .collect();
    assert_eq!(
        support,
        vec![
            "core.sessions.delete".to_string(),
            "core.sessions.read".to_string(),
            "core.user_password.execute".to_string(),
            "core.users.read".to_string(),
        ]
    );

    // …and the instance-only ones are deliberately so: `read-only-admin` reads
    // instance-wide things (audit, settings), `group-admin` administers groups,
    // which cross organisational units by construction.
    for slug in ["read-only-admin", "group-admin"] {
        let role: Uuid = db
            .fetch_scalar::<Uuid>("SELECT id FROM core.roles WHERE slug = $1", params![slug])
            .await
            .expect("rôle système");
        assert!(
            guards::ensure_scopable(&db, role, AssignmentScope::OrgUnit)
                .await
                .is_err(),
            "« {slug} » ne peut pas être restreint à une unité"
        );
    }
}
