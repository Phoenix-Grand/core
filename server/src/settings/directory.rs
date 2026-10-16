//! The directory policy - the five keys of migration `000110`, resolved.
//!
//! This module exists so that the policy is read in **one** place and through
//! the scope engine, never with a hand-written `SELECT … FROM core.settings`.
//! The distinction is the whole point: a value posted on an organisational unit
//! only governs anything if the code that acts reads it through
//! [`chain::resolve_for`]. Read the mirror column instead and the console will
//! cheerfully report "overridden here" for a policy that never applies.
//!
//! ## Everything here resolves at the USER scope
//!
//! `SettingScope::user(id)` walks account → groups → the account's unit and its
//! ancestors → instance → factory (`core.setting_chain`, migration `000060`).
//! Resolving at the unit instead would lose the two levels above it and forbid
//! a per-account exception; resolving at the instance would lose the unit
//! entirely, which is the defect this module is written against.
//!
//! An account attached to no unit resolves to `instance → factory` and needs no
//! special case: its chain is simply shorter.
//!
//! ## Failure is closed for reads, open for writes
//!
//! A database error while resolving a *sharing* key hides the directory
//! (`Err` propagates, the caller answers an error) rather than disclosing it.
//! A database error while resolving a *profile-editing* key is likewise
//! propagated: refusing a profile change because the policy could not be read is
//! recoverable, silently allowing one is not.

use kubuno_db::DbPool;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use super::chain;
use super::scope::SettingScope;
use crate::errors::AppError;

// ── Keys ─────────────────────────────────────────────────────────────────────

pub const KEY_ENABLED: &str = "directory.enabled";
pub const KEY_SHARE_EMAIL: &str = "directory.share_email";
pub const KEY_AUDIENCE: &str = "directory.audience";

/// The fields of the profile a person may or may not rewrite themselves.
///
/// The enum is what keeps the setting key, the refusal message and the call
/// site in step: adding a governed field is a variant plus its key, and the
/// compiler then demands the matching arms below.
///
/// The six added by migration `000114` are governed exactly like the first two:
/// same scope, same resolver, same refusal shape. Two of them -
/// [`ProfileField::Gender`] and [`ProfileField::Birthday`] - carry personal
/// data, and it is worth being precise about what the switch does and does not
/// do there. It decides whether the **person** may state or erase the datum. It
/// decides nothing about who may *see* it: neither field is ever returned by
/// `search_users` or `lookup_users`, whatever these keys are set to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileField {
    Name,
    FirstName,
    LastName,
    Photo,
    NamePronunciation,
    Pronouns,
    WorkLocation,
    Introduction,
    Gender,
    Birthday,
}

impl ProfileField {
    /// Every governed field, in the order the administration card lists them.
    /// Used by the tests below to assert the invariants hold for all of them
    /// rather than for the two somebody remembered to check.
    pub const ALL: [ProfileField; 10] = [
        ProfileField::Name,
        ProfileField::FirstName,
        ProfileField::LastName,
        ProfileField::Photo,
        ProfileField::NamePronunciation,
        ProfileField::Pronouns,
        ProfileField::WorkLocation,
        ProfileField::Introduction,
        ProfileField::Gender,
        ProfileField::Birthday,
    ];

