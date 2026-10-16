//! Alert centre, against a real PostgreSQL (see `common`).
//!
//! Covers the three things that decide whether the feature is usable at all:
//! deduplication (the reason the queue does not become a log), the lifecycle
//! (including the asymmetry between `ignored` and `resolved`), and the privilege
//! filter (a delegate must not be shown alerts they cannot act on).

mod common;

use kubuno_core::alerts::model::{NewAlert, Severity, Status};
use kubuno_core::alerts::{catalog, store};
use kubuno_core::audit::ActorOrigin;
use kubuno_core::authz::context::PrivilegeScope;
use kubuno_core::authz::{keys, AdminContext};
use serde_json::json;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct ClosedRow {
    closed_at: Option<chrono::DateTime<chrono::Utc>>,
    closed_by: Option<Uuid>,
}

#[derive(sqlx::FromRow)]
struct DedupKeyRow {
    dedup_key: String,
}

// `store::set_status` / `store::add_comment` write through a `&mut DbTx`. These
// wrappers open a short transaction and commit only on success, matching the
// autocommit semantics the tests relied on with a pooled connection.
async fn set_status(
    db: &DbPool,
    alert_id: Uuid,
    next: Status,
    actor_id: Uuid,
    actor_label: &str,
    note: Option<&str>,
) -> Result<Status, kubuno_core::errors::AppError> {
    let mut tx = db
        .begin()
        .await
        .map_err(kubuno_core::errors::AppError::Database)?;
    let r = store::set_status(&mut tx, alert_id, next, actor_id, actor_label, note).await;
    if r.is_ok() {
        tx.commit()
            .await
            .map_err(kubuno_core::errors::AppError::Database)?;
    }
    r
}

async fn add_comment(
    db: &DbPool,
    alert_id: Uuid,
    body: &str,
    actor_id: Uuid,
    actor_label: &str,
) -> Result<(), kubuno_core::errors::AppError> {
    let mut tx = db
        .begin()
        .await
        .map_err(kubuno_core::errors::AppError::Database)?;
    let r = store::add_comment(&mut tx, alert_id, body, actor_id, actor_label).await;
    if r.is_ok() {
        tx.commit()
            .await
            .map_err(kubuno_core::errors::AppError::Database)?;
    }
    r
}

/// Dedup keys are namespaced per test run: the test database is shared between
/// test binaries, and the partial unique index is global.
fn tag() -> String {
    Uuid::new_v4().simple().to_string()
}

async fn cleanup(db: &DbPool, discriminator: &str) {
    // `core.alert_events` goes with it (ON DELETE CASCADE).
    let _ = db
        .execute(
            "DELETE FROM core.alerts WHERE dedup_key LIKE '%' || $1 || '%'",
            params![discriminator],
        )
        .await;
}

async fn row_count(db: &DbPool, discriminator: &str) -> i64 {
    db.fetch_scalar::<i64>(
        "SELECT COUNT(*) FROM core.alerts WHERE dedup_key LIKE '%' || $1 || '%'",
        params![discriminator],
    )
    .await
    .expect("comptage des alertes")
}

async fn occurrences(db: &DbPool, id: Uuid) -> i32 {
    db.fetch_scalar::<i32>("SELECT occurrences FROM core.alerts WHERE id = $1", params![id])
        .await
        .expect("lecture du compteur")
}

async fn status_of(db: &DbPool, id: Uuid) -> String {
    db.fetch_scalar::<String>("SELECT status FROM core.alerts WHERE id = $1", params![id])
        .await
        .expect("lecture de l'état")
}

fn sample(discriminator: &str, severity: Severity) -> NewAlert {
    NewAlert::new(
        catalog::JOB_DEAD_LETTER,
        catalog::SRC_JOBS,
        severity,
        format!("Background work “{discriminator}” has given up"),
    )
    .summary("Test")
    .payload(json!({ "job_type": discriminator, "failures": 3 }))
    .dedup(discriminator)
}

/// An operator holding everything, for the reads.
fn root(user_id: Uuid) -> AdminContext {
    let mut ctx = AdminContext::empty(user_id, ActorOrigin::Session, None);
    ctx.is_superuser = true;
    ctx
}

