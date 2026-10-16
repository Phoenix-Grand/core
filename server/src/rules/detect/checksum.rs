//! The arithmetic checks that turn a shape into an identifier.
//!
//! A pattern answers "does this look like a card number". A checksum answers
//! "is this one". The difference is the whole usefulness of the feature: sixteen
//! digits appear in order references, invoice lines, product codes and phone
//! logs, and a detector that fires on all of them is a detector an operator
//! turns off within a week.
//!
//! Every function here is **total and pure**: a malformed candidate answers
//! `false` rather than erroring. They run on the hot path of the gate, once per
//! candidate, and a third outcome nobody designed for is a third outcome that
//! eventually ships.
//!
//! ## What "discard" means
//!
//! A failed checksum removes the candidate entirely rather than lowering its
//! confidence. Lowering it would mean a rule with a permissive threshold still
//! fires on arithmetic nonsense, which is exactly the false positive the check
//! exists to remove.

use serde::{Deserialize, Serialize};

/// The closed set of checks a detector may name. Closed for the same reason the
/// condition vocabulary is: an administrator picks from a list the server can
/// enumerate, never writes an algorithm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Checksum {
    /// Payment cards, SIREN, and everything else built on the 1954 patent.
    Luhn,
    /// IBAN, ISO 13616: move the country prefix to the end, mod 97 must be 1.
    Iban,
    /// French social-security number: 13 digits plus a 2-digit key, mod 97.
    Nir,
    /// French establishment identifier: 14 digits, Luhn, with the La Poste rule.
    Siret,
    /// French bank account details: the mod-97 key over bank, branch, account.
    RibFr,
}

impl Checksum {
    pub const ALL: &'static [Checksum] = &[
        Checksum::Luhn,
        Checksum::Iban,
        Checksum::Nir,
        Checksum::Siret,
        Checksum::RibFr,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Checksum::Luhn => "luhn",
            Checksum::Iban => "iban",
            Checksum::Nir => "nir",
            Checksum::Siret => "siret",
            Checksum::RibFr => "rib_fr",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|c| c.as_str() == raw)
    }

    /// Does `candidate` pass? Separators are the caller's problem to leave in:
    /// every implementation strips what it does not want.
    pub fn verify(self, candidate: &str) -> bool {
        match self {
            Checksum::Luhn => luhn(candidate),
            Checksum::Iban => iban(candidate),
            Checksum::Nir => nir(candidate),
            Checksum::Siret => siret(candidate),
            Checksum::RibFr => rib_fr(candidate),
        }
    }
}

// ── Luhn ─────────────────────────────────────────────────────────────────────

/// The Luhn check over every digit of `candidate`, other characters ignored.
///
/// Rejects a candidate of fewer than two digits and one made only of zeroes:
/// `0000000000000000` passes the arithmetic and is not a card number, and a
/// placeholder is the single most common thing in a document that also carries
/// a real one.
pub fn luhn(candidate: &str) -> bool {
    let digits: Vec<u32> = candidate.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() < 2 || digits.iter().all(|d| *d == 0) {
        return false;
    }
    let mut sum = 0u32;
    for (i, d) in digits.iter().rev().enumerate() {
        let mut v = *d;
        if i % 2 == 1 {
            v *= 2;
            if v > 9 {
                v -= 9;
            }
        }
        sum += v;
    }
    sum.is_multiple_of(10)
}

// ── IBAN ─────────────────────────────────────────────────────────────────────

