//! The language and the time zone of the instance - and the readers that make
//! them mean something.
//!
//! ## Why the readers come first
//!
//! A setting nothing reads is worse than a missing feature: it is a control that
//! reports back. An operator who picks `Europe/Paris` and sees the value stick
//! has been told, by the interface itself, that dates are now stated in Paris
//! time. If no code path reads the key, that is simply false, and nothing on the
//! screen says so. So this module is written as *readers* - everything below
//! answers "what language / what zone applies **here**", and the two settings
//! exist to feed those answers.
//!
//! ## Resolution
//!
//! Both keys go through the scoped chain of migration `000060`:
//!
//! ```text
//!   account ?? group ?? closest organisational unit ?? instance ?? factory
//! ```
//!
//! which is what lets a multilingual organisation give one unit a different
//! language without touching a single account. When no subject is known - the
//! sign-in page, a message to an address that matches no account - the chain
//! starts at the instance, which is exactly the level meant to answer for
//! "somebody we know nothing about".
//!
//! ## What is deliberately *not* localised
//!
//! Machine-facing instants stay in UTC: API payloads, the audit trail, the
//! access log, export filenames. They are read by parsers, compared across
//! deployments and correlated with other systems' logs; restating them in a zone
//! an operator can change tomorrow would make yesterday's record unreadable.
//! Only text a human reads as a sentence is stated in the instance zone.

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use kubuno_db::DbPool;
use serde_json::Value;
use uuid::Uuid;

use super::chain;
use super::scope::SettingScope;

/// Declared in migration `000080`.
pub const LOCALE_KEY: &str = "instance.locale";
pub const TIMEZONE_KEY: &str = "instance.timezone";

/// Factory time zone. UTC rather than the host's zone: an instance that has not
/// been told where it lives must date its messages in the one zone that needs no
/// context to be read, not in whatever `/etc/localtime` happens to say on the
/// machine that ran the installer.
pub const DEFAULT_TIMEZONE: Tz = Tz::UTC;

/// Locales the product actually ships, in the order the language picker shows
/// them. Kept identical to `frontend/src/core/i18n/index.ts` and to
/// [`crate::mailer::templates::LOCALES`]; the test at the bottom of this file
/// holds the mailer side of that promise.
pub const LOCALES: [&str; 13] = [
    "en", "fr", "es", "pt", "it", "de", "el", "ru", "ar", "he", "hi", "zh", "ja",
];

/// Normalises to a locale the product ships, accepting regional forms
/// (`fr-CA` → `fr`). `None` for anything else - the caller decides whether an
/// unusable value falls back or is reported as a misconfiguration, and those are
/// not the same answer.
pub fn normalise_locale(raw: &str) -> Option<&'static str> {
    let base = raw.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase();
    LOCALES.iter().copied().find(|l| *l == base)
}

/// Parses an IANA identifier. `None` for a name the compiled-in database does
/// not know: a typo must surface as a failing health check, never as a silent
/// slide back to UTC that leaves every future message wrongly dated.
pub fn parse_timezone(raw: &str) -> Option<Tz> {
    raw.trim().parse::<Tz>().ok()
}

/// One instant, stated for a human, in the zone that applies to them.
///
/// Deliberately numeric and locale-independent: `2026-08-04 15:32 (Europe/Paris)`
/// reads the same in all thirteen languages and needs no thirteenth translation
/// to be unambiguous. The zone is named in full rather than abbreviated - `CEST`
/// and `EST` are not unique identifiers, `Europe/Paris` is.
pub fn format_stamp(at: DateTime<Utc>, tz: Tz) -> String {
    format!("{} ({})", at.with_timezone(&tz).format("%Y-%m-%d %H:%M"), tz.name())
}

/// The scope a resolution starts from: an account when one is known, the
/// instance otherwise.
fn scope_of(user_id: Option<Uuid>) -> SettingScope {
    match user_id {
        Some(id) => SettingScope::user(id),
        None => SettingScope::INSTANCE,
    }
}

/// Resolves one key and hands back its string value, or `None` on any failure.
///
/// Every caller here has a hard fallback, and a chain query that fails must not
/// take a password-reset message down with it. The error is logged by
/// [`chain::resolve_for`] before it gets here.
async fn resolved_string(db: &DbPool, key: &str, user_id: Option<Uuid>) -> Option<String> {
    let scope = scope_of(user_id);
    let resolution = chain::resolve_for(db, key, &scope).await.ok()?;
    resolution
        .value
        .as_ref()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The language that applies to `user_id` - or to the instance when nothing is
/// known about the reader.
///
/// Falls back to English, which is the factory value: an instance whose locale
/// row was deleted still speaks a language.
pub async fn locale_for(db: &DbPool, user_id: Option<Uuid>) -> &'static str {
    match resolved_string(db, LOCALE_KEY, user_id).await {
        Some(raw) => match normalise_locale(&raw) {
            Some(locale) => locale,
            None => {
                tracing::warn!(
                    value = %raw,
                    "intl: instance.locale ne correspond à aucune langue livrée, repli sur l'anglais"
                );
                "en"
            }
        },
        None => "en",
    }
}

