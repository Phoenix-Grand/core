//! Value and wire types of the rule engine.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::errors::AppError;

use super::condition::Condition;

// ── Modes of caution ─────────────────────────────────────────────────────────

/// How much a rule is allowed to do.
///
/// | mode       | evaluates | logs | acts | alerts            |
/// |------------|-----------|------|------|-------------------|
/// | `inactive` | no        | no   | no   | no                |
/// | `simulate` | yes       | yes  | **no** | yes, **isolated** |
/// | `monitor`  | yes       | yes  | no   | yes, real         |
/// | `enforce`  | yes       | yes  | **yes** | yes, real      |
/// | `backtest` | yes       | yes  | no   | no                |
///
/// `Backtest` is not a state a rule sits in - it is the mode an execution row
/// carries when it came from a retrospective replay. Keeping it in the same
/// enum is what stops the replay path from quietly growing a second evaluator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Inactive,
    Simulate,
    Monitor,
    Enforce,
    Backtest,
}

impl Mode {
    /// The four an administrator may set on a rule.
    pub const SETTABLE: &'static [Mode] =
        &[Mode::Inactive, Mode::Simulate, Mode::Monitor, Mode::Enforce];

    pub const fn as_str(self) -> &'static str {
        match self {
            Mode::Inactive => "inactive",
            Mode::Simulate => "simulate",
            Mode::Monitor => "monitor",
            Mode::Enforce => "enforce",
            Mode::Backtest => "backtest",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "inactive" => Some(Mode::Inactive),
            "simulate" => Some(Mode::Simulate),
            "monitor" => Some(Mode::Monitor),
            "enforce" => Some(Mode::Enforce),
            "backtest" => Some(Mode::Backtest),
            _ => None,
        }
    }

    /// Only a mode a rule may be stored in.
    pub fn parse_settable(raw: &str) -> Result<Self, AppError> {
        match Mode::parse(raw) {
            Some(Mode::Backtest) => Err(AppError::Validation(
                "'backtest' is a run type, not a rule mode".into(),
            )),
            Some(m) => Ok(m),
            None => Err(AppError::Validation(format!(
                "Unknown mode '{raw}': expected {}",
                Mode::SETTABLE
                    .iter()
                    .map(|m| m.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }

    pub const fn evaluates(self) -> bool {
        !matches!(self, Mode::Inactive)
    }

    /// Does this mode run the rule's actions? Exactly one does.
    pub const fn acts(self) -> bool {
        matches!(self, Mode::Enforce)
    }

    /// Does this mode raise alerts at all?
    pub const fn alerts(self) -> bool {
        matches!(self, Mode::Simulate | Mode::Monitor | Mode::Enforce)
    }

    /// Are the alerts it raises quarantined out of every badge and notification?
    pub const fn alerts_are_isolated(self) -> bool {
        matches!(self, Mode::Simulate)
    }

    /// Does this mode persist non-matches?
    ///
    /// Simulation only. In `enforce`, every event of the trigger's type would
    /// write a row saying "nothing happened" - a table nobody can keep and
    /// nobody reads.
    pub const fn logs_non_matches(self) -> bool {
        matches!(self, Mode::Simulate)
    }
}

// ── Outcome of one evaluation ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Conditions held; nothing was executed (the mode does not act, or the
    /// rule declares no action).
    Matched,
    /// Conditions held and the actions were dispatched.
    Acted,
    NoMatch,
    OutOfScope,
    OutOfRollout,
    /// Matched, but the "N times in T" threshold is not reached yet.
    BelowThreshold,
    /// Refused by the feedback-loop guard.
    DepthExceeded,
    Error,
}

impl Outcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Outcome::Matched => "matched",
            Outcome::Acted => "acted",
            Outcome::NoMatch => "no_match",
            Outcome::OutOfScope => "out_of_scope",
            Outcome::OutOfRollout => "out_of_rollout",
            Outcome::BelowThreshold => "below_threshold",
            Outcome::DepthExceeded => "depth_exceeded",
            Outcome::Error => "error",
        }
    }
}

// ── Severity ─────────────────────────────────────────────────────────────────

/// Re-uses the alert centre's scale, because a rule's severity ends up on the
/// alert it raises and two scales that must agree are one refactor away from
/// disagreeing.
pub type Severity = crate::alerts::Severity;

// ── Scope ────────────────────────────────────────────────────────────────────

/// One member of a scope list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScopeRef {
    /// An organisational unit, by default with its whole subtree.
    OrgUnit {
        id: Uuid,
        #[serde(default = "default_true")]
        descendants: bool,
    },
    Group { id: Uuid },
    User { id: Uuid },
}

fn default_true() -> bool {
    true
}

