//! The evaluator: one event in, zero or more rule executions out.
//!
//! ## The order of the gates, and why it is that order
//!
//! ```text
//!   event ─► index lookup ─► depth guard ─► conditions ─► scope ─► rollout ─► threshold ─► act
//!            (memory)        (cheap, and    (memory)     (1 query  (memory,   (1 query,
//!                             the one that                only if   determin-  only if a
//!                             must run even   scope is    istic)    threshold
//!                             when nothing    non-empty)            exists)
//!                             else does)
//! ```
//!
//! Everything free comes first. The two gates that cost a query are placed
//! behind the conditions, so an instance whose rules almost never match pays
//! almost nothing - and the two that must be *correct* rather than fast (the
//! depth guard, the deterministic rollout) never depend on state that could
//! differ between two processes.
//!
//! ## The feedback loop
//!
//! A rule action changes the instance. Changing the instance emits an event.
//! That event is a trigger. Left alone, "when a setting changes, notify" plus
//! "when a notification is sent, log a setting" is an instance melting down at
//! the speed of PostgreSQL. Every fact therefore carries a **depth**, actions
//! emit their consequences at `depth + 1`, and past `rules.max_depth` the
//! evaluation is refused, logged with the outcome `depth_exceeded`, and raised
//! as a **critical** alert. Cutting the chain silently would trade a meltdown
//! for a mystery.
//!
//! ## Alerts follow the mode, strictly
//!
//! `simulate` raises the alert it would have raised, quarantined
//! (`is_simulation`) so it can never reach a badge or a notification.
//! `monitor` and `enforce` raise it for real. `backtest` raises nothing at all:
//! a retrospective question must not put anything in anybody's queue.

use std::sync::Arc;
use std::time::Instant;

use serde_json::json;
use sha2::{Digest, Sha256};
use kubuno_db::DbPool;
use uuid::Uuid;

use crate::alerts::{self, catalog as alert_catalog, NewAlert};
use crate::errors::AppError;
use crate::events::EventBus;

use super::dispatch::{self, ActionJob};
use super::facts::Facts;
use super::index::{self, CompiledRule};
use super::model::{Mode, Outcome, Rule};
use super::store::{self, NewExecution};

/// Default ceiling on chained rule reactions, when the setting is unreadable.
const DEFAULT_MAX_DEPTH: u64 = 3;

// ── The worker ───────────────────────────────────────────────────────────────

/// Subscribes to the bus and evaluates every event against the memory index.
///
/// One task, for the whole instance. It never blocks on an action: matching
/// enqueues a job and moves on.
pub async fn run(bus: Arc<EventBus>, db: DbPool) {
    let mut rx = bus.subscribe();
    tracing::info!("Moteur de règles à l'écoute du bus d'événements");

    loop {
        match rx.recv().await {
            Ok(envelope) => {
                // The cheapest possible answer to "does anybody care?", before
                // the facts are even built.
                let event_type = crate::events::bus::event_type_name(&envelope.event);
                let snapshot = index::snapshot();
                if !snapshot.watches(&event_type) {
                    continue;
                }

                let facts = super::facts::facts_of(&envelope);
                for compiled in snapshot.for_event(&event_type) {
                    evaluate_live(&db, compiled, &facts).await;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                // Rules are not a security control that may silently miss
                // events: say so loudly.
                tracing::warn!(
                    perdus = n,
                    "Moteur de règles en retard : des événements n'ont pas été évalués"
                );
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                tracing::warn!("Bus d'événements fermé : arrêt du moteur de règles");
                break;
            }
        }
    }
}

/// Evaluates one rule against one live event, logging and acting per its mode.
async fn evaluate_live(db: &DbPool, compiled: &CompiledRule, facts: &Facts) {
    let rule = &compiled.rule;
    let started = Instant::now();

    // The engine can be disarmed instance-wide without touching a single rule.
    if !store::engine_enabled(db).await {
        return;
    }

    let verdict = match decide(db, rule, facts, rule.mode).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, rule_id = %rule.id, "rules: évaluation impossible");
            Verdict::simple(Outcome::Error)
        }
    };

    let elapsed = started.elapsed().as_millis().min(i32::MAX as u128) as i32;
    persist_and_react(db, rule, facts, rule.mode, verdict, elapsed).await;
}