/// A test account, created and removed by the caller. Never `admin@kubuno.local`.
async fn make_user(db: &DbPool, tag: &str) -> Uuid {
    let id = kubuno_db::new_id();
    db.execute(
        r#"INSERT INTO core.users (id, email, username, password_hash, display_name, role)
           VALUES ($1, $2, $3, 'x', $4, 'user')"#,
        params![
            id,
            format!("alerts-{tag}@test.invalid"),
            format!("alerts-{tag}"),
            format!("Alerts {tag}")
        ],
    )
    .await
    .expect("création du compte de test");
    id
}

async fn drop_user(db: &DbPool, id: Uuid) {
    let _ = db
        .execute("DELETE FROM core.users WHERE id = $1", params![id])
        .await;
}

// ── Deduplication ────────────────────────────────────────────────────────────

/// The contract the whole feature rests on: two hundred observations of one
/// problem are ONE row whose counter says two hundred - not two hundred rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recurrences_increment_a_counter_instead_of_creating_rows() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    const N: i32 = 25;
    let mut first = None;
    for i in 0..N {
        let outcome = store::raise(&db, sample(&t, Severity::Warning))
            .await
            .expect("levée");
        if i == 0 {
            assert!(outcome.created, "la première observation crée la ligne");
            first = Some(outcome.id);
        } else {
            assert!(!outcome.created, "les suivantes sont absorbées");
            assert_eq!(outcome.id, first.expect("id"), "toujours la même ligne");
        }
        assert_eq!(outcome.occurrences, i + 1);
    }

    let id = first.expect("id");
    assert_eq!(row_count(&db, &t).await, 1, "N observations → 1 ligne");
    assert_eq!(occurrences(&db, id).await, N, "compteur à N");

    // The timeline holds one creation and N-1 recurrences: the history is
    // complete without the table being.
    let timeline = store::timeline(&db, id).await.expect("fil");
    assert_eq!(timeline.iter().filter(|e| e.kind == "created").count(), 1);
    assert_eq!(
        timeline.iter().filter(|e| e.kind == "recurrence").count(),
        (N - 1) as usize
    );

    cleanup(&db, &t).await;
}

/// An escalation between two passes is recorded, not silently applied.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_severity_change_between_two_passes_lands_on_the_timeline() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    let a = store::raise(&db, sample(&t, Severity::Warning)).await.expect("levée");
    let b = store::raise(&db, sample(&t, Severity::Critical)).await.expect("levée");
    assert_eq!(a.id, b.id);

    let timeline = store::timeline(&db, a.id).await.expect("fil");
    let escalation = timeline
        .iter()
        .find(|e| e.kind == "severity")
        .expect("changement de gravité");
    assert_eq!(escalation.from_value.as_deref(), Some("warning"));
    assert_eq!(escalation.to_value.as_deref(), Some("critical"));

    cleanup(&db, &t).await;
}

