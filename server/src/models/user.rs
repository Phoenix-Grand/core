use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::{Validate, ValidationError};

/// Last-resort quota, used only when the `storage.default_quota_bytes` setting
/// cannot be read at all - a database that is mid-migration, or a key somebody
/// deleted. It matches the `core.users.quota_bytes` column default of migration
/// 000001 and the factory value of the setting, so the three never disagree.
///
/// It is **no longer** what account creation applies: [`default_quota_for`] is.
/// The `continuity.default_quota` health check compares the configured value
/// with the applied one and exists to catch a regression back to a constant.
pub const DEFAULT_QUOTA_BYTES: i64 = 10_737_418_240;

/// The key an operator edits, at whatever scope they edit it.
pub const DEFAULT_QUOTA_SETTING: &str = "storage.default_quota_bytes";

/// Bounds a configured default is clamped into.
///
/// A quota of zero locks every new account out of the product on its first day,
/// and a negative one would violate the column's own CHECK - neither is a policy
/// somebody meant to write. The ceiling is 1 PiB: past it the number stops
/// meaning "a quota" and starts meaning "somebody pasted a wrong figure".
const MIN_QUOTA_BYTES: i64 = 1_048_576; // 1 MiB
const MAX_QUOTA_BYTES: i64 = 1_125_899_906_842_624; // 1 PiB

/// The quota a new account receives, resolved through the setting chain.
///
/// `org_unit` is the unit the account is being created in, and it is the whole
/// point of resolving rather than reading the instance value: the inheritance of
/// migration 000060 lets an operator give the Marketing unit 50 GiB while the
/// rest of the instance stays at 10, and a locked value higher in the tree still
/// wins - the same policy every other scoped setting obeys.
///
/// The account does not exist yet, so the chain is read from the unit (or from
/// the instance when there is none). A per-user override of this key would be
/// meaningless anyway: the value is consumed once, at creation, and afterwards
/// the account carries its own `quota_bytes` column.
///
/// Never fails: a storage default that cannot be read must not stop somebody
/// from signing up. The failure is logged and [`DEFAULT_QUOTA_BYTES`] applies.
pub async fn default_quota_for(
    db: &kubuno_db::DbPool,
    org_unit: Option<Uuid>,
) -> i64 {
    let scope = match org_unit {
        Some(id) => crate::settings::SettingScope::org_unit(id),
        None => crate::settings::SettingScope::INSTANCE,
    };

    let resolved = crate::settings::chain::resolve_for(db, DEFAULT_QUOTA_SETTING, &scope).await;
    let raw = match resolved {
        Ok(r) => r.value.as_ref().and_then(serde_json::Value::as_i64),
        Err(_) => {
            // already logged by the resolver
            None
        }
    };

    if raw.is_none() {
        tracing::warn!(
            key = DEFAULT_QUOTA_SETTING,
            "quota par défaut illisible : application de la valeur d'usine"
        );
    }
    clamp_quota(raw)
}

/// The policy applied to whatever the chain returned, isolated so it is testable
/// without a database.
pub fn clamp_quota(raw: Option<i64>) -> i64 {
    match raw {
        Some(v) => v.clamp(MIN_QUOTA_BYTES, MAX_QUOTA_BYTES),
        None => DEFAULT_QUOTA_BYTES,
    }
}

