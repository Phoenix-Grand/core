//! The password policy - the seven keys of migration `000115`, resolved.
//!
//! Same contract as [`super::directory`]: the policy is read in **one** place
//! and through the scope engine, so that a value posted on an organisational
//! unit actually governs the accounts of that unit. A hand-written
//! `SELECT … FROM core.settings` would read the instance mirror and report a
//! per-unit policy that never applies.
//!
//! ## Where it applies
//!
//! Every point at which a **local** password is chosen:
//!
//! | Point                                      | Call site                              |
//! |--------------------------------------------|----------------------------------------|
//! | public sign-up                             | `handlers::auth::register`             |
//! | self-service change                        | `handlers::users::change_password`     |
//! | reset by e-mailed link                     | `handlers::auth::password_reset`       |
//! | administrative creation                    | `handlers::admin::users::create_user`  |
//! | administrative reset                       | `handlers::admin::password_reset`      |
//!
//! and one point at which an **existing** password is judged rather than
//! chosen: `handlers::auth::login`, which arms the forced-change screen when the
//! password has expired or no longer satisfies a policy that has since been
//! tightened.
//!
//! ## What it deliberately does not govern
//!
//! Accounts whose credential is held elsewhere - a directory bind, an identity
//! provider. There is no local hash to judge, and refusing a sign-in because a
//! password this instance never stored is "too short" would be a claim it
//! cannot substantiate.
//!
//! ## Why the expiry check reads a plaintext at sign-in
//!
//! Judging an *existing* password against a *new* policy is impossible from an
//! argon2id hash: length and character classes are exactly what a hash destroys.
//! The alternative - storing the length of every password - narrows an offline
//! attack for no gain. The sign-in handler already holds the plaintext the
//! person just typed, so the evaluation happens there, once, and nothing about
//! the password is persisted.

use kubuno_db::{params, DbPool, DbTx};
use serde_json::Value;
use uuid::Uuid;

use super::chain;
use super::scope::SettingScope;
use crate::crypto::password;
use crate::errors::AppError;

// ── Keys ─────────────────────────────────────────────────────────────────────

pub const KEY_MIN_LENGTH: &str = "security.password_min_length";
pub const KEY_STRONG: &str = "security.password_strong";
pub const KEY_REUSE_ALLOWED: &str = "security.password_reuse_allowed";
pub const KEY_HISTORY_DEPTH: &str = "security.password_history_depth";
pub const KEY_EXPIRY_DAYS: &str = "security.password_expiry_days";
pub const KEY_ENFORCE_AT_LOGIN: &str = "security.password_enforce_at_login";
pub const KEY_SELF_SERVICE_RECOVERY: &str = "auth.self_service_recovery";

/// The floor the policy may never go under, whatever an administrator posts.
/// It is also the length the DTO validators have always enforced, so an
/// instance that never touches the setting behaves exactly as before.
pub const MIN_LENGTH_FLOOR: i64 = 8;
/// Argon2id hashes any length; the cap exists so a pasted megabyte does not
/// become a per-sign-in cost.
pub const MIN_LENGTH_CEILING: i64 = 128;
/// Each remembered password costs one argon2id verification at change time.
pub const HISTORY_DEPTH_CEILING: i64 = 24;

// ── The resolved policy ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PasswordPolicy {
    pub min_length: usize,
    pub strong: bool,
    pub reuse_allowed: bool,
    pub history_depth: usize,
    /// `0` disables expiry.
    pub expiry_days: i64,
    pub enforce_at_login: bool,
}

impl Default for PasswordPolicy {
    /// What the instance did before migration `000115`: eight characters, no
    /// other demand. This is the value used when a key resolves to nothing -
    /// an instance whose migration has not run - so an upgrade never tightens
    /// or loosens anything on its own.
    fn default() -> Self {
        Self {
            min_length: MIN_LENGTH_FLOOR as usize,
            strong: false,
            reuse_allowed: false,
            history_depth: 5,
            expiry_days: 0,
            enforce_at_login: false,
        }
    }
}

