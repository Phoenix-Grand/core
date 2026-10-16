//! Administrative audit trail.
//!
//! `core.event_log` answers "what happened to the system". This module answers
//! the question an operator actually asks after an incident: **who did it, from
//! where, with what credential, to what, and what did it change** - including
//! the attempts that were refused.
//!
//! ## Shape of the thing
//!
//! ```text
//!   AdminAudit          extractor: authorises like AdminUser *and* hands over
//!                       the request-scoped AuditContext (actor + address + UA)
//!        │
//!        ├─ .begin(db) ─► AuditTx ──── .commit(entry) ─► mutation + entry, one COMMIT
//!        │                   └── no other way to commit exists
//!        │
//!        └─ .record(db, entry)        escape hatch: refusals, failed sign-ins,
//!                                     detached background work
//! ```
//!
//! Every snapshot placed in `before` / `after` goes through [`redact`], which
//! keeps only fields explicitly whitelisted for the target type.
//!
//! ## Retention purge
//!
//! [`retention::purge_expired`] is a plain async function; this module still
//! ships **no scheduler of its own**. It is driven by the core's job runner as
//! the recurring job type [`crate::jobs::builtin::PURGE_ADMIN_AUDIT`]
//! (`core.purge_admin_audit`), declared next to `core.cleanup_event_log` in
//! `jobs/builtin.rs`: registered at bootstrap, armed once at startup, and
//! re-armed at +24 h by its own handler.
//!
//! It can also be run on demand from SQL: `SELECT core.purge_admin_audit(400);`
//! - though that path bypasses the trail entry the job writes.

pub mod chain;
pub mod context;
pub mod model;
pub mod query;
pub mod redact;
pub mod retention;
pub mod writer;

pub use context::{
    anonymous_context, context_from, login_context, record_refusal, AdminAudit,
};
pub use model::{
    ActorOrigin, AuditActor, AuditContext, AuditEntry, AuditRow, Outcome, TargetRef,
};
pub use query::{AuditQuery, Cursor};
pub use writer::{snap, AuditTx};
