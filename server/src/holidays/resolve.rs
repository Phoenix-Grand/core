//! Which calendars apply to a reader.
//!
//! ## Two answers, and the difference matters
//!
//! An instance can *know* where somebody is - because an administrator posted
//! `intl.holiday_calendars` on their account, their group or their unit - or it
//! can *guess*, from the time zone that already applies to them. The two are
//! returned distinctly ([`Source`]) because a module must be able to say
//! "France (d'après votre fuseau horaire)" and offer to correct it. A guess
//! presented as a decision is how a Belgian ends up looking at French holidays
//! and has nowhere to say so.
//!
//! ## Why the time zone is the fallback and not the address
//!
//! It is the only location signal this product already holds, it was set on
//! purpose, and it costs no outward request. Reading an address, calling a
//! geolocation service, or sniffing the browser's locale would each add a
//! dependency - or a disclosure - to answer a question the time zone answers
//! well enough to be corrected in one click.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;
use kubuno_db::DbPool;
use uuid::Uuid;

use crate::settings::{chain, intl, scope::SettingScope};

/// `IANA zone → ISO 3166-1 alpha-2`, generated with the dataset.
static ZONES: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();

const ZONE_COUNTRIES: &str = include_str!("../../data/timezone_countries.json");

fn zones() -> &'static HashMap<&'static str, &'static str> {
    ZONES.get_or_init(|| match serde_json::from_str(ZONE_COUNTRIES) {
        Ok(map) => map,
        Err(e) => {
            // Not fatal: without the map the fallback simply stops guessing, and
            // an explicit setting still answers. Loud, because it means the
            // shipped file was corrupted at packaging time.
            tracing::error!(error = %e, "holidays: carte fuseau → pays illisible");
            HashMap::new()
        }
    })
}

/// The country a time zone belongs to, when it belongs to exactly one.
pub fn country_of_timezone(zone: &str) -> Option<&'static str> {
    zones().get(zone).copied()
}

/// Where the answer came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// Somebody posted the setting, at some level of the chain.
    Setting,
    /// Deduced from the time zone that applies to the reader.
    Timezone,
    /// Neither: the reader's zone is UTC, or belongs to no single country.
    Unknown,
}

/// What applies, and how confidently.
#[derive(Debug, Clone, Serialize)]
pub struct Applicable {
    pub codes: Vec<String>,
    pub source: Source,
    /// The zone the guess was made from, so a module can explain itself.
    pub timezone: String,
}

/// Splits the stored setting: `"FR-6AE, BE"` → `["FR-6AE", "BE"]`.
///
/// Tolerant on purpose - this value is typed by a human in a text field, and
/// refusing a trailing comma would be refusing a whole configuration over
/// punctuation.
pub fn parse_codes(raw: &str) -> Vec<String> {
    raw.split([',', ';', ' '])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_uppercase())
        .take(8)
        .collect()
}

/// The calendars that apply to `user_id`, or to the instance when nobody in
/// particular is asking.
pub async fn for_user(db: &DbPool, user_id: Option<Uuid>) -> Applicable {
    let scope = match user_id {
        Some(id) => SettingScope::user(id),
        None => SettingScope::INSTANCE,
    };

    let configured = chain::resolve_for(db, "intl.holiday_calendars", &scope)
        .await
        .ok()
        .and_then(|resolution| resolution.value)
        .and_then(|value| value.as_str().map(str::to_string))
        .map(|raw| parse_codes(&raw))
        .unwrap_or_default();

    let timezone = intl::timezone_for(db, user_id).await;

    if !configured.is_empty() {
        return Applicable {
            codes: configured,
            source: Source::Setting,
            timezone: timezone.name().to_string(),
        };
    }

    match country_of_timezone(timezone.name()) {
        Some(country) => Applicable {
            codes: vec![country.to_string()],
            source: Source::Timezone,
            timezone: timezone.name().to_string(),
        },
        None => Applicable {
            codes: Vec::new(),
            source: Source::Unknown,
            timezone: timezone.name().to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_zone_map_loads_and_answers() {
        assert_eq!(country_of_timezone("Europe/Paris"), Some("FR"));
        assert_eq!(country_of_timezone("America/New_York"), Some("US"));
        assert_eq!(country_of_timezone("Africa/Casablanca"), Some("MA"));
        assert_eq!(country_of_timezone("Asia/Tokyo"), Some("JP"));
        // UTC belongs to no country, and pretending otherwise would give every
        // unconfigured instance the holidays of whichever country the map
        // happened to list first.
        assert_eq!(country_of_timezone("UTC"), None);
        assert_eq!(country_of_timezone("Europe/Pariz"), None);
    }

    #[test]
    fn a_hand_typed_list_is_read_generously() {
        assert_eq!(parse_codes("FR"), vec!["FR"]);
        assert_eq!(parse_codes("fr-6ae, be"), vec!["FR-6AE", "BE"]);
        assert_eq!(parse_codes(" FR ,, BE, "), vec!["FR", "BE"]);
        assert!(parse_codes("   ").is_empty());
        // Bounded: a paste of the whole world would expand into a query nobody
        // asked for.
        assert_eq!(parse_codes(&vec!["FR"; 40].join(",")).len(), 8);
    }
}