/// The asymmetry that makes both buttons mean what they say.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ignored_absorbs_recurrences_while_resolved_opens_a_new_alert() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();
    let operator = make_user(&db, &t).await;

    // ── Ignored: a recurrence must stay silent. ──
    let first = store::raise(&db, sample(&t, Severity::Warning)).await.expect("levée");
    set_status(&db, first.id, Status::Ignored, operator, "Test", Some("ne s'applique pas"))
        .await
        .expect("ignorer");

    let again = store::raise(&db, sample(&t, Severity::Warning)).await.expect("levée");
    assert_eq!(again.id, first.id, "une alerte ignorée absorbe les récurrences");
    assert_eq!(status_of(&db, first.id).await, "ignored", "et reste ignorée");
    assert_eq!(row_count(&db, &t).await, 1);

    // ── Resolved: a recurrence is a regression, and gets its own row. ──
    set_status(&db, first.id, Status::Resolved, operator, "Test", None)
        .await
        .expect("clore");

    let comeback = store::raise(&db, sample(&t, Severity::Warning)).await.expect("levée");
    assert_ne!(comeback.id, first.id, "le problème revenu est une nouvelle alerte");
    assert!(comeback.created);
    assert_eq!(comeback.occurrences, 1, "et repart d'un compteur neuf");
    assert_eq!(row_count(&db, &t).await, 2);

    cleanup(&db, &t).await;
    drop_user(&db, operator).await;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_lifecycle_records_every_step_with_its_author() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();
    let operator = make_user(&db, &t).await;

    let raised = store::raise(&db, sample(&t, Severity::Warning)).await.expect("levée");

    let previous = set_status(&db, raised.id, Status::Acknowledged, operator, "Alice", None)
        .await
        .expect("prise en charge");
    assert_eq!(previous, Status::New);

    // Re-asserting the current state writes nothing: a timeline of no-ops is a
    // timeline nobody reads.
    assert!(
        set_status(&db, raised.id, Status::Acknowledged, operator, "Alice", None)
            .await
            .is_err()
    );

    add_comment(&db, raised.id, "Relance planifiée", operator, "Alice")
        .await
        .expect("commentaire");

    set_status(&db, raised.id, Status::Resolved, operator, "Alice", Some("corrigé"))
        .await
        .expect("clôture");

    let closed = db
        .fetch_one_as::<ClosedRow>(
            "SELECT closed_at, closed_by FROM core.alerts WHERE id = $1",
            params![raised.id],
        )
        .await
        .expect("lecture de la clôture");
    assert!(closed.closed_at.is_some(), "une alerte close porte sa date");
    assert_eq!(closed.closed_by, Some(operator), "et son auteur");

    let timeline = store::timeline(&db, raised.id).await.expect("fil");
    let kinds: Vec<&str> = timeline.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(kinds, vec!["created", "status", "comment", "status"]);
    assert!(timeline.iter().all(|e| !e.actor_label.is_empty()));

    cleanup(&db, &t).await;
    drop_user(&db, operator).await;
}

/// Exactly one assignee, and only somebody who can open the alert centre.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_alert_is_only_handed_to_someone_who_can_read_it() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();
    let outsider = make_user(&db, &t).await;

    // No role assignment at all: the account cannot open the alert centre, so
    // it is refused as an assignee before anything is written.
    let refused = store::eligible_assignee(&db, outsider).await;
    assert!(refused.is_err(), "un compte sans accès ne peut pas être assigné");

    drop_user(&db, outsider).await;
}

/// A condition that has gone away must leave the queue, or the queue lies.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_condition_that_disappeared_is_closed_automatically() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    let raised = store::raise(&db, sample(&t, Severity::Warning)).await.expect("levée");

    // The producer reports every live problem EXCEPT ours. Building the list
    // from what is actually open rather than from a single made-up key matters:
    // `auto_resolve` closes everything of that kind outside the list, and the
    // test database is shared with the other tests running in parallel.
    let live: Vec<String> = db
        .fetch_all_as::<DedupKeyRow>(
            "SELECT dedup_key FROM core.alerts
          WHERE kind = $1 AND status IN ('new','acknowledged') AND id <> $2",
            params![catalog::JOB_DEAD_LETTER, raised.id],
        )
        .await
        .expect("clés vivantes")
        .into_iter()
        .map(|r| r.dedup_key)
        .collect();

    let closed = store::auto_resolve(&db, catalog::JOB_DEAD_LETTER, &live)
        .await
        .expect("clôture automatique");
    assert_eq!(closed, 1, "seule la nôtre est close");
    assert_eq!(status_of(&db, raised.id).await, "resolved");

    let timeline = store::timeline(&db, raised.id).await.expect("fil");
    let auto = timeline.last().expect("dernière ligne");
    assert_eq!(auto.kind, "status");
    assert!(auto.actor_id.is_none(), "close par le serveur, pas par une personne");
    assert!(auto.body.as_deref().unwrap_or_default().contains("plus observée"));

    cleanup(&db, &t).await;
}

// ── Privilege filtering ──────────────────────────────────────────────────────

