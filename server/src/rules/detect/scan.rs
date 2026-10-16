//! Compiling a detector, and running it over a piece of content **within
//! bounds**.
//!
//! ## The threat, stated plainly
//!
//! A pattern is written by an administrator. It is executed against text written
//! by users, on a request path a module is waiting on. Those two facts together
//! are the classic regular-expression denial of service: somebody with console
//! access - or somebody who talked an operator into pasting a pattern - makes
//! every message sent on the instance cost a second of CPU.
//!
//! ## Four bounds, three of them independent
//!
//! 1. **The engine cannot backtrack.** Rust's `regex` is a finite automaton with
//!    linear-time matching guarantees. `(a+)+$` - the textbook catastrophe - is
//!    linear here. This is a structural answer rather than a mitigation, and it
//!    is why no amount of pattern review would have been a substitute: reviewing
//!    is a process, and processes are what fail at 3am. The cost is that
//!    backreferences and lookaround do not exist, which for detecting an IBAN is
//!    not a cost at all.
//!
//! 2. **The compiled size is bounded** ([`MAX_COMPILED_BYTES`],
//!    [`MAX_DFA_BYTES`]). Linear time is linear in the input *and* in the
//!    automaton: `\d{1,10000}{1,10000}` compiles to something enormous and would
//!    make every scan slow without ever backtracking. The ceiling is enforced by
//!    the compiler itself and hit at **write time**, in front of the
//!    administrator who can fix it, never on the request path.
//!
//! 3. **The inspected volume is bounded** ([`Limits::max_part_bytes`]). A part
//!    longer than the ceiling is truncated, and the report says so.
//!
//! 4. **The inspection time is bounded** ([`Limits::max_scan_ms`]). The part is
//!    walked in chunks and the wall clock is read between them, so the scan
//!    stops mid-part rather than running to the end of whatever it was given.
//!    Bounds 3 and 4 are deliberately not the same bound: the first protects
//!    against a large input, the second against a slow automaton, and an
//!    instance can meet one without the other.
//!
//! ## Why chunks overlap
//!
//! A match straddling a chunk boundary would be missed, which is a detector
//! silently failing - the worst failure mode a data-protection control has.
//! Chunks therefore overlap by [`CHUNK_OVERLAP`] and matches are de-duplicated
//! by their absolute offset. A match longer than the overlap can still be cut;
//! the overlap is sized well past the longest identifier any seeded detector
//! looks for, and [`Limits::max_match_len`] documents that ceiling rather than
//! leaving it implicit.

use std::collections::HashSet;
use std::time::Instant;

use regex::{Regex, RegexBuilder};
use sha2::{Digest, Sha256};

use crate::errors::AppError;

use super::model::{Detector, Kind};

// ── Compile-time ceilings ────────────────────────────────────────────────────

/// Longest pattern an administrator may submit, in characters.
///
/// Well past every seeded detector (the longest is under 300) and far short of
/// what it takes to write something pathological.
pub const MAX_PATTERN_LEN: usize = 2_000;

/// Ceiling on the compiled program, in bytes. The crate's own default is 10 MB;
/// none of the detectors this is for come near 64 KB, and the gap is where the
/// abusive patterns live.
pub const MAX_COMPILED_BYTES: usize = 256 * 1024;

/// Ceiling on the lazy DFA cache, in bytes. Exceeding it does not fail the
/// match - the engine falls back to a slower strategy - so this bounds memory
/// rather than correctness.
pub const MAX_DFA_BYTES: usize = 1024 * 1024;

/// Most terms a word list may hold.
pub const MAX_TERMS: usize = 200;
/// Longest single term.
pub const MAX_TERM_LEN: usize = 120;

/// Bytes scanned between two readings of the clock.
///
/// Small enough that the budget is respected to within one chunk's cost, large
/// enough that the clock is not the dominant cost of a scan.
const CHUNK_BYTES: usize = 16 * 1024;

