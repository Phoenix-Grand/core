//! Wire and value types of the alert centre.
//!
//! Everything an operator sees is computed on the server: the severity, the
//! wording, and above all the **recommended actions**. The console renders them;
//! it never decides what to do about an alert from a value it happens to hold.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::errors::AppError;

// ── Severity ─────────────────────────────────────────────────────────────────

/// How much an alert costs if it is left alone.
///
/// Ordered worst-first, so `sort()` puts the urgent work on top - the same
/// convention as [`crate::health::Severity`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Critical,
    Warning,
    Info,
}

impl Severity {
    pub const ALL: &'static [Severity] = &[Severity::Critical, Severity::Warning, Severity::Info];

    pub const fn as_str(self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::Warning => "warning",
            Severity::Info => "info",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "critical" => Some(Severity::Critical),
            "warning" => Some(Severity::Warning),
            "info" => Some(Severity::Info),
            _ => None,
        }
    }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/// Where an alert stands.
///
/// `new` → `acknowledged` → `resolved` is the flow; `ignored` is a decision
/// taken *beside* it ("this does not apply here"), reachable from any state and
/// reversible like the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Nobody has looked at it yet.
    New,
    /// Somebody took it. This is the state that stops two operators doing the
    /// same work twice.
    Acknowledged,
    /// Somebody states the problem is gone. A recurrence after this opens a
    /// **new** alert - see the deduplication note in migration `000056`.
    Resolved,
    /// Does not apply here. Recurrences keep landing on it, silently.
    Ignored,
}

impl Status {
    pub const ALL: &'static [Status] = &[
        Status::New,
        Status::Acknowledged,
        Status::Resolved,
        Status::Ignored,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Status::New => "new",
            Status::Acknowledged => "acknowledged",
            Status::Resolved => "resolved",
            Status::Ignored => "ignored",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "new" => Some(Status::New),
            "acknowledged" => Some(Status::Acknowledged),
            "resolved" => Some(Status::Resolved),
            "ignored" => Some(Status::Ignored),
            _ => None,
        }
    }

    /// Is the alert still in the queue? `ignored` is closed for the operator's
    /// purposes even though the deduplication index still covers it.
    pub const fn is_open(self) -> bool {
        matches!(self, Status::New | Status::Acknowledged)
    }

    /// Does this state carry a closure timestamp? Mirrors the
    /// `alert_closure_coherent` CHECK constraint.
    pub const fn is_closed(self) -> bool {
        matches!(self, Status::Resolved | Status::Ignored)
    }

    /// May the lifecycle go from `self` to `next`?
    ///
    /// Everything is reachable except a transition to itself - re-asserting the
    /// current state would write a timeline entry that says nothing. Reopening a
    /// closed alert is allowed on purpose: "resolved" is a claim, and claims are
    /// sometimes wrong.
    pub fn may_move_to(self, next: Status) -> bool {
        self != next
    }
}

// ── Recommended actions ──────────────────────────────────────────────────────

/// What to *do* about an alert.
///
/// This is the whole point of the feature. An alert with no action is a log
/// line, and the instance already has two logs. Every action is addressable with
/// the console's deep-action convention - `/admin?tab=<tab>&action=<verb>` - so
/// the operator lands on the surface that performs the task rather than on a
/// page they then have to search.
#[derive(Debug, Clone, Serialize)]
pub struct Action {
    /// Stable identifier. The console renders `admin.alact_<id>`; `label` is the
    /// fallback when a catalogue lags behind the server.
    pub id: String,
    /// Navigable leaf of the admin menu.
    pub tab: String,
    /// The verb the destination claims with `useAdminAction`. Absent when the
    /// target is a place rather than a task.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verb: Option<String>,
    /// Value of `?id=`, when the verb applies to a resource.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    /// Extra query parameters the destination reads (`user`, `audit_action`…).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<(String, String)>,
    /// English wording of the button.
    pub label: String,
    /// Privilege the caller must hold for the action to be offered at all.
    /// Offering a button the server refuses is worse than offering none.
    pub privilege: String,
    /// True when the alert centre itself performs the work (a POST it owns),
    /// false when the action merely opens another surface.
    pub executes: bool,
}

impl Action {
    /// A link into another section.
    pub fn open(id: &str, tab: &str, label: &str, privilege: &str) -> Self {
        Self {
            id: id.to_string(),
            tab: tab.to_string(),
            verb: None,
            target_id: None,
            params: Vec::new(),
            label: label.to_string(),
            privilege: privilege.to_string(),
            executes: false,
        }
    }