/// Reads one integer key, clamped to the range the policy accepts.
///
/// Clamping rather than refusing: the value was already validated on the way in
/// (`handlers::admin::settings`), and a policy that fails *open* because a row
/// holds an out-of-range number would be worse than one that reads it as the
/// nearest legal value.
async fn resolve_int(
    db: &DbPool,
    key: &str,
    scope: &SettingScope,
    fallback: i64,
    min: i64,
    max: i64,
) -> Result<i64, AppError> {
    let resolution = chain::resolve_for(db, key, scope).await?;
    let raw = resolution
        .value
        .as_ref()
        .and_then(Value::as_i64)
        .unwrap_or(fallback);
    Ok(raw.clamp(min, max))
}

async fn resolve_bool(
    db: &DbPool,
    key: &str,
    scope: &SettingScope,
    fallback: bool,
) -> Result<bool, AppError> {
    let resolution = chain::resolve_for(db, key, scope).await?;
    Ok(resolution
        .value
        .as_ref()
        .and_then(Value::as_bool)
        .unwrap_or(fallback))
}

impl PasswordPolicy {
    /// Resolves the six policy keys for a scope.
    ///
    /// The caller chooses the scope, and the choice matters: an existing account
    /// resolves at [`SettingScope::user`] so that account → groups → unit →
    /// ancestors → instance all apply, while an account that does not exist yet
    /// (administrative creation, public sign-up) resolves at the unit it is
    /// about to land in - which is the most specific level that can be known
    /// before the row exists.
    pub async fn resolve(db: &DbPool, scope: &SettingScope) -> Result<Self, AppError> {
        let d = Self::default();
        Ok(Self {
            min_length: resolve_int(
                db,
                KEY_MIN_LENGTH,
                scope,
                MIN_LENGTH_FLOOR,
                MIN_LENGTH_FLOOR,
                MIN_LENGTH_CEILING,
            )
            .await? as usize,
            strong: resolve_bool(db, KEY_STRONG, scope, d.strong).await?,
            reuse_allowed: resolve_bool(db, KEY_REUSE_ALLOWED, scope, d.reuse_allowed).await?,
            history_depth: resolve_int(
                db,
                KEY_HISTORY_DEPTH,
                scope,
                d.history_depth as i64,
                1,
                HISTORY_DEPTH_CEILING,
            )
            .await? as usize,
            expiry_days: resolve_int(db, KEY_EXPIRY_DAYS, scope, 0, 0, 3650).await?,
            enforce_at_login: resolve_bool(db, KEY_ENFORCE_AT_LOGIN, scope, d.enforce_at_login)
                .await?,
        })
    }

    /// Resolves for an existing account.
    pub async fn for_user(db: &DbPool, user_id: Uuid) -> Result<Self, AppError> {
        Self::resolve(db, &SettingScope::user(user_id)).await
    }

    /// Resolves for an account that does not exist yet, from the unit it is
    /// being created in. `None` - an instance whose tree is not reachable -
    /// falls back to the instance scope rather than to the factory default.
    pub async fn for_new_account(
        db: &DbPool,
        org_unit_id: Option<Uuid>,
    ) -> Result<Self, AppError> {
        let scope = match org_unit_id {
            Some(id) => SettingScope::org_unit(id),
            None => SettingScope::INSTANCE,
        };
        Self::resolve(db, &scope).await
    }

    /// Refuses a password the policy does not accept.
    ///
    /// The message states the rule that was broken, never the password and
    /// never how close it came: "il manque un caractère" is a free oracle for
    /// anyone changing somebody else's password.
    pub fn check(&self, candidate: &str) -> Result<(), AppError> {
        let length = candidate.chars().count();
        if length < self.min_length {
            return Err(AppError::Validation(format!(
                "Password: minimum {} characters",
                self.min_length
            )));
        }

        if self.strong && !is_strong(candidate) {
            return Err(AppError::Validation(
                "The password must combine at least three character groups (lowercase letters, uppercase letters, numbers, symbols) and cannot be a repetition or a simple sequence"
                    .into(),
            ));
        }

        Ok(())
    }

    /// Whether a password chosen at `changed_at` has aged out.
    ///
    /// An account with no recorded date is treated as **not** expired: the
    /// column is backfilled by migration `000115` for every account that holds
    /// a hash, so a NULL here means an account that has no local password at
    /// all - nothing to expire.
    pub fn is_expired(&self, changed_at: Option<chrono::DateTime<chrono::Utc>>) -> bool {
        if self.expiry_days <= 0 {
            return false;
        }
        let Some(changed_at) = changed_at else {
            return false;
        };
        let age = chrono::Utc::now() - changed_at;
        age > chrono::Duration::days(self.expiry_days)
    }
}