#[derive(Debug, Clone, Serialize, FromRow, ToSchema)]
pub struct User {
    pub id:             Uuid,
    pub email:          String,
    pub username:       String,
    #[serde(skip_serializing)]
    pub password_hash:  Option<String>,
    pub display_name:   Option<String>,
    /// Given name (migration `000124`). Free text, never required; the source
    /// the mail address rule reads for `{prenom}`.
    pub first_name:     Option<String>,
    /// Family name (migration `000124`). Free text, never required; `{nom}`.
    pub last_name:      Option<String>,
    pub avatar_url:     Option<String>,
    pub role:           String,
    pub quota_bytes:    i64,
    pub used_bytes:     i64,
    pub is_active:      bool,
    pub email_verified: bool,
    pub oauth_provider: Option<String>,
    pub oauth_id:       Option<String>,
    pub preferences:    serde_json::Value,
    pub org_unit_id:    Option<Uuid>,
    /// How the person's name is pronounced (migration `000114`). Free text.
    pub name_pronunciation: Option<String>,
    /// Pronouns the person goes by. Free text - no closed list is imposed.
    pub pronouns:           Option<String>,
    /// Where the person works: site, building, floor, "remote". Not the city
    /// they live in - that stays a personal preference.
    pub work_location:      Option<String>,
    /// Short self-description shown on the profile.
    pub introduction:       Option<String>,
    /// **Personal data.** Free text, never required, and deliberately absent
    /// from `search_users` / `lookup_users`: the directory and every people
    /// picker answer name, username and photo. This is read on the account's own
    /// profile and on the administration sheet, and nowhere else.
    pub gender:             Option<String>,
    /// **Personal data.** Same rule as [`Self::gender`] - never disclosed by the
    /// directory, never carried into the audit trail (`audit::redact` does not
    /// list it).
    pub birthday:           Option<NaiveDate>,
    pub created_at:     DateTime<Utc>,
    pub updated_at:     DateTime<Utc>,
    pub last_login_at:  Option<DateTime<Utc>>,
    /// When the current local password was chosen (migration `000115`).
    ///
    /// This is a date, not a secret: it says *when*, never anything about the
    /// password itself. It is what makes `security.password_expiry_days`
    /// enforceable - an argon2id hash cannot be asked how old it is.
    /// `NULL` for an account that holds no local password at all.
    pub password_changed_at: Option<DateTime<Utc>>,
    pub totp_enabled:        bool,
    /// Set when the account still carries a password it did not choose (initial
    /// seeded administrator). The UI forces a password change before anything else.
    pub must_change_password: bool,
    /// Deadline by which this administrator must carry a second factor, armed the
    /// first time the instance requirement is seen unmet (see
    /// [`crate::auth::admin_2fa`]). `NULL` while nothing is pending.
    pub admin_2fa_grace_until: Option<DateTime<Utc>>,
    #[serde(skip_serializing)]
    pub totp_secret:         Option<String>,
    #[serde(skip_serializing)]
    pub totp_pending_secret: Option<String>,
    /// The directory that governs this account, when one does. Set by
    /// [`crate::directory`] - a synchronisation, or a first successful sign-in.
    ///
    /// This field alone does **not** decide which authenticator applies:
    /// `password_hash` does (see [`crate::directory::auth`]). An account that
    /// was local before it was linked keeps its hash and keeps signing in
    /// locally, which is what makes a directory outage survivable.
    pub ldap_directory_id: Option<Uuid>,
    /// Distinguished name of the directory entry. Internal plumbing, and long:
    /// not worth shipping on every `/me`.
    #[serde(skip_serializing)]
    pub ldap_dn:  Option<String>,
    /// Immutable directory identifier (`entryUUID`, `objectGUID`). This, not the
    /// DN, re-identifies somebody the day they are renamed or moved.
    #[serde(skip_serializing)]
    pub ldap_uid: Option<String>,
    pub ldap_synced_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, Validate, ToSchema)]
pub struct CreateUserDto {
    #[validate(email(message = "Email invalide"))]
    pub email:    String,
    #[validate(length(min = 3, max = 100, message = "Username: 3-100 caractères"))]
    pub username: String,
    #[validate(length(min = 8, message = "Mot de passe: 8 caractères minimum"))]
    pub password: String,
    pub display_name: Option<String>,
}

fn validate_http_url(url: &str) -> Result<(), ValidationError> {
    if url.starts_with("https://") || url.starts_with("http://") {
        Ok(())
    } else {
        let mut e = ValidationError::new("url");
        e.message = Some(std::borrow::Cow::Borrowed("L'URL doit utiliser le schéma http ou https"));
        Err(e)
    }
}

/// Tells "the client did not send this field" from "the client sent `null`".
///
/// A plain `Option<T>` cannot: serde maps an absent key and an explicit `null`
/// to the same `None`, and the UPDATE statement is then unable to distinguish
/// *leave this alone* from *erase this*. For the profile fields of migration
/// `000114` that difference is the feature itself - somebody who once entered a
/// birthday must be able to take it back out, not merely overwrite it with
/// another one. `Option<Option<T>>` behind this deserializer gives the three
/// states: `None` absent, `Some(None)` erase, `Some(Some(v))` set.
pub(crate) fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

/// Maximum lengths of the profile fields, mirrored by the column widths of
/// migration `000114`. Declared here because this is where a value is refused
/// with a sentence naming the field; the column is the backstop for any path
/// that forgets to ask.
const MAX_FIRST_NAME: usize = 120;
const MAX_LAST_NAME: usize = 120;
const MAX_NAME_PRONUNCIATION: usize = 120;
const MAX_PRONOUNS: usize = 60;
const MAX_WORK_LOCATION: usize = 160;
const MAX_INTRODUCTION: usize = 4000;
const MAX_GENDER: usize = 80;

/// Oldest birthday this accepts, as `(year, month, day)`. Not an age rule - a
/// typo filter, and the same floor as the column's own CHECK.
const EARLIEST_BIRTHDAY: (i32, u32, u32) = (1900, 1, 1);