/// ISO 13616: rotate the first four characters to the end, map letters to their
/// two-digit ordinal from 10, and require a remainder of 1 modulo 97.
///
/// The remainder is computed **incrementally** rather than by building one big
/// integer: an IBAN is up to 34 characters, so the decimal expansion reaches 68
/// digits, well past `u128`. Chunking keeps every intermediate inside `u64` and
/// works for any length without a bignum dependency.
pub fn iban(candidate: &str) -> bool {
    let compact: String = candidate
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();

    // ISO 13616 caps an IBAN at 34; the shortest in use (Norway) is 15.
    if !(15..=34).contains(&compact.len()) {
        return false;
    }
    let bytes = compact.as_bytes();
    // Country code, then the two check digits.
    if !bytes[0].is_ascii_alphabetic()
        || !bytes[1].is_ascii_alphabetic()
        || !bytes[2].is_ascii_digit()
        || !bytes[3].is_ascii_digit()
    {
        return false;
    }

    let rotated = format!("{}{}", &compact[4..], &compact[..4]);
    let mut remainder: u64 = 0;
    for c in rotated.chars() {
        if let Some(d) = c.to_digit(10) {
            remainder = remainder * 10 + u64::from(d);
        } else if c.is_ascii_uppercase() {
            // 'A' → 10 … 'Z' → 35, two decimal digits each.
            remainder = remainder * 100 + u64::from(c as u8 - b'A') + 10;
        } else {
            return false;
        }
        // Reduced every step; the largest intermediate is 96 * 100 + 35.
        remainder %= 97;
    }
    remainder == 1
}

// ── NIR ──────────────────────────────────────────────────────────────────────

/// French social-security number: 13 characters of number plus a 2-digit key,
/// the key being `97 - (number mod 97)`.
///
/// Corsica is the one irregularity and the one everybody gets wrong: the
/// department is written `2A` or `2B`, so the "number" is not a number. The
/// official correction replaces the letter with `0` and subtracts one million
/// for `A`, two million for `B`. A NIR from Ajaccio is refused by every
/// implementation that skips this, which makes it a correctness bug that
/// discriminates by birthplace.
pub fn nir(candidate: &str) -> bool {
    let compact: String = candidate
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if compact.len() != 15 {
        return false;
    }
    let (body, key) = compact.split_at(13);
    let Ok(key) = key.parse::<u64>() else {
        return false;
    };

    let (digits, correction): (String, u64) = if body.contains('A') {
        (body.replace('A', "0"), 1_000_000)
    } else if body.contains('B') {
        (body.replace('B', "0"), 2_000_000)
    } else {
        (body.to_string(), 0)
    };
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let Ok(number) = digits.parse::<u64>() else {
        return false;
    };
    let Some(number) = number.checked_sub(correction) else {
        return false;
    };

    // The key is 1..=97; `97 - 0` is 97 and is a legitimate key.
    key == 97 - (number % 97)
}

// ── SIRET ────────────────────────────────────────────────────────────────────

/// French establishment identifier: fourteen digits, Luhn - except La Poste.
///
/// Every SIRET whose SIREN is `356000000` fails Luhn by construction and is
/// checked instead by "the digits sum to a multiple of five". That is not a
/// curiosity to leave out: La Poste has tens of thousands of establishments, and
/// a detector that misses all of them misses one of the largest employers in the
/// country.
pub fn siret(candidate: &str) -> bool {
    let digits: String = candidate.chars().filter(char::is_ascii_digit).collect();
    if digits.len() != 14 {
        return false;
    }
    if digits.starts_with("356000000") {
        let sum: u32 = digits.chars().filter_map(|c| c.to_digit(10)).sum();
        return sum.is_multiple_of(5);
    }
    luhn(&digits)
}

// ── RIB ──────────────────────────────────────────────────────────────────────

/// French bank account details: 5 + 5 + 11 + 2 characters, the last two being
/// the key `97 - ((89·bank + 15·branch + 3·account) mod 97)`.
///
/// The account number may carry letters, converted by the Bank of France's
/// table (`A`,`J` → 1 … `I`,`R`,`Z` → 9) - the same table the account holder
/// sees printed on their own statement.
pub fn rib_fr(candidate: &str) -> bool {
    let compact: String = candidate
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if compact.len() != 23 {
        return false;
    }
    let bank = &compact[0..5];
    let branch = &compact[5..10];
    let account = &compact[10..21];
    let key = &compact[21..23];

    let (Ok(bank), Ok(key)) = (bank.parse::<u64>(), key.parse::<u64>()) else {
        return false;
    };
    let (Some(branch), Some(account)) = (letters_to_digits(branch), letters_to_digits(account))
    else {
        return false;
    };

    // 89·bank + 15·branch + 3·account overflows nothing: every term is already
    // reduced below 97.
    let total = 89 * (bank % 97) + 15 * (branch % 97) + 3 * (account % 97);
    // The key runs 1..=97, never 0: a remainder of zero yields the key 97, and
    // reducing that back to 0 would refuse one account in ninety-seven.
    key == 97 - (total % 97)
}