/// At least three of the four families, and not a single repeated character or
/// a straight run of the alphabet or the digits.
///
/// Deliberately not a dictionary: shipping one would make the refusal depend on
/// a word list an operator cannot inspect, and the rule stated in the console
/// must be the rule the server applies.
fn is_strong(candidate: &str) -> bool {
    let mut lower = false;
    let mut upper = false;
    let mut digit = false;
    let mut symbol = false;
    for ch in candidate.chars() {
        if ch.is_lowercase() {
            lower = true;
        } else if ch.is_uppercase() {
            upper = true;
        } else if ch.is_numeric() {
            digit = true;
        } else if !ch.is_whitespace() {
            symbol = true;
        }
    }
    let families = [lower, upper, digit, symbol].into_iter().filter(|f| *f).count();
    if families < 3 {
        return false;
    }
    !is_trivial_run(candidate)
}

/// A single repeated character (`aaaaaaaa`) or a strictly consecutive run
/// (`abcdefgh`, `87654321`), tested on the whole string only: a password that
/// merely *contains* `abc` is not thereby weak.
fn is_trivial_run(candidate: &str) -> bool {
    let chars: Vec<char> = candidate.chars().collect();
    if chars.len() < 3 {
        return false;
    }
    let mut same = true;
    let mut ascending = true;
    let mut descending = true;
    for pair in chars.windows(2) {
        let (a, b) = (pair[0] as i64, pair[1] as i64);
        if a != b {
            same = false;
        }
        if b - a != 1 {
            ascending = false;
        }
        if a - b != 1 {
            descending = false;
        }
    }
    same || ascending || descending
}

// ── History ──────────────────────────────────────────────────────────────────

/// Refuses a password the account has already used.
///
/// No-op when the policy allows reuse - the history is still *written* in that
/// case, so that turning the rule back on is immediately effective instead of
/// starting from an empty memory.
pub async fn reject_reuse(
    db: &DbPool,
    policy: &PasswordPolicy,
    user_id: Uuid,
    candidate: &str,
) -> Result<(), AppError> {
    if policy.reuse_allowed {
        return Ok(());
    }

    // Single-column result read through a 1-tuple: the pool has no
    // `fetch_all_scalar`, and `(String,)` satisfies `FromRow` on every engine.
    let hashes: Vec<String> = db
        .fetch_all_as::<(String,)>(
            "SELECT password_hash FROM core.password_history \
             WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
            params![user_id, policy.history_depth as i64],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "password_policy: lecture de l'historique");
            AppError::Database(e)
        })?
        .into_iter()
        .map(|(hash,)| hash)
        .collect();

    if hashes.is_empty() {
        return Ok(());
    }

    // One hop to the blocking pool for the whole scan, as in
    // `auth::backup_codes`: argon2id is memory-hard by design and N round trips
    // through the scheduler would cost more than the hashing itself.
    let needle = candidate.to_owned();
    let reused = tokio::task::spawn_blocking(move || {
        hashes
            .iter()
            // A malformed stored hash must not abort the scan: the remaining
            // entries are still legitimate history.
            .any(|hash| matches!(password::verify_password(&needle, hash), Ok(true)))
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "password_policy: pool bloquant indisponible");
        AppError::Internal(anyhow::anyhow!(
            "Cannot check password history"
        ))
    })?;

    if reused {
        return Err(AppError::Validation(
            "This password has already been used by this account. Choose another.".into(),
        ));
    }
    Ok(())
}

