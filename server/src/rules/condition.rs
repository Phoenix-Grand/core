//! The condition tree: a closed vocabulary, deserialised by serde, evaluated
//! against a JSON fact.
//!
//! ## Why there is no expression language here
//!
//! The obvious way to let an administrator say "when a sign-in fails more than
//! five times from outside the office" is a little expression language. It is
//! also the wrong way. A parser is a surface: it has to be sandboxed, its
//! failure modes are runtime, and reviewing a rule means reading a program. The
//! vocabulary below is an enum instead - [`Condition`] and [`Operator`]. serde
//! rejects anything outside it before the engine ever sees it, `cargo test`
//! covers every branch, and a rule can be rendered back as a sentence because
//! there is a finite set of sentences.
//!
//! ```text
//!   { "type": "all", "of": [
//!       { "type": "compare", "field": "email", "op": "ends_with", "value": "@example.org" },
//!       { "type": "not", "of":
//!           { "type": "compare", "field": "role", "op": "eq", "value": "admin" } }
//!   ]}
//! ```
//!
//! ## Bounded on purpose
//!
//! Depth and leaf count are checked on **every write** ([`validate`]), not at
//! evaluation time. A rule that would take a millisecond per event to evaluate
//! is refused when it is saved, once, by the person who can fix it - rather than
//! discovered on the hot path by the instance it is slowing down.
//!
//! ## String comparisons are case-insensitive
//!
//! Deliberate, and documented in the console: the values administrators compare
//! are addresses, domains, usernames and setting keys, where `@Example.org` and
//! `@example.org` are the same thing to everyone except a byte comparison. Every
//! other type compares exactly.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::AppError;

use super::detect::{DetectorLeaf, Evidence};

/// Deepest nesting a condition tree may reach. The outermost node counts as 1.
pub const MAX_DEPTH: usize = 5;
/// Most comparisons a single rule may hold, all branches combined.
pub const MAX_LEAVES: usize = 32;

// ── Operators ────────────────────────────────────────────────────────────────

/// The closed set of comparisons.
///
/// No regular expressions: a regex is a mini-language with its own parser and
/// its own denial-of-service class (catastrophic backtracking), reintroducing
/// exactly what this enum exists to avoid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    /// The field's value is one of the listed values.
    In,
    NotIn,
    /// The field is present and not null.
    Exists,
    NotExists,
    IsTrue,
    IsFalse,
}

impl Operator {
    pub const ALL: &'static [Operator] = &[
        Operator::Eq,
        Operator::Ne,
        Operator::Lt,
        Operator::Lte,
        Operator::Gt,
        Operator::Gte,
        Operator::Contains,
        Operator::NotContains,
        Operator::StartsWith,
        Operator::EndsWith,
        Operator::In,
        Operator::NotIn,
        Operator::Exists,
        Operator::NotExists,
        Operator::IsTrue,
        Operator::IsFalse,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Operator::Eq => "eq",
            Operator::Ne => "ne",
            Operator::Lt => "lt",
            Operator::Lte => "lte",
            Operator::Gt => "gt",
            Operator::Gte => "gte",
            Operator::Contains => "contains",
            Operator::NotContains => "not_contains",
            Operator::StartsWith => "starts_with",
            Operator::EndsWith => "ends_with",
            Operator::In => "in",
            Operator::NotIn => "not_in",
            Operator::Exists => "exists",
            Operator::NotExists => "not_exists",
            Operator::IsTrue => "is_true",
            Operator::IsFalse => "is_false",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|o| o.as_str() == raw)
    }

    /// Does this operator read the `value` field at all? The unary ones do not,
    /// and a rule that supplies one is not wrong - it is ignored.
    pub const fn is_unary(self) -> bool {
        matches!(
            self,
            Operator::Exists | Operator::NotExists | Operator::IsTrue | Operator::IsFalse
        )
    }
}

// ── The tree ─────────────────────────────────────────────────────────────────

