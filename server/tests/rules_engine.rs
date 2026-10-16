//! Integration tests for the administration rule engine, against a real
//! database.
//!
//! What is deliberately **not** here: the operator coverage, the nesting, the
//! depth ceiling, the scope algebra and the rollout determinism. Those are pure
//! functions and live as unit tests next to the code they describe, where they
//! run in milliseconds and cannot be skipped for want of a fixture.
//!
//! What is here is everything whose correctness is a property of the *database*:
//! that a rule cannot be written without its version, that a threshold really
//! counts over a rolling window, that a simulation alert cannot reach a badge,
//! and that the feedback guard cuts a chain rather than logging about it.
//!
//! Without `KUBUNO_TEST_DATABASE_URL` these print a notice and pass - see
//! `tests/common`.

mod common;

use kubuno_core::rules::{
    condition::{Condition, Operator},
    model::{Mode, Outcome, Scope, ScopeRef},
    store::{self, RuleDraft},
};
use serde_json::json;
use kubuno_db::{params, DbPool, DbQueryBuilder};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct ColumnNameRow {
    column_name: String,
}

#[derive(sqlx::FromRow)]
struct FlagRow {
    id: Uuid,
    is_simulation: bool,
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/// A trigger of our own, so the tests never depend on the core's catalogue
/// staying exactly as it is today.
async fn seed_trigger(db: &DbPool, key: &str, event_type: &str) {
    db.execute(
        r#"INSERT INTO core.rule_triggers (key, module_id, event_type, label, fields)
           VALUES ($1, 'core', $2, 'Déclencheur de test', '[]'::jsonb)
           ON CONFLICT (key) DO UPDATE SET event_type = EXCLUDED.event_type"#,
        params![key, event_type],
    )
    .await
    .expect("déclencheur de test");
}

fn draft(name: &str, trigger: &str) -> RuleDraft {
    RuleDraft {
        name: name.to_string(),
        description: None,
        trigger_key: trigger.to_string(),
        conditions: Condition::default(),
        actions: vec![],
        mode: Mode::Monitor,
        scope: Scope::default(),
        threshold_count: None,
        threshold_window_s: None,
        rollout_percent: 100,
        severity: "warning".into(),
        priority: 100,
    }
}

async fn cleanup(db: &DbPool, rule_id: Uuid, trigger: &str) {
    // Executions, versions and hits cascade from the rule.
    let _ = db
        .execute("DELETE FROM core.rules WHERE id = $1", params![rule_id])
        .await;
    let _ = db
        .execute("DELETE FROM core.rule_triggers WHERE key = $1", params![trigger])
        .await;
}

// ── Versioning ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn every_write_produces_a_version_in_the_same_transaction() {
    let Some(db) = common::test_pool().await else { return };
    let trigger = "core.test_versioning";
    seed_trigger(&db, trigger, "TestVersioning").await;

    let mut tx = db.begin().await.expect("transaction");
    let rule = store::insert_rule(&mut tx, &draft("v1", trigger), None, Some("création"))
        .await
        .expect("création");
    tx.commit().await.expect("commit");
    assert_eq!(rule.version, 1);

    // Two edits, each bumping the version.
    for (n, name) in [(2, "v2"), (3, "v3")] {
        let mut d = draft(name, trigger);
        d.mode = Mode::Simulate;
        let mut tx = db.begin().await.expect("transaction");
        let updated = store::update_rule(&mut tx, rule.id, &d, None, Some("édition"))
            .await
            .expect("mise à jour");
        tx.commit().await.expect("commit");
        assert_eq!(updated.version, n);
    }

    let versions = store::versions(&db, rule.id).await.expect("versions");
    assert_eq!(versions.len(), 3, "une version par écriture");
    // Newest first, and every version number present exactly once.
    let numbers: Vec<i32> = versions.iter().map(|v| v.version).collect();
    assert_eq!(numbers, vec![3, 2, 1]);

    // The snapshot is the definition as it stood, not a pointer to today's row.
    let v1 = versions.iter().find(|v| v.version == 1).expect("v1");
    assert_eq!(v1.snapshot["name"], json!("v1"));
    assert_eq!(v1.snapshot["mode"], json!("monitor"));
    let v3 = versions.iter().find(|v| v.version == 3).expect("v3");
    assert_eq!(v3.snapshot["name"], json!("v3"));
    assert_eq!(v3.snapshot["mode"], json!("simulate"));

    cleanup(&db, rule.id, trigger).await;
}

