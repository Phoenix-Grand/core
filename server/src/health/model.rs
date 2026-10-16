//! Wire types of the instance health report.
//!
//! Everything here is computed on the server. The console never infers the
//! state of a setting from a value it happens to have fetched for another
//! screen: two readers of the same fact drift, and the one that drifts is
//! always the one telling the operator "everything is fine".

use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

/// Functional area a check belongs to. The console groups by this, and the
/// order below is the order the page paints - most damaging first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Block {
    /// Who may get in, and with what.
    Security,
    /// What the outside world can reach, and what the server believes about it.
    Exposure,
    /// What survives a disk filling up or a machine dying.
    Continuity,
    /// Whether the instance can talk to its users at all.
    Communications,
    /// Identity of the instance and everyday usability.
    Identity,
}

impl Block {
    pub const ALL: &'static [Block] = &[
        Block::Security,
        Block::Exposure,
        Block::Continuity,
        Block::Communications,
        Block::Identity,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Block::Security => "security",
            Block::Exposure => "exposure",
            Block::Continuity => "continuity",
            Block::Communications => "communications",
            Block::Identity => "identity",
        }
    }
}

/// How much a failing check costs. Fixed per *outcome*, not per check: a data
/// volume at 92 % and one at 99 % are not the same problem, and pretending they
/// are is how an operator learns to ignore the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Ordered worst-first so `sort()` puts the urgent tasks on top.
    Critical,
    Warning,
    Info,
}

impl Severity {
    /// Weight in the score. A critical failure must not be offset by three
    /// informational passes - that is precisely the arithmetic that produces a
    /// reassuring 85 % on an instance with a default password.
    pub const fn weight(self) -> u32 {
        match self {
            Severity::Critical => 10,
            Severity::Warning => 4,
            Severity::Info => 1,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::Warning => "warning",
            Severity::Info => "info",
        }
    }
}

/// Where a check stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Nothing to do.
    Ok,
    /// Actionable, and the console knows where to send the operator.
    Todo,
    /// Genuinely wrong, but nothing in the administration console can fix it -
    /// it needs the command line, the configuration file or a decision that
    /// does not exist yet as a feature. Kept visible rather than hidden: a gap
    /// the product has is still a gap the instance has.
    Blocked,
    /// The operator saw it and decided it does not apply. Reversible.
    Ignored,
    /// The premise of the check is absent (testing a relay that is not
    /// configured). Counted nowhere.
    NotApplicable,
}

impl Status {
    pub const fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Todo => "todo",
            Status::Blocked => "blocked",
            Status::Ignored => "ignored",
            Status::NotApplicable => "not_applicable",
        }
    }

    /// Does this status count against the score?
    pub const fn is_failing(self) -> bool {
        matches!(self, Status::Todo | Status::Blocked)
    }

    /// Does this status take part in the score at all? An ignored or
    /// inapplicable check leaves the denominator, so silencing a check raises
    /// the score to exactly what it would be if the check did not exist -
    /// never above it.
    pub const fn is_scored(self) -> bool {
        matches!(self, Status::Ok | Status::Todo | Status::Blocked)
    }
}

/// The observed value, in a form the console can render in the reader's
/// language.
///
/// A check that inspects a secret reports a VERDICT here - never the value.
/// There is no variant carrying opaque bytes on purpose.
#[derive(Debug, Clone, Serialize)]
pub struct Observed {
    /// i18n suffix: the console renders `admin.hc_val_<key>` with `args`.
    pub key: &'static str,
    /// Interpolation arguments (counts, sizes, host names, module ids).
    pub args: serde_json::Value,
    /// Ready-to-read English rendering. Serves API consumers, and the console
    /// falls back to it when a catalogue lags behind the code.
    pub summary: String,
}

impl Observed {
    pub fn new(key: &'static str, args: serde_json::Value, summary: impl Into<String>) -> Self {
        Self { key, args, summary: summary.into() }
    }
}

/// Where the console must send the operator to deal with the finding.
///
/// `tab` is a navigable leaf of the admin menu and `verb` the deep action the
/// section understands - together they form `/admin?tab=<tab>&action=<verb>`,
/// the convention the whole console uses for addressable actions.
#[derive(Debug, Clone, Serialize)]
pub struct Action {
    pub tab: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verb: Option<&'static str>,
    /// English label of the button. The console prefers its own catalogue.
    pub label: &'static str,
}

/// Who silenced a check, and when.
#[derive(Debug, Clone, Serialize)]
pub struct Muted {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_label: Option<String>,
    pub at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// One line of the health report.
#[derive(Debug, Clone, Serialize)]
pub struct Check {
    /// Stable identifier, `<block>.<subject>`. It is the key the console
    /// translates against and the key a mute is stored under, so it must
    /// outlive refactors.
    pub id: &'static str,
    pub block: Block,
    pub severity: Severity,
    pub status: Status,
    /// English title; the console prefers `admin.hc_<id>_title`.
    pub title: &'static str,
    /// One sentence saying why it matters. Not a restatement of the title -
    /// the consequence of leaving it undone.
    pub why: &'static str,
    pub value: Observed,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<Action>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_href: Option<&'static str>,
    /// May the operator silence it? A check nobody can act on from the console
    /// usually can; a default administrator password never can.
    pub ignorable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub muted: Option<Muted>,
    /// Privilege the caller must hold to be shown this line at all. Never
    /// serialised: it is a server-side filter, not information for the client.
    #[serde(skip)]
    pub privilege: &'static str,
}

/// Aggregate counts, so the console does not have to derive them (and get the
/// exclusions wrong).
#[derive(Debug, Clone, Default, Serialize)]
pub struct Counts {
    pub total: usize,
    pub ok: usize,
    pub todo: usize,
    pub blocked: usize,
    pub ignored: usize,
    pub not_applicable: usize,
    /// Failing checks that are `critical` - what the global banner keys off.
    pub critical: usize,
    pub warning: usize,
    pub info: usize,
}

/// `GET /api/v1/admin/health-checks`.
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// 0-100, weighted by severity. `None` when the caller may see no check at
    /// all - a delegate is not shown a score computed over things they cannot
    /// read.
    pub score: Option<u32>,
    pub generated_at: DateTime<Utc>,
    /// True when the answer came from the short-lived cache rather than a fresh
    /// evaluation.
    pub cached: bool,
    pub counts: Counts,
    pub checks: Vec<Check>,
}

