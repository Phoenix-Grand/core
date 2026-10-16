//! The synchronous portal: "may this operation proceed?"
//!
//! Everything else in this directory reacts *after* the fact - an event happens,
//! a rule notices, an action follows. Data protection cannot work that way: a
//! message whose account numbers have already been sent is not saved by an alert
//! raised a second later. So a module asks **before** it commits, and waits for
//! an answer.
//!
//! ```text
//!   module ──POST /internal/rules/gate──► core
//!     │        { trigger, facts, content: { subject, body } }
//!     │
//!     │        ┌─ rules of that trigger, from the memory index
//!     │        ├─ scan once per (detector, part)
//!     │        ├─ evaluate the tree, per rule, in priority order
//!     │        └─ strongest verdict wins
//!     ▼
//!   allow │ warn │ block  + a short reference
//! ```
//!
//! ## Failing open, on purpose, by default
//!
//! A gate that refuses when it is unwell converts a hiccup in the rule engine
//! into an outage of every module that asks it a question - nobody can send a
//! message because the *policy* service is slow. That trade is almost never the
//! right one, so the default is **open**: a timeout or an internal error lets the
//! operation through and is logged loudly. Regulated deployments set
//! `rules.gate.fail_mode` to `closed` and accept the opposite trade knowingly.
//!
//! Both the policy and the deadline are settings rather than constants, because
//! the right answer differs per instance and the wrong answer is discovered in
//! production.
//!
//! The core enforces the deadline **on its own evaluation**; a module enforces
//! the same policy on its own HTTP call, which is the half the core cannot do
//! for it. [`FailMode`] is what both sides name.
//!
//! ## What the blocked user is told
//!
//! "This content carries sensitive data", and a reference. Never the rule, never
//! the detector, never the matched value, never the count. Anybody with a text
//! box and a blocking gate can otherwise map the entire policy by bisection -
//! type a candidate, observe block or allow, repeat. The reference is the whole
//! bridge back to somebody who *can* look: it is indexed on
//! `core.rule_executions`, so a compliance officer pastes it and lands on the
//! run, while the user holding it learns nothing from it.
//!
//! ## What is persisted
//!
//! An execution row: which rule, which version, which mode, which outcome, how
//! many matches, how many distinct values, how long it took. **Not the content,
//! not a value, not an offset, not an excerpt** - in the row, in the response,
//! in the audit trail, or in a log line. The content exists for the length of
//! one function call and is dropped with the request.

use std::time::{Duration, Instant};

use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use kubuno_db::DbPool;
use uuid::Uuid;

use crate::errors::AppError;

use super::detect::{self, Evidence};
use super::facts::Facts;
use super::index;
use super::model::{Outcome, Rule};
use super::store::{self, NewExecution};

/// Action keys whose only meaning is a verdict here.
///
/// They are declared through the ordinary catalogue path ([`super::declare`]),
/// so the rule editor offers them like any other action and the console renders
/// them like any other action - but they are read rather than dispatched. The
/// asymmetry is stated here rather than hidden: an action that changes nothing
/// and is consumed synchronously is a different animal from one the job runner
/// carries out, and pretending otherwise would mean a rule in `enforce` mode
/// quietly enqueuing a job that does nothing.
pub const ACTION_BLOCK: &str = "core.block_operation";
pub const ACTION_WARN: &str = "core.warn_operation";

/// Default deadline when the setting is unreadable.
const DEFAULT_TIMEOUT_MS: u64 = 2_000;

// ── Fail policy ──────────────────────────────────────────────────────────────

/// What to do when the portal cannot answer in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailMode {
    /// Let the operation through and log it. The default.
    Open,
    /// Refuse the operation. For instances that would rather stop than leak.
    Closed,
}