#[tokio::test]
async fn a_rolled_back_write_leaves_neither_a_rule_nor_a_version() {
    let Some(db) = common::test_pool().await else { return };
    let trigger = "core.test_rollback";
    seed_trigger(&db, trigger, "TestRollback").await;

    let mut tx = db.begin().await.expect("transaction");
    let rule = store::insert_rule(&mut tx, &draft("annulée", trigger), None, None)
        .await
        .expect("création");
    // The handler's `?` would do this. The rule and its version must vanish
    // together - a version without its rule is what makes an execution log
    // unreadable.
    drop(tx);

    let orphan_versions: i64 = db
        .fetch_scalar::<i64>(
            "SELECT COUNT(*) FROM core.rule_versions WHERE rule_id = $1",
            params![rule.id],
        )
        .await
        .expect("comptage");
    assert_eq!(orphan_versions, 0);
    assert!(store::get_rule(&db, rule.id).await.is_err());

    cleanup(&db, rule.id, trigger).await;
}

// ── Threshold ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_threshold_counts_over_a_rolling_window_and_per_subject() {
    let Some(db) = common::test_pool().await else { return };
    let trigger = "core.test_threshold";
    seed_trigger(&db, trigger, "TestThreshold").await;

    let mut d = draft("seuil", trigger);
    d.threshold_count = Some(3);
    d.threshold_window_s = Some(600);
    let mut tx = db.begin().await.expect("transaction");
    let rule = store::insert_rule(&mut tx, &d, None, None).await.expect("création");
    tx.commit().await.expect("commit");

    // Three occurrences on the same subject: the count reaches the threshold on
    // the third and not before.
    for expected in 1..=3 {
        let n = store::hit_and_count(&db, rule.id, "user:alice", 600)
            .await
            .expect("comptage");
        assert_eq!(n, expected);
    }

    // A different subject counts separately - otherwise "5 failures on one
    // account" would fire on five accounts failing once each.
    let n = store::hit_and_count(&db, rule.id, "user:bob", 600)
        .await
        .expect("comptage");
    assert_eq!(n, 1);

    // Occurrences outside the window are not counted. The rows are there; the
    // window is what excludes them.
    db.execute(
        "UPDATE core.rule_hits SET occurred_at = $1 WHERE rule_id = $2",
        params![chrono::Utc::now() - chrono::Duration::hours(2), rule.id],
    )
    .await
    .expect("vieillissement");
    let n = store::hit_and_count(&db, rule.id, "user:alice", 600)
        .await
        .expect("comptage");
    assert_eq!(n, 1, "seule l'occurrence qui vient d'être écrite est dans la fenêtre");

    cleanup(&db, rule.id, trigger).await;
}

// ── Execution log ────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_run_log_records_structure_and_counters_but_no_inspected_content() {
    let Some(db) = common::test_pool().await else { return };
    let trigger = "core.test_log";
    seed_trigger(&db, trigger, "TestLog").await;

    let mut tx = db.begin().await.expect("transaction");
    let rule = store::insert_rule(&mut tx, &draft("journal", trigger), None, None)
        .await
        .expect("création");
    tx.commit().await.expect("commit");

    let mut exec = store::NewExecution::new(&rule, Mode::Simulate, Outcome::Matched, "TestLog");
    exec.resource_type = Some("document".into());
    exec.resource_id = Some("doc-1".into());
    exec.detail = json!({ "leaves_evaluated": 2 });
    exec.duration_ms = 7;
    let id = store::record_execution(&db, &exec).await.expect("écriture");
    assert!(id > 0);

    let rows = store::list_executions(
        &db,
        &store::ExecutionQuery {
            rule_id: Some(rule.id),
            ..Default::default()
        },
    )
    .await
    .expect("lecture");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.rule_version, rule.version, "l'exécution nomme sa version");
    assert_eq!(row.mode, "simulate");
    assert_eq!(row.outcome, "matched");
    assert_eq!(row.resource_id.as_deref(), Some("doc-1"));

    // The column set itself is the guarantee: there is nowhere to put a value a
    // rule inspected, and this fails if somebody adds one.
    let columns: Vec<String> = db
        .fetch_all_as::<ColumnNameRow>(
            "SELECT column_name::text FROM information_schema.columns
          WHERE table_schema = 'core' AND table_name = 'rule_executions'",
            params![],
        )
        .await
        .expect("colonnes")
        .into_iter()
        .map(|r| r.column_name)
        .collect();
    for forbidden in ["facts", "payload", "values", "event_payload", "matched_value"] {
        assert!(
            !columns.iter().any(|c| c == forbidden),
            "core.rule_executions ne doit pas porter de colonne « {forbidden} »"
        );
    }

    cleanup(&db, rule.id, trigger).await;
}

// ── Simulation alerts are quarantined ────────────────────────────────────────