#[derive(Debug, Default, Deserialize, Validate)]
pub struct UpdateUserDto {
    #[validate(length(max = 255))]
    pub display_name: Option<String>,
    #[validate(custom(function = "validate_http_url"))]
    pub avatar_url:   Option<String>,
    pub preferences:  Option<serde_json::Value>,

    // ── Profile fields of migration `000114` ────────────────────────────────
    //
    // `validator` has no rule that reaches inside `Option<Option<_>>`, so these
    // are checked by [`UpdateUserDto::tidy_profile`] - which also trims, and
    // turns a blank string into an explicit erase, because that is what a form
    // sends when somebody empties a box.
    #[serde(default, deserialize_with = "double_option")]
    pub first_name:         Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub last_name:          Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub name_pronunciation: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub pronouns:           Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub work_location:      Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub introduction:       Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub gender:             Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub birthday:           Option<Option<NaiveDate>>,
}

/// Trims one profile string in place, refusing it if it will not fit.
///
/// A value that is nothing but whitespace becomes `Some(None)`: emptying a box
/// and pressing Save must clear the field, not store a space.
fn tidy_text(slot: &mut Option<Option<String>>, label: &str, max: usize) -> Result<(), String> {
    let Some(inner) = slot.as_mut() else { return Ok(()) };
    let Some(text) = inner.as_ref() else { return Ok(()) };

    let trimmed = text.trim();
    if trimmed.is_empty() {
        *inner = None;
        return Ok(());
    }
    // Counted in characters, not bytes: "60 caractères maximum" must mean the
    // same thing for an accented or a non-latin name as for an ASCII one.
    if trimmed.chars().count() > max {
        return Err(format!("{label} : {max} caractères maximum"));
    }
    let owned = trimmed.to_owned();
    *inner = Some(owned);
    Ok(())
}

impl UpdateUserDto {
    /// Normalises the profile fields and refuses the implausible ones.
    ///
    /// Returns the sentence to answer with, never a key name: the caller turns
    /// it into a `422` and the person reads which field is at fault.
    pub fn tidy_profile(&mut self, today: NaiveDate) -> Result<(), String> {
        tidy_text(&mut self.first_name, "Prénom", MAX_FIRST_NAME)?;
        tidy_text(&mut self.last_name, "Nom de famille", MAX_LAST_NAME)?;
        tidy_text(&mut self.name_pronunciation, "Prononciation du nom", MAX_NAME_PRONUNCIATION)?;
        tidy_text(&mut self.pronouns, "Pronoms", MAX_PRONOUNS)?;
        tidy_text(&mut self.work_location, "Lieu de travail", MAX_WORK_LOCATION)?;
        tidy_text(&mut self.introduction, "Présentation", MAX_INTRODUCTION)?;
        tidy_text(&mut self.gender, "Genre", MAX_GENDER)?;

        if let Some(Some(day)) = self.birthday {
            // The floor catches a mistyped year; the ceiling catches the far
            // more common one, a date entered in a future year. Neither decides
            // who may hold an account.
            let (y, m, d) = EARLIEST_BIRTHDAY;
            // A constant that cannot fail to be a date; falling back to `today`
            // rather than panicking keeps the promise of no `unwrap` on a path a
            // request can reach.
            let earliest = NaiveDate::from_ymd_opt(y, m, d).unwrap_or(today);
            if day < earliest || day > today {
                return Err("Date de naissance : date invalide".into());
            }
        }
        Ok(())
    }

    /// Names of the profile fields this request carries, for the event payload
    /// and the audit line. **Names only** - a personal datum never travels into
    /// a log or a trail entry, which is the whole reason this returns strings
    /// and not values.
    pub fn profile_fields_present(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.display_name.is_some() { names.push("display_name"); }
        if self.avatar_url.is_some() { names.push("avatar_url"); }
        if self.preferences.is_some() { names.push("preferences"); }
        if self.first_name.is_some() { names.push("first_name"); }
        if self.last_name.is_some() { names.push("last_name"); }
        if self.name_pronunciation.is_some() { names.push("name_pronunciation"); }
        if self.pronouns.is_some() { names.push("pronouns"); }
        if self.work_location.is_some() { names.push("work_location"); }
        if self.introduction.is_some() { names.push("introduction"); }
        if self.gender.is_some() { names.push("gender"); }
        if self.birthday.is_some() { names.push("birthday"); }
        names
    }
}