    pub fn key(self) -> &'static str {
        match self {
            ProfileField::Name => "directory.profile_edit_name",
            ProfileField::FirstName => "directory.profile_edit_first_name",
            ProfileField::LastName => "directory.profile_edit_last_name",
            ProfileField::Photo => "directory.profile_edit_photo",
            ProfileField::NamePronunciation => "directory.profile_edit_name_pronunciation",
            ProfileField::Pronouns => "directory.profile_edit_pronouns",
            ProfileField::WorkLocation => "directory.profile_edit_work_location",
            ProfileField::Introduction => "directory.profile_edit_introduction",
            ProfileField::Gender => "directory.profile_edit_gender",
            ProfileField::Birthday => "directory.profile_edit_birthday",
        }
    }

    /// What the refusal says. Named after what the person tried to change, not
    /// after the setting key: "directory.profile_edit_name = false" is an
    /// answer for an operator reading a log, not for somebody who just pressed
    /// Save.
    fn refusal(self) -> &'static str {
        match self {
            ProfileField::Name => {
                "Le nom affiché est géré par votre administrateur : il ne peut pas être modifié ici."
            }
            ProfileField::FirstName => {
                "Votre prénom est géré par votre administrateur : il ne peut pas être modifié ici."
            }
            ProfileField::LastName => {
                "Votre nom de famille est géré par votre administrateur : il ne peut pas être modifié ici."
            }
            ProfileField::Photo => {
                "La photo de profil est gérée par votre administrateur : elle ne peut pas être modifiée ici."
            }
            ProfileField::NamePronunciation => {
                "La prononciation de votre nom est gérée par votre administrateur : elle ne peut pas être modifiée ici."
            }
            ProfileField::Pronouns => {
                "Vos pronoms sont gérés par votre administrateur : ils ne peuvent pas être modifiés ici."
            }
            ProfileField::WorkLocation => {
                "Votre lieu de travail est géré par votre administrateur : il ne peut pas être modifié ici."
            }
            ProfileField::Introduction => {
                "Votre présentation est gérée par votre administrateur : elle ne peut pas être modifiée ici."
            }
            ProfileField::Gender => {
                "Le champ « genre » est géré par votre administrateur : il ne peut pas être modifié ici."
            }
            ProfileField::Birthday => {
                "Votre date de naissance est gérée par votre administrateur : elle ne peut pas être modifiée ici."
            }
        }
    }
}

// ── Resolution helpers ───────────────────────────────────────────────────────

/// Resolves one boolean key for an account, falling back to `fallback` when the
/// key resolves to nothing at all.
///
/// "Nothing at all" means an undeclared key or a `NULL` factory default - the
/// state of an instance whose migration `000110` has not run yet. A background
/// of `false` there would turn an unmigrated instance into one with no
/// directory and no editable profile, so the caller passes the value that
/// reproduces the pre-`000110` behaviour.
async fn resolve_bool(
    db: &DbPool,
    key: &str,
    user_id: Uuid,
    fallback: bool,
) -> Result<bool, AppError> {
    let scope = SettingScope::user(user_id);
    let resolution = chain::resolve_for(db, key, &scope).await?;
    Ok(resolution
        .value
        .as_ref()
        .and_then(Value::as_bool)
        .unwrap_or(fallback))
}

// ── Sharing ──────────────────────────────────────────────────────────────────

/// Who the directory shows to one member.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Audience {
    /// Every active account of the instance.
    AllMembers,
    /// The member's own organisational unit and everything below it.
    SameUnit,
}

impl Audience {
    fn parse(v: Option<&Value>) -> Self {
        match v.and_then(Value::as_str) {
            Some("same_unit") => Audience::SameUnit,
            // Anything else - including a value a future version may add and
            // this one does not know - reads as the permissive default the
            // route had before the key existed. A narrowing this code cannot
            // enforce must not be *reported* as enforced.
            _ => Audience::AllMembers,
        }
    }
}

/// The directory as one member is entitled to see it.
#[derive(Debug, Clone, Copy)]
pub struct SharingPolicy {
    pub enabled: bool,
    pub share_email: bool,
    pub audience: Audience,
}

impl SharingPolicy {
    /// What an administrator gets: the directory never closes on them, because
    /// the administration console's own people pickers run on these very
    /// routes. An operator who mistypes a policy must be able to reach the
    /// screen that undoes it - the same reasoning as `auth.local_admin_fallback`
    /// (migration `000090`).
    ///
    /// Addresses stay governed: an administrator is exempt from the *closure*
    /// of the directory, not entitled to a disclosure the policy withholds.
    fn administrator(share_email: bool) -> Self {
        Self { enabled: true, share_email, audience: Audience::AllMembers }
    }

    /// Resolves the three sharing keys for one member.
    ///
    /// `is_admin` is passed in rather than re-read: the caller already holds the
    /// authenticated account, and a second round trip to learn a column it has
    /// in hand would be one per directory search.
    pub async fn resolve(db: &DbPool, user_id: Uuid, is_admin: bool) -> Result<Self, AppError> {
        let share_email = resolve_bool(db, KEY_SHARE_EMAIL, user_id, false).await?;
        if is_admin {
            return Ok(Self::administrator(share_email));
        }

        let enabled = resolve_bool(db, KEY_ENABLED, user_id, true).await?;
        let audience = Audience::parse(
            chain::resolve_for(db, KEY_AUDIENCE, &SettingScope::user(user_id))
                .await?
                .value
                .as_ref(),
        );

        Ok(Self { enabled, share_email, audience })
    }
}