    /// A verb claimed by the destination section.
    pub fn verb(mut self, verb: &str) -> Self {
        self.verb = Some(verb.to_string());
        self
    }

    pub fn id_param(mut self, id: impl std::fmt::Display) -> Self {
        self.target_id = Some(id.to_string());
        self
    }

    pub fn param(mut self, key: &str, value: impl std::fmt::Display) -> Self {
        self.params.push((key.to_string(), value.to_string()));
        self
    }

    /// Marks the action as performed by the alert centre (a POST on this very
    /// alert) rather than by another screen.
    pub fn executed_here(mut self) -> Self {
        self.executes = true;
        self
    }
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/// One alert, as the API serves it.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AlertRow {
    pub id: Uuid,
    pub source: String,
    pub kind: String,
    pub severity: String,
    pub status: String,
    pub title: String,
    pub summary: Option<String>,
    pub payload: Value,
    pub module_id: Option<String>,
    pub subject_user_id: Option<Uuid>,
    pub subject_label: Option<String>,
    pub org_unit_id: Option<Uuid>,
    /// Raised by a rule running in simulation. Quarantined out of every badge,
    /// counter and notification - see [`super::store::raise`].
    pub is_simulation: bool,
    /// How many times the same problem was observed. `1` is the common case;
    /// anything higher is what deduplication saved the operator from reading.
    pub occurrences: i32,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub assignee_id: Option<Uuid>,
    pub assignee_label: Option<String>,
    pub assigned_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    /// Computed per request from the catalogue, never stored: the wording of an
    /// action changes with the code, and a stored one would rot. Not a column -
    /// filled in after the row is read.
    #[sqlx(skip)]
    pub actions: Vec<Action>,
}

/// One line of an alert's timeline.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AlertEventRow {
    pub id: i64,
    pub kind: String,
    pub actor_id: Option<Uuid>,
    pub actor_label: String,
    pub from_value: Option<String>,
    pub to_value: Option<String>,
    pub body: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

/// Aggregate counts for the badges - computed server-side so two readers cannot
/// disagree about how many criticals are open.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AlertSummary {
    pub open: i64,
    pub new: i64,
    pub acknowledged: i64,
    pub critical: i64,
    pub warning: i64,
    pub info: i64,
    pub ignored: i64,
    pub resolved: i64,
    /// Open alerts assigned to the caller.
    pub mine: i64,
    /// When the producers last completed a pass. `None` on an instance where
    /// they have never run - the console says so rather than claiming "all
    /// clear" on the strength of an empty table.
    pub last_scan_at: Option<DateTime<Utc>>,
}

/// A saved filter set, owned by one operator.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AlertView {
    pub id: Uuid,
    pub name: String,
    pub filters: Value,
    pub created_at: DateTime<Utc>,
}

/// A new alert as a producer states it.
#[derive(Debug, Clone)]
pub struct NewAlert {
    pub source: &'static str,
    pub kind: &'static str,
    pub severity: Severity,
    pub title: String,
    pub summary: Option<String>,
    pub payload: Value,
    pub module_id: Option<String>,
    pub subject_user_id: Option<Uuid>,
    pub org_unit_id: Option<Uuid>,
    /// Identity of the *problem*. Two observations of the same problem share it.
    pub dedup_key: String,
    /// Raised by a rule in simulation: visible only to somebody who asks for
    /// simulated alerts, never counted, never notified.
    pub is_simulation: bool,
}

impl NewAlert {
    pub fn new(kind: &'static str, source: &'static str, severity: Severity, title: impl Into<String>) -> Self {
        Self {
            source,
            kind,
            severity,
            title: title.into(),
            summary: None,
            payload: Value::Object(Default::default()),
            module_id: None,
            subject_user_id: None,
            org_unit_id: None,
            dedup_key: kind.to_string(),
            is_simulation: false,
        }
    }

    /// Marks the alert as produced by a rule running in simulation.
    ///
    /// The deduplication identity is namespaced at the same time, and that is
    /// not a detail: without it a simulated observation would land on the *real*
    /// alert for the same problem, bumping a counter an operator reads as
    /// genuine. The wall has to hold at the identity level, not only at the
    /// query level.
    pub fn simulated(mut self) -> Self {
        self.is_simulation = true;
        if !self.dedup_key.starts_with("sim:") {
            self.dedup_key = format!("sim:{}", self.dedup_key);
        }
        self
    }

    pub fn summary(mut self, summary: impl Into<String>) -> Self {
        self.summary = Some(summary.into());
        self
    }