/// Remembers a hash and trims the account's history to `depth` entries.
///
/// Takes an executor so it runs inside the caller's transaction: a history that
/// commits without the password change - or the reverse - is exactly the
/// disagreement the reuse rule cannot survive.
///
/// The trim keeps `depth` rows even when reuse is currently allowed, so the
/// table never grows without bound on an instance that changed its mind twice.
pub async fn remember(
    tx: &mut DbTx,
    user_id: Uuid,
    password_hash: &str,
    depth: usize,
) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO core.password_history (user_id, password_hash) VALUES ($1, $2)",
        params![user_id, password_hash],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, user_id = %user_id, "password_policy: écriture de l'historique");
        AppError::Database(e)
    })?;

    // `user_id` feeds two placeholders ($1, $2); the engine-agnostic layer
    // numbers placeholders strictly and never reuses one, so it is bound twice.
    //
    // The kept set is wrapped in a derived table (`kept`): MySQL and MariaDB
    // refuse a `LIMIT` directly inside an `IN (...)` subquery (error 1235) and a
    // subquery reading the very table being deleted from (error 1093). The
    // derived table is materialised first, which both engines accept, and it
    // means the same on PostgreSQL and SQLite.
    tx.execute(
        "DELETE FROM core.password_history \
          WHERE user_id = $1 \
            AND id NOT IN ( \
                SELECT id FROM ( \
                    SELECT id FROM core.password_history \
                     WHERE user_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3 \
                ) kept \
            )",
        params![user_id, user_id, depth as i64],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, user_id = %user_id, "password_policy: purge de l'historique");
        AppError::Database(e)
    })?;

    Ok(())
}

// ── Self-service recovery ────────────────────────────────────────────────────

/// Whether the "forgotten password" link may be issued for this account.
///
/// Resolved at the account's scope, and read **after** the account lookup, so
/// the answer of `POST /auth/forgot-password` is unchanged in every branch: the
/// route returns the same body whether the address is unknown, known, or known
/// and governed by a policy that forbids the link. A database failure reads as
/// `true` - the behaviour the route had before this key existed - because the
/// alternative is a silent, instance-wide loss of the recovery path on a
/// transient error.
pub async fn self_service_recovery_allowed(db: &DbPool, user_id: Uuid) -> bool {
    let scope = SettingScope::user(user_id);
    match chain::resolve_for(db, KEY_SELF_SERVICE_RECOVERY, &scope).await {
        Ok(resolution) => resolution
            .value
            .as_ref()
            .and_then(Value::as_bool)
            .unwrap_or(true),
        Err(e) => {
            tracing::error!(
                error = %e,
                "password_policy: résolution de auth.self_service_recovery impossible"
            );
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(min_length: usize, strong: bool) -> PasswordPolicy {
        PasswordPolicy { min_length, strong, ..PasswordPolicy::default() }
    }

    #[test]
    fn length_is_counted_in_characters_not_bytes() {
        // Eight accented characters are eight characters, not sixteen bytes -
        // and not the other way round either: a policy that counted bytes would
        // silently accept a five-character password written in French.
        let p = policy(8, false);
        assert!(p.check("éléphants").is_ok());
        assert!(p.check("éléphan").is_err());
    }

    #[test]
    fn the_default_policy_reproduces_the_previous_behaviour() {
        let p = PasswordPolicy::default();
        assert!(p.check("motdepasse").is_ok());
        assert!(p.check("court").is_err());
    }

    #[test]
    fn strong_demands_three_families() {
        let p = policy(8, true);
        assert!(p.check("motdepasse").is_err());
        assert!(p.check("Motdepasse").is_err());
        assert!(p.check("Motdepasse1").is_ok());
        assert!(p.check("motdepasse1!").is_ok());
    }

    #[test]
    fn strong_refuses_a_trivial_run() {
        assert!(!is_strong("aaaaaaaa"));
        assert!(!is_strong("abcdefgh"));
        assert!(!is_strong("87654321"));
        // Containing a run is not being one.
        assert!(is_strong("abcXyz9!"));
    }

    #[test]
    fn expiry_is_off_at_zero_and_ignores_an_unknown_date() {
        let mut p = PasswordPolicy::default();
        let long_ago = chrono::Utc::now() - chrono::Duration::days(400);
        assert!(!p.is_expired(Some(long_ago)));
        p.expiry_days = 90;
        assert!(p.is_expired(Some(long_ago)));
        assert!(!p.is_expired(Some(chrono::Utc::now())));
        assert!(!p.is_expired(None));
    }

    #[test]
    fn a_policy_read_from_nothing_never_goes_under_the_floor() {
        // `resolve_int` clamps rather than refuses; the floor is what the DTO
        // validators have always enforced.
        assert_eq!(
            (MIN_LENGTH_FLOOR - 3).clamp(MIN_LENGTH_FLOOR, MIN_LENGTH_CEILING),
            MIN_LENGTH_FLOOR
        );
    }
}
