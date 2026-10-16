//! Verdict on the shared internal secret - never its value.
//!
//! `ServerSettings::validate_internal_secret` already refuses an empty secret
//! and anything under 32 bytes at startup, which is a length test and nothing
//! more: a secret of thirty-two `a`s boots the server happily. Since
//! `X-Internal-Secret` is the only thing standing between the outside world and
//! `/internal/*` - module registration, event publication - a guessable value
//! there is a full compromise, so the health page grades it.
//!
//! Everything in this file returns a VERDICT. There is deliberately no function
//! that echoes, truncates, hashes or fingerprints the secret: a check that
//! leaks four characters of a credential into a JSON payload an operator then
//! pastes into a bug report has done more harm than the check prevents.

/// Why a secret is judged weak. Stable identifiers: the console translates
/// them, and they carry nothing derived from the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretVerdict {
    /// Long, varied, no recognisable filler.
    Strong,
    /// Absent or blank.
    Missing,
    /// Under [`MIN_LEN`] bytes. Startup refuses this outright, so seeing it
    /// here means the value changed under a running process.
    TooShort,
    /// Contains a word from the placeholder list - the value shipped in the
    /// example configuration, or an obvious stand-in.
    Placeholder,
    /// Long enough, but with too little variety to be random (a repeated
    /// pattern, a single character, a keyboard run).
    LowVariety,
}

impl SecretVerdict {
    pub const fn as_str(self) -> &'static str {
        match self {
            SecretVerdict::Strong => "strong",
            SecretVerdict::Missing => "missing",
            SecretVerdict::TooShort => "too_short",
            SecretVerdict::Placeholder => "placeholder",
            SecretVerdict::LowVariety => "low_variety",
        }
    }

    pub const fn is_strong(self) -> bool {
        matches!(self, SecretVerdict::Strong)
    }
}

/// Mirrors `config::settings::MIN_INTERNAL_SECRET_LEN`.
const MIN_LEN: usize = 32;

/// Estimated entropy under which a secret of legal length is still a guess
/// away. A 32-character base64 string carries ~192 bits; 80 is a floor no
/// human-typed filler reaches and no generated secret falls under.
const MIN_ENTROPY_BITS: f64 = 80.0;

/// Case-insensitive markers of a value that was never replaced. `CHANGEZ_MOI`
/// is what `config.toml.example` ships, and it is the one an installer script
/// is most likely to leave behind.
const PLACEHOLDERS: &[&str] = &[
    "changez", "changeme", "change_me", "change-me", "tochange",
    "placeholder", "example", "default", "insecure", "dummy",
    "password", "motdepasse", "secret_here", "yoursecret", "votresecret",
    "todo", "fixme", "azerty", "qwerty", "123456",
];

/// Grades the secret. Pure, so the rules are unit-tested without a server.
pub fn grade(secret: &str) -> SecretVerdict {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return SecretVerdict::Missing;
    }
    if trimmed.len() < MIN_LEN {
        return SecretVerdict::TooShort;
    }

    let lowered = trimmed.to_ascii_lowercase();
    if PLACEHOLDERS.iter().any(|p| lowered.contains(p)) {
        return SecretVerdict::Placeholder;
    }

    // Two independent tests, because each misses what the other catches.
    //
    // The distribution test does not see structure: `0123` repeated ten times
    // has four symbols evenly spread, so it scores a respectable 80 bits while
    // being a four-character secret in disguise. The period test does not see
    // variety: `aaaa…b…aaaa` has no short period at all.
    if is_repetitive(trimmed) {
        return SecretVerdict::LowVariety;
    }
    if shannon_bits(trimmed) < MIN_ENTROPY_BITS {
        return SecretVerdict::LowVariety;
    }

    SecretVerdict::Strong
}

/// True when the value is one short block repeated - the shape of a secret
/// padded to length rather than generated.
///
/// "Repeated" means at least three times: two halves that happen to match is
/// improbable but possible in random data, three identical thirds is not.
fn is_repetitive(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    let len = chars.len();
    for period in 1..=len / 3 {
        if !len.is_multiple_of(period) {
            continue;
        }
        if chars.chunks(period).all(|chunk| chunk == &chars[..period]) {
            return true;
        }
    }
    false
}