/// One node of a condition tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Condition {
    /// Every child must hold. An empty `all` matches - a rule with no condition
    /// fires on every occurrence of its trigger, which is a legitimate thing to
    /// want and must not be expressed as a trick.
    All { of: Vec<Condition> },
    /// At least one child must hold. An empty `any` matches nothing.
    Any { of: Vec<Condition> },
    Not { of: Box<Condition> },
    /// A single comparison.
    Compare {
        /// Dotted path into the fact, e.g. `subject.email`. Plain segment walk:
        /// no wildcards, no indexing expressions, nothing to interpret.
        field: String,
        op: Operator,
        #[serde(default)]
        value: Value,
    },
    /// "This content carries sensitive data of a named kind."
    ///
    /// The one leaf that reads content rather than facts - and it still carries
    /// no logic: a catalogue key and three thresholds
    /// ([`super::detect::DetectorLeaf`]). The pattern lives in the detector, a
    /// row an administrator manages on its own screen, tested on its own screen,
    /// audited on its own trail. That separation is what let content inspection
    /// arrive without an expression language arriving with it: the vocabulary
    /// here is still a serde enum, and serde still refuses everything outside
    /// it.
    ///
    /// Outside the synchronous gate there is no content, so this leaf answers
    /// `false` - see [`Condition::matches`].
    Detector(DetectorLeaf),
}

impl Default for Condition {
    fn default() -> Self {
        Condition::All { of: Vec::new() }
    }
}

impl Condition {
    /// Depth of the tree, the root counting as 1.
    pub fn depth(&self) -> usize {
        match self {
            Condition::Compare { .. } | Condition::Detector(_) => 1,
            Condition::Not { of } => 1 + of.depth(),
            Condition::All { of } | Condition::Any { of } => {
                1 + of.iter().map(Condition::depth).max().unwrap_or(0)
            }
        }
    }

    /// Number of leaves in the whole tree, comparisons and detectors alike.
    ///
    /// Detector leaves count towards the same ceiling as comparisons and are not
    /// given an allowance of their own: they are the *expensive* ones, and a
    /// budget that gets more generous the more expensive the leaf is is not a
    /// budget.
    pub fn leaves(&self) -> usize {
        match self {
            Condition::Compare { .. } | Condition::Detector(_) => 1,
            Condition::Not { of } => of.leaves(),
            Condition::All { of } | Condition::Any { of } => {
                of.iter().map(Condition::leaves).sum()
            }
        }
    }

    /// Every `(field, operator)` pair the tree uses, for validation against the
    /// trigger's declared fields.
    pub fn comparisons(&self) -> Vec<(&str, Operator)> {
        let mut out = Vec::new();
        self.collect(&mut out);
        out
    }

    fn collect<'a>(&'a self, out: &mut Vec<(&'a str, Operator)>) {
        match self {
            Condition::Compare { field, op, .. } => out.push((field.as_str(), *op)),
            Condition::Detector(_) => {}
            Condition::Not { of } => of.collect(out),
            Condition::All { of } | Condition::Any { of } => {
                for c in of {
                    c.collect(out);
                }
            }
        }
    }

    /// Every detector leaf in the tree, for validation and for deciding what to
    /// scan before the tree is evaluated.
    pub fn detectors(&self) -> Vec<&DetectorLeaf> {
        let mut out = Vec::new();
        self.collect_detectors(&mut out);
        out
    }

