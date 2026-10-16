//! Recursive traversal of `core.org_units` and cycle protection.
//!
//! Exercises the SQL functions added by migration `000041` and the exact
//! predicate the admin handler uses to refuse a reparenting that would create
//! a cycle (`handlers/admin/org_units.rs`).

mod common;

use std::time::Duration;

use kubuno_db::{params, DbPool};
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow, PartialEq)]
struct UnitRow {
    id:        Uuid,
    name:      String,
    parent_id: Option<Uuid>,
    depth:     i32,
}

async fn create_unit(db: &DbPool, name: &str, parent: Option<Uuid>) -> Uuid {
    let id = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.org_units (id, name, parent_id) VALUES ($1, $2, $3)",
        params![id, name, parent],
    )
    .await
    .expect("création d'unité");
    id
}

async fn ancestors(db: &DbPool, id: Uuid) -> Vec<UnitRow> {
    db.fetch_all_as::<UnitRow>(
        "SELECT id, name, parent_id, depth FROM core.org_unit_ancestors($1)",
        params![id],
    )
    .await
    .expect("ancêtres")
}

async fn descendants(db: &DbPool, id: Uuid) -> Vec<UnitRow> {
    db.fetch_all_as::<UnitRow>(
        "SELECT id, name, parent_id, depth FROM core.org_unit_descendants($1)",
        params![id],
    )
    .await
    .expect("descendants")
}

/// The check performed by `update_org_unit` before writing a new parent.
async fn creates_cycle(db: &DbPool, unit: Uuid, new_parent: Uuid) -> bool {
    db.fetch_scalar::<bool>(
        "SELECT EXISTS (SELECT 1 FROM core.org_unit_descendants($1) d WHERE d.id = $2)",
        params![unit, new_parent],
    )
    .await
    .expect("détection de cycle")
}

/// Builds  racine → direction → équipe → binôme  plus a sibling of « équipe ».
async fn build_tree(db: &DbPool, tag: &str) -> (Uuid, Uuid, Uuid, Uuid) {
    let root   = create_unit(db, &format!("{tag} racine"), None).await;
    let dir    = create_unit(db, &format!("{tag} direction"), Some(root)).await;
    let equipe = create_unit(db, &format!("{tag} équipe"), Some(dir)).await;
    let binome = create_unit(db, &format!("{tag} binôme"), Some(equipe)).await;
    (root, dir, equipe, binome)
}

async fn cleanup(db: &DbPool, tag: &str) {
    // Break any cycle first, otherwise ON DELETE CASCADE has nothing to grip.
    let _ = db
        .execute(
            "UPDATE core.org_units SET parent_id = NULL WHERE name LIKE $1",
            params![format!("{tag}%")],
        )
        .await;
    let _ = db
        .execute(
            "DELETE FROM core.org_units WHERE name LIKE $1",
            params![format!("{tag}%")],
        )
        .await;
}

#[tokio::test]
async fn ancestors_are_returned_closest_first() {
    let Some(db) = common::test_pool().await else { return };
    let tag = format!("t{}", Uuid::new_v4().simple());
    let (root, dir, equipe, binome) = build_tree(&db, &tag).await;

    let chain = ancestors(&db, binome).await;
    let ids: Vec<Uuid> = chain.iter().map(|u| u.id).collect();
    let depths: Vec<i32> = chain.iter().map(|u| u.depth).collect();
    assert_eq!(ids, vec![binome, equipe, dir, root], "du plus proche au plus lointain");
    assert_eq!(depths, vec![0, 1, 2, 3], "depth 0 = l'unité elle-même");

    // A root is its own - and only - ancestor.
    let chain = ancestors(&db, root).await;
    assert_eq!(chain.len(), 1);
    assert_eq!(chain[0].id, root);
    assert_eq!(chain[0].depth, 0);

    // Unknown unit → empty, not an error.
    assert!(ancestors(&db, Uuid::new_v4()).await.is_empty());

    cleanup(&db, &tag).await;
}