#[tokio::test]
async fn a_simulation_alert_is_never_counted_and_never_merged_into_a_real_one() {
    use kubuno_core::alerts::{self, NewAlert, Severity};

    let Some(db) = common::test_pool().await else { return };
    let marker = Uuid::new_v4();

    // The same problem, observed by a rule that is only simulating and by one
    // that is running for real.
    let simulated = NewAlert::new(
        alerts::catalog::RULE_MATCHED,
        alerts::catalog::SRC_RULES,
        Severity::Critical,
        "simulation",
    )
    .simulated()
    .dedup(marker);
    let real = NewAlert::new(
        alerts::catalog::RULE_MATCHED,
        alerts::catalog::SRC_RULES,
        Severity::Critical,
        "réelle",
    )
    .dedup(marker);

    // The wall holds at the identity level: the two never share a dedup key, so
    // a simulated observation cannot bump a real alert's counter.
    assert_ne!(simulated.dedup_key, real.dedup_key);
    assert!(simulated.dedup_key.starts_with("sim:"));

    let a = alerts::raise(&db, simulated).await.expect("levée simulée");
    let b = alerts::raise(&db, real).await.expect("levée réelle");
    assert_ne!(a.id, b.id, "deux lignes distinctes");
    assert!(a.created && b.created);

    let mut qb = DbQueryBuilder::new(
        db.backend(),
        "SELECT id, is_simulation FROM core.alerts WHERE id",
    );
    qb.push_in(vec![a.id, b.id]);
    let flags: Vec<FlagRow> = qb.fetch_all_as::<FlagRow>(&db).await.expect("relecture");
    assert_eq!(
        flags.iter().find(|r| r.id == a.id).map(|r| r.is_simulation),
        Some(true)
    );
    assert_eq!(
        flags.iter().find(|r| r.id == b.id).map(|r| r.is_simulation),
        Some(false)
    );

    // And the counters the badges are built from ignore it entirely.
    let mut qb = DbQueryBuilder::new(db.backend(), "SELECT COUNT(*) FROM core.alerts WHERE id");
    qb.push_in(vec![a.id, b.id]);
    qb.push(" AND status IN ('new','acknowledged') AND is_simulation = FALSE");
    let counted: i64 = qb.fetch_scalar::<i64>(&db).await.expect("comptage");
    assert_eq!(counted, 1, "seule l'alerte réelle est comptée");

    let mut qb = DbQueryBuilder::new(db.backend(), "DELETE FROM core.alerts WHERE id");
    qb.push_in(vec![a.id, b.id]);
    let _ = qb.execute(&db).await;
}

// ── The feedback guard ───────────────────────────────────────────────────────

#[tokio::test]
async fn the_feedback_guard_cuts_a_chain_before_the_conditions_are_even_read() {
    use kubuno_core::events::{AppEvent, EventEnvelope, EventMeta};
    use kubuno_core::rules::{engine, facts};

    let Some(db) = common::test_pool().await else { return };
    let trigger = "core.test_loop";
    seed_trigger(&db, trigger, "TestLoop").await;

    // A rule whose condition can NEVER hold. If the guard did not fire first,
    // the outcome would be `no_match` - so this also proves the ordering.
    let mut d = draft("boucle", trigger);
    d.conditions = Condition::Compare {
        field: "impossible".into(),
        op: Operator::Eq,
        value: json!("jamais"),
    };
    let mut tx = db.begin().await.expect("transaction");
    let rule = store::insert_rule(&mut tx, &d, None, None).await.expect("création");
    tx.commit().await.expect("commit");

    let make = |depth: u16| {
        let event = AppEvent::Custom {
            event_type: "TestLoop".into(),
            module_id: "core".into(),
            payload: json!({}),
        };
        facts::facts_of(&EventEnvelope {
            event,
            meta: EventMeta {
                depth,
                ..Default::default()
            },
        })
    };

    // Below the ceiling: the conditions get their say, and refuse.
    let shallow = engine::decide(&db, &rule, &make(0), Mode::Enforce)
        .await
        .expect("évaluation");
    assert_eq!(shallow.outcome, Outcome::NoMatch);

    // At and past the ceiling (default `rules.max_depth` = 3): refused before
    // anything is evaluated.
    for depth in [3u16, 4, 9] {
        let deep = engine::decide(&db, &rule, &make(depth), Mode::Enforce)
            .await
            .expect("évaluation");
        assert_eq!(
            deep.outcome,
            Outcome::DepthExceeded,
            "profondeur {depth} aurait dû être refusée"
        );
    }

    // An event caused by a rule action really does come back one level deeper.
    let caused = EventMeta::caused_by_rule(rule.id, 1);
    assert_eq!(caused.depth, 2);

    cleanup(&db, rule.id, trigger).await;
}