/// Who a rule applies to.
///
/// An empty `include` means the whole instance. `exclude` always wins - the
/// exception an operator writes ("everyone in Support except the on-call
/// account") must never be overridable by a broader inclusion added later.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scope {
    #[serde(default)]
    pub include: Vec<ScopeRef>,
    #[serde(default)]
    pub exclude: Vec<ScopeRef>,
}

/// Everything about a subject that a scope test needs, resolved once.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Subject {
    pub user_id: Option<Uuid>,
    pub org_unit_id: Option<Uuid>,
    /// The subject's unit and every ancestor of it, so a scope naming a parent
    /// unit with `descendants` covers it without a query per rule.
    pub unit_chain: Vec<Uuid>,
    pub group_ids: Vec<Uuid>,
}

impl Subject {
    fn matches_ref(&self, r: &ScopeRef) -> bool {
        match r {
            ScopeRef::User { id } => self.user_id == Some(*id),
            ScopeRef::Group { id } => self.group_ids.contains(id),
            ScopeRef::OrgUnit { id, descendants } => {
                if *descendants {
                    self.unit_chain.contains(id)
                } else {
                    self.org_unit_id == Some(*id)
                }
            }
        }
    }
}

impl Scope {
    pub fn is_everyone(&self) -> bool {
        self.include.is_empty() && self.exclude.is_empty()
    }

    /// Does the rule apply to `subject`?
    pub fn covers(&self, subject: &Subject) -> bool {
        // Exclusion first, and unconditionally: an exception is a promise.
        if self.exclude.iter().any(|r| subject.matches_ref(r)) {
            return false;
        }
        if self.include.is_empty() {
            return true;
        }
        self.include.iter().any(|r| subject.matches_ref(r))
    }

    /// Every unit, group and user id the scope names, for existence checks at
    /// write time.
    pub fn referenced(&self) -> impl Iterator<Item = &ScopeRef> {
        self.include.iter().chain(self.exclude.iter())
    }
}

// ── Action reference ─────────────────────────────────────────────────────────

/// One action a rule runs, with the parameters the administrator filled in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionSpec {
    /// Catalogue key, `<module_id>.<name>`.
    pub action: String,
    #[serde(default)]
    pub params: Value,
}

// ── The rule ─────────────────────────────────────────────────────────────────

/// A rule as stored and as evaluated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub trigger_key: String,
    pub conditions: Condition,
    pub actions: Vec<ActionSpec>,
    pub mode: Mode,
    pub scope: Scope,
    pub threshold_count: Option<i32>,
    pub threshold_window_s: Option<i32>,
    pub rollout_percent: i16,
    pub severity: String,
    pub priority: i32,
    pub version: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Rule {
    pub fn severity(&self) -> Severity {
        Severity::parse(&self.severity).unwrap_or(crate::alerts::Severity::Warning)
    }

    pub fn threshold(&self) -> Option<(i32, i32)> {
        match (self.threshold_count, self.threshold_window_s) {
            (Some(c), Some(w)) => Some((c, w)),
            _ => None,
        }
    }
}

/// One row of the execution log, as the API serves it.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ExecutionRow {
    pub id: i64,
    pub rule_id: Uuid,
    pub rule_name: Option<String>,
    pub rule_version: i32,
    pub mode: String,
    pub outcome: String,
    pub event_type: String,
    pub actor_user_id: Option<Uuid>,
    pub org_unit_id: Option<Uuid>,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub detail: Value,
    pub actions_total: i16,
    pub actions_ok: i16,
    pub actions_failed: i16,
    pub depth: i16,
    pub duration_ms: i32,
    pub occurred_at: DateTime<Utc>,
    /// Set only on executions produced by the synchronous gate: the reference
    /// the stopped user was handed. Searching on it is how somebody who *may*
    /// read the policy answers "why was I blocked" for somebody who may not.
    pub gate_reference: Option<String>,
}