/// A delegate is shown their own perimeter, never somebody else's problems.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_queue_is_narrowed_to_what_the_caller_may_read() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();

    // Two alerts of two different families.
    let job_alert = store::raise(&db, sample(&t, Severity::Warning)).await.expect("levée");
    let module_alert = store::raise(
        &db,
        NewAlert::new(
            catalog::MODULE_UNAVAILABLE,
            catalog::SRC_MODULES,
            Severity::Critical,
            format!("The module “{t}” is not answering"),
        )
        .payload(json!({ "module_id": t }))
        .dedup(&t),
    )
    .await
    .expect("levée");

    // Holds the alert-centre key only: sees the job alert (no narrower owner),
    // never the module one (`core.modules.read`).
    let mut delegate = AdminContext::empty(Uuid::new_v4(), ActorOrigin::Session, None);
    delegate.privileges.insert(
        keys::ALERTS_READ.to_string(),
        PrivilegeScope { instance: true, units: Default::default() },
    );

    let denied = store::denied_kinds(&delegate);
    assert!(denied.contains(&catalog::MODULE_UNAVAILABLE.to_string()));
    assert!(!denied.contains(&catalog::JOB_DEAD_LETTER.to_string()));

    let query = kubuno_core::alerts::AlertQuery {
        q: Some(t.clone()),
        ..Default::default()
    };
    let page = store::list(&db, &query, &delegate).await.expect("file");
    let ids: Vec<Uuid> = page.rows.iter().map(|r| r.id).collect();
    assert!(ids.contains(&job_alert.id));
    assert!(!ids.contains(&module_alert.id), "hors périmètre : invisible");

    // Addressing it directly is refused too - hiding a row from a list is not a
    // boundary if the detail route serves it anyway.
    assert!(store::get(&db, module_alert.id, &delegate).await.is_err());

    // A super-user sees both.
    let root = root(Uuid::new_v4());
    let all = store::list(&db, &query, &root).await.expect("file");
    let ids: Vec<Uuid> = all.rows.iter().map(|r| r.id).collect();
    assert!(ids.contains(&job_alert.id) && ids.contains(&module_alert.id));

    cleanup(&db, &t).await;
}

/// Every alert served carries only the actions its reader may actually run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actions_are_narrowed_to_what_the_caller_may_perform() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();
    let raised = store::raise(&db, sample(&t, Severity::Warning)).await.expect("levée");

    // Read-only: the retry and discard verbs need `core.alerts.manage`.
    let mut reader = AdminContext::empty(Uuid::new_v4(), ActorOrigin::Session, None);
    reader.privileges.insert(
        keys::ALERTS_READ.to_string(),
        PrivilegeScope { instance: true, units: Default::default() },
    );
    let alert = store::get(&db, raised.id, &reader).await.expect("détail");
    assert!(
        alert.actions.is_empty(),
        "aucun bouton que le serveur refuserait : {:?}",
        alert.actions.iter().map(|a| a.id.clone()).collect::<Vec<_>>()
    );

    // A manager gets both, and they address the alert rather than a job row.
    let mut manager = reader.clone();
    manager.privileges.insert(
        keys::ALERTS_MANAGE.to_string(),
        PrivilegeScope { instance: true, units: Default::default() },
    );
    let alert = store::get(&db, raised.id, &manager).await.expect("détail");
    let ids: Vec<String> = alert.actions.iter().map(|a| a.id.clone()).collect();
    assert!(ids.contains(&"retry-jobs".to_string()));
    assert!(ids.contains(&"discard-jobs".to_string()));

    cleanup(&db, &t).await;
}

/// Saved filter sets are personal: another operator never sees them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saved_filter_sets_belong_to_their_owner() {
    let Some(db) = common::test_pool().await else { return };
    let t = tag();
    let alice = make_user(&db, &format!("a{t}")).await;
    let bob = make_user(&db, &format!("b{t}")).await;

    let view = store::save_view(&db, alice, "Mes critiques", &json!({ "severity": "critical" }))
        .await
        .expect("enregistrement");
    // Saving twice under the same name overwrites rather than failing.
    let again = store::save_view(&db, alice, "Mes critiques", &json!({ "severity": "warning" }))
        .await
        .expect("réenregistrement");
    assert_eq!(view.id, again.id);

    assert_eq!(store::list_views(&db, alice).await.expect("liste").len(), 1);
    assert!(store::list_views(&db, bob).await.expect("liste").is_empty());
    // Deleting somebody else's is a 404, not a silent success.
    assert!(store::delete_view(&db, bob, view.id).await.is_err());
    assert!(store::delete_view(&db, alice, view.id).await.is_ok());

    drop_user(&db, alice).await;
    drop_user(&db, bob).await;
}