#[derive(Debug, Deserialize, Validate)]
pub struct ChangePasswordDto {
    pub old_password: String,
    #[validate(length(min = 8, message = "Nouveau mot de passe: 8 caractères minimum"))]
    pub new_password: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreadable_setting_falls_back_to_the_factory_value() {
        assert_eq!(clamp_quota(None), DEFAULT_QUOTA_BYTES);
    }

    #[test]
    fn a_configured_value_is_applied_verbatim() {
        let fifty_gib = 53_687_091_200;
        assert_eq!(clamp_quota(Some(fifty_gib)), fifty_gib);
    }

    #[test]
    fn zero_and_negative_quotas_are_refused_rather_than_stored() {
        // Both would lock every new account out of the product on its first day,
        // and a negative one violates the column's own CHECK.
        assert_eq!(clamp_quota(Some(0)), MIN_QUOTA_BYTES);
        assert_eq!(clamp_quota(Some(-1)), MIN_QUOTA_BYTES);
    }

    #[test]
    fn an_absurd_ceiling_is_capped() {
        assert_eq!(clamp_quota(Some(i64::MAX)), MAX_QUOTA_BYTES);
    }

    // ── Profile fields of migration `000114` ────────────────────────────────

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 8, 6).expect("constant date")
    }

    fn parse(body: &str) -> UpdateUserDto {
        serde_json::from_str(body).expect("valid dto")
    }

    #[test]
    fn absent_null_and_a_value_are_three_different_requests() {
        // The distinction the whole `Option<Option<_>>` shape exists for.
        assert_eq!(parse(r#"{}"#).gender, None);
        assert_eq!(parse(r#"{"gender":null}"#).gender, Some(None));
        assert_eq!(parse(r#"{"gender":"non binaire"}"#).gender, Some(Some("non binaire".into())));
    }

    #[test]
    fn emptying_a_box_clears_the_field_rather_than_storing_blanks() {
        let mut dto = parse(r#"{"pronouns":"   ","introduction":""}"#);
        dto.tidy_profile(today()).expect("blank is not an error");
        assert_eq!(dto.pronouns, Some(None));
        assert_eq!(dto.introduction, Some(None));
    }

    #[test]
    fn surrounding_whitespace_is_never_stored() {
        let mut dto = parse(r#"{"work_location":"  Bâtiment C, 2e étage  "}"#);
        dto.tidy_profile(today()).expect("valid");
        assert_eq!(dto.work_location, Some(Some("Bâtiment C, 2e étage".into())));
    }

    #[test]
    fn an_oversized_field_is_refused_by_name_and_counted_in_characters() {
        // 61 accented characters: 122 bytes, and still just 61 characters - a
        // byte-length check would refuse a name that fits.
        let long = "é".repeat(MAX_PRONOUNS + 1);
        let mut dto = UpdateUserDto { pronouns: Some(Some(long)), ..Default::default() };
        let err = dto.tidy_profile(today()).expect_err("too long");
        assert!(err.contains("Pronoms"), "{err}");

        let ok = "é".repeat(MAX_PRONOUNS);
        let mut dto = UpdateUserDto { pronouns: Some(Some(ok)), ..Default::default() };
        assert!(dto.tidy_profile(today()).is_ok());
    }

    #[test]
    fn an_implausible_birthday_is_refused_and_an_erase_is_not() {
        let future = NaiveDate::from_ymd_opt(2027, 1, 1).expect("constant date");
        let mut dto = UpdateUserDto { birthday: Some(Some(future)), ..Default::default() };
        assert!(dto.tidy_profile(today()).is_err(), "une date future n'est pas une naissance");

        let ancient = NaiveDate::from_ymd_opt(1899, 12, 31).expect("constant date");
        let mut dto = UpdateUserDto { birthday: Some(Some(ancient)), ..Default::default() };
        assert!(dto.tidy_profile(today()).is_err());

        // Taking a personal datum back out is always allowed by the DTO; only
        // the policy may refuse it.
        let mut dto = UpdateUserDto { birthday: Some(None), ..Default::default() };
        assert!(dto.tidy_profile(today()).is_ok());

        let plausible = NaiveDate::from_ymd_opt(1984, 2, 29).expect("constant date");
        let mut dto = UpdateUserDto { birthday: Some(Some(plausible)), ..Default::default() };
        assert!(dto.tidy_profile(today()).is_ok());
    }

    #[test]
    fn the_reported_field_list_carries_names_and_never_values() {
        let dto = parse(r#"{"gender":"femme","birthday":"1990-05-04","display_name":"Ada"}"#);
        let names = dto.profile_fields_present();
        assert_eq!(names, vec!["display_name", "gender", "birthday"]);
        // Nothing in that list can disclose anything about the person.
        assert!(!names.iter().any(|n| n.contains("femme") || n.contains("1990")));
    }
}
