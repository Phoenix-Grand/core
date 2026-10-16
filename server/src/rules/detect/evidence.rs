//! What the scan found, and the answer a `detector` leaf reads.
//!
//! ## Why the leaf does not scan
//!
//! [`super::super::condition::Condition::matches`] is synchronous and pure. It
//! has to be: it runs on the event worker, inside a backtest replaying hundreds
//! of thousands of rows, and inside the gate. Making a leaf able to read the
//! database or spend milliseconds on a regular expression would put an
//! unbounded cost behind a `!` in a boolean expression, evaluated as many times
//! as the tree happens to visit it.
//!
//! So the gate scans **once, up front**: every distinct `(detector, part)` pair
//! the candidate rules mention, each scanned a single time however many leaves
//! refer to it. [`Evidence`] is that table of results, and a leaf becomes a
//! lookup plus three comparisons.
//!
//! ## Nothing here survives the request
//!
//! `Evidence` holds offsets and fingerprints for the length of one call and is
//! dropped with it. What reaches the execution log is
//! [`Evidence::counters`] - how many detectors fired, how many matches, how many
//! distinct values - and not one byte of what was inspected.
//!
//! ## The empty evidence is the honest default
//!
//! Outside the gate there is no content: the bus carries an event, not a
//! document. [`Evidence::empty`] therefore answers "no" to every detector leaf,
//! which is what makes a data-protection rule inert on the asynchronous path
//! rather than accidentally firing on a fact that happens to be named `body`.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::model::DetectorLeaf;
use super::scan::PartScan;

/// One detector's results across the parts it was run on.
#[derive(Debug, Default)]
pub struct DetectorEvidence {
    /// Part name → what was found there.
    pub parts: HashMap<String, PartScan>,
}

/// Everything the inspection found, for one gate call.
#[derive(Debug, Default)]
pub struct Evidence {
    /// Detector key → its results.
    by_detector: HashMap<String, DetectorEvidence>,
    /// At least one scan was cut short (truncated, timed out, or saturated).
    incomplete: bool,
}