    fn collect_detectors<'a>(&'a self, out: &mut Vec<&'a DetectorLeaf>) {
        match self {
            Condition::Detector(leaf) => out.push(leaf),
            Condition::Compare { .. } => {}
            Condition::Not { of } => of.collect_detectors(out),
            Condition::All { of } | Condition::Any { of } => {
                for c in of {
                    c.collect_detectors(out);
                }
            }
        }
    }

    /// Does the tree hold for `facts`, with no content inspected?
    ///
    /// The asynchronous path: the bus carries an event, not a document, so every
    /// detector leaf answers `false`. That is deliberate rather than a gap - a
    /// data-protection rule is a rule about content, and content only exists on
    /// the synchronous gate. Silently matching on a *fact* that happened to be
    /// named `body` would be far worse than not matching.
    pub fn matches(&self, facts: &Value) -> bool {
        self.matches_with(facts, &Evidence::empty())
    }

    /// Does the tree hold for `facts`, given what was found in the content?
    ///
    /// Total: a missing field, a type mismatch, a nonsensical comparison or an
    /// unknown detector answers `false` rather than erroring. An engine that can
    /// fail to evaluate has a third outcome nobody designed for, and on the hot
    /// path that third outcome is always the one that ships.
    pub fn matches_with(&self, facts: &Value, evidence: &Evidence) -> bool {
        match self {
            Condition::All { of } => of.iter().all(|c| c.matches_with(facts, evidence)),
            Condition::Any { of } => of.iter().any(|c| c.matches_with(facts, evidence)),
            Condition::Not { of } => !of.matches_with(facts, evidence),
            Condition::Compare { field, op, value } => {
                compare(lookup(facts, field), *op, value)
            }
            // A lookup and three comparisons: the scanning happened once, before
            // the tree was walked. See `super::detect` for why a leaf must not
            // be able to spend milliseconds behind a `!`.
            Condition::Detector(leaf) => evidence.holds(leaf),
        }
    }
}

/// Validates depth and breadth. Called on every write, never on the hot path.
pub fn validate(condition: &Condition, max_depth: usize, max_leaves: usize) -> Result<(), AppError> {
    let depth = condition.depth();
    if depth > max_depth {
        return Err(AppError::Validation(format!(
            "Arbre de conditions trop profond : {depth} niveaux, maximum {max_depth}"
        )));
    }
    let leaves = condition.leaves();
    if leaves > max_leaves {
        return Err(AppError::Validation(format!(
            "Trop de comparaisons dans la règle : {leaves}, maximum {max_leaves}"
        )));
    }
    Ok(())
}

// ── Field lookup ─────────────────────────────────────────────────────────────

/// Walks a dotted path. Returns `None` for an absent path, and for a path that
/// tries to descend into a scalar.
pub fn lookup<'a>(facts: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cursor = facts;
    for segment in path.split('.') {
        if segment.is_empty() {
            return None;
        }
        cursor = cursor.get(segment)?;
    }
    match cursor {
        Value::Null => None,
        other => Some(other),
    }
}

// ── Comparison ───────────────────────────────────────────────────────────────

fn compare(actual: Option<&Value>, op: Operator, expected: &Value) -> bool {
    // Presence operators answer before anything is read.
    match op {
        Operator::Exists => return actual.is_some(),
        Operator::NotExists => return actual.is_none(),
        _ => {}
    }

    let Some(actual) = actual else {
        // An absent field satisfies nothing. `not_exists` above is the only way
        // to assert absence, which keeps "the field is missing" from silently
        // meaning "the field differs".
        return false;
    };

    match op {
        Operator::Exists | Operator::NotExists => unreachable!("traités plus haut"),
        Operator::IsTrue => actual.as_bool() == Some(true),
        Operator::IsFalse => actual.as_bool() == Some(false),
        Operator::Eq => equals(actual, expected),
        Operator::Ne => !equals(actual, expected),
        Operator::Lt | Operator::Lte | Operator::Gt | Operator::Gte => {
            match order(actual, expected) {
                Some(ordering) => match op {
                    Operator::Lt => ordering.is_lt(),
                    Operator::Lte => ordering.is_le(),
                    Operator::Gt => ordering.is_gt(),
                    Operator::Gte => ordering.is_ge(),
                    _ => unreachable!("borné par le bras extérieur"),
                },
                None => false,
            }
        }
        Operator::Contains => text_pair(actual, expected)
            .map(|(a, b)| a.contains(&b))
            .unwrap_or(false),
        Operator::NotContains => text_pair(actual, expected)
            .map(|(a, b)| !a.contains(&b))
            // A non-textual pair cannot be said to "not contain" anything either.
            .unwrap_or(false),
        Operator::StartsWith => text_pair(actual, expected)
            .map(|(a, b)| a.starts_with(&b))
            .unwrap_or(false),
        Operator::EndsWith => text_pair(actual, expected)
            .map(|(a, b)| a.ends_with(&b))
            .unwrap_or(false),
        Operator::In => member_of(actual, expected),
        Operator::NotIn => match expected {
            Value::Array(_) => !member_of(actual, expected),
            // `not_in` against a non-list is meaningless; refusing to match is
            // safer than the alternative, which would fire on everything.
            _ => false,
        },
    }
}