// ── The decision ─────────────────────────────────────────────────────────────

/// What one evaluation concluded.
#[derive(Debug, Clone)]
pub struct Verdict {
    pub outcome: Outcome,
    /// Occurrences counted inside the threshold window, when there is one.
    pub hits: Option<i64>,
}

impl Verdict {
    fn simple(outcome: Outcome) -> Self {
        Self { outcome, hits: None }
    }
}

/// Runs the gates in order and returns the outcome.
///
/// Pure with respect to the world: it reads (the subject, the hit counter) but
/// changes nothing an operator would notice. Acting, logging and alerting are
/// the caller's business, which is what lets the backtest reuse it verbatim.
pub async fn decide(
    db: &DbPool,
    rule: &Rule,
    facts: &Facts,
    mode: Mode,
) -> Result<Verdict, AppError> {
    // ── Gate 1: the feedback guard ───────────────────────────────────────────
    // First, and unconditional. A rule caught in a loop is precisely a rule
    // whose conditions keep matching, so a guard placed after them would run
    // exactly as often as the loop it is supposed to stop.
    let max_depth = store::setting_u64(db, "rules.max_depth", DEFAULT_MAX_DEPTH, 1, 10).await as u16;
    if facts.depth >= max_depth {
        tracing::error!(
            rule_id = %rule.id,
            depth = facts.depth,
            max_depth,
            event_type = %facts.event_type,
            "Chaîne de rétroaction coupée : profondeur maximale atteinte"
        );
        return Ok(Verdict::simple(Outcome::DepthExceeded));
    }

    // ── Gate 2: the conditions ───────────────────────────────────────────────
    if !rule.conditions.matches(&facts.values) {
        return Ok(Verdict::simple(Outcome::NoMatch));
    }

    // ── Gate 3: the scope ────────────────────────────────────────────────────
    // The only place the evaluator touches the database on a match, and it is
    // skipped entirely for a rule that applies to everybody.
    if !rule.scope.is_everyone() {
        let subject = match facts.subject_user_id {
            Some(uid) => store::resolve_subject(db, uid).await?,
            // An event about nobody cannot be inside a scope that names people.
            None => Default::default(),
        };
        if !rule.scope.covers(&subject) {
            return Ok(Verdict::simple(Outcome::OutOfScope));
        }
    }

    // ── Gate 4: the progressive rollout ──────────────────────────────────────
    if !in_rollout(rule.id, &facts.subject_key(), rule.rollout_percent) {
        return Ok(Verdict::simple(Outcome::OutOfRollout));
    }

    // ── Gate 5: the threshold ────────────────────────────────────────────────
    if let Some((count, window)) = rule.threshold() {
        // A backtest must not write hit rows: it would poison the live counters
        // of a rule that is running for real.
        if mode == Mode::Backtest {
            return Ok(Verdict {
                outcome: Outcome::Matched,
                hits: None,
            });
        }
        let hits = store::hit_and_count(db, rule.id, &facts.subject_key(), window).await?;
        if hits < i64::from(count) {
            return Ok(Verdict {
                outcome: Outcome::BelowThreshold,
                hits: Some(hits),
            });
        }
        return Ok(Verdict {
            outcome: if mode.acts() && !rule.actions.is_empty() {
                Outcome::Acted
            } else {
                Outcome::Matched
            },
            hits: Some(hits),
        });
    }

    Ok(Verdict {
        outcome: if mode.acts() && !rule.actions.is_empty() {
            Outcome::Acted
        } else {
            Outcome::Matched
        },
        hits: None,
    })
}

// ── Deterministic rollout ────────────────────────────────────────────────────

/// Is this subject inside the rule's pilot?
///
/// **Deterministic**, and that is the entire requirement. A random draw per
/// evaluation would put an account in the pilot on Monday and out of it on
/// Tuesday: the rule would half-apply to everybody instead of fully applying to
/// some, every measurement taken from it would be meaningless, and an account
/// could be suspended by a rule that "does not apply" to it on the next look.
///
/// The draw is `SHA-256(rule_id : subject) mod 100`, so it is stable across
/// processes, restarts, and versions of this binary - and different for each
/// rule, so two 10% pilots do not silently target the same tenth of the
/// population.
pub fn in_rollout(rule_id: Uuid, subject_key: &str, percent: i16) -> bool {
    if percent >= 100 {
        return true;
    }
    if percent <= 0 {
        return false;
    }
    let digest = Sha256::digest(format!("{rule_id}:{subject_key}").as_bytes());
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    let bucket = (u64::from_be_bytes(bytes) % 100) as i16;
    bucket < percent
}