// ── Scope, resolved against real accounts ────────────────────────────────────

#[tokio::test]
async fn a_scope_excludes_an_account_even_when_its_unit_is_included() {
    let Some(db) = common::test_pool().await else { return };

    let unit = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.org_units (id, name) VALUES ($1, 'Test règles')",
        params![unit],
    )
    .await
    .expect("unité");

    let mut ids = Vec::new();
    for n in 0..2 {
        let id = kubuno_db::new_id();
        db.execute(
            r#"INSERT INTO core.users (id, email, username, password_hash, org_unit_id)
               VALUES ($1, $2, $3, 'x', $4)"#,
            params![
                id,
                format!("rules-scope-{n}-{}@test.invalid", Uuid::new_v4()),
                format!("rules-scope-{n}-{}", Uuid::new_v4()),
                unit
            ],
        )
        .await
        .expect("compte");
        ids.push(id);
    }

    let scope = Scope {
        include: vec![ScopeRef::OrgUnit {
            id: unit,
            descendants: true,
        }],
        exclude: vec![ScopeRef::User { id: ids[1] }],
    };

    // Resolved from the database - unit chain and group memberships - not from
    // a hand-built fixture.
    let inside = store::resolve_subject(&db, ids[0]).await.expect("sujet");
    let excepted = store::resolve_subject(&db, ids[1]).await.expect("sujet");
    assert!(inside.unit_chain.contains(&unit));
    assert!(scope.covers(&inside));
    assert!(!scope.covers(&excepted), "l'exclusion doit primer sur l'unité");

    // An account that no longer exists is covered by nothing.
    let gone = store::resolve_subject(&db, Uuid::new_v4()).await.expect("sujet");
    assert!(!scope.covers(&gone));

    for id in ids {
        let _ = db
            .execute("DELETE FROM core.users WHERE id = $1", params![id])
            .await;
    }
    let _ = db
        .execute("DELETE FROM core.org_units WHERE id = $1", params![unit])
        .await;
}

// ── The catalogue ────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_module_cannot_declare_outside_its_own_namespace() {
    use kubuno_core::rules::catalog::{self, ActionDef, TriggerDef};

    let Some(db) = common::test_pool().await else { return };
    let module = format!("testmod{}", &Uuid::new_v4().simple().to_string()[..8]);

    // The core's own catalogue is declared at bootstrap, which no test runs; it
    // is seeded here so the "a module cannot touch core's entries" assertion
    // below has something to protect.
    kubuno_core::rules::declare::register(&db)
        .await
        .expect("catalogue du core");

    let mut tx = db.begin().await.expect("transaction");
    catalog::register_module(
        &mut tx,
        &module,
        &[
            TriggerDef {
                key: "thing_happened".into(),
                event_type: format!("{module}.thing_happened"),
                label: "Chose".into(),
                description: None,
                fields: vec![],
            },
            // Refused and skipped, not silently double-prefixed.
            TriggerDef {
                key: "core.account_created".into(),
                event_type: "UserCreated".into(),
                label: "Détournement".into(),
                description: None,
                fields: vec![],
            },
        ],
        &[ActionDef {
            key: "do_thing".into(),
            label: "Faire".into(),
            description: None,
            endpoint: Some("/internal/rules/do-thing".into()),
            params: vec![],
            blocking: false,
            reversible: false,
        }],
    )
    .await
    .expect("enregistrement");
    tx.commit().await.expect("commit");

    let triggers = catalog::list_triggers(&db).await.expect("catalogue");
    let mine: Vec<_> = triggers.iter().filter(|t| t.module_id == module).collect();
    assert_eq!(mine.len(), 1, "la déclaration hors espace est ignorée");
    assert_eq!(mine[0].key, format!("{module}.thing_happened"));

    // The core's own entry is untouched by the attempt.
    assert!(triggers
        .iter()
        .any(|t| t.key == "core.account_created" && t.module_id == "core"));

    let action = catalog::resolve_action(&db, &format!("{module}.do_thing"))
        .await
        .expect("résolution")
        .expect("action présente");
    assert_eq!(action.module_id, module);
    assert_eq!(action.endpoint.as_deref(), Some("/internal/rules/do-thing"));

    // Re-registering without them purges what the module no longer declares.
    let mut tx = db.begin().await.expect("transaction");
    catalog::register_module(&mut tx, &module, &[], &[])
        .await
        .expect("ré-enregistrement");
    tx.commit().await.expect("commit");

    let triggers = catalog::list_triggers(&db).await.expect("catalogue");
    assert!(!triggers.iter().any(|t| t.module_id == module));
    assert!(catalog::resolve_action(&db, &format!("{module}.do_thing"))
        .await
        .expect("résolution")
        .is_none());
}