/// The time zone that applies to `user_id` - or to the instance.
///
/// Falls back to UTC *and says so in the log*: silently dating messages in the
/// wrong zone is precisely the failure the health check exists to surface.
pub async fn timezone_for(db: &DbPool, user_id: Option<Uuid>) -> Tz {
    match resolved_string(db, TIMEZONE_KEY, user_id).await {
        Some(raw) => match parse_timezone(&raw) {
            Some(tz) => tz,
            None => {
                tracing::warn!(
                    value = %raw,
                    "intl: instance.timezone n'est pas un identifiant IANA connu, repli sur UTC"
                );
                DEFAULT_TIMEZONE
            }
        },
        None => DEFAULT_TIMEZONE,
    }
}

/// The instance-wide language, with nobody in particular in mind.
pub async fn instance_locale(db: &DbPool) -> &'static str {
    locale_for(db, None).await
}

/// The instance-wide time zone.
pub async fn instance_timezone(db: &DbPool) -> Tz {
    timezone_for(db, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn the_locale_list_matches_the_one_the_mailer_renders() {
        // Two tables, one truth: a locale added here without a row in the mail
        // templates would resolve to a language no message can be written in.
        assert_eq!(LOCALES, crate::mailer::templates::LOCALES);
    }

    #[test]
    fn regional_forms_resolve_and_unknown_ones_do_not() {
        assert_eq!(normalise_locale("fr-CA"), Some("fr"));
        assert_eq!(normalise_locale("PT_BR"), Some("pt"));
        assert_eq!(normalise_locale("EN"), Some("en"));
        // Not a fallback: the caller must be able to tell "unset" from "wrong".
        assert_eq!(normalise_locale("kl"), None);
        assert_eq!(normalise_locale(""), None);
    }

    #[test]
    fn a_typo_in_a_zone_name_is_reported_rather_than_swallowed() {
        assert_eq!(parse_timezone("Europe/Paris"), Some(Tz::Europe__Paris));
        assert_eq!(parse_timezone("  UTC  "), Some(Tz::UTC));
        assert_eq!(parse_timezone("Europe/Pariz"), None);
        assert_eq!(parse_timezone("CEST"), None, "une abréviation n'est pas un identifiant IANA");
        assert_eq!(parse_timezone(""), None);
    }

    #[test]
    fn an_instant_is_stated_in_the_zone_that_was_chosen() {
        // 2026-08-04 13:32 UTC - summer time, so Paris is UTC+2 and Tokyo UTC+9.
        let at = Utc.with_ymd_and_hms(2026, 8, 4, 13, 32, 0).single().expect("instant valide");

        assert_eq!(format_stamp(at, Tz::UTC), "2026-08-04 13:32 (UTC)");
        assert_eq!(format_stamp(at, Tz::Europe__Paris), "2026-08-04 15:32 (Europe/Paris)");
        assert_eq!(format_stamp(at, Tz::Asia__Tokyo), "2026-08-04 22:32 (Asia/Tokyo)");
        // Across the date line the DAY changes too - the case a naive "add an
        // offset to the hour" implementation gets wrong.
        assert_eq!(
            format_stamp(at, Tz::America__Los_Angeles),
            "2026-08-04 06:32 (America/Los_Angeles)",
        );
    }

    #[test]
    fn winter_and_summer_are_not_the_same_offset() {
        // The reason a stored offset would not do: the same zone, six months
        // apart, is two different offsets.
        let winter = Utc.with_ymd_and_hms(2026, 1, 15, 12, 0, 0).single().expect("instant valide");
        let summer = Utc.with_ymd_and_hms(2026, 7, 15, 12, 0, 0).single().expect("instant valide");
        assert_eq!(format_stamp(winter, Tz::Europe__Paris), "2026-01-15 13:00 (Europe/Paris)");
        assert_eq!(format_stamp(summer, Tz::Europe__Paris), "2026-07-15 14:00 (Europe/Paris)");
    }

    #[test]
    fn a_zone_whose_offset_is_not_a_whole_hour_is_handled() {
        let at = Utc.with_ymd_and_hms(2026, 8, 4, 13, 32, 0).single().expect("instant valide");
        // UTC+05:45 - the case that catches an implementation storing hours.
        assert_eq!(format_stamp(at, Tz::Asia__Kathmandu), "2026-08-04 19:17 (Asia/Kathmandu)");
    }
}