    pub fn payload(mut self, payload: Value) -> Self {
        self.payload = payload;
        self
    }

    pub fn module(mut self, module_id: impl Into<String>) -> Self {
        self.module_id = Some(module_id.into());
        self
    }

    pub fn subject(mut self, user_id: Uuid) -> Self {
        self.subject_user_id = Some(user_id);
        self
    }

    /// Sets the deduplication identity. Always `<kind>` plus whatever makes the
    /// problem distinct - never a timestamp, which would defeat the whole point.
    pub fn dedup(mut self, discriminator: impl std::fmt::Display) -> Self {
        // The simulation namespace survives a later `dedup()` call, so the two
        // builders compose in either order. Order-dependent builders are how a
        // simulated alert ends up merged into a real one six months from now.
        let prefix = if self.is_simulation { "sim:" } else { "" };
        self.dedup_key = format!("{prefix}{}:{}", self.kind, discriminator);
        self
    }
}

/// What [`super::store::raise`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RaiseOutcome {
    pub id: Uuid,
    /// True when a row was inserted, false when an existing one absorbed the
    /// observation.
    pub created: bool,
    pub occurrences: i32,
}

// ── Timeline event kinds ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    Created,
    StatusChanged,
    SeverityChanged,
    Assigned,
    Comment,
    Recurrence,
}

impl EventKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            EventKind::Created => "created",
            EventKind::StatusChanged => "status",
            EventKind::SeverityChanged => "severity",
            EventKind::Assigned => "assigned",
            EventKind::Comment => "comment",
            EventKind::Recurrence => "recurrence",
        }
    }
}

/// Longest operator comment kept. Long enough for a paragraph of handover notes,
/// short enough that the column cannot be used as free storage.
pub const MAX_COMMENT_LEN: usize = 2_000;

/// Validates and trims a free-text comment.
pub fn clean_comment(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("The comment is empty".into()));
    }
    if trimmed.chars().count() > MAX_COMMENT_LEN {
        return Err(AppError::Validation(format!(
            "The comment exceeds {MAX_COMMENT_LEN} characters"
        )));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_round_trip_through_their_wire_form() {
        for s in Status::ALL {
            assert_eq!(Status::parse(s.as_str()), Some(*s));
        }
        for s in Severity::ALL {
            assert_eq!(Severity::parse(s.as_str()), Some(*s));
        }
        assert_eq!(Status::parse("closed"), None);
    }

    #[test]
    fn open_and_closed_partition_the_lifecycle() {
        assert!(Status::New.is_open() && !Status::New.is_closed());
        assert!(Status::Acknowledged.is_open());
        assert!(Status::Resolved.is_closed() && !Status::Resolved.is_open());
        // "Ignored" is closed for the operator even though recurrences still
        // land on it - that asymmetry is the whole meaning of the button.
        assert!(Status::Ignored.is_closed() && !Status::Ignored.is_open());
    }

    #[test]
    fn a_transition_to_the_same_state_is_refused() {
        assert!(!Status::New.may_move_to(Status::New));
        assert!(Status::New.may_move_to(Status::Acknowledged));
        // Reopening is allowed: "resolved" is a claim, and claims can be wrong.
        assert!(Status::Resolved.may_move_to(Status::New));
        assert!(Status::Ignored.may_move_to(Status::Acknowledged));
    }

    #[test]
    fn severity_orders_worst_first() {
        let mut all = vec![Severity::Info, Severity::Critical, Severity::Warning];
        all.sort();
        assert_eq!(all, vec![Severity::Critical, Severity::Warning, Severity::Info]);
    }

    #[test]
    fn the_dedup_key_never_carries_a_timestamp() {
        let a = NewAlert::new("jobs.dead_letter", "jobs", Severity::Warning, "x").dedup("core.selftest");
        assert_eq!(a.dedup_key, "jobs.dead_letter:core.selftest");
        // Same problem observed twice yields the same identity, which is what
        // makes the counter grow instead of the table.
        let b = NewAlert::new("jobs.dead_letter", "jobs", Severity::Warning, "y").dedup("core.selftest");
        assert_eq!(a.dedup_key, b.dedup_key);
    }

    #[test]
    fn comments_are_trimmed_and_bounded() {
        assert_eq!(clean_comment("  pris en charge  ").expect("valide"), "pris en charge");
        assert!(clean_comment("   ").is_err());
        assert!(clean_comment(&"a".repeat(MAX_COMMENT_LEN + 1)).is_err());
    }
}