impl FailMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            FailMode::Open => "open",
            FailMode::Closed => "closed",
        }
    }

    /// Parses the setting, defaulting to `open` for anything unrecognised.
    ///
    /// A typo must not silently arm the strictest policy on the instance: an
    /// operator who meant `closed` and typed `closd` gets the documented
    /// default and a service that still works, rather than an outage whose
    /// cause is a spelling mistake in a settings table.
    pub fn parse(raw: &str) -> Self {
        match raw.trim().trim_matches('"') {
            "closed" => FailMode::Closed,
            _ => FailMode::Open,
        }
    }

    pub async fn from_settings(db: &DbPool) -> Self {
        Self::parse(&detect::store::setting_str(db, "rules.gate.fail_mode", "open").await)
    }
}

// ── Wire types ───────────────────────────────────────────────────────────────

/// What a module asks.
#[derive(Debug, Clone, Deserialize)]
pub struct GateRequest {
    /// Catalogue key of the trigger this operation corresponds to.
    pub trigger: String,
    /// Free label for the operation, e.g. `send`, `share`, `export`. Carried
    /// into the facts so a rule can distinguish them without a trigger each.
    #[serde(default)]
    pub operation: Option<String>,
    /// The account performing the operation.
    #[serde(default)]
    pub actor_user_id: Option<Uuid>,
    #[serde(default)]
    pub resource_type: Option<String>,
    #[serde(default)]
    pub resource_id: Option<String>,
    /// Structural facts a rule may compare. Never content.
    #[serde(default)]
    pub facts: Value,
    /// The parts to inspect: part name → text. **Never stored, never logged.**
    #[serde(default)]
    pub content: std::collections::BTreeMap<String, String>,
}

/// The three answers, ordered by strength.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Warn,
    Block,
}

impl Decision {
    pub const fn as_str(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Warn => "warn",
            Decision::Block => "block",
        }
    }
}

/// What the module gets back.
///
/// Every field here has been weighed against "could a user with a text box learn
/// the policy from it". `decision` and `code` they already know by observation;
/// `reference` is opaque; `message` is the same sentence whatever fired. There
/// is no rule name, no detector key, and no count.
#[derive(Debug, Clone, Serialize)]
pub struct GateResponse {
    pub decision: Decision,
    /// Stable machine code, so a module can localise the sentence itself.
    pub code: &'static str,
    /// The sentence to show, already in the instance's language.
    pub message: String,
    /// Short, copyable, findable in the run log. Present on `warn` and `block`,
    /// and on a degraded answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// The portal could not answer properly and the fail policy was applied.
    pub degraded: bool,
    pub elapsed_ms: u64,
}

/// Machine codes. Deliberately coarse - a finer taxonomy would be the policy,
/// spelled differently.
pub const CODE_OK: &str = "ok";
pub const CODE_SENSITIVE: &str = "sensitive_content";
pub const CODE_UNAVAILABLE: &str = "policy_unavailable";

fn message_for(decision: Decision, degraded: bool) -> String {
    match (decision, degraded) {
        (Decision::Allow, _) => String::new(),
        (Decision::Warn, _) => {
            "Ce contenu semble comporter des données sensibles. Vérifiez avant de continuer.".into()
        }
        (Decision::Block, false) => {
            "Ce contenu comporte des données sensibles et ne peut pas être envoyé.".into()
        }
        (Decision::Block, true) => {
            // The user must be able to tell "the policy says no" from "the
            // policy could not be consulted": the two need different phone
            // calls, and only one of them is their problem to fix.
            "La vérification de conformité est momentanément indisponible et cette instance refuse de continuer sans elle.".into()
        }
    }
}

// ── The reference ────────────────────────────────────────────────────────────

/// Alphabet of a request reference: Crockford base 32, which drops `I`, `L`, `O`
/// and `U`.
///
/// A reference is read aloud on the phone and typed by somebody who is already
/// annoyed. `0`/`O` and `1`/`I` are the two transcription errors that actually
/// happen, and `U` is dropped so no reference can spell an unfortunate word.
const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REFERENCE_LEN: usize = 8;