/// Weighted score over the checks the caller may actually see.
///
/// Ignored and inapplicable checks are excluded from both terms, so silencing a
/// finding can only bring the score back to where it would be without the
/// check - it can never push it higher than a genuine pass would.
pub fn score_of(checks: &[Check]) -> Option<u32> {
    let mut total = 0u32;
    let mut earned = 0u32;
    for c in checks.iter().filter(|c| c.status.is_scored()) {
        let w = c.severity.weight();
        total += w;
        if c.status == Status::Ok {
            earned += w;
        }
    }
    if total == 0 {
        return None;
    }
    // Round to nearest; a 99.6 % instance reads 100 only when it is spotless,
    // because `earned == total` is the only way to reach it.
    let pct = (u64::from(earned) * 100 + u64::from(total) / 2) / u64::from(total);
    let pct = pct as u32;
    Some(if earned == total { 100 } else { pct.min(99) })
}

pub fn counts_of(checks: &[Check]) -> Counts {
    let mut c = Counts { total: checks.len(), ..Counts::default() };
    for chk in checks {
        match chk.status {
            Status::Ok => c.ok += 1,
            Status::Todo => c.todo += 1,
            Status::Blocked => c.blocked += 1,
            Status::Ignored => c.ignored += 1,
            Status::NotApplicable => c.not_applicable += 1,
        }
        if chk.status.is_failing() {
            match chk.severity {
                Severity::Critical => c.critical += 1,
                Severity::Warning => c.warning += 1,
                Severity::Info => c.info += 1,
            }
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(id: &'static str, severity: Severity, status: Status) -> Check {
        Check {
            id,
            block: Block::Security,
            severity,
            status,
            title: "t",
            why: "w",
            value: Observed::new("none", serde_json::json!({}), ""),
            action: None,
            doc_href: None,
            ignorable: true,
            muted: None,
            privilege: "core.settings.read",
        }
    }

    #[test]
    fn empty_report_has_no_score() {
        assert_eq!(score_of(&[]), None);
        // Only-ignored is the same situation: nothing scoreable.
        let only_muted = vec![check("a", Severity::Critical, Status::Ignored)];
        assert_eq!(score_of(&only_muted), None);
    }

    #[test]
    fn perfect_only_when_spotless() {
        let all_ok = vec![
            check("a", Severity::Critical, Status::Ok),
            check("b", Severity::Info, Status::Ok),
        ];
        assert_eq!(score_of(&all_ok), Some(100));
    }

    #[test]
    fn one_informational_miss_never_reads_as_perfect() {
        // 10 criticals passing + one info failing = 99.0 % by arithmetic. It
        // must not round up to a clean 100.
        let mut checks: Vec<Check> = (0..10)
            .map(|_| check("ok", Severity::Critical, Status::Ok))
            .collect();
        checks.push(check("miss", Severity::Info, Status::Todo));
        assert_eq!(score_of(&checks), Some(99));
    }

    #[test]
    fn a_critical_failure_dominates_informational_passes() {
        // One critical failure against five informational passes: the score has
        // to read as broken, not as "83 % - almost there".
        let mut checks = vec![check("bad", Severity::Critical, Status::Todo)];
        checks.extend((0..5).map(|_| check("ok", Severity::Info, Status::Ok)));
        let score = score_of(&checks).expect("scoreable");
        assert_eq!(score, 33, "5×1 earned out of 10+5 total");
    }

    #[test]
    fn muting_restores_the_score_it_would_have_without_the_check() {
        let base = vec![check("a", Severity::Warning, Status::Ok)];
        let with_muted = vec![
            check("a", Severity::Warning, Status::Ok),
            check("b", Severity::Critical, Status::Ignored),
        ];
        assert_eq!(score_of(&base), score_of(&with_muted));
    }

    #[test]
    fn blocked_counts_against_the_score() {
        // "The product cannot fix it" is not "the instance is fine".
        let checks = vec![check("backup", Severity::Critical, Status::Blocked)];
        assert_eq!(score_of(&checks), Some(0));
    }

    #[test]
    fn counts_only_tally_failing_severities() {
        let checks = vec![
            check("a", Severity::Critical, Status::Todo),
            check("b", Severity::Critical, Status::Ok),
            check("c", Severity::Warning, Status::Blocked),
            check("d", Severity::Info, Status::Ignored),
            check("e", Severity::Info, Status::NotApplicable),
        ];
        let c = counts_of(&checks);
        assert_eq!((c.total, c.ok, c.todo, c.blocked, c.ignored, c.not_applicable), (5, 1, 1, 1, 1, 1));
        assert_eq!((c.critical, c.warning, c.info), (1, 1, 0));
    }
}