/// Equality, case-insensitive between two strings, numeric between two numbers.
fn equals(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::String(a), Value::String(b)) => a.to_lowercase() == b.to_lowercase(),
        (Value::Number(_), Value::Number(_)) => number(actual) == number(expected),
        // A number compared against its own decimal notation as a string is the
        // single most common way to write a rule that silently never fires.
        (Value::Number(_), Value::String(_)) | (Value::String(_), Value::Number(_)) => {
            match (number(actual), number(expected)) {
                (Some(a), Some(b)) => a == b,
                _ => false,
            }
        }
        _ => actual == expected,
    }
}

fn order(actual: &Value, expected: &Value) -> Option<std::cmp::Ordering> {
    if let (Some(a), Some(b)) = (number(actual), number(expected)) {
        return a.partial_cmp(&b);
    }
    match (actual, expected) {
        (Value::String(a), Value::String(b)) => Some(a.to_lowercase().cmp(&b.to_lowercase())),
        _ => None,
    }
}

/// Numeric reading of a value, accepting the decimal notation of a number given
/// as a string (a JSON payload that went through a form does that constantly).
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(_) | Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

/// Both sides as lower-cased text, or `None` when either side is not textual.
fn text_pair(actual: &Value, expected: &Value) -> Option<(String, String)> {
    let a = actual.as_str()?.to_lowercase();
    let b = expected.as_str()?.to_lowercase();
    Some((a, b))
}

