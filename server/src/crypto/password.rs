use anyhow::Result;
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use rand::Rng;

/// Alphabet of generated passwords.
///
/// `0/O`, `1/l/I` and `5/S` are left out on purpose: a generated password is
/// read aloud, dictated over the phone or copied by hand at least once, and a
/// character pair nobody can tell apart turns a reset into a support ticket. The
/// symbol set is small and keyboard-layout agnostic for the same reason (no `@`,
/// no `#`, nothing that moves between AZERTY and QWERTY).
/// Generated-password alphabet, stripped of glyphs that get misread when a
/// password is dictated over the phone or copied off a printout: 0/O, 1/l/I and
/// 5/S. Only one member of each confusable pair survives.
const ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRTUVWXYZ2346789-.=+";

/// Length of a generated password. 16 characters over a 60-symbol alphabet is
/// ~94 bits of entropy: far beyond anything an offline attack on the argon2id
/// hash reaches, and still short enough to dictate.
pub const GENERATED_LENGTH: usize = 16;

/// Generates a random password with a CSPRNG.
///
/// Uniform by construction: `gen_range` over the alphabet's length, never
/// `random_byte % len`, which would bias the first characters of the set.
pub fn generate_password(length: usize) -> String {
    // The ceiling matches `password_policy::MIN_LENGTH_CEILING`: an instance
    // that demands 100 characters must still be able to have one generated for
    // it, and a clamp below the policy floor would produce a password the very
    // policy that asked for it then refuses.
    let length = length.clamp(12, 128);
    let mut rng = rand::thread_rng();
    (0..length)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

pub fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("Erreur hachage mot de passe: {e}"))?
        .to_string();
    Ok(hash)
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool> {
    let parsed = PasswordHash::new(hash)
        .map_err(|e| anyhow::anyhow!("Hash invalide: {e}"))?;
    let ok = Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok();
    Ok(ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn generated_passwords_avoid_ambiguous_characters() {
        // One draw only samples a fraction of the alphabet, so a stray glyph
        // would surface as a test that fails once in a while - the kind that
        // ends up ignored. Draw enough to hit every character many times over.
        for _ in 0..200 {
            let pwd = generate_password(GENERATED_LENGTH);
            assert_eq!(pwd.chars().count(), GENERATED_LENGTH);
            for c in ['0', 'O', '1', 'l', 'I', '5', 'S'] {
                assert!(!pwd.contains(c), "caractère ambigu {c} dans « {pwd} »");
            }
        }
    }

    #[test]
    fn generated_passwords_are_not_repeated() {
        let set: HashSet<String> = (0..200).map(|_| generate_password(GENERATED_LENGTH)).collect();
        assert_eq!(set.len(), 200, "collision dans 200 tirages : générateur non aléatoire");
    }

    #[test]
    fn length_is_clamped_to_a_usable_range() {
        assert_eq!(generate_password(0).chars().count(), 12);
        assert_eq!(generate_password(1_000).chars().count(), 128);
    }

    #[test]
    fn a_generated_password_verifies_against_its_hash() {
        let pwd = generate_password(GENERATED_LENGTH);
        let hash = hash_password(&pwd).expect("hachage");
        assert!(verify_password(&pwd, &hash).expect("vérification"));
        assert!(!verify_password("autre-chose", &hash).expect("vérification"));
    }
}