/// The Bank of France letter table, then the value modulo 97.
///
/// Reduced as it goes for the same reason as the IBAN: an eleven-character
/// account whose letters expand to two digits each would not fit a `u64`.
fn letters_to_digits(raw: &str) -> Option<u64> {
    let mut acc: u64 = 0;
    for c in raw.chars() {
        let value = if let Some(d) = c.to_digit(10) {
            u64::from(d)
        } else if c.is_ascii_uppercase() {
            // A..I → 1..9, J..R → 1..9, S..Z → 2..9. The table is the letter's
            // position within its group of nine, which is what this arithmetic
            // spells out.
            let index = u64::from(c as u8 - b'A');
            match index {
                0..=8 => index + 1,
                9..=17 => index - 8,
                _ => index - 16,
            }
        } else {
            return None;
        };
        acc = (acc * 10 + value) % 97;
    }
    Some(acc)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Luhn ─────────────────────────────────────────────────────────────────

    #[test]
    fn luhn_accepts_real_card_numbers_and_refuses_near_misses() {
        // Test numbers published by the schemes themselves; no real card here.
        for ok in [
            "4539578763621486",
            "4111111111111111",
            "5500005555555559",
            "4539 5787 6362 1486",
            "4539-5787-6362-1486",
        ] {
            assert!(luhn(ok), "devrait passer : {ok}");
        }
        for bad in [
            "1234567890123456",
            "4539578763621487", // last digit changed
            "4539578763621",    // truncated
            "",
            "4",
        ] {
            assert!(!luhn(bad), "devrait échouer : {bad}");
        }
    }

    #[test]
    fn a_run_of_zeroes_is_not_an_identifier_even_though_it_passes() {
        // The arithmetic says yes; the placeholder in a template is the single
        // most common thing sitting next to a real number.
        assert!(!luhn("0000000000000000"));
        assert!(!luhn("00000000"));
    }

    #[test]
    fn luhn_covers_the_siren_it_is_also_used_for() {
        assert!(luhn("732829320")); // published SIREN
        assert!(luhn("552100554"));
        assert!(!luhn("732829321"));
    }

    // ── IBAN ─────────────────────────────────────────────────────────────────

    #[test]
    fn iban_accepts_the_published_examples_of_several_countries() {
        for ok in [
            "FR7630006000011234567890189",
            "FR14 2004 1010 0505 0001 3M02 606",
            "DE89370400440532013000",
            "BE68539007547034",
            "GB82WEST12345698765432",
        ] {
            assert!(iban(ok), "devrait passer : {ok}");
        }
    }

    #[test]
    fn iban_refuses_a_transposition_which_is_the_error_it_exists_for() {
        // Two adjacent characters swapped - a typo mod 97 is designed to catch.
        assert!(!iban("FR7630006000011234567809189"));
        assert!(!iban("DE89370400440532013001"));
        // Wrong check digits.
        assert!(!iban("FR0030006000011234567890189"));
        // Structurally impossible.
        assert!(!iban("FR76"));
        assert!(!iban("7630006000011234567890189"));
        assert!(!iban(&"FR76".repeat(20)));
    }

    #[test]
    fn iban_stays_exact_at_the_maximum_length_where_a_naive_integer_overflows() {
        // 34 characters is 68 decimal digits once letters expand: any
        // implementation that builds the number first is wrong here.
        assert!(iban("MT84MALT011000012345MTLCAST001S"));
    }

    // ── NIR ──────────────────────────────────────────────────────────────────

    #[test]
    fn nir_accepts_a_published_number_and_refuses_a_wrong_key() {
        assert!(nir("269054958815780"));
        assert!(nir("2 69 05 49 588 157 80"));
        assert!(!nir("269054958815781"));
        assert!(!nir("269054958815"));
        assert!(!nir("26905495881578012"));
    }

    #[test]
    fn nir_handles_corsica_which_is_where_naive_implementations_break() {
        // 2A/2B are not digits. An implementation that skips the correction
        // refuses every insured person born in Corsica.
        //
        // 13 characters: sex(1) year(2) month(2) department(2 → "2A")
        // commune(3) order(3). The key is derived here rather than quoted, so
        // the test states the rule instead of memorising one answer.
        let body = "155082A123456";
        let digits = body.replace('A', "0");
        let number: u64 = digits.parse::<u64>().expect("chiffres") - 1_000_000;
        let key = 97 - (number % 97);
        let candidate = format!("{body}{key:02}");
        assert!(nir(&candidate), "NIR corse 2A refusé : {candidate}");

        // The same number with the 2B correction must NOT validate under 2A's.
        let wrong = format!("155082B123456{key:02}");
        assert!(!nir(&wrong), "la correction 2B doit différer de 2A");
    }

    // ── SIRET ────────────────────────────────────────────────────────────────

    #[test]
    fn siret_is_luhn_over_fourteen_digits() {
        assert!(siret("44306184100047"));
        assert!(siret("443 061 841 00047"));
        assert!(!siret("44306184100048"));
        assert!(!siret("443061841"), "un SIREN n'est pas un SIRET");
    }

    #[test]
    fn siret_knows_the_la_poste_exception() {
        // Every La Poste SIRET fails Luhn by construction; the rule is that the
        // digits sum to a multiple of five.
        let la_poste = "35600000000001";
        let sum: u32 = la_poste.chars().filter_map(|c| c.to_digit(10)).sum();
        assert_eq!(sum % 5, 0, "somme = {sum}");
        assert!(!luhn(la_poste), "l'exception n'aurait pas lieu d'être");
        assert!(siret(la_poste));

        // …and the exception is not a blank cheque for the whole prefix.
        assert!(!siret("35600000000002"));
    }

    // ── RIB ──────────────────────────────────────────────────────────────────

    #[test]
    fn rib_accepts_the_key_of_a_published_account() {
        // The body of FR7630006000011234567890189.
        assert!(rib_fr("30006000011234567890189"));
        assert!(rib_fr("30006 00001 12345678901 89"));
        // Wrong key.
        assert!(!rib_fr("30006000011234567890188"));
        // Too short.
        assert!(!rib_fr("300060000112345678901"));
    }

    #[test]
    fn rib_converts_the_letters_an_account_number_may_carry() {
        // The body of FR1420041010050500013M02606 - the account holds an `M`,
        // which the Bank of France table maps to 4.
        assert!(rib_fr("20041010050500013M02606"));
        // Changing the letter changes the key, so the same digits with another
        // letter must fail.
        assert!(!rib_fr("20041010050500013N02606"));
    }

    // ── The dispatcher ───────────────────────────────────────────────────────

    #[test]
    fn every_algorithm_round_trips_through_its_wire_form() {
        for c in Checksum::ALL {
            assert_eq!(Checksum::parse(c.as_str()), Some(*c));
        }
        assert_eq!(Checksum::parse("md5"), None);
        assert!(serde_json::from_str::<Checksum>("\"md5\"").is_err());
    }

    #[test]
    fn verify_routes_to_the_right_algorithm() {
        assert!(Checksum::Luhn.verify("4111111111111111"));
        assert!(Checksum::Iban.verify("DE89370400440532013000"));
        assert!(Checksum::Nir.verify("269054958815780"));
        assert!(Checksum::Siret.verify("44306184100047"));
        assert!(Checksum::RibFr.verify("30006000011234567890189"));

        // Each refuses the others' inputs - otherwise a mislabelled detector
        // would look like it works.
        assert!(!Checksum::Iban.verify("4111111111111111"));
        assert!(!Checksum::Nir.verify("4111111111111111"));
        assert!(!Checksum::RibFr.verify("4111111111111111"));
    }

    #[test]
    fn nothing_here_panics_on_hostile_input() {
        let accents = "é".repeat(100);
        let digits = "9".repeat(10_000);
        let hostile = [
            "",
            " ",
            accents.as_str(),
            "\u{0}\u{1}\u{2}",
            digits.as_str(),
            "-----",
        ];
        for algo in Checksum::ALL {
            for input in hostile {
                let _ = algo.verify(input);
            }
        }
    }
}
