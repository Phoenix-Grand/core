//! Per-scope setting values, inheritance down the organisational tree, and the
//! properties that make the model correct rather than merely present.
//!
//! Exercises migration `000060` (the table, the chain function, the two mirror
//! triggers) together with `crate::settings` - resolution policy, "revert =
//! delete", lock enforcement - against a real database.

mod common;

use kubuno_core::settings::{
    chain, scope::SettingScope, store, ScopeKind,
};
use serde_json::{json, Value};
use kubuno_db::{params, DbPool, DbQueryBuilder};
use uuid::Uuid;

// The store's write helpers take (`&DbPool` for reads, `&mut DbTx` for the
// write). These wrappers open a short transaction, run the write, and commit
// only on success - reproducing the autocommit semantics the tests relied on
// when they used a pooled connection.
async fn set_value(
    db: &DbPool,
    key: &str,
    scope: &SettingScope,
    value: &Value,
    actor: Option<Uuid>,
) -> Result<store::WriteOutcome, kubuno_core::errors::AppError> {
    let mut tx = db
        .begin()
        .await
        .map_err(kubuno_core::errors::AppError::Database)?;
    let r = store::set_value(db, &mut tx, key, scope, value, actor).await;
    if r.is_ok() {
        tx.commit()
            .await
            .map_err(kubuno_core::errors::AppError::Database)?;
    }
    r
}

async fn clear_value(
    db: &DbPool,
    key: &str,
    scope: &SettingScope,
    actor: Option<Uuid>,
) -> Result<store::WriteOutcome, kubuno_core::errors::AppError> {
    let mut tx = db
        .begin()
        .await
        .map_err(kubuno_core::errors::AppError::Database)?;
    let r = store::clear_value(db, &mut tx, key, scope, actor).await;
    if r.is_ok() {
        tx.commit()
            .await
            .map_err(kubuno_core::errors::AppError::Database)?;
    }
    r
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// The suite runs in parallel against ONE database, so every test owns its own
// setting key and its own subtree. Sharing a real key (`security.max_sessions`)
// made the tests fight over the instance row and fail in whichever order they
// happened to interleave - a flake that says nothing about the code.

struct Tree {
    root:  Uuid,
    zone:  Uuid,
    team:  Uuid,
    user:  Uuid,
    group: Uuid,
    /// Declared setting owned by this fixture alone.
    key:   String,
    /// Its factory default.
    factory: Value,
}

async fn unit(db: &DbPool, name: &str, parent: Option<Uuid>) -> Uuid {
    let id = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.org_units (id, name, parent_id) VALUES ($1, $2, $3)",
        params![id, name, parent],
    )
    .await
    .expect("création d'unité");
    id
}

async fn fixture(db: &DbPool, tag: &str) -> Tree {
    let tag = format!("zz{tag}-{}", &Uuid::new_v4().to_string()[..8]);
    let tag = tag.as_str();

    let key = format!("zztest.{tag}");
    let factory = json!(10);
    db.execute(
        "INSERT INTO core.settings (key, value, default_value, category, value_type, module_id) \
         VALUES ($1, $2, $3, 'zztest', 'int', 'zztest')",
        params![&key, factory.clone(), factory.clone()],
    )
    .await
    .expect("déclaration du réglage de test");

    let root = unit(db, &format!("{tag} Racine"), None).await;
    let zone = unit(db, &format!("{tag} Zone"), Some(root)).await;
    let team = unit(db, &format!("{tag} Equipe"), Some(zone)).await;

    let user: Uuid = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.users (id, email, username, password_hash, display_name, org_unit_id) \
         VALUES ($1, $2, $3, 'x', 'Compte de test', $4)",
        params![user, format!("{tag}@test.local"), format!("{tag}-user"), team],
    )
    .await
    .expect("création du compte");

    let group: Uuid = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.user_groups (id, name) VALUES ($1, $2)",
        params![group, format!("{tag} Groupe")],
    )
    .await
    .expect("création du groupe");
    db.execute(
        "INSERT INTO core.user_group_members (group_id, user_id) VALUES ($1, $2)",
        params![group, user],
    )
    .await
    .expect("adhésion au groupe");

    Tree { root, zone, team, user, group, key, factory }
}