fn member_of(actual: &Value, expected: &Value) -> bool {
    match expected {
        Value::Array(items) => items.iter().any(|item| equals(actual, item)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn facts() -> Value {
        json!({
            "event_type": "core.auth.login_failed",
            "count": 7,
            "subject": { "email": "Alice@Example.ORG", "role": "user", "active": true },
            "quota": { "used": 12.5 },
            "tags": ["beta", "pilot"]
        })
    }

    fn cmp(field: &str, op: Operator, value: Value) -> Condition {
        Condition::Compare {
            field: field.into(),
            op,
            value,
        }
    }

    // ── Operators, one by one ────────────────────────────────────────────────

    #[test]
    fn every_operator_has_a_covered_behaviour() {
        let f = facts();
        let cases: Vec<(Condition, bool, &str)> = vec![
            (cmp("subject.role", Operator::Eq, json!("user")), true, "eq"),
            (cmp("subject.role", Operator::Eq, json!("admin")), false, "eq faux"),
            (cmp("subject.role", Operator::Ne, json!("admin")), true, "ne"),
            (cmp("count", Operator::Lt, json!(10)), true, "lt"),
            (cmp("count", Operator::Lt, json!(7)), false, "lt strict"),
            (cmp("count", Operator::Lte, json!(7)), true, "lte"),
            (cmp("count", Operator::Gt, json!(3)), true, "gt"),
            (cmp("count", Operator::Gte, json!(7)), true, "gte"),
            (cmp("subject.email", Operator::Contains, json!("example")), true, "contains"),
            (cmp("subject.email", Operator::NotContains, json!("gmail")), true, "not_contains"),
            (cmp("subject.email", Operator::StartsWith, json!("alice")), true, "starts_with"),
            (cmp("subject.email", Operator::EndsWith, json!("@example.org")), true, "ends_with"),
            (cmp("subject.role", Operator::In, json!(["user", "guest"])), true, "in"),
            (cmp("subject.role", Operator::NotIn, json!(["admin"])), true, "not_in"),
            (cmp("subject.email", Operator::Exists, Value::Null), true, "exists"),
            (cmp("subject.phone", Operator::NotExists, Value::Null), true, "not_exists"),
            (cmp("subject.active", Operator::IsTrue, Value::Null), true, "is_true"),
            (cmp("subject.active", Operator::IsFalse, Value::Null), false, "is_false"),
        ];
        for (condition, expected, label) in cases {
            assert_eq!(condition.matches(&f), expected, "opérateur : {label}");
        }
    }

    #[test]
    fn operators_round_trip_through_their_wire_form() {
        for op in Operator::ALL {
            assert_eq!(Operator::parse(op.as_str()), Some(*op));
        }
        // The vocabulary is closed: nothing outside it deserialises.
        assert_eq!(Operator::parse("regex"), None);
        assert!(serde_json::from_str::<Operator>("\"regex\"").is_err());
    }

    #[test]
    fn a_missing_field_satisfies_nothing_but_not_exists() {
        let f = facts();
        for op in Operator::ALL {
            let c = cmp("subject.absent", *op, json!("x"));
            let expected = *op == Operator::NotExists;
            assert_eq!(c.matches(&f), expected, "champ absent + {}", op.as_str());
        }
    }

    #[test]
    fn string_comparisons_ignore_case() {
        let f = facts();
        assert!(cmp("subject.email", Operator::Eq, json!("alice@example.org")).matches(&f));
        assert!(cmp("subject.email", Operator::EndsWith, json!("@EXAMPLE.ORG")).matches(&f));
        assert!(cmp("subject.role", Operator::In, json!(["USER"])).matches(&f));
    }

    #[test]
    fn a_number_written_as_a_string_still_compares_numerically() {
        // The most common way to write a rule that silently never fires.
        let f = facts();
        assert!(cmp("count", Operator::Eq, json!("7")).matches(&f));
        assert!(cmp("count", Operator::Gt, json!("3")).matches(&f));
        assert!(cmp("quota.used", Operator::Gte, json!(12.5)).matches(&f));
    }

    #[test]
    fn a_nonsensical_comparison_is_false_rather_than_an_error() {
        let f = facts();
        // Ordering a list against a number, containing a boolean in a number…
        assert!(!cmp("tags", Operator::Gt, json!(3)).matches(&f));
        assert!(!cmp("count", Operator::Contains, json!("7")).matches(&f));
        assert!(!cmp("subject.role", Operator::In, json!("user")).matches(&f));
        assert!(!cmp("subject.role", Operator::NotIn, json!("user")).matches(&f));
    }

    // ── Nesting ──────────────────────────────────────────────────────────────

    #[test]
    fn nested_trees_evaluate_and_short_circuit_correctly() {
        let f = facts();
        let tree = Condition::All {
            of: vec![
                cmp("count", Operator::Gte, json!(5)),
                Condition::Any {
                    of: vec![
                        cmp("subject.email", Operator::EndsWith, json!("@nope.test")),
                        Condition::Not {
                            of: Box::new(cmp("subject.role", Operator::Eq, json!("admin"))),
                        },
                    ],
                },
            ],
        };
        assert!(tree.matches(&f));

        // One false branch inside an `all` is enough.
        let tree = Condition::All {
            of: vec![
                cmp("count", Operator::Gte, json!(5)),
                cmp("subject.role", Operator::Eq, json!("admin")),
            ],
        };
        assert!(!tree.matches(&f));
    }

    #[test]
    fn an_empty_all_matches_and_an_empty_any_does_not() {
        let f = facts();
        // A rule with no condition fires on every occurrence of its trigger.
        assert!(Condition::All { of: vec![] }.matches(&f));
        assert!(Condition::default().matches(&f));
        // …whereas "at least one of nothing" is unsatisfiable, which is what
        // makes the two containers genuinely different rather than aliases.
        assert!(!Condition::Any { of: vec![] }.matches(&f));
    }

    #[test]
    fn double_negation_is_transparent() {
        let f = facts();
        let inner = cmp("subject.role", Operator::Eq, json!("user"));
        let double = Condition::Not {
            of: Box::new(Condition::Not { of: Box::new(inner) }),
        };
        assert!(double.matches(&f));
    }

    // ── Bounds ───────────────────────────────────────────────────────────────

    fn nest(depth: usize) -> Condition {
        let mut c = Condition::Compare {
            field: "count".into(),
            op: Operator::Gt,
            value: json!(0),
        };
        for _ in 1..depth {
            c = Condition::All { of: vec![c] };
        }
        c
    }

    #[test]
    fn depth_is_counted_from_one_and_refused_past_the_ceiling() {
        assert_eq!(nest(1).depth(), 1);
        assert_eq!(nest(MAX_DEPTH).depth(), MAX_DEPTH);
        assert!(validate(&nest(MAX_DEPTH), MAX_DEPTH, MAX_LEAVES).is_ok());

        let too_deep = nest(MAX_DEPTH + 1);
        assert_eq!(too_deep.depth(), MAX_DEPTH + 1);
        let err = validate(&too_deep, MAX_DEPTH, MAX_LEAVES).expect_err("doit être refusé");
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn breadth_is_refused_past_the_ceiling() {
        let wide = Condition::Any {
            of: (0..MAX_LEAVES + 1)
                .map(|i| cmp("count", Operator::Eq, json!(i)))
                .collect(),
        };
        assert_eq!(wide.leaves(), MAX_LEAVES + 1);
        // Shallow, so only the leaf ceiling can catch it.
        assert_eq!(wide.depth(), 2);
        assert!(validate(&wide, MAX_DEPTH, MAX_LEAVES).is_err());
    }

    #[test]
    fn a_not_node_does_not_inflate_the_leaf_count() {
        let c = Condition::Not {
            of: Box::new(cmp("count", Operator::Gt, json!(1))),
        };
        assert_eq!(c.leaves(), 1);
        assert_eq!(c.depth(), 2);
    }

    #[test]
    fn comparisons_are_collected_for_catalogue_validation() {
        let tree = Condition::All {
            of: vec![
                cmp("a", Operator::Eq, json!(1)),
                Condition::Not {
                    of: Box::new(cmp("b.c", Operator::Contains, json!("x"))),
                },
            ],
        };
        assert_eq!(
            tree.comparisons(),
            vec![("a", Operator::Eq), ("b.c", Operator::Contains)]
        );
    }

    // ── Wire form ────────────────────────────────────────────────────────────

    #[test]
    fn the_wire_form_round_trips_and_rejects_anything_unknown() {
        let raw = r#"{"type":"all","of":[
            {"type":"compare","field":"subject.email","op":"ends_with","value":"@example.org"},
            {"type":"not","of":{"type":"compare","field":"subject.role","op":"eq","value":"admin"}}
        ]}"#;
        let parsed: Condition = serde_json::from_str(raw).expect("forme valide");
        assert_eq!(parsed.leaves(), 2);
        assert!(parsed.matches(&facts()));

        let round = serde_json::to_string(&parsed).expect("sérialisable");
        let again: Condition = serde_json::from_str(&round).expect("aller-retour");
        assert_eq!(again.leaves(), 2);

        // An unknown node type is not a node with a default meaning: it is
        // refused, which is the whole point of a closed vocabulary.
        assert!(serde_json::from_str::<Condition>(r#"{"type":"eval","code":"1+1"}"#).is_err());
    }

    // ── The detector leaf ────────────────────────────────────────────────────

    #[test]
    fn a_detector_leaf_deserialises_into_the_closed_vocabulary() {
        let raw = r#"{"type":"detector","detector":"core.iban",
                      "min_confidence":0.8,"min_matches":2,"min_unique_matches":2,
                      "parts":["body"]}"#;
        let parsed: Condition = serde_json::from_str(raw).expect("forme valide");
        assert_eq!(parsed.leaves(), 1);
        assert_eq!(parsed.depth(), 1);
        let leaves = parsed.detectors();
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].detector, "core.iban");
        assert_eq!(leaves[0].min_unique_matches, 2);

        // Round trip, and still nothing to interpret in it.
        let round = serde_json::to_string(&parsed).expect("sérialisable");
        assert!(round.contains("\"type\":\"detector\""));
        let again: Condition = serde_json::from_str(&round).expect("aller-retour");
        assert_eq!(again.detectors().len(), 1);
    }

    #[test]
    fn a_detector_leaf_carries_no_pattern_and_cannot_be_given_one() {
        // The founding principle, asserted: adding content inspection must not
        // have added an expression language through the back door.
        assert!(serde_json::from_str::<Condition>(
            r#"{"type":"detector","pattern":"(a+)+"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Condition>(r#"{"type":"regex","pattern":"x"}"#).is_err());
    }

    #[test]
    fn a_detector_leaf_never_matches_without_content() {
        // The asynchronous path. A rule about content is inert on the bus, and
        // `not detector` is therefore true there - which is exactly why
        // `matches` is documented rather than merely implemented.
        let f = facts();
        let leaf: Condition =
            serde_json::from_str(r#"{"type":"detector","detector":"core.iban"}"#)
                .expect("forme valide");
        assert!(!leaf.matches(&f));
        assert!(Condition::Not { of: Box::new(leaf) }.matches(&f));
    }

    #[test]
    fn a_detector_leaf_is_counted_by_the_same_budget_as_a_comparison() {
        let tree = Condition::All {
            of: (0..MAX_LEAVES + 1)
                .map(|_| {
                    serde_json::from_str::<Condition>(
                        r#"{"type":"detector","detector":"core.iban"}"#,
                    )
                    .expect("forme valide")
                })
                .collect(),
        };
        assert_eq!(tree.leaves(), MAX_LEAVES + 1);
        assert!(validate(&tree, MAX_DEPTH, MAX_LEAVES).is_err());
    }

    #[test]
    fn detector_leaves_are_collected_from_every_branch() {
        let tree = Condition::All {
            of: vec![
                cmp("count", Operator::Gt, json!(1)),
                Condition::Not {
                    of: Box::new(
                        serde_json::from_str(r#"{"type":"detector","detector":"core.card"}"#)
                            .expect("forme valide"),
                    ),
                },
                Condition::Any {
                    of: vec![serde_json::from_str(
                        r#"{"type":"detector","detector":"core.nir"}"#,
                    )
                    .expect("forme valide")],
                },
            ],
        };
        let keys: Vec<&str> = tree.detectors().iter().map(|l| l.detector.as_str()).collect();
        assert_eq!(keys, vec!["core.card", "core.nir"]);
        // …and a detector leaf contributes no comparison to validate against
        // the trigger's fields.
        assert_eq!(tree.comparisons(), vec![("count", Operator::Gt)]);
    }

    #[test]
    fn a_lookup_never_descends_into_a_scalar() {
        let f = facts();
        assert!(lookup(&f, "count.nope").is_none());
        assert!(lookup(&f, "").is_none());
        assert!(lookup(&f, "subject..email").is_none());
        assert_eq!(lookup(&f, "subject.role"), Some(&json!("user")));
    }
}