impl Evidence {
    /// No content was inspected. Every detector leaf answers `false`.
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.by_detector.is_empty()
    }

    /// Was any scan cut short? The gate reports it, because "did not match" on a
    /// truncated scan is a different statement from "did not match".
    pub fn incomplete(&self) -> bool {
        self.incomplete
    }

    pub fn record(&mut self, detector: &str, part: &str, scan: PartScan) {
        if scan.incomplete() {
            self.incomplete = true;
        }
        self.by_detector
            .entry(detector.to_string())
            .or_default()
            .parts
            .insert(part.to_string(), scan);
    }

    /// Does `leaf` hold?
    ///
    /// The three thresholds are applied **across the parts the leaf names**,
    /// not per part: "three account numbers" means three in the message, not
    /// three in the subject line. Confidence filters first, because a match
    /// below the floor is not a match and must not count towards either total.
    pub fn holds(&self, leaf: &DetectorLeaf) -> bool {
        let (matches, unique, _) = self.tally(leaf);
        matches >= leaf.min_matches.max(1) && unique >= leaf.min_unique_matches.max(1)
    }

    /// `(matches, distinct values, best confidence)` for `leaf`.
    pub fn tally(&self, leaf: &DetectorLeaf) -> (i32, i32, f32) {
        let Some(evidence) = self.by_detector.get(&leaf.detector) else {
            return (0, 0, 0.0);
        };
        let mut seen = std::collections::HashSet::new();
        let mut matches = 0i32;
        let mut best = 0.0f32;
        for (part, scan) in &evidence.parts {
            if !leaf.covers(part) {
                continue;
            }
            for hit in scan.counted(leaf.min_confidence) {
                matches = matches.saturating_add(1);
                seen.insert(hit.fingerprint);
                if hit.confidence > best {
                    best = hit.confidence;
                }
            }
        }
        (matches, i32::try_from(seen.len()).unwrap_or(i32::MAX), best)
    }

    /// Counters for the execution log.
    ///
    /// Read this next to `core.rule_executions.detail` and satisfy yourself that
    /// there is no way back to the content: a detector key an administrator
    /// chose, three integers, and a rounded confidence. Offsets are deliberately
    /// absent - an offset plus a guess at the pattern is a value.
    pub fn counters(&self) -> Value {
        let mut detectors: Vec<Value> = self
            .by_detector
            .iter()
            .map(|(key, ev)| {
                let mut matches = 0i64;
                let mut unique = std::collections::HashSet::new();
                let mut best = 0.0f32;
                let mut parts = 0i64;
                for scan in ev.parts.values() {
                    parts += 1;
                    for hit in &scan.hits {
                        matches += 1;
                        unique.insert(hit.fingerprint);
                        if hit.confidence > best {
                            best = hit.confidence;
                        }
                    }
                }
                json!({
                    "detector":       key,
                    "parts_scanned":  parts,
                    "matches":        matches,
                    "unique_matches": unique.len(),
                    // Two decimals: the exact float says nothing more and
                    // varies with an arithmetic nobody reading a log cares
                    // about.
                    "confidence":     (best * 100.0).round() / 100.0,
                })
            })
            .collect();
        detectors.sort_by(|a, b| {
            a.get("detector")
                .and_then(Value::as_str)
                .cmp(&b.get("detector").and_then(Value::as_str))
        });
        json!({ "detectors": detectors, "incomplete": self.incomplete })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::scan::Hit;

    fn hit(confidence: f32, fingerprint: u64) -> Hit {
        Hit {
            start: 0,
            end: 1,
            confidence,
            fingerprint,
        }
    }

    fn scan(hits: Vec<Hit>) -> PartScan {
        PartScan {
            hits,
            ..PartScan::default()
        }
    }

    fn leaf(detector: &str) -> DetectorLeaf {
        DetectorLeaf {
            detector: detector.into(),
            min_confidence: 0.7,
            min_matches: 1,
            min_unique_matches: 1,
            parts: Vec::new(),
        }
    }

    #[test]
    fn an_empty_evidence_answers_no_to_everything() {
        // The asynchronous path: an event carries no content, so a data
        // protection rule is inert there rather than accidentally firing.
        let e = Evidence::empty();
        assert!(!e.holds(&leaf("core.iban")));
        assert_eq!(e.tally(&leaf("core.iban")), (0, 0, 0.0));
        assert!(e.is_empty());
    }

    #[test]
    fn the_confidence_floor_is_applied_before_either_count() {
        let mut e = Evidence::default();
        e.record("core.iban", "body", scan(vec![hit(0.5, 1), hit(0.9, 2)]));

        let mut l = leaf("core.iban");
        l.min_confidence = 0.7;
        assert_eq!(e.tally(&l), (1, 1, 0.9));

        l.min_confidence = 0.4;
        assert_eq!(e.tally(&l), (2, 2, 0.9));
    }

    #[test]
    fn the_match_threshold_and_the_distinct_threshold_are_independent() {
        // The whole reason the third threshold exists: fifty occurrences of one
        // value must not satisfy "fifty account numbers".
        let mut e = Evidence::default();
        e.record(
            "core.iban",
            "body",
            scan((0..50).map(|_| hit(0.9, 42)).collect()),
        );

        let mut l = leaf("core.iban");
        l.min_matches = 20;
        l.min_unique_matches = 1;
        assert!(e.holds(&l), "50 occurrences franchissent bien 20 occurrences");

        l.min_unique_matches = 20;
        assert!(
            !e.holds(&l),
            "un même numéro répété ne doit pas franchir le seuil de valeurs distinctes"
        );

        // …and twenty different values do.
        let mut e = Evidence::default();
        e.record(
            "core.iban",
            "body",
            scan((0..20).map(|i| hit(0.9, i)).collect()),
        );
        assert!(e.holds(&l));
    }

    #[test]
    fn thresholds_are_counted_across_the_parts_the_leaf_names() {
        let mut e = Evidence::default();
        e.record("core.iban", "subject", scan(vec![hit(0.9, 1)]));
        e.record("core.iban", "body", scan(vec![hit(0.9, 2)]));

        let mut l = leaf("core.iban");
        l.min_matches = 2;
        // No part named: both are read, so two matches.
        assert!(e.holds(&l));

        // One part named: one match, threshold not met.
        l.parts = vec!["body".into()];
        assert!(!e.holds(&l));
        l.min_matches = 1;
        assert!(e.holds(&l));
    }

    #[test]
    fn an_unknown_detector_is_a_leaf_that_does_not_hold() {
        // A detector deleted or disabled after the rule was written. Answering
        // "false" is the only safe answer: the alternative is a rule that keeps
        // blocking on something nobody can look up any more.
        let mut e = Evidence::default();
        e.record("core.iban", "body", scan(vec![hit(0.9, 1)]));
        assert!(!e.holds(&leaf("core.gone")));
    }

    #[test]
    fn the_counters_carry_numbers_and_nothing_else() {
        let mut e = Evidence::default();
        e.record("core.iban", "body", scan(vec![hit(0.9, 7), hit(0.9, 7)]));
        let counters = e.counters();
        let text = serde_json::to_string(&counters).expect("sérialisable");

        // The contract, asserted rather than trusted: keys, integers, and no
        // offset that could be combined with a guess at the pattern.
        assert!(text.contains("\"matches\":2"));
        assert!(text.contains("\"unique_matches\":1"));
        assert!(!text.contains("start"));
        assert!(!text.contains("end"));
        assert!(!text.contains("fingerprint"));
        assert!(!text.contains("value"));
    }

    #[test]
    fn an_incomplete_scan_is_flagged_all_the_way_up() {
        let mut e = Evidence::default();
        e.record(
            "core.iban",
            "body",
            PartScan {
                truncated: true,
                ..PartScan::default()
            },
        );
        assert!(e.incomplete());
        assert!(e.counters()["incomplete"].as_bool().unwrap_or(false));
    }
}