/// A fresh reference. 32^8 ≈ 1.1×10^12 - collisions do not matter for lookup
/// (the run log is queried by reference *and* time) and the value carries no
/// information about what was found, which is the property that counts.
pub fn new_reference() -> String {
    let mut rng = rand::thread_rng();
    (0..REFERENCE_LEN)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

// ── The portal ───────────────────────────────────────────────────────────────

/// Answers a gate request, applying the fail policy to its own deadline.
///
/// The deadline covers the whole evaluation - every scan, every rule, every
/// write. A module applies the same policy to the HTTP call itself; between the
/// two, neither a slow core nor an unreachable one can hold a user's send button
/// hostage.
pub async fn decide(db: &DbPool, request: GateRequest) -> GateResponse {
    let started = Instant::now();

    if !detect::store::setting_bool(db, "rules.gate.enabled", true).await {
        return GateResponse {
            decision: Decision::Allow,
            code: CODE_OK,
            message: String::new(),
            reference: None,
            degraded: false,
            elapsed_ms: started.elapsed().as_millis() as u64,
        };
    }

    let timeout_ms = store::setting_u64(db, "rules.gate.timeout_ms", DEFAULT_TIMEOUT_MS, 10, 60_000).await;
    let fail_mode = FailMode::from_settings(db).await;

    match tokio::time::timeout(Duration::from_millis(timeout_ms), evaluate(db, &request)).await {
        Ok(Ok(outcome)) => GateResponse {
            decision: outcome.decision,
            code: if outcome.decision == Decision::Allow {
                CODE_OK
            } else {
                CODE_SENSITIVE
            },
            message: message_for(outcome.decision, false),
            reference: outcome.reference,
            degraded: false,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        Ok(Err(e)) => degraded(started, fail_mode, &request, "erreur interne", Some(e)),
        Err(_) => degraded(
            started,
            fail_mode,
            &request,
            "délai dépassé",
            None,
        ),
    }
}

/// Builds the answer the fail policy dictates, and says so in the log.
///
/// The log line is the "journaliser" half of "laisser passer et journaliser":
/// failing open silently would mean an instance whose data protection has been
/// off for a month and nobody knows. It carries the trigger, the reason and the
/// reference - never the content, and never what would have been found.
fn degraded(
    started: Instant,
    fail_mode: FailMode,
    request: &GateRequest,
    reason: &str,
    error: Option<AppError>,
) -> GateResponse {
    let reference = new_reference();
    let elapsed_ms = started.elapsed().as_millis() as u64;

    match fail_mode {
        FailMode::Open => tracing::error!(
            trigger = %request.trigger,
            reference = %reference,
            elapsed_ms,
            raison = %reason,
            error = error.as_ref().map(|e| e.to_string()).unwrap_or_default(),
            "Portail de protection des données dégradé : opération laissée passer (politique « ouverte »)"
        ),
        FailMode::Closed => tracing::error!(
            trigger = %request.trigger,
            reference = %reference,
            elapsed_ms,
            raison = %reason,
            error = error.as_ref().map(|e| e.to_string()).unwrap_or_default(),
            "Portail de protection des données dégradé : opération REFUSÉE (politique « fermée »)"
        ),
    }

    let decision = match fail_mode {
        FailMode::Open => Decision::Allow,
        FailMode::Closed => Decision::Block,
    };
    GateResponse {
        decision,
        code: CODE_UNAVAILABLE,
        message: message_for(decision, true),
        reference: Some(reference),
        degraded: true,
        elapsed_ms,
    }
}

/// What the evaluation concluded, before the fail policy is considered.
struct GateOutcome {
    decision: Decision,
    reference: Option<String>,
}

/// Evaluates every rule of the trigger and returns the strongest verdict.
async fn evaluate(db: &DbPool, request: &GateRequest) -> Result<GateOutcome, AppError> {
    if !store::engine_enabled(db).await {
        return Ok(GateOutcome {
            decision: Decision::Allow,
            reference: None,
        });
    }

    let trigger = request.trigger.trim();
    let snapshot = index::snapshot();
    let candidates: Vec<_> = snapshot
        .for_trigger(trigger)
        .iter()
        .map(|c| c.rule.clone())
        .collect();
    if candidates.is_empty() {
        return Ok(GateOutcome {
            decision: Decision::Allow,
            reference: None,
        });
    }

    // ── Content, bounded before anything looks at it ─────────────────────────
    let max_parts = store::setting_u64(db, "rules.detectors.max_parts", detect::DEFAULT_MAX_PARTS, 1, 64).await;
    let parts: Vec<(String, String)> = request
        .content
        .iter()
        .take(max_parts as usize)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    // ── One scan per (detector, part), for every rule at once ────────────────
    let leaves: Vec<&super::detect::DetectorLeaf> = candidates
        .iter()
        .flat_map(|r| r.conditions.detectors())
        .collect();
    let evidence = if leaves.is_empty() || parts.is_empty() {
        Evidence::empty()
    } else {
        let limits = detect::limits_from_settings(db).await;
        detect::evaluate(&leaves, &parts, &limits)
    };

    // ── Facts. Content is deliberately absent from them ──────────────────────
    let facts = facts_of(request);

    let mut decision = Decision::Allow;
    let mut reference: Option<String> = None;

    for rule in &candidates {
        let started = Instant::now();
        let verdict = decide_rule(db, rule, &facts, &evidence).await?;
        let elapsed = started.elapsed().as_millis().min(i32::MAX as u128) as i32;

        let matched = matches!(verdict, Outcome::Matched | Outcome::Acted);
        if !matched && !rule.mode.logs_non_matches() {
            continue;
        }

        // Only `enforce` applies a verdict. `simulate` and `monitor` evaluate
        // and log what they *would* have done and let the operation through -
        // which is the whole point of having them: an administrator arms a
        // blocking rule after watching it, not before.
        let would = rule_verdict(rule);
        let applied = if matched && rule.mode.acts() {
            would
        } else {
            Decision::Allow
        };
        if applied > decision {
            decision = applied;
        }

        let this_reference = new_reference();
        let mut detail = evidence.counters();
        detail["leaves_evaluated"] = json!(rule.conditions.leaves());
        detail["gate"] = json!({
            "operation":  request.operation,
            "would":      would.as_str(),
            "applied":    applied.as_str(),
            "parts":      parts.len(),
        });

        let mut exec = NewExecution::new(rule, rule.mode, verdict, facts.event_type.clone());
        exec.actor_user_id = request.actor_user_id;
        exec.resource_type = request.resource_type.clone();
        exec.resource_id = request.resource_id.clone();
        exec.duration_ms = elapsed;
        exec.detail = detail;
        exec.gate_reference = Some(this_reference.clone());

        // A failure to log must not turn into a failure to answer: the caller is
        // holding a user's send button. It is already logged by the store.
        let _ = store::record_execution(db, &exec).await;

        // The reference handed back is the one of the run that decided the
        // answer. A `warn` overridden by a later `block` must not leave the user
        // with the reference of the run that did not decide anything.
        if applied == decision && applied != Decision::Allow {
            reference = Some(this_reference);
        }
    }

    Ok(GateOutcome {
        decision,
        reference: if decision == Decision::Allow {
            None
        } else {
            reference
        },
    })
}

/// The gates that apply on the synchronous path.
///
/// Deliberately **not** [`super::engine::decide`]: that one starts with the
/// feedback-depth guard, which is meaningless here (a gate call is not the
/// consequence of a rule action), and it writes threshold hit rows, which on a
/// per-keystroke path would grow a table nobody asked for. Scope and rollout are
/// the two that carry over, and they carry over unchanged.
async fn decide_rule(
    db: &DbPool,
    rule: &Rule,
    facts: &Facts,
    evidence: &Evidence,
) -> Result<Outcome, AppError> {
    if !rule.conditions.matches_with(&facts.values, evidence) {
        return Ok(Outcome::NoMatch);
    }

    if !rule.scope.is_everyone() {
        let subject = match facts.subject_user_id {
            Some(uid) => store::resolve_subject(db, uid).await?,
            None => Default::default(),
        };
        if !rule.scope.covers(&subject) {
            return Ok(Outcome::OutOfScope);
        }
    }

    if !super::engine::in_rollout(rule.id, &facts.subject_key(), rule.rollout_percent) {
        return Ok(Outcome::OutOfRollout);
    }

    Ok(if rule.mode.acts() && !rule.actions.is_empty() {
        Outcome::Acted
    } else {
        Outcome::Matched
    })
}

/// The strongest verdict this rule's action list expresses.
fn rule_verdict(rule: &Rule) -> Decision {
    let mut out = Decision::Allow;
    for spec in &rule.actions {
        let d = match spec.action.as_str() {
            ACTION_BLOCK => Decision::Block,
            ACTION_WARN => Decision::Warn,
            // Every other action is meaningless here and is not run: the gate
            // dispatches nothing. A rule that suspends an account on a *send*
            // would otherwise fire on every keystroke of a draft.
            _ => Decision::Allow,
        };
        if d > out {
            out = d;
        }
    }
    out
}

/// Builds the facts of a gate call. **Content is not in them**, and cannot be:
/// the map is built from `request.facts` and a handful of structural keys.
fn facts_of(request: &GateRequest) -> Facts {
    let mut values = match request.facts.clone() {
        Value::Object(map) => Value::Object(map),
        _ => json!({}),
    };
    if let Value::Object(map) = &mut values {
        map.insert("event_type".into(), json!(request.trigger.trim()));
        map.insert("source_module".into(), json!("gate"));
        map.insert("depth".into(), json!(0));
        if let Some(op) = &request.operation {
            map.insert("operation".into(), json!(op.trim()));
        }
        if let Some(uid) = request.actor_user_id {
            map.insert("actor_user_id".into(), json!(uid));
        }
    }
    Facts {
        event_type: request.trigger.trim().to_string(),
        values,
        subject_user_id: request.actor_user_id,
        resource_type: request.resource_type.clone(),
        resource_id: request.resource_id.clone(),
        depth: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── The fail policy ──────────────────────────────────────────────────────

    #[test]
    fn the_fail_policy_defaults_to_open_including_for_a_typo() {
        assert_eq!(FailMode::parse("open"), FailMode::Open);
        assert_eq!(FailMode::parse("\"open\""), FailMode::Open);
        assert_eq!(FailMode::parse("closed"), FailMode::Closed);
        assert_eq!(FailMode::parse("\"closed\" "), FailMode::Closed);
        // A spelling mistake must not arm the strictest policy on the instance.
        assert_eq!(FailMode::parse("closd"), FailMode::Open);
        assert_eq!(FailMode::parse(""), FailMode::Open);
        assert_eq!(FailMode::parse("strict"), FailMode::Open);
    }

    #[test]
    fn a_degraded_gate_lets_through_when_open_and_refuses_when_closed() {
        let request = GateRequest {
            trigger: "core.content_gate".into(),
            operation: None,
            actor_user_id: None,
            resource_type: None,
            resource_id: None,
            facts: json!({}),
            content: Default::default(),
        };

        let open = degraded(Instant::now(), FailMode::Open, &request, "délai dépassé", None);
        assert_eq!(open.decision, Decision::Allow);
        assert!(open.degraded);
        // Traceable even though it passed: an instance whose protection has
        // been off for a month must be discoverable.
        assert!(open.reference.is_some());
        assert_eq!(open.code, CODE_UNAVAILABLE);

        let closed = degraded(Instant::now(), FailMode::Closed, &request, "délai dépassé", None);
        assert_eq!(closed.decision, Decision::Block);
        assert!(closed.degraded);
        // …and the sentence distinguishes "the policy says no" from "the policy
        // could not be consulted".
        assert!(closed.message.contains("indisponible"));
    }

    // ── What the user is told ────────────────────────────────────────────────

    #[test]
    fn the_blocked_user_is_told_nothing_about_the_policy() {
        let message = message_for(Decision::Block, false);
        for forbidden in [
            "IBAN", "iban", "règle", "detector", "détecteur", "core.", "Finance",
        ] {
            assert!(
                !message.contains(forbidden),
                "le message révèle « {forbidden} » : {message}"
            );
        }
        assert!(message.contains("données sensibles"));

        // The warning says as little.
        let warn = message_for(Decision::Warn, false);
        assert!(!warn.contains("core."));
        assert!(!warn.contains("détecteur"));
    }

    #[test]
    fn a_reference_is_short_copyable_and_free_of_confusable_characters() {
        for _ in 0..200 {
            let r = new_reference();
            assert_eq!(r.len(), REFERENCE_LEN);
            for c in r.chars() {
                assert!(
                    ALPHABET.contains(&(c as u8)),
                    "caractère hors alphabet : {c}"
                );
                // The two transcription errors that actually happen on a phone.
                assert!(!matches!(c, 'I' | 'L' | 'O' | 'U'));
            }
        }
    }

    #[test]
    fn two_references_differ() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1_000 {
            assert!(seen.insert(new_reference()), "référence répétée sur 1 000 tirages");
        }
    }

    // ── Verdict arithmetic ───────────────────────────────────────────────────

    #[test]
    fn the_strongest_verdict_wins_and_ordinary_actions_carry_none() {
        assert!(Decision::Block > Decision::Warn);
        assert!(Decision::Warn > Decision::Allow);
    }

    #[test]
    fn a_gate_request_carries_content_that_never_reaches_the_facts() {
        // The property the whole feature rests on, asserted rather than
        // trusted: whatever a module sends under `content` is not in the object
        // a rule compares, is not in the execution row, and cannot leak through
        // a comparison on a cleverly named field.
        let request = GateRequest {
            trigger: "core.content_gate".into(),
            operation: Some("send".into()),
            actor_user_id: None,
            resource_type: None,
            resource_id: None,
            facts: json!({ "destination": "external" }),
            content: [
                ("body".to_string(), "IBAN FR7630006000011234567890189".to_string()),
                ("subject".to_string(), "confidentiel".to_string()),
            ]
            .into_iter()
            .collect(),
        };

        let facts = facts_of(&request);
        let rendered = serde_json::to_string(&facts.values).expect("sérialisable");
        assert!(!rendered.contains("FR7630006"));
        assert!(!rendered.contains("confidentiel"));
        assert!(rendered.contains("external"));
        assert!(rendered.contains("send"));
        assert_eq!(facts.event_type, "core.content_gate");
        assert_eq!(facts.depth, 0);
    }

    #[test]
    fn facts_that_are_not_an_object_do_not_break_the_gate() {
        for raw in [json!(null), json!(3), json!("x"), json!([1, 2])] {
            let request = GateRequest {
                trigger: "core.content_gate".into(),
                operation: None,
                actor_user_id: None,
                resource_type: None,
                resource_id: None,
                facts: raw,
                content: Default::default(),
            };
            let facts = facts_of(&request);
            assert!(facts.values.is_object());
            assert_eq!(facts.values["event_type"], json!("core.content_gate"));
        }
    }

    #[test]
    fn the_response_carries_no_reference_when_nothing_was_decided() {
        let response = GateResponse {
            decision: Decision::Allow,
            code: CODE_OK,
            message: String::new(),
            reference: None,
            degraded: false,
            elapsed_ms: 1,
        };
        let rendered = serde_json::to_string(&response).expect("sérialisable");
        assert!(!rendered.contains("reference"));
        assert!(rendered.contains("\"decision\":\"allow\""));
    }
}