#[tokio::test]
async fn descendants_cover_the_whole_subtree() {
    let Some(db) = common::test_pool().await else { return };
    let tag = format!("t{}", Uuid::new_v4().simple());
    let (root, dir, equipe, binome) = build_tree(&db, &tag).await;
    let autre = create_unit(&db, &format!("{tag} autre équipe"), Some(dir)).await;

    let subtree = descendants(&db, root).await;
    let ids: Vec<Uuid> = subtree.iter().map(|u| u.id).collect();
    assert_eq!(ids.len(), 5, "l'unité + ses 4 descendants");
    for expected in [root, dir, equipe, binome, autre] {
        assert!(ids.contains(&expected), "sous-arbre incomplet");
    }
    assert_eq!(subtree[0].id, root);
    assert_eq!(subtree[0].depth, 0, "depth 0 = l'unité elle-même");
    let depth_of = |id: Uuid| subtree.iter().find(|u| u.id == id).map(|u| u.depth);
    assert_eq!(depth_of(dir), Some(1));
    assert_eq!(depth_of(equipe), Some(2));
    assert_eq!(depth_of(autre), Some(2));
    assert_eq!(depth_of(binome), Some(3));

    // A leaf is its own only descendant.
    assert_eq!(descendants(&db, binome).await.len(), 1);

    // « This rule applies to N users »: the query the feature will run.
    let users: i64 = db
        .fetch_scalar::<i64>(
            "SELECT COUNT(*) FROM core.users u
          WHERE u.org_unit_id IN (SELECT d.id FROM core.org_unit_descendants($1) d)",
            params![root],
        )
        .await
        .expect("comptage");
    assert_eq!(users, 0, "aucun utilisateur dans l'arborescence de test");

    cleanup(&db, &tag).await;
}

#[tokio::test]
async fn a_cycle_in_the_database_does_not_hang_the_traversal() {
    let Some(db) = common::test_pool().await else { return };
    let tag = format!("t{}", Uuid::new_v4().simple());
    let (_root, dir, equipe, binome) = build_tree(&db, &tag).await;

    // Forge a cycle behind the application's back: direction → … → binôme → direction.
    db.execute(
        "UPDATE core.org_units SET parent_id = $1 WHERE id = $2",
        params![binome, dir],
    )
    .await
    .expect("création du cycle");

    // Both functions must return, bounded by their depth guard.
    let chain = tokio::time::timeout(Duration::from_secs(10), ancestors(&db, equipe))
        .await
        .expect("les ancêtres ne doivent pas boucler indéfiniment");
    assert!(!chain.is_empty());
    assert!(chain.len() <= 4, "un cycle ne doit pas dupliquer les unités : {}", chain.len());

    let subtree = tokio::time::timeout(Duration::from_secs(10), descendants(&db, dir))
        .await
        .expect("les descendants ne doivent pas boucler indéfiniment");
    assert!(subtree.len() <= 4, "un cycle ne doit pas dupliquer les unités : {}", subtree.len());

    // And the explicit depth cap truncates the walk.
    let capped: Vec<UnitRow> = db
        .fetch_all_as::<UnitRow>(
            "SELECT id, name, parent_id, depth FROM core.org_unit_ancestors($1, 1)",
            params![equipe],
        )
        .await
        .expect("ancêtres bornés");
    assert_eq!(capped.len(), 2, "profondeur 1 = l'unité et son parent");

    cleanup(&db, &tag).await;
}

#[tokio::test]
async fn reparenting_inside_its_own_subtree_is_detected() {
    let Some(db) = common::test_pool().await else { return };
    let tag = format!("t{}", Uuid::new_v4().simple());
    let (root, dir, equipe, binome) = build_tree(&db, &tag).await;
    let autre = create_unit(&db, &format!("{tag} autre"), Some(root)).await;

    // Refused: any node of the unit's own subtree, at any depth.
    assert!(creates_cycle(&db, dir, equipe).await, "enfant direct");
    assert!(creates_cycle(&db, dir, binome).await, "petit-enfant");
    assert!(creates_cycle(&db, dir, dir).await, "soi-même");

    // Allowed: an ancestor or a sibling branch.
    assert!(!creates_cycle(&db, dir, root).await);
    assert!(!creates_cycle(&db, equipe, autre).await);
    assert!(!creates_cycle(&db, binome, root).await);

    cleanup(&db, &tag).await;
}
