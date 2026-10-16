//! Administration rule engine - "when x happens, do y".
//!
//! This is what turns the console from a dashboard into an instrument of
//! operation: an administrator states a reaction once, and the instance carries
//! it out at machine speed, on a population described rather than enumerated.
//! Everything below exists to make that safe.
//!
//! ## The rule the whole design rests on: the core knows no module
//!
//! ```text
//!   module registration ──► catalog::register_module ──┐
//!                                                      ├─► core.rule_triggers
//!   crate::rules::declare ─► catalog::register_core ───┘    core.rule_actions
//!                                                                  │
//!   bus event ─► index (memory) ─► engine::decide ─► dispatch ──────┘
//!                                        │                │
//!                                        │                ├─ core action: in process
//!                                        │                └─ module action: POST to the
//!                                        │                   endpoint the module declared
//!                                        └─► core.rule_executions (structural only)
//! ```
//!
//! The core declares its own triggers and actions **through the same function**
//! a module uses, into the same two tables, with the same validation and the
//! same forced prefixing. Grep this directory for a module identifier: the only
//! one is the `"core"` of [`catalog::CORE_NAMESPACE`]. Installing a module
//! requires zero lines here.
//!
//! ## A closed vocabulary, never an expression language
//!
//! Conditions are a serde enum ([`condition::Condition`], [`condition::Operator`])
//! with bounded depth and breadth, validated on write. A rule is auditable by
//! reading it and offers no surface for injection - see the header of
//! [`condition`] for why a small parser would have been the wrong trade.
//!
//! ## The five degrees of caution
//!
//! | mode | evaluates | logs | acts | alerts |
//! |---|---|---|---|---|
//! | `inactive` | no | no | no | no |
//! | `simulate` | yes | yes | **no** | yes, **isolated** |
//! | `monitor`  | yes | yes | no | yes, real |
//! | `enforce`  | yes | yes | **yes** | yes |
//! | `backtest` | yes | yes | no | no |
//!
//! Simulation alerts are quarantined at the identity level, not merely filtered
//! at read time ([`crate::alerts::NewAlert::simulated`]).
//!
//! ## Where each piece lives
//!
//! * [`catalog`] - what modules and the core may declare, and orphan handling;
//! * [`declare`] - the core's own triggers and actions;
//! * [`condition`] - the vocabulary and the evaluator;
//! * [`model`] - modes, scope, severity, the rule itself;
//! * [`facts`] - event → the JSON a rule is evaluated against;
//! * [`validate`] - everything refusable, on write, once;
//! * [`store`] - rules, versions (same transaction), executions, thresholds;
//! * [`index`] - the memory index and its `LISTEN/NOTIFY` reload;
//! * [`engine`] - the gates, in order, plus the feedback guard;
//! * [`dispatch`] - actions, via the job runner, with idempotency;
//! * [`backtest`] - the retrospective replay and its stated limits;
//! * [`jobs`] - the three job types;
//! * [`detect`] - content detectors, their bounded scanning, and the counters
//!   that are the only thing an inspection ever leaves behind;
//! * [`gate`] - the synchronous portal a module asks *before* it commits, and
//!   its fail policy.
//!
//! ## Reacting is not enough: the synchronous gate
//!
//! Everything above reacts *after* the fact. A message whose account numbers
//! have already been sent is not saved by an alert raised a second later, so
//! [`gate`] is a second entry point into the **same** evaluator: a module asks
//! before it commits and waits for allow, warn or block. It adds no vocabulary
//! - a data-protection rule is an ordinary rule, with a [`detect`] leaf in its
//! condition tree and a verdict in its action list - and it inherits scope,
//! rollout, the five modes and the run log unchanged. Only `enforce` blocks;
//! `monitor` writes down what it would have blocked, which is how a blocking
//! rule gets armed by somebody who has already seen what it does.
//!
//! ## Not to be confused with `flow`
//!
//! The `flow` module is a **per-user** orchestrator, which its user may bypass
//! because it is theirs. This is a **per-administrator** control which its
//! subject may not. They share no code, and merging them would mean either
//! giving users a governance surface or taking their automation away.

pub mod actions;
pub mod backtest;
pub mod catalog;
pub mod condition;
pub mod declare;
pub mod detect;
pub mod dispatch;
pub mod engine;
pub mod facts;
pub mod gate;
pub mod index;
pub mod jobs;
pub mod model;
pub mod store;
pub mod validate;

pub use gate::{Decision, FailMode, GateRequest, GateResponse};
pub use model::{Mode, Outcome, Rule, Scope, ScopeRef};

/// Privilege keys this feature checks by name.
///
/// Re-exported from [`crate::authz::keys`] rather than redeclared: two constants
/// holding the same string is one refactor away from being two constants holding
/// different strings, and the one that drifts is always the one that fails open.
pub mod keys {
    pub use crate::authz::keys::{RULES_MANAGE, RULES_READ};
}

use std::sync::Arc;

use kubuno_db::DbPool;

use crate::events::EventBus;

/// Brings the engine up: declares the core's catalogue, builds the memory index,
/// starts the reload listener and the event worker.
///
/// Every failure here is logged and tolerated. An instance whose rules cannot be
/// loaded must still serve its users - the engine is an operator's convenience,
/// not a dependency of signing in.
pub async fn start(db: DbPool, bus: Arc<EventBus>) {
    if let Err(e) = declare::register(&db).await {
        tracing::error!(error = %e, "rules: déclaration du catalogue du core impossible");
    }
    if let Err(e) = catalog::refresh_orphans(&db).await {
        tracing::warn!(error = %e, "rules: réévaluation des entrées orphelines impossible");
    }
    match index::reload(&db).await {
        Ok(n) => tracing::info!(règles = n, "Moteur de règles initialisé"),
        Err(e) => tracing::error!(error = %e, "rules: construction initiale de l'index impossible"),
    }
    index::start_listener(db.clone()).await;
    tokio::spawn(engine::run(bus, db));
}