/// Overlap between two chunks. Past the longest identifier anything here looks
/// for (an IBAN with separators is 41 characters; a private-key header is 52).
const CHUNK_OVERLAP: usize = 512;

/// Most matches recorded for one detector on one part. Reaching it stops the
/// scan: a hundred thousand hits and a thousand answer the same rule, and the
/// difference is a vector of a hundred thousand offsets.
const MAX_HITS_PER_PART: usize = 2_000;

// ── Runtime limits ───────────────────────────────────────────────────────────

/// The bounds a scan runs under. Read from settings once per gate call rather
/// than per detector, so one request has one set of rules.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_part_bytes: usize,
    pub max_scan_ms: u64,
    pub max_match_len: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_part_bytes: 256 * 1024,
            max_scan_ms: 50,
            max_match_len: CHUNK_OVERLAP,
        }
    }
}

// ── A compiled detector ──────────────────────────────────────────────────────

/// A detector with its expressions built. Built once at load, shared by every
/// scan: compiling a regular expression per request would make the cost of the
/// feature proportional to traffic instead of to configuration.
#[derive(Debug)]
pub struct Compiled {
    pub detector: Detector,
    matcher: Regex,
    proximity: Option<Regex>,
}

impl Compiled {
    /// Builds the expressions of `detector`, refusing anything past the
    /// ceilings.
    ///
    /// The error is the administrator's to read, so it names what was exceeded
    /// rather than saying "invalid".
    pub fn build(detector: Detector) -> Result<Self, AppError> {
        let source = match detector.kind {
            Kind::Regex | Kind::Checksum => detector
                .pattern
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| {
                    AppError::Validation(
                        "Un détecteur de type « motif » ou « somme de contrôle » exige un motif"
                            .into(),
                    )
                })?
                .to_string(),
            Kind::Wordlist => wordlist_pattern(&detector.terms)?,
        };

        let matcher = compile(&source)?;

        let proximity = if detector.proximity_terms.is_empty() {
            None
        } else {
            // Proximity terms are *words*, not patterns: they are escaped by
            // the core and matched case-insensitively without word boundaries,
            // so a term of ":" or "=" works and a term of "(" cannot become a
            // group. An administrator writing a keyword list is not writing a
            // regular expression, and must not be able to do so by accident.
            let alternation = detector
                .proximity_terms
                .iter()
                .take(MAX_TERMS)
                .map(|t| regex::escape(t.trim()))
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("|");
            if alternation.is_empty() {
                None
            } else {
                Some(compile_ci(&format!("(?:{alternation})"))?)
            }
        };

        Ok(Self {
            detector,
            matcher,
            proximity,
        })
    }

    pub fn key(&self) -> &str {
        &self.detector.key
    }

    /// Runs the detector over `text` within `limits`.
    pub fn scan(&self, text: &str, limits: &Limits) -> PartScan {
        scan_with(self, text, limits)
    }
}

/// Compiles a pattern under the size ceilings, case-sensitively.
///
/// Case sensitivity is deliberate and documented in the seeded catalogue: an
/// IBAN is upper case, a French number plate is upper case, and folding
/// everything would make `\b[A-Z]{2}[- ]\d{3}` match inside ordinary prose.
pub fn compile(source: &str) -> Result<Regex, AppError> {
    build_regex(source, false)
}

/// Same, case-insensitively - for word lists and proximity keywords, which are
/// words rather than shapes.
pub fn compile_ci(source: &str) -> Result<Regex, AppError> {
    build_regex(source, true)
}

fn build_regex(source: &str, case_insensitive: bool) -> Result<Regex, AppError> {
    if source.chars().count() > MAX_PATTERN_LEN {
        return Err(AppError::Validation(format!(
            "Motif trop long : {MAX_PATTERN_LEN} caractères maximum"
        )));
    }
    RegexBuilder::new(source)
        .case_insensitive(case_insensitive)
        // The two ceilings that make an administrator-written pattern safe to
        // run on the request path. Both are checked here, at write time.
        .size_limit(MAX_COMPILED_BYTES)
        .dfa_size_limit(MAX_DFA_BYTES)
        .build()
        .map_err(|e| {
            // The message says which ceiling, because "compiled too big" and
            // "syntax error" are fixed by different edits.
            AppError::Validation(format!("Motif refusé : {e}"))
        })
}