// ── Profile editing ──────────────────────────────────────────────────────────

/// Refuses a profile change the policy does not allow for this account.
///
/// The refusal is a **403 carrying its own sentence**. `AppError::Forbidden`
/// would answer the fixed "Accès refusé", which tells somebody who just pressed
/// Save nothing about why, and `AppError::Validation` would answer 400 "données
/// invalides" for data that is perfectly valid. `SettingLocked` is the project's
/// existing "a setting forbids this write" refusal: 403, free-form message,
/// error code `SETTING_LOCKED` - which is precisely the situation, since the
/// administrator may indeed have locked the key.
pub async fn ensure_may_edit(
    db: &DbPool,
    user_id: Uuid,
    field: ProfileField,
) -> Result<(), AppError> {
    if resolve_bool(db, field.key(), user_id, true).await? {
        return Ok(());
    }
    // Logged at warn: a refusal here is a policy doing its job, and an operator
    // investigating "why can nobody rename themselves" needs the key and the
    // account, which the message deliberately withholds from the person.
    tracing::warn!(
        %user_id,
        key = %field.key(),
        "annuaire : modification de profil refusée par la politique de l'organisation"
    );
    Err(AppError::SettingLocked(field.refusal().into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_unknown_audience_reads_as_the_permissive_default() {
        assert_eq!(Audience::parse(Some(&json!("same_unit"))), Audience::SameUnit);
        assert_eq!(Audience::parse(Some(&json!("all_members"))), Audience::AllMembers);
        // A value written by a later version, a typo, a null, nothing at all:
        // never a narrowing this build cannot actually apply.
        assert_eq!(Audience::parse(Some(&json!("same_building"))), Audience::AllMembers);
        assert_eq!(Audience::parse(Some(&json!(null))), Audience::AllMembers);
        assert_eq!(Audience::parse(None), Audience::AllMembers);
    }

    #[test]
    fn an_administrator_keeps_the_directory_but_not_the_addresses() {
        let open = SharingPolicy::administrator(true);
        assert!(open.enabled);
        assert_eq!(open.audience, Audience::AllMembers);
        assert!(open.share_email);

        // Exempt from the closure, not entitled to the disclosure.
        let closed = SharingPolicy::administrator(false);
        assert!(closed.enabled);
        assert!(!closed.share_email);
    }

    #[test]
    fn every_governed_field_names_a_distinct_key_and_its_own_refusal() {
        assert_eq!(ProfileField::Name.key(), "directory.profile_edit_name");
        assert_eq!(ProfileField::Photo.key(), "directory.profile_edit_photo");

        let mut keys: Vec<&str> = ProfileField::ALL.iter().map(|f| f.key()).collect();
        let mut refusals: Vec<&str> = ProfileField::ALL.iter().map(|f| f.refusal()).collect();
        keys.sort_unstable();
        refusals.sort_unstable();
        let (before_keys, before_refusals) = (keys.len(), refusals.len());
        keys.dedup();
        refusals.dedup();
        assert_eq!(keys.len(), before_keys, "deux champs partagent une clé de réglage");
        assert_eq!(refusals.len(), before_refusals, "deux champs partagent un message de refus");

        for field in ProfileField::ALL {
            // Every key belongs to the directory family the console reads…
            assert!(field.key().starts_with("directory.profile_edit_"), "{}", field.key());
            // …and no message must ever hand a setting key to the person who
            // just pressed Save.
            assert!(!field.refusal().contains("directory."), "{}", field.refusal());
        }
    }

    #[test]
    fn the_two_personal_fields_are_governed_like_the_rest() {
        // Nothing special about their *editing* policy - the difference lives in
        // what the directory routes select, which is asserted next to those
        // queries (`handlers::users::DIRECTORY_COLUMNS`).
        assert_eq!(ProfileField::Gender.key(), "directory.profile_edit_gender");
        assert_eq!(ProfileField::Birthday.key(), "directory.profile_edit_birthday");
    }
}
