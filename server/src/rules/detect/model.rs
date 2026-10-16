//! What a detector is, and what a rule says about one.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::checksum::Checksum;

// ── Defaults ─────────────────────────────────────────────────────────────────

/// Confidence a leaf requires when it says nothing.
///
/// 0.7 rather than 0.5: at half, a bare shape with no checksum and no keyword
/// already qualifies, and the first thing an operator meets is a false
/// positive. A detector that wants to fire on shape alone says so by raising
/// its own `base_confidence`.
pub const DEFAULT_MIN_CONFIDENCE: f32 = 0.7;
/// Matches a leaf requires when it says nothing.
pub const DEFAULT_MIN_MATCHES: i32 = 1;
/// Distinct values a leaf requires when it says nothing.
pub const DEFAULT_MIN_UNIQUE: i32 = 1;

fn default_min_confidence() -> f32 {
    DEFAULT_MIN_CONFIDENCE
}
fn default_min_matches() -> i32 {
    DEFAULT_MIN_MATCHES
}
fn default_min_unique() -> i32 {
    DEFAULT_MIN_UNIQUE
}

// ── Kind ─────────────────────────────────────────────────────────────────────

/// How a detector looks at a text. Closed, like everything else an
/// administrator picks from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A regular expression, executed by Rust's automaton engine.
    Regex,
    /// A list of words, compiled into one case-insensitive alternation with
    /// word boundaries. Not a regex the administrator writes: the escaping is
    /// the core's job, so a term containing `.` or `(` cannot become a pattern.
    Wordlist,
    /// A pattern whose candidates must pass an arithmetic check.
    Checksum,
}

impl Kind {
    pub const ALL: &'static [Kind] = &[Kind::Regex, Kind::Wordlist, Kind::Checksum];

    pub const fn as_str(self) -> &'static str {
        match self {
            Kind::Regex => "regex",
            Kind::Wordlist => "wordlist",
            Kind::Checksum => "checksum",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|k| k.as_str() == raw)
    }
}

// ── The detector ─────────────────────────────────────────────────────────────

/// One detector, as stored and as the console reads it.
///
/// Nothing here is a secret: a pattern is policy, not credential, and hiding it
/// from an operator who may read the rules that use it would only mean nobody
/// can tell why a rule fires.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Detector {
    pub id: Uuid,
    pub key: String,
    pub label: String,
    pub description: Option<String>,
    pub category: String,
    pub kind: Kind,
    pub pattern: Option<String>,
    pub terms: Vec<String>,
    pub checksum: Option<Checksum>,
    pub proximity_terms: Vec<String>,
    pub proximity_window: i32,
    pub proximity_required: bool,
    pub base_confidence: f32,
    pub checksum_bonus: f32,
    pub proximity_bonus: f32,
    pub min_confidence: f32,
    pub min_matches: i32,
    pub min_unique_matches: i32,
    pub is_enabled: bool,
    pub is_builtin: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ── The condition leaf ───────────────────────────────────────────────────────

/// The `detector` leaf of a condition tree.
///
/// It carries **thresholds, not logic**. There is no pattern here, no operator
/// and nothing to interpret: the leaf names a detector from the catalogue and
/// states how much of it is enough. That is what keeps the promise the engine
/// was built on - the vocabulary stays a serde enum, and adding content
/// inspection did not add an expression language through the back door.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectorLeaf {
    /// Catalogue key, e.g. `core.iban`. Not the id: a rule snapshot read three
    /// years later must still say what it looked for.
    pub detector: String,

    /// How sure a single match must be before it is counted at all.
    #[serde(default = "default_min_confidence")]
    pub min_confidence: f32,

    /// How many counted matches the inspected parts must carry.
    #[serde(default = "default_min_matches")]
    pub min_matches: i32,

    /// How many **distinct values** those matches must cover.
    ///
    /// The threshold that makes a "mass leak" rule mean what it says. Without
    /// it, one account number quoted fifty times in a thread satisfies "more
    /// than twenty account numbers", and the rule fires on a conversation about
    /// a single invoice. Occurrences measure how much text is about the thing;
    /// distinct values measure how many people are exposed.
    #[serde(default = "default_min_unique")]
    pub min_unique_matches: i32,

    /// Which content parts to look at. Empty = every part the caller supplied.
    #[serde(default)]
    pub parts: Vec<String>,
}

impl DetectorLeaf {
    /// Does this leaf name `part`?
    pub fn covers(&self, part: &str) -> bool {
        self.parts.is_empty() || self.parts.iter().any(|p| p == part)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_leaf_that_states_only_its_detector_gets_workable_defaults() {
        let leaf: DetectorLeaf =
            serde_json::from_str(r#"{"detector":"core.iban"}"#).expect("forme valide");
        assert_eq!(leaf.detector, "core.iban");
        assert_eq!(leaf.min_confidence, DEFAULT_MIN_CONFIDENCE);
        assert_eq!(leaf.min_matches, 1);
        assert_eq!(leaf.min_unique_matches, 1);
        // No part named = every part supplied.
        assert!(leaf.parts.is_empty());
        assert!(leaf.covers("body"));
        assert!(leaf.covers("anything"));
    }

    #[test]
    fn a_leaf_that_names_parts_looks_only_at_them() {
        let leaf: DetectorLeaf =
            serde_json::from_str(r#"{"detector":"core.iban","parts":["body"]}"#)
                .expect("forme valide");
        assert!(leaf.covers("body"));
        assert!(!leaf.covers("subject"));
    }

    #[test]
    fn the_leaf_carries_no_pattern_and_refuses_to_grow_one() {
        // The whole point: a leaf is thresholds, never logic. An unknown field
        // is not silently dropped into a place where it could later mean
        // something.
        let leaf: DetectorLeaf = serde_json::from_str(
            r#"{"detector":"core.iban","min_confidence":0.9,"min_matches":3,"min_unique_matches":2}"#,
        )
        .expect("forme valide");
        assert_eq!(leaf.min_matches, 3);
        assert_eq!(leaf.min_unique_matches, 2);
        let round = serde_json::to_value(&leaf).expect("sérialisable");
        assert!(round.get("pattern").is_none());
        assert!(round.get("regex").is_none());
    }

    #[test]
    fn kinds_and_checksums_round_trip_and_refuse_the_unknown() {
        for k in Kind::ALL {
            assert_eq!(Kind::parse(k.as_str()), Some(*k));
        }
        assert_eq!(Kind::parse("script"), None);
        assert!(serde_json::from_str::<Kind>("\"script\"").is_err());
    }
}