/// Turns a word list into one alternation, escaped by the core.
fn wordlist_pattern(terms: &[String]) -> Result<String, AppError> {
    let cleaned: Vec<&str> = terms
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();
    if cleaned.is_empty() {
        return Err(AppError::Validation(
            "Un détecteur de type « liste de mots » exige au moins un terme".into(),
        ));
    }
    if cleaned.len() > MAX_TERMS {
        return Err(AppError::Validation(format!(
            "Une liste de mots compte au plus {MAX_TERMS} termes"
        )));
    }
    if let Some(long) = cleaned.iter().find(|t| t.chars().count() > MAX_TERM_LEN) {
        return Err(AppError::Validation(format!(
            "Terme trop long ({} caractères, maximum {MAX_TERM_LEN})",
            long.chars().count()
        )));
    }
    // The boundary is applied **per term and per side**, and only where the term
    // actually ends in a word character. A blanket `\b(?:…)\b` around the whole
    // alternation looks tidier and is wrong: a term like `c++` ends on a symbol,
    // where a trailing `\b` demands a word character next - so the one term an
    // administrator most expects to be tricky is the one that silently never
    // matches. Getting this wrong is a detector that reports nothing, which is
    // the failure mode this feature can least afford.
    let alternation = cleaned
        .iter()
        .map(|t| {
            let escaped = regex::escape(t);
            let lead = t.chars().next().is_some_and(is_word_char);
            let trail = t.chars().next_back().is_some_and(is_word_char);
            format!(
                "{}{escaped}{}",
                if lead { r"\b" } else { "" },
                if trail { r"\b" } else { "" }
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    // `(?i)` here rather than through the builder so the compiled pattern is
    // self-describing when it is logged or shown.
    Ok(format!(r"(?i)(?:{alternation})"))
}

/// What `\b` considers a word character: `[0-9A-Za-z_]` and, since the engine
/// is Unicode-aware by default, any alphanumeric.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

// ── One scan ─────────────────────────────────────────────────────────────────

/// One counted match. Offsets exist for the **test screen only**, which
/// highlights in the browser what the administrator pasted there; they are
/// never persisted and never leave a gate response.
#[derive(Debug, Clone, Copy)]
pub struct Hit {
    pub start: usize,
    pub end: usize,
    pub confidence: f32,
    /// Hash of the normalised value, used to count *distinct* matches.
    ///
    /// A hash rather than the value: distinctness is the only question asked of
    /// it, a hash answers that question exactly, and it means no inspected value
    /// exists anywhere in the engine's own state - not even in memory beyond the
    /// scan itself.
    pub fingerprint: u64,
}

/// What one detector found in one part.
#[derive(Debug, Clone, Default)]
pub struct PartScan {
    pub hits: Vec<Hit>,
    /// The part was longer than the byte ceiling and was cut.
    pub truncated: bool,
    /// The time budget ran out before the part was finished.
    pub timed_out: bool,
    /// The hit ceiling was reached.
    pub saturated: bool,
    pub bytes_scanned: usize,
}

impl PartScan {
    /// Matches at or above `min_confidence`.
    pub fn counted(&self, min_confidence: f32) -> impl Iterator<Item = &Hit> {
        self.hits
            .iter()
            .filter(move |h| h.confidence >= min_confidence)
    }

    /// `(matches, distinct values, best confidence)` at `min_confidence`.
    pub fn tally(&self, min_confidence: f32) -> (i32, i32, f32) {
        let mut seen: HashSet<u64> = HashSet::new();
        let mut count = 0i32;
        let mut best = 0.0f32;
        for hit in self.counted(min_confidence) {
            count = count.saturating_add(1);
            seen.insert(hit.fingerprint);
            if hit.confidence > best {
                best = hit.confidence;
            }
        }
        (count, i32::try_from(seen.len()).unwrap_or(i32::MAX), best)
    }

    /// Whether the scan was cut short in any way. A rule that did not match on a
    /// truncated scan did not match on the whole content, and the gate says so.
    pub fn incomplete(&self) -> bool {
        self.truncated || self.timed_out || self.saturated
    }
}

fn scan_with(compiled: &Compiled, text: &str, limits: &Limits) -> PartScan {
    let started = Instant::now();
    let mut out = PartScan::default();

    // ── Bound 3: the volume ──────────────────────────────────────────────────
    let text = if text.len() > limits.max_part_bytes {
        out.truncated = true;
        &text[..floor_boundary(text, limits.max_part_bytes)]
    } else {
        text
    };
    out.bytes_scanned = text.len();
    if text.is_empty() {
        return out;
    }

    // Proximity positions, found once for the whole part rather than once per
    // candidate: a hundred candidates would otherwise re-scan the text a
    // hundred times.
    let proximity: Vec<(usize, usize)> = match &compiled.proximity {
        Some(re) => re.find_iter(text).map(|m| (m.start(), m.end())).collect(),
        None => Vec::new(),
    };

    let d = &compiled.detector;
    let window = usize::try_from(d.proximity_window.max(0)).unwrap_or(0);
    let mut seen_offsets: HashSet<usize> = HashSet::new();

    let mut cursor = 0usize;
    while cursor < text.len() {
        // ── Bound 4: the clock, read between chunks ──────────────────────────
        if started.elapsed().as_millis() as u64 >= limits.max_scan_ms {
            out.timed_out = true;
            break;
        }

        let end = floor_boundary(text, (cursor + CHUNK_BYTES).min(text.len()));
        let chunk = &text[cursor..end];

        for m in compiled.matcher.find_iter(chunk) {
            let start = cursor + m.start();
            if !seen_offsets.insert(start) {
                continue; // already found in the previous chunk's overlap
            }
            if m.len() > limits.max_match_len {
                // Longer than the overlap: it may have been cut by a boundary
                // and cannot be trusted to be complete.
                continue;
            }
            if let Some(hit) = judge(d, m.as_str(), start, cursor + m.end(), &proximity, window) {
                out.hits.push(hit);
                if out.hits.len() >= MAX_HITS_PER_PART {
                    out.saturated = true;
                    return out;
                }
            }
        }

        if end >= text.len() {
            break;
        }
        // Step forward by a chunk minus the overlap, never by zero.
        let next = end.saturating_sub(CHUNK_OVERLAP).max(cursor + 1);
        cursor = floor_boundary(text, next);
    }

    out
}

/// Applies the checksum, the proximity rule and the confidence arithmetic to one
/// candidate. `None` means the candidate is discarded.
fn judge(
    d: &Detector,
    value: &str,
    start: usize,
    end: usize,
    proximity: &[(usize, usize)],
    window: usize,
) -> Option<Hit> {
    let mut confidence = d.base_confidence;

    // ── The checksum discards rather than penalises ──────────────────────────
    if let Some(algo) = d.checksum {
        if !algo.verify(value) {
            return None;
        }
        confidence += d.checksum_bonus;
    }

    // ── Proximity ────────────────────────────────────────────────────────────
    let near = if proximity.is_empty() {
        false
    } else {
        let from = start.saturating_sub(window);
        let to = end.saturating_add(window);
        proximity.iter().any(|(ps, pe)| *ps < to && *pe > from)
    };
    if near {
        confidence += d.proximity_bonus;
    } else if d.proximity_required {
        // A shape whose meaning comes entirely from its context: a plaintext
        // password is just a word, and a number plate is just letters and
        // digits, until something nearby says otherwise.
        return None;
    }

    Some(Hit {
        start,
        end,
        confidence: confidence.clamp(0.0, 1.0),
        fingerprint: fingerprint(value),
    })
}

/// A stable, non-reversible identity for "the same value seen twice".
///
/// Normalised first - case folded, separators removed - so `FR76 3000 6…` and
/// `fr7630006…` are one value rather than two. That normalisation is what makes
/// the distinct-value threshold resistant to the obvious evasion of retyping the
/// same number with different spacing.
fn fingerprint(value: &str) -> u64 {
    let normalised: String = value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    let digest = Sha256::digest(normalised.as_bytes());
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    u64::from_be_bytes(bytes)
}

/// Largest index at or below `index` that lands on a character boundary.
///
/// `str::floor_char_boundary` is unstable, and slicing a `&str` at a byte that
/// is not one panics - inside a scan of user content, which is the one place a
/// panic must not be possible.
fn floor_boundary(text: &str, index: usize) -> usize {
    let mut i = index.min(text.len());
    while i > 0 && !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::super::checksum::Checksum;
    use super::*;
    use uuid::Uuid;

    fn detector(kind: Kind) -> Detector {
        Detector {
            id: Uuid::nil(),
            key: "test.d".into(),
            label: "Essai".into(),
            description: None,
            category: "other".into(),
            kind,
            pattern: None,
            terms: Vec::new(),
            checksum: None,
            proximity_terms: Vec::new(),
            proximity_window: 100,
            proximity_required: false,
            base_confidence: 0.5,
            checksum_bonus: 0.35,
            proximity_bonus: 0.2,
            min_confidence: 0.7,
            min_matches: 1,
            min_unique_matches: 1,
            is_enabled: true,
            is_builtin: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn iban_detector() -> Compiled {
        let mut d = detector(Kind::Checksum);
        d.pattern = Some(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b".into());
        d.checksum = Some(Checksum::Iban);
        d.base_confidence = 0.6;
        Compiled::build(d).expect("compilable")
    }

    // ── Compilation bounds ───────────────────────────────────────────────────

    #[test]
    fn a_pattern_past_the_length_ceiling_is_refused_at_compile_time() {
        let mut d = detector(Kind::Regex);
        d.pattern = Some("a".repeat(MAX_PATTERN_LEN + 1));
        let err = Compiled::build(d).expect_err("doit être refusé");
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn a_pattern_that_compiles_too_large_is_refused_rather_than_run() {
        // Linear time is linear in the automaton too: this one never
        // backtracks and would still be slow on every request forever.
        let mut d = detector(Kind::Regex);
        d.pattern = Some(r"(?:\w{500}){500}".into());
        let err = Compiled::build(d).expect_err("doit dépasser le plafond compilé");
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn the_textbook_catastrophic_pattern_is_linear_here() {
        // `(a+)+$` against a long run of 'a' followed by 'b' is the canonical
        // exponential blow-up in a backtracking engine. It must be fast, and it
        // must be fast without the time budget having to save us.
        let mut d = detector(Kind::Regex);
        d.pattern = Some(r"(a+)+$".into());
        let compiled = Compiled::build(d).expect("compilable");
        let hostile = format!("{}b", "a".repeat(4_000));

        let started = Instant::now();
        let out = compiled.scan(&hostile, &Limits::default());
        assert!(out.hits.is_empty());
        assert!(
            started.elapsed().as_millis() < 200,
            "l'automate a mis {} ms : le moteur rétrograderait",
            started.elapsed().as_millis()
        );
    }

    #[test]
    fn a_word_list_term_cannot_smuggle_a_pattern() {
        // An administrator typing keywords is not writing a regular expression,
        // and must not become one by accident.
        let mut d = detector(Kind::Wordlist);
        d.terms = vec!["c++".into(), "a.b".into(), "(x)".into()];
        let compiled = Compiled::build(d).expect("compilable");
        let out = compiled.scan("on parle de c++ ici", &Limits::default());
        assert_eq!(out.hits.len(), 1);
        // `a.b` must not match `axb`.
        let out = compiled.scan("axb", &Limits::default());
        assert!(out.hits.is_empty());
    }

    #[test]
    fn an_empty_word_list_is_refused_rather_than_matching_everything() {
        let mut d = detector(Kind::Wordlist);
        d.terms = vec!["   ".into()];
        assert!(Compiled::build(d).is_err());
    }

    // ── Runtime bounds ───────────────────────────────────────────────────────

    #[test]
    fn a_part_past_the_byte_ceiling_is_truncated_and_says_so() {
        let compiled = iban_detector();
        let mut text = "x".repeat(1_000);
        text.push_str("DE89370400440532013000");
        let limits = Limits {
            max_part_bytes: 500,
            ..Limits::default()
        };
        let out = compiled.scan(&text, &limits);
        assert!(out.truncated);
        assert_eq!(out.bytes_scanned, 500);
        // The IBAN was past the cut: it was not seen, and the caller can tell.
        assert!(out.hits.is_empty());
        assert!(out.incomplete());
    }

    #[test]
    fn the_time_budget_stops_a_scan_mid_part() {
        // A zero-millisecond budget must stop before the first chunk, whatever
        // the input: the clock is read *before* the work, not after.
        let compiled = iban_detector();
        let text = "DE89370400440532013000 ".repeat(5_000);
        let limits = Limits {
            max_part_bytes: 10 * 1024 * 1024,
            max_scan_ms: 0,
            ..Limits::default()
        };
        let out = compiled.scan(&text, &limits);
        assert!(out.timed_out, "le budget de temps n'a pas coupé le balayage");
        assert!(out.hits.is_empty());
        assert!(out.incomplete());

        // …and with a real budget the same text is found.
        let generous = Limits {
            max_part_bytes: 10 * 1024 * 1024,
            max_scan_ms: 5_000,
            ..Limits::default()
        };
        let out = compiled.scan(&text, &generous);
        assert!(!out.timed_out);
        assert!(!out.hits.is_empty());
    }

    #[test]
    fn truncation_never_splits_a_character() {
        // Slicing a &str off a boundary panics, and this runs on user content.
        let compiled = iban_detector();
        let text = "é".repeat(1_000);
        let limits = Limits {
            max_part_bytes: 501, // lands in the middle of a two-byte character
            ..Limits::default()
        };
        let out = compiled.scan(&text, &limits);
        assert_eq!(out.bytes_scanned, 500);
    }

    #[test]
    fn a_match_straddling_a_chunk_boundary_is_still_found_once() {
        // The bug this guards against is a detector that silently misses, which
        // is the worst failure mode a data-protection control has.
        let compiled = iban_detector();
        // The IBAN starts ten bytes before the end of the first chunk and runs
        // past it: without the overlap it would be seen only in part, and a
        // partial IBAN matches nothing.
        let padding = CHUNK_BYTES - 10;
        let text = format!("{} DE89370400440532013000 fin", "x".repeat(padding));
        let limits = Limits {
            max_part_bytes: 10 * 1024 * 1024,
            max_scan_ms: 5_000,
            ..Limits::default()
        };
        let out = compiled.scan(&text, &limits);
        assert_eq!(out.hits.len(), 1, "trouvé {} fois", out.hits.len());
    }

    // ── Checksum, proximity, confidence ──────────────────────────────────────

    #[test]
    fn a_failed_checksum_discards_the_candidate_entirely() {
        let compiled = iban_detector();
        // Right shape, wrong arithmetic.
        let out = compiled.scan("DE89370400440532013001", &Limits::default());
        assert!(out.hits.is_empty());
        // Right arithmetic.
        let out = compiled.scan("DE89370400440532013000", &Limits::default());
        assert_eq!(out.hits.len(), 1);
        // base 0.6 + checksum 0.35, no proximity term declared.
        assert!((out.hits[0].confidence - 0.95).abs() < 1e-5);
    }

    #[test]
    fn proximity_raises_confidence_and_can_be_the_whole_detection() {
        let mut d = detector(Kind::Regex);
        d.pattern = Some(r"\b\d{4}\b".into());
        d.proximity_terms = vec!["code".into()];
        d.proximity_window = 20;
        d.base_confidence = 0.4;
        d.proximity_bonus = 0.4;
        let compiled = Compiled::build(d).expect("compilable");

        let far = compiled.scan("1234", &Limits::default());
        assert_eq!(far.hits.len(), 1);
        assert!((far.hits[0].confidence - 0.4).abs() < 1e-5);

        let near = compiled.scan("code 1234", &Limits::default());
        assert!((near.hits[0].confidence - 0.8).abs() < 1e-5);

        // Outside the window: the keyword is there, but not next to it.
        let outside = compiled.scan(&format!("code{}1234", " ".repeat(60)), &Limits::default());
        assert!((outside.hits[0].confidence - 0.4).abs() < 1e-5);
    }

    #[test]
    fn a_required_keyword_that_is_absent_discards_the_match() {
        let mut d = detector(Kind::Regex);
        d.pattern = Some(r"\b\d{4}\b".into());
        d.proximity_terms = vec!["code".into()];
        d.proximity_window = 20;
        d.proximity_required = true;
        let compiled = Compiled::build(d).expect("compilable");

        assert!(compiled.scan("1234", &Limits::default()).hits.is_empty());
        assert_eq!(compiled.scan("code 1234", &Limits::default()).hits.len(), 1);
    }

    #[test]
    fn confidence_never_leaves_the_unit_interval() {
        let mut d = detector(Kind::Checksum);
        d.pattern = Some(r"\b\d{16}\b".into());
        d.checksum = Some(Checksum::Luhn);
        d.base_confidence = 0.9;
        d.checksum_bonus = 0.9;
        d.proximity_terms = vec!["carte".into()];
        d.proximity_bonus = 0.9;
        let compiled = Compiled::build(d).expect("compilable");
        let out = compiled.scan("carte 4111111111111111", &Limits::default());
        assert_eq!(out.hits.len(), 1);
        assert!((out.hits[0].confidence - 1.0).abs() < 1e-6);
    }

    // ── Tallying ─────────────────────────────────────────────────────────────

    #[test]
    fn the_same_value_repeated_counts_once_towards_distinctness() {
        // The threshold that stops "fifty account numbers" from meaning "one
        // account number pasted fifty times".
        let compiled = iban_detector();
        let text = "DE89370400440532013000 ".repeat(50);
        let out = compiled.scan(&text, &Limits::default());
        let (matches, unique, best) = out.tally(0.7);
        assert_eq!(matches, 50);
        assert_eq!(unique, 1);
        assert!(best > 0.9);
    }

    #[test]
    fn respacing_a_value_does_not_make_it_a_second_distinct_one() {
        // The obvious evasion of the distinct-value threshold.
        let compiled = iban_detector();
        let out = compiled.scan(
            "DE89370400440532013000 puis DE89 3704 0044 0532 0130 00",
            &Limits::default(),
        );
        let (matches, unique, _) = out.tally(0.7);
        assert_eq!(matches, 2);
        assert_eq!(unique, 1, "la normalisation doit fondre les deux écritures");
    }

    #[test]
    fn distinct_values_are_counted_distinctly() {
        let compiled = iban_detector();
        let out = compiled.scan(
            "DE89370400440532013000 BE68539007547034 GB82WEST12345698765432",
            &Limits::default(),
        );
        let (matches, unique, _) = out.tally(0.7);
        assert_eq!(matches, 3);
        assert_eq!(unique, 3);
    }

    #[test]
    fn the_confidence_floor_filters_before_anything_is_counted() {
        let mut d = detector(Kind::Regex);
        d.pattern = Some(r"\b\d{4}\b".into());
        d.base_confidence = 0.4;
        let compiled = Compiled::build(d).expect("compilable");
        let out = compiled.scan("1111 2222 3333", &Limits::default());
        assert_eq!(out.hits.len(), 3);
        assert_eq!(out.tally(0.7), (0, 0, 0.0));
        assert_eq!(out.tally(0.3).0, 3);
    }
}
