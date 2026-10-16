//! Content detection: finding sensitive data in a piece of text, and saying so
//! in counters.
//!
//! ```text
//!   rules of the trigger ─► detector leaves ─┐
//!                                            ├─► one scan per (detector, part)
//!   gate call ─► content parts ──────────────┘            │
//!                                                         ▼
//!                                                    Evidence
//!                                                         │
//!   condition tree ─► Condition::matches_with(facts, evidence) ─► verdict
//! ```
//!
//! ## The three thresholds, and why the third is the one that matters
//!
//! A detector leaf states a confidence floor, a minimum number of matches, and a
//! minimum number of **distinct** matches. The first two are obvious. The third
//! is what makes a rule mean what its author read back: without it, one account
//! number quoted fifty times in a thread satisfies "more than twenty account
//! numbers = mass leak", and the rule fires on a conversation about a single
//! invoice. Occurrences measure how much of the text is about the thing;
//! distinct values measure how many people are exposed. Only the second is a
//! leak, and only the second survives somebody pasting a quote.
//!
//! Distinctness is computed over a **fingerprint of the normalised match** - case
//! folded, separators stripped - so `FR76 3000 6…` and `fr7630006…` are one
//! value, and no inspected value exists in the engine's state even in memory
//! beyond the scan.
//!
//! ## What is never persisted
//!
//! Nothing inspected, and nothing derived from it beyond a count. Read
//! [`Evidence::counters`] and satisfy yourself: a detector key an administrator
//! chose, three integers, and a rounded confidence. No offset, no fingerprint,
//! no excerpt. The one place inspected content is ever displayed is the test
//! screen, and that screen receives **offsets only** and highlights in the
//! browser the text the administrator pasted there himself.

pub mod checksum;
pub mod evidence;
pub mod model;
pub mod scan;
pub mod store;

use std::collections::BTreeSet;

use kubuno_db::DbPool;

pub use evidence::Evidence;
pub use model::{Detector, DetectorLeaf, Kind};
pub use scan::Limits;

/// Reads the scan bounds from settings.
///
/// Once per gate call rather than once per detector: one request must run under
/// one set of rules, even if an administrator changes a setting while it is in
/// flight.
pub async fn limits_from_settings(db: &DbPool) -> Limits {
    use super::store::setting_u64;
    Limits {
        max_part_bytes: setting_u64(db, "rules.detectors.max_part_bytes", 262_144, 1_024, 16_777_216)
            .await as usize,
        max_scan_ms: setting_u64(db, "rules.detectors.max_scan_ms", 50, 1, 10_000).await,
        max_match_len: Limits::default().max_match_len,
    }
}

/// Most content parts one call may carry, before the setting is read.
pub const DEFAULT_MAX_PARTS: u64 = 16;

/// Runs every `(detector, part)` pair the leaves ask for, once each.
///
/// The de-duplication is the point: five leaves naming `core.iban` on the same
/// body scan that body once. A rule author writing "IBAN or card, and IBAN again
/// with a stricter threshold" must not multiply the cost of their message by the
/// number of times they mentioned a detector.
pub fn evaluate(leaves: &[&DetectorLeaf], parts: &[(String, String)], limits: &Limits) -> Evidence {
    let set = store::snapshot();
    let mut out = Evidence::default();

    // Which detectors, and for each which parts. Ordered so a scan is
    // reproducible run to run, which matters when reading a log.
    let mut wanted: std::collections::BTreeMap<&str, BTreeSet<&str>> = Default::default();
    for leaf in leaves {
        let entry = wanted.entry(leaf.detector.as_str()).or_default();
        for (name, _) in parts {
            if leaf.covers(name) {
                entry.insert(name.as_str());
            }
        }
    }

    for (detector_key, part_names) in wanted {
        let Some(compiled) = set.get(detector_key) else {
            // Disabled, deleted, or failed to compile. The leaf will answer
            // "false", which is the only safe answer: a rule must not keep
            // blocking on something nobody can look up any more.
            continue;
        };
        for part_name in part_names {
            let Some((_, text)) = parts.iter().find(|(n, _)| n == part_name) else {
                continue;
            };
            out.record(detector_key, part_name, compiled.scan(text, limits));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(detector: &str, parts: &[&str]) -> DetectorLeaf {
        DetectorLeaf {
            detector: detector.into(),
            min_confidence: 0.7,
            min_matches: 1,
            min_unique_matches: 1,
            parts: parts.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    #[test]
    fn an_unloaded_detector_yields_no_evidence_rather_than_an_error() {
        // The compiled set is empty in a unit test: every leaf must simply not
        // hold, and nothing may panic.
        let l = leaf("core.iban", &[]);
        let parts = vec![("body".to_string(), "DE89370400440532013000".to_string())];
        let evidence = evaluate(&[&l], &parts, &Limits::default());
        assert!(evidence.is_empty());
        assert!(!evidence.holds(&l));
    }

    #[test]
    fn a_leaf_naming_a_part_that_was_not_supplied_asks_for_nothing() {
        let l = leaf("core.iban", &["attachment"]);
        let parts = vec![("body".to_string(), "x".to_string())];
        let evidence = evaluate(&[&l], &parts, &Limits::default());
        assert!(evidence.is_empty());
    }
}