// ── Logging, alerting, acting ────────────────────────────────────────────────

async fn persist_and_react(
    db: &DbPool,
    rule: &Rule,
    facts: &Facts,
    mode: Mode,
    verdict: Verdict,
    duration_ms: i32,
) {
    // Non-matches are persisted in simulation only. In `enforce`, one row per
    // event of the trigger's type is a table nobody can keep and nobody reads.
    let uninteresting = matches!(
        verdict.outcome,
        Outcome::NoMatch | Outcome::OutOfScope | Outcome::OutOfRollout
    );
    if uninteresting && !mode.logs_non_matches() {
        return;
    }

    let matched = matches!(verdict.outcome, Outcome::Matched | Outcome::Acted);

    let mut detail = json!({
        "leaves_evaluated": rule.conditions.leaves(),
        "scope_applied":    !rule.scope.is_everyone(),
        "rollout_percent":  rule.rollout_percent,
    });
    if let (Some(hits), Some((count, window))) = (verdict.hits, rule.threshold()) {
        detail["threshold"] = json!({ "hits": hits, "needed": count, "window_s": window });
    }

    let mut exec = NewExecution::new(rule, mode, verdict.outcome, facts.event_type.clone());
    exec.actor_user_id = facts.subject_user_id;
    exec.resource_type = facts.resource_type.clone();
    exec.resource_id = facts.resource_id.clone();
    exec.depth = i16::try_from(facts.depth).unwrap_or(i16::MAX);
    exec.duration_ms = duration_ms;
    exec.detail = detail;
    exec.actions_total = if matched {
        i16::try_from(rule.actions.len()).unwrap_or(i16::MAX)
    } else {
        0
    };

    let execution_id = match store::record_execution(db, &exec).await {
        Ok(id) => id,
        Err(_) => return, // already logged
    };

    // ── The feedback alert ───────────────────────────────────────────────────
    // Raised whatever the mode, including backtest: a loop discovered by a
    // replay is still a defect in a rule that exists.
    if verdict.outcome == Outcome::DepthExceeded {
        let alert = NewAlert::new(
            alert_catalog::RULE_FEEDBACK_LOOP,
            alert_catalog::SRC_RULES,
            alerts::Severity::Critical,
            format!("Boucle de rétroaction coupée : règle « {} »", rule.name),
        )
        .summary(format!(
            "Une action de règle a produit un événement qui redéclenche une règle. La chaîne a été coupée à la profondeur {}.",
            facts.depth
        ))
        .payload(json!({
            "rule_id":    rule.id,
            "rule_name":  rule.name,
            "event_type": facts.event_type,
            "depth":      facts.depth,
        }))
        .dedup(rule.id);
        if let Err(e) = alerts::raise(db, alert).await {
            tracing::error!(error = %e, "rules: levée de l'alerte de rétroaction");
        }
        return;
    }

    if !matched {
        return;
    }

    // ── The match alert ──────────────────────────────────────────────────────
    if mode.alerts() {
        let mut alert = NewAlert::new(
            alert_catalog::RULE_MATCHED,
            alert_catalog::SRC_RULES,
            rule.severity(),
            format!("Règle « {} » déclenchée", rule.name),
        )
        .payload(json!({
            "rule_id":         rule.id,
            "rule_name":       rule.name,
            "rule_version":    rule.version,
            "mode":            mode.as_str(),
            "event_type":      facts.event_type,
            "subject_user_id": facts.subject_user_id,
            // Structural only. Not one value the rule inspected.
            "would_act":       !mode.acts() && !rule.actions.is_empty(),
        }));
        if mode.alerts_are_isolated() {
            // The wall. Applied before `dedup` so the namespacing survives it.
            alert = alert.simulated();
        }
        alert = alert.dedup(format!(
            "{}:{}",
            rule.id,
            facts
                .subject_user_id
                .map(|u| u.to_string())
                .unwrap_or_else(|| "-".into())
        ));
        if let Some(uid) = facts.subject_user_id {
            alert = alert.subject(uid);
        }
        if let Err(e) = alerts::raise(db, alert).await {
            tracing::error!(error = %e, rule_id = %rule.id, "rules: levée de l'alerte de correspondance");
        }
    }

    // ── The actions ──────────────────────────────────────────────────────────
    // Exactly one mode reaches this line.
    if !mode.acts() || rule.actions.is_empty() {
        return;
    }

    let job = ActionJob {
        execution_id,
        rule_id: rule.id,
        rule_version: rule.version,
        rule_name: rule.name.clone(),
        severity: rule.severity.clone(),
        event_type: facts.event_type.clone(),
        subject_user_id: facts.subject_user_id,
        resource_type: facts.resource_type.clone(),
        resource_id: facts.resource_id.clone(),
        depth: facts.depth,
        actions: rule.actions.clone(),
    };
    if let Err(e) = dispatch::enqueue(db, &job).await {
        tracing::error!(error = %e, rule_id = %rule.id, "rules: mise en file des actions");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn rule_id(n: u8) -> Uuid {
        Uuid::from_bytes([n; 16])
    }

    #[test]
    fn a_full_rollout_includes_everybody_and_an_empty_one_nobody() {
        let id = rule_id(1);
        for subject in ["user:a", "user:b", "event:x"] {
            assert!(in_rollout(id, subject, 100));
            assert!(in_rollout(id, subject, 101), "au-delà de 100 = tout le monde");
            assert!(!in_rollout(id, subject, 0));
            assert!(!in_rollout(id, subject, -1), "en deçà de 0 = personne");
        }
    }

    #[test]
    fn the_rollout_is_stable_for_a_given_subject() {
        // The property the whole pilot rests on: asked a thousand times, the
        // same answer. A random draw here would make every measurement taken
        // from a pilot meaningless.
        let id = rule_id(2);
        let first = in_rollout(id, "user:alice", 50);
        for _ in 0..1_000 {
            assert_eq!(in_rollout(id, "user:alice", 50), first);
        }
    }

    #[test]
    fn the_rollout_is_monotonic_in_the_percentage() {
        // Widening a pilot may only add subjects, never swap them: an account
        // that was being acted upon at 20% must still be at 40%.
        let id = rule_id(3);
        for n in 0..200 {
            let subject = format!("user:{n}");
            let mut was_in = false;
            for percent in 0..=100 {
                let now_in = in_rollout(id, &subject, percent);
                if was_in {
                    assert!(now_in, "{subject} sorti du pilote en l'élargissant à {percent}%");
                }
                was_in = now_in;
            }
        }
    }

    #[test]
    fn two_rules_at_the_same_percentage_do_not_pick_the_same_subjects() {
        // Otherwise every 10% pilot on the instance would target the same tenth
        // of the population, and that tenth would carry every experiment.
        let a: HashSet<String> = (0..500)
            .map(|n| format!("user:{n}"))
            .filter(|s| in_rollout(rule_id(4), s, 10))
            .collect();
        let b: HashSet<String> = (0..500)
            .map(|n| format!("user:{n}"))
            .filter(|s| in_rollout(rule_id(5), s, 10))
            .collect();
        assert!(!a.is_empty() && !b.is_empty());
        let shared = a.intersection(&b).count();
        // Independent draws overlap around 1% of 500 ≈ 5 subjects; anything
        // near |a| would mean the rule id is not part of the hash.
        assert!(
            shared * 3 < a.len(),
            "les deux pilotes se recouvrent trop : {shared} sur {}",
            a.len()
        );
    }

    #[test]
    fn the_distribution_is_roughly_the_percentage_asked_for() {
        let id = rule_id(6);
        let population = 5_000;
        let selected = (0..population)
            .filter(|n| in_rollout(id, &format!("user:{n}"), 25))
            .count();
        let ratio = selected as f64 / population as f64;
        assert!(
            (0.22..=0.28).contains(&ratio),
            "25% demandés, {:.1}% obtenus",
            ratio * 100.0
        );
    }
}