/// Shannon entropy of the value, in bits: `len × H` over the observed character
/// distribution. It is an estimate, not a proof - but it separates a random
/// 48-character token from `abababab…` without needing a dictionary, and it
/// never has to hold on to the value.
fn shannon_bits(value: &str) -> f64 {
    let chars: Vec<char> = value.chars().collect();
    let len = chars.len();
    if len == 0 {
        return 0.0;
    }
    let mut counts: std::collections::HashMap<char, usize> = std::collections::HashMap::new();
    for c in &chars {
        *counts.entry(*c).or_insert(0) += 1;
    }
    let len_f = len as f64;
    let per_char: f64 = counts
        .values()
        .map(|&n| {
            let p = n as f64 / len_f;
            -p * p.log2()
        })
        .sum();
    per_char * len_f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_and_short_secrets_are_named_precisely() {
        assert_eq!(grade(""), SecretVerdict::Missing);
        assert_eq!(grade("   "), SecretVerdict::Missing);
        assert_eq!(grade("short"), SecretVerdict::TooShort);
        // 31 bytes - one under the floor.
        assert_eq!(grade(&"k".repeat(31)), SecretVerdict::TooShort);
    }

    #[test]
    fn the_shipped_example_value_is_caught_even_when_padded_to_length() {
        // The failure mode this check exists for: an operator satisfies the
        // length rule by padding the placeholder instead of replacing it.
        assert_eq!(grade("CHANGEZ_MOI_CHANGEZ_MOI_CHANGEZ_MOI"), SecretVerdict::Placeholder);
        assert_eq!(grade("my-super-secret-password-value-000"), SecretVerdict::Placeholder);
    }

    #[test]
    fn long_but_repetitive_values_are_refused() {
        // 32 identical characters pass the startup validator today.
        assert_eq!(grade(&"a".repeat(32)), SecretVerdict::LowVariety);
        assert_eq!(grade(&"ab".repeat(24)), SecretVerdict::LowVariety);
        // 4 evenly-spread symbols over 40 characters scores exactly at the
        // entropy floor: only the period test catches it.
        assert_eq!(grade(&"0123".repeat(10)), SecretVerdict::LowVariety);
    }

    #[test]
    fn periodicity_needs_three_repetitions_not_two() {
        assert!(is_repetitive("abcabcabc"));
        assert!(is_repetitive(&"xY7".repeat(11)));
        // Two identical halves are not enough evidence on their own.
        assert!(!is_repetitive("abcdefabcdef"));
        assert!(!is_repetitive("Xq7Rk2ZpL9wVn4Jt8sBc1YhM6dFgA3eU"));
    }

    #[test]
    fn a_secret_with_one_odd_character_among_filler_is_still_refused() {
        // No short period here, so only the distribution test can see it.
        let mostly_filler = format!("{}b{}", "a".repeat(20), "a".repeat(20));
        assert!(!is_repetitive(&mostly_filler));
        assert_eq!(grade(&mostly_filler), SecretVerdict::LowVariety);
    }

    #[test]
    fn a_generated_token_is_strong() {
        assert_eq!(grade("Xq7Rk2ZpL9wVn4Jt8sBc1YhM6dFgA3eU"), SecretVerdict::Strong);
        assert_eq!(
            grade("f3a9c1e7b25d48f0a6c93e1b7d5028af4c6e91b3d7052a8f"),
            SecretVerdict::Strong,
        );
    }

    #[test]
    fn entropy_grows_with_variety_not_just_length() {
        let uniform = shannon_bits(&"a".repeat(64));
        let varied = shannon_bits("Xq7Rk2ZpL9wVn4Jt8sBc1YhM6dFgA3eU");
        assert_eq!(uniform, 0.0);
        assert!(varied > MIN_ENTROPY_BITS, "got {varied}");
    }

    #[test]
    fn no_verdict_carries_the_value() {
        // The whole point: the verdict is a fixed vocabulary, so nothing
        // derived from the secret can travel with it.
        for v in [
            SecretVerdict::Strong,
            SecretVerdict::Missing,
            SecretVerdict::TooShort,
            SecretVerdict::Placeholder,
            SecretVerdict::LowVariety,
        ] {
            assert!(!v.as_str().is_empty());
            assert!(v.as_str().is_ascii());
        }
    }
}
