//! Alert centre - the queue of what demands the operator's attention.
//!
//! ## Why a third table, next to the audit trail and the event log
//!
//! `core.event_log` says what happened to the system. `core.admin_audit` says
//! who did what. Both are read backwards, after an incident, and neither has a
//! state: an operator scanning them decides, line by line, whether a fact is
//! still true and whether anybody dealt with it.
//!
//! An alert is a different object. It is **open until somebody closes it**, it
//! has exactly one owner, it keeps a history of what was tried - and, above
//! everything else, it ships with **what to do about it**. That last point is
//! the design rule of the whole feature, enforced by a test in [`catalog`]: an
//! alert type that cannot recommend an action is not created, because a badge
//! over a second event list is worse than no badge at all.
//!
//! ## Shape
//!
//! ```text
//!   producers ──raise()──►  core.alerts  ──── dedup_key (partial UNIQUE)
//!   (crate::alerts::producers)   │              recurrence ⇒ counter++, not a row
//!        ▲                       │
//!        │                       ├──► core.alert_events   the timeline
//!   crate::jobs (core.alerts.scan)└──► catalog::actions_for()  what to do
//! ```
//!
//! * [`model`] - wire types, the lifecycle, the action shape;
//! * [`catalog`] - the alert types and their recommended actions;
//! * [`store`] - deduplicating upsert, queue reads, transitions;
//! * [`producers`] - the detectors, each over something the core already records;
//! * [`jobs`] - the recurring scan, as a type of the **existing** job runner.
//!
//! ## Deduplication, in one sentence
//!
//! Raising an alert is an upsert on `dedup_key`, so a module down for a week is
//! one row whose counter grows - see the header of migration `000056` for why
//! `ignored` absorbs recurrences and `resolved` does not.
//!
//! ## Authorisation
//!
//! Two privileges: `core.alerts.read` opens the queue, `core.alerts.manage`
//! changes it. On top of that, each alert *type* declares the privilege its
//! subject needs ([`catalog::read_privilege`]), so a delegated operator sees the
//! alerts they could act on rather than a list of somebody else's problems -
//! the same rule [`crate::health`] applies to its report.

pub mod catalog;
pub mod jobs;
pub mod model;
pub mod producers;
pub mod store;

pub use model::{
    Action, AlertEventRow, AlertRow, AlertSummary, AlertView, NewAlert, Severity, Status,
};
pub use store::{raise, AlertQuery};

/// Privilege keys this feature checks by name.
///
/// Re-exported from [`crate::authz::keys`] rather than redeclared: two constants
/// holding the same string is one refactor away from being two constants holding
/// different strings, and the one that drifts is always the one that fails open.
pub mod keys {
    pub use crate::authz::keys::{ALERTS_MANAGE, ALERTS_READ};
}