/// One version snapshot, as the API serves it.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct VersionRow {
    pub version: i32,
    pub snapshot: Value,
    pub change_note: Option<String>,
    pub changed_by: Option<Uuid>,
    pub changed_by_label: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uid(n: u8) -> Uuid {
        Uuid::from_bytes([n; 16])
    }

    #[test]
    fn the_mode_table_is_what_the_documentation_claims() {
        // Inactive does nothing at all.
        assert!(!Mode::Inactive.evaluates());
        assert!(!Mode::Inactive.acts());
        assert!(!Mode::Inactive.alerts());

        // Simulation evaluates and alerts, but never acts, and its alerts are
        // quarantined.
        assert!(Mode::Simulate.evaluates());
        assert!(!Mode::Simulate.acts());
        assert!(Mode::Simulate.alerts());
        assert!(Mode::Simulate.alerts_are_isolated());
        assert!(Mode::Simulate.logs_non_matches());

        // "Active without actions" is the same, with real alerts.
        assert!(Mode::Monitor.evaluates());
        assert!(!Mode::Monitor.acts());
        assert!(Mode::Monitor.alerts());
        assert!(!Mode::Monitor.alerts_are_isolated());
        assert!(!Mode::Monitor.logs_non_matches());

        // Exactly one mode acts.
        assert_eq!(
            Mode::SETTABLE.iter().filter(|m| m.acts()).count(),
            1,
            "un seul mode doit agir"
        );

        // Backtest is silent: no action, no alert.
        assert!(Mode::Backtest.evaluates());
        assert!(!Mode::Backtest.acts());
        assert!(!Mode::Backtest.alerts());
        assert!(!Mode::Backtest.logs_non_matches());
    }

    #[test]
    fn backtest_is_not_a_mode_a_rule_can_be_saved_in() {
        assert!(Mode::parse_settable("backtest").is_err());
        assert!(Mode::parse_settable("enforce").is_ok());
        assert!(Mode::parse_settable("actif").is_err());
        for m in Mode::SETTABLE {
            assert_eq!(Mode::parse(m.as_str()), Some(*m));
        }
    }

    #[test]
    fn an_empty_scope_covers_everyone() {
        let scope = Scope::default();
        assert!(scope.is_everyone());
        assert!(scope.covers(&Subject::default()));
        assert!(scope.covers(&Subject {
            user_id: Some(uid(1)),
            ..Default::default()
        }));
    }

    #[test]
    fn exclusion_beats_inclusion() {
        let unit = uid(9);
        let victim = uid(1);
        let scope = Scope {
            include: vec![ScopeRef::OrgUnit {
                id: unit,
                descendants: true,
            }],
            exclude: vec![ScopeRef::User { id: victim }],
        };

        let inside = Subject {
            user_id: Some(uid(2)),
            org_unit_id: Some(unit),
            unit_chain: vec![unit],
            group_ids: vec![],
        };
        assert!(scope.covers(&inside));

        // Same unit, but named in the exclusion list.
        let excepted = Subject {
            user_id: Some(victim),
            ..inside.clone()
        };
        assert!(!scope.covers(&excepted), "l'exclusion doit primer");

        // Outside the unit entirely.
        let outside = Subject {
            user_id: Some(uid(3)),
            org_unit_id: Some(uid(8)),
            unit_chain: vec![uid(8)],
            group_ids: vec![],
        };
        assert!(!scope.covers(&outside));
    }

    #[test]
    fn an_exclusion_alone_means_everyone_but() {
        let scope = Scope {
            include: vec![],
            exclude: vec![ScopeRef::Group { id: uid(4) }],
        };
        assert!(!scope.is_everyone());
        assert!(scope.covers(&Subject {
            user_id: Some(uid(1)),
            ..Default::default()
        }));
        assert!(!scope.covers(&Subject {
            user_id: Some(uid(1)),
            group_ids: vec![uid(4)],
            ..Default::default()
        }));
    }

    #[test]
    fn a_subtree_scope_follows_the_ancestor_chain_but_a_strict_one_does_not() {
        let parent = uid(10);
        let child = uid(11);
        let subject = Subject {
            user_id: Some(uid(1)),
            org_unit_id: Some(child),
            unit_chain: vec![child, parent],
            group_ids: vec![],
        };

        let subtree = Scope {
            include: vec![ScopeRef::OrgUnit {
                id: parent,
                descendants: true,
            }],
            exclude: vec![],
        };
        assert!(subtree.covers(&subject));

        let strict = Scope {
            include: vec![ScopeRef::OrgUnit {
                id: parent,
                descendants: false,
            }],
            exclude: vec![],
        };
        assert!(!strict.covers(&subject), "sans descendants, l'unité parente ne couvre pas l'enfant");
    }

    #[test]
    fn a_subject_outside_the_tree_is_not_in_every_subtree() {
        // The same default as `authz::PrivilegeScope::covers`: an account
        // attached to no unit is covered by nothing that names a unit.
        let scope = Scope {
            include: vec![ScopeRef::OrgUnit {
                id: uid(10),
                descendants: true,
            }],
            exclude: vec![],
        };
        assert!(!scope.covers(&Subject {
            user_id: Some(uid(1)),
            ..Default::default()
        }));
    }

    #[test]
    fn the_scope_wire_form_defaults_to_the_subtree() {
        let parsed: Scope =
            serde_json::from_str(r#"{"include":[{"type":"org_unit","id":"00000000-0000-0000-0000-00000000000a"}]}"#)
                .expect("forme valide");
        match &parsed.include[0] {
            ScopeRef::OrgUnit { descendants, .. } => assert!(*descendants),
            other => panic!("attendu org_unit, obtenu {other:?}"),
        }
        assert!(parsed.exclude.is_empty());
        // A scope kind nobody defined is refused rather than ignored.
        assert!(serde_json::from_str::<Scope>(r#"{"include":[{"type":"everyone"}]}"#).is_err());
    }
}