async fn cleanup(db: &DbPool, tree: &Tree) {
    // The units cascade to their subtree, and the purge triggers take the
    // setting values with them.
    let _ = db.execute("DELETE FROM core.users WHERE id = $1", params![tree.user]).await;
    let _ = db.execute("DELETE FROM core.user_groups WHERE id = $1", params![tree.group]).await;
    let _ = db.execute("DELETE FROM core.org_units WHERE id = $1", params![tree.root]).await;
    // Cascades to every remaining value of the key.
    let _ = db.execute("DELETE FROM core.settings WHERE key = $1", params![&tree.key]).await;
}

/// Writes straight to the table - the fixture path, deliberately bypassing the
/// store so the store's own guards can be tested against it.
async fn put(db: &DbPool, key: &str, scope: &SettingScope, value: Value, locked: bool) {
    db.execute(
        "INSERT INTO core.setting_values (key, scope_type, scope_id, value, locked) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (key, scope_type, scope_id) DO UPDATE SET value = EXCLUDED.value, locked = EXCLUDED.locked",
        params![key, scope.kind.as_str(), scope.storage_id(), value.clone(), locked],
    )
    .await
    .expect("écriture de la valeur");
}

async fn effective(db: &DbPool, key: &str, scope: &SettingScope) -> Option<Value> {
    chain::resolve_for(db, key, scope).await.expect("résolution").value
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn resolution_walks_the_whole_order_and_the_closest_unit_wins() {
    let Some(db) = common::test_pool().await else { return };
    let t = fixture(&db, "ordre").await;
    let user_scope = SettingScope::user(t.user);

    // Nothing anywhere: the factory default applies.
    assert_eq!(effective(&db, &t.key, &user_scope).await, Some(t.factory.clone()));

    put(&db, &t.key, &SettingScope::INSTANCE, json!(100), false).await;
    assert_eq!(effective(&db, &t.key, &user_scope).await, Some(json!(100)), "instance");

    put(&db, &t.key, &SettingScope::org_unit(t.root), json!(200), false).await;
    assert_eq!(effective(&db, &t.key, &user_scope).await, Some(json!(200)), "racine > instance");

    put(&db, &t.key, &SettingScope::org_unit(t.zone), json!(300), false).await;
    assert_eq!(effective(&db, &t.key, &user_scope).await, Some(json!(300)), "zone > racine");

    put(&db, &t.key, &SettingScope::org_unit(t.team), json!(400), false).await;
    assert_eq!(
        effective(&db, &t.key, &user_scope).await,
        Some(json!(400)),
        "l'unité LA PLUS PROCHE l'emporte"
    );

    put(&db, &t.key, &SettingScope::group(t.group), json!(500), false).await;
    assert_eq!(effective(&db, &t.key, &user_scope).await, Some(json!(500)), "groupe > unité");

    put(&db, &t.key, &SettingScope::user(t.user), json!(600), false).await;
    assert_eq!(effective(&db, &t.key, &user_scope).await, Some(json!(600)), "utilisateur > groupe");

    cleanup(&db, &t).await;
}

#[tokio::test]
async fn an_inherited_scope_holds_no_row_and_reverting_is_a_deletion() {
    let Some(db) = common::test_pool().await else { return };
    let t = fixture(&db, "heritage").await;
    let team_scope = SettingScope::org_unit(t.team);

    put(&db, &t.key, &SettingScope::org_unit(t.zone), json!(10), false).await;

    // The child inherits - and stores nothing. This is the invariant the whole
    // feature rests on: materialising here would freeze the value.
    let r = chain::resolve_for(&db, &t.key, &team_scope).await.expect("résolution");
    assert_eq!(r.value, Some(json!(10)));
    assert!(!r.has_own_value, "une portée qui hérite n'a PAS de ligne");
    let stored: i64 = db
        .fetch_scalar::<i64>(
            "SELECT count(*) FROM core.setting_values WHERE key = $1 AND scope_type = 'org_unit' AND scope_id = $2",
            params![&t.key, t.team],
        )
        .await
        .expect("comptage");
    assert_eq!(stored, 0, "rien n'a été matérialisé");

    // Override, then revert through the store.
    set_value(&db, &t.key, &team_scope, &json!(99), None)
        .await
        .expect("surcharge");
    assert_eq!(effective(&db, &t.key, &team_scope).await, Some(json!(99)));

    clear_value(&db, &t.key, &team_scope, None)
        .await
        .expect("rétablissement");
    let stored: i64 = db
        .fetch_scalar::<i64>(
            "SELECT count(*) FROM core.setting_values WHERE key = $1 AND scope_type = 'org_unit' AND scope_id = $2",
            params![&t.key, t.team],
        )
        .await
        .expect("comptage");
    assert_eq!(stored, 0, "« rétablir » est une SUPPRESSION, pas une écriture");

    // And the point of the deletion: the child now FOLLOWS the parent again.
    put(&db, &t.key, &SettingScope::org_unit(t.zone), json!(77), false).await;
    assert_eq!(
        effective(&db, &t.key, &team_scope).await,
        Some(json!(77)),
        "le réglage suit à nouveau les changements du parent"
    );

    cleanup(&db, &t).await;
}

#[tokio::test]
async fn a_lock_wins_over_every_level_below_and_the_api_refuses_to_write_there() {
    let Some(db) = common::test_pool().await else { return };
    let t = fixture(&db, "verrou").await;

    put(&db, &t.key, &SettingScope::org_unit(t.zone), json!(42), true).await;
    put(&db, &t.key, &SettingScope::user(t.user), json!(1), false).await;

    // The user's own value exists and is ignored: the lock short-circuits it.
    let r = chain::resolve_for(&db, &t.key, &SettingScope::user(t.user))
        .await
        .expect("résolution");
    assert_eq!(r.value, Some(json!(42)), "la valeur verrouillée l'emporte");
    assert!(r.locked_above);
    assert!(!r.can_override());
    assert_eq!(
        r.lock_source.as_ref().map(|o| o.scope_type.as_str()),
        Some(ScopeKind::OrgUnit.as_str())
    );

    // Writing underneath is refused, at the sub-unit and at the account alike.
    for scope in [SettingScope::org_unit(t.team), SettingScope::user(t.user)] {
        let err = set_value(&db, &t.key, &scope, &json!(7), None)
            .await
            .expect_err("l'écriture sous un verrou doit être refusée");
        assert!(
            matches!(err, kubuno_core::errors::AppError::SettingLocked(_)),
            "erreur inattendue : {err:?}"
        );
    }
    // …and so is reverting: a lock is not escaped by deleting one's own row.
    let err = clear_value(&db, &t.key, &SettingScope::user(t.user), None)
        .await
        .expect_err("le rétablissement sous un verrou doit être refusé");
    assert!(matches!(err, kubuno_core::errors::AppError::SettingLocked(_)));

    // The level that HOLDS the lock is not locked out of its own value.
    set_value(&db, &t.key, &SettingScope::org_unit(t.zone), &json!(43), None)
        .await
        .expect("le niveau qui verrouille garde la main");
    // …and setting it again did not silently drop the lock.
    let still: bool = db
        .fetch_scalar::<bool>(
            "SELECT locked FROM core.setting_values WHERE key = $1 AND scope_type = 'org_unit' AND scope_id = $2",
            params![&t.key, t.zone],
        )
        .await
        .expect("relecture du verrou");
    assert!(still, "réécrire la valeur ne déverrouille pas");

    cleanup(&db, &t).await;
}

#[tokio::test]
async fn the_most_general_lock_wins_over_a_lower_one() {
    let Some(db) = common::test_pool().await else { return };
    let t = fixture(&db, "verroudouble").await;

    put(&db, &t.key, &SettingScope::INSTANCE, json!(5), true).await;
    put(&db, &t.key, &SettingScope::org_unit(t.zone), json!(50), true).await;

    assert_eq!(
        effective(&db, &t.key, &SettingScope::user(t.user)).await,
        Some(json!(5)),
        "le verrou le plus général court-circuite le verrou local"
    );

    cleanup(&db, &t).await;
}

#[tokio::test]
async fn the_compatibility_mirror_stays_in_step_in_both_directions() {
    let Some(db) = common::test_pool().await else { return };
    let t = fixture(&db, "miroir").await;

    async fn read_mirror(db: &DbPool, key: &str) -> Value {
        db.fetch_scalar::<Value>("SELECT value FROM core.settings WHERE key = $1", params![key])
            .await
            .expect("miroir")
    }

    // Legacy write path (about twenty call sites still do exactly this).
    db.execute(
        "UPDATE core.settings SET value = $1 WHERE key = $2",
        params![json!(33), &t.key],
    )
    .await
    .expect("écriture héritée");
    let stored: Option<Value> = db
        .fetch_optional_scalar::<Value>(
            "SELECT value FROM core.setting_values WHERE key = $1 AND scope_type = 'instance'",
            params![&t.key],
        )
        .await
        .expect("lecture de la portée instance");
    assert_eq!(stored, Some(json!(33)), "l'écriture héritée atterrit dans la table par portée");

    // Scoped write path.
    put(&db, &t.key, &SettingScope::INSTANCE, json!(44), false).await;
    assert_eq!(read_mirror(&db, &t.key).await, json!(44), "le miroir suit l'écriture par portée");

    // Reverting the instance level puts the factory default back in the mirror,
    // which is what the legacy readers must see.
    let factory = t.factory.clone();
    db.execute(
        "DELETE FROM core.setting_values WHERE key = $1 AND scope_type = 'instance'",
        params![&t.key],
    )
    .await
    .expect("retour à l'usine");
    assert_eq!(read_mirror(&db, &t.key).await, factory);

    // A per-unit override never leaks into the mirror: it is not an instance
    // value, and the legacy readers must keep seeing the instance one.
    put(&db, &t.key, &SettingScope::org_unit(t.zone), json!(999), false).await;
    assert_eq!(read_mirror(&db, &t.key).await, factory, "rien d'hérité n'entre dans le miroir");

    cleanup(&db, &t).await;
}

#[tokio::test]
async fn the_migration_preserved_every_effective_value() {
    let Some(db) = common::test_pool().await else { return };

    // After 000060 the effective instance value of every declared key must equal
    // what `core.settings.value` holds - that column is the mirror, and any
    // divergence would be a silent behaviour change for the twenty call sites
    // still reading it.
    let mismatches: i64 = db
        .fetch_scalar::<i64>(
            "SELECT count(*) FROM core.settings s \
          WHERE s.value IS DISTINCT FROM COALESCE( \
              (SELECT v.value FROM core.setting_values v \
                WHERE v.key = s.key AND v.scope_type = 'instance'), \
              s.default_value)",
            params![],
        )
        .await
        .expect("comparaison");
    assert_eq!(mismatches, 0, "des valeurs effectives ont changé pendant la migration");

    // And every key now has a factory default to fall back to.
    let orphans: i64 = db
        .fetch_scalar::<i64>(
            "SELECT count(*) FROM core.settings WHERE default_value IS NULL",
            params![],
        )
        .await
        .expect("comptage");
    assert_eq!(orphans, 0, "toute clé doit avoir une valeur d'usine");
}

#[tokio::test]
async fn deleting_a_subject_takes_its_overrides_with_it() {
    let Some(db) = common::test_pool().await else { return };
    let t = fixture(&db, "purge").await;

    put(&db, &t.key, &SettingScope::org_unit(t.team), json!(1), false).await;
    put(&db, &t.key, &SettingScope::user(t.user), json!(2), false).await;
    put(&db, &t.key, &SettingScope::group(t.group), json!(3), false).await;

    // Counted on this fixture's subjects only: the suite runs in parallel on a
    // shared database, and a global count would race with the other tests.
    let subjects = vec![t.team, t.user, t.group];
    async fn count(db: &DbPool, key: &str, subjects: &[Uuid]) -> i64 {
        let mut qb = DbQueryBuilder::new(
            db.backend(),
            "SELECT count(*) FROM core.setting_values WHERE key = ",
        );
        qb.push_bind(key);
        qb.push(" AND scope_id").push_in(subjects.to_vec());
        qb.fetch_scalar::<i64>(db).await.expect("comptage")
    }
    assert_eq!(count(&db, &t.key, &subjects).await, 3);

    cleanup(&db, &t).await;
    assert_eq!(
        count(&db, &t.key, &subjects).await,
        0,
        "un sujet supprimé ne laisse pas de réglage orphelin qu'un uuid recyclé ressusciterait"
    );
}

#[tokio::test]
async fn a_value_outside_the_declared_domain_is_refused() {
    let Some(db) = common::test_pool().await else { return };
    let t = fixture(&db, "domaine").await;

    // The fixture key is declared `int`: a string must not pass.
    let err = set_value(&db, &t.key, &SettingScope::INSTANCE, &json!("beaucoup"), None)
        .await
        .expect_err("un type incompatible doit être refusé");
    assert!(matches!(err, kubuno_core::errors::AppError::Validation(_)), "{err:?}");

    let err = set_value(&db, "n.existe.pas", &SettingScope::INSTANCE, &json!(1), None)
        .await
        .expect_err("une clé non déclarée doit être refusée");
    assert!(matches!(err, kubuno_core::errors::AppError::NotFound(_)), "{err:?}");

    cleanup(&db, &t).await;
}
