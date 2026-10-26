//! The grammar of a holiday, and the shapes the API answers with.
//!
//! Four rule kinds, and no fifth. The grammar is closed because every kind is
//! expanded by [`super::rules`]: a kind the expander does not know would be a
//! row storing a promise the product never keeps. Anything the four cannot
//! describe - an Islamic, Hebrew, Chinese or astronomical feast - is stored as
//! the dates it actually falls on, honestly bounded by the window the dataset
//! computed.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::errors::AppError;

/// What kind of day this is. Closed vocabulary, mirrored by the CHECK
/// constraint of migration `000111`: a module *filters* on it (an agenda shows
/// `Public`, a payroll cares about `Bank`), and free text would turn that filter
/// into a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    /// A day off for everybody. The default, and the overwhelming case.
    Public,
    /// Banks and public administrations close; most other people work.
    Bank,
    Government,
    School,
    /// Off if the employer grants it.
    Optional,
    HalfDay,
    ArmedForces,
    /// A day the law names as *worked* - the compensating Saturdays several
    /// countries schedule around a long weekend.
    Workday,
    /// Marked, celebrated, but not a day off (Mother's Day, a flag day).
    Observance,
}

impl Category {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Bank => "bank",
            Self::Government => "government",
            Self::School => "school",
            Self::Optional => "optional",
            Self::HalfDay => "half_day",
            Self::ArmedForces => "armed_forces",
            Self::Workday => "workday",
            Self::Observance => "observance",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, AppError> {
        Ok(match raw {
            "public" => Self::Public,
            "bank" => Self::Bank,
            "government" => Self::Government,
            "school" => Self::School,
            "optional" => Self::Optional,
            "half_day" => Self::HalfDay,
            "armed_forces" => Self::ArmedForces,
            "workday" => Self::Workday,
            "observance" => Self::Observance,
            other => {
                return Err(AppError::Validation(format!(
                    "Unknown category '{other}'"
                )))
            }
        })
    }
}

/// What happens when the day lands on a weekend.
///
/// Per day and not per country, because it *is* per day: in the United States
/// Christmas moves to the nearest weekday and Columbus Day does not move at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Observance {
    /// The date stands, weekend or not.
    #[default]
    None,
    /// Saturday and Sunday both move to the following Monday.
    NextWorkday,
    /// Saturday moves back to Friday, Sunday forward to Monday - the shape that
    /// keeps the day off adjacent to the date it commemorates.
    NearestWorkday,
    SundayToMonday,
    SaturdayToMonday,
    SaturdayToFriday,
}

impl Observance {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::NextWorkday => "next_workday",
            Self::NearestWorkday => "nearest_workday",
            Self::SundayToMonday => "sunday_to_monday",
            Self::SaturdayToMonday => "saturday_to_monday",
            Self::SaturdayToFriday => "saturday_to_friday",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, AppError> {
        Ok(match raw {
            "none" => Self::None,
            "next_workday" => Self::NextWorkday,
            "nearest_workday" => Self::NearestWorkday,
            "sunday_to_monday" => Self::SundayToMonday,
            "saturday_to_monday" => Self::SaturdayToMonday,
            "saturday_to_friday" => Self::SaturdayToFriday,
            other => {
                return Err(AppError::Validation(format!(
                    "Unknown observance rule '{other}'"
                )))
            }
        })
    }
}

/// Which Easter a rule counts from. Orthodox Easter is the Julian computation,
/// stated in the Gregorian calendar - the two fall on the same day only about a
/// quarter of the time, so a single Easter would misdate half of eastern Europe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EasterBasis {
    #[default]
    Gregorian,
    Julian,
}

/// The four kinds, and their parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Rule {
    /// The same month and day every year.
    Fixed { month: u32, day: u32 },
    /// Easter plus (or minus) a number of days.
    Easter {
        offset: i64,
        #[serde(default)]
        basis: EasterBasis,
    },
    /// The nth weekday of a month. `weekday` is ISO (Monday = 1), `nth` is 1..=5
    /// counted from the start of the month, or -1 for the last one.
    NthWeekday { month: u32, weekday: u32, nth: i32 },
    /// The dates themselves, for the feasts no Gregorian rule describes.
    Dates { dates: Vec<NaiveDate> },
}

impl Rule {
    /// The `kind` column value.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Fixed { .. } => "fixed",
            Self::Easter { .. } => "easter",
            Self::NthWeekday { .. } => "nth_weekday",
            Self::Dates { .. } => "dates",
        }
    }

    /// The `rule` column value - parameters only, without the discriminant.
    pub fn params(&self) -> Value {
        match self {
            Self::Fixed { month, day } => json!({ "month": month, "day": day }),
            Self::Easter { offset, basis } => json!({
                "offset": offset,
                "basis": match basis { EasterBasis::Gregorian => "gregorian", EasterBasis::Julian => "julian" },
            }),
            Self::NthWeekday { month, weekday, nth } => {
                json!({ "month": month, "weekday": weekday, "nth": nth })
            }
            Self::Dates { dates } => json!({
                "dates": dates.iter().map(|d| d.to_string()).collect::<Vec<_>>(),
            }),
        }
    }

    /// Rebuilds a rule from the two columns, refusing anything the expander
    /// could not answer for.
    ///
    /// Validation lives here rather than in the handler because both the API and
    /// the seeder write rows: a rule accepted by one path and rejected by the
    /// other is how a dataset upgrade ships a day nobody can edit.
    pub fn from_parts(kind: &str, params: &Value) -> Result<Self, AppError> {
        let field = |name: &str| -> Result<i64, AppError> {
            params
                .get(name)
                .and_then(Value::as_i64)
                .ok_or_else(|| AppError::Validation(format!("Rule '{kind}': missing field '{name}'")))
        };

        match kind {
            "fixed" => {
                let (month, day) = (field("month")?, field("day")?);
                let rule = Self::Fixed {
                    month: month as u32,
                    day: day as u32,
                };
                rule.validate()?;
                Ok(rule)
            }
            "easter" => {
                let basis = match params.get("basis").and_then(Value::as_str).unwrap_or("gregorian") {
                    "gregorian" => EasterBasis::Gregorian,
                    "julian" => EasterBasis::Julian,
                    other => {
                        return Err(AppError::Validation(format!(
                            "Rule 'easter': unknown base '{other}' (gregorian or julian)"
                        )))
                    }
                };
                let rule = Self::Easter {
                    offset: field("offset")?,
                    basis,
                };
                rule.validate()?;
                Ok(rule)
            }
            "nth_weekday" => {
                let rule = Self::NthWeekday {
                    month: field("month")? as u32,
                    weekday: field("weekday")? as u32,
                    nth: field("nth")? as i32,
                };
                rule.validate()?;
                Ok(rule)
            }
            "dates" => {
                let raw = params
                    .get("dates")
                    .and_then(Value::as_array)
                    .ok_or_else(|| AppError::Validation("Rule 'dates': missing list".into()))?;
                let mut dates = Vec::with_capacity(raw.len());
                for entry in raw {
                    let text = entry.as_str().ok_or_else(|| {
                        AppError::Validation("Rule 'dates': each date must be a YYYY-MM-DD string".into())
                    })?;
                    dates.push(text.parse::<NaiveDate>().map_err(|_| {
                        AppError::Validation(format!("Invalid date '{text}' (expected YYYY-MM-DD)"))
                    })?);
                }
                dates.sort_unstable();
                dates.dedup();
                let rule = Self::Dates { dates };
                rule.validate()?;
                Ok(rule)
            }
            other => Err(AppError::Validation(format!(
                "Unknown rule type '{other}'"
            ))),
        }
    }

    /// Refuses a rule that names no day at all.
    ///
    /// `31 February` is the case worth naming: it passes every "month between 1
    /// and 12" check, produces nothing in any year, and would sit in the console
    /// looking like a holiday that simply never happens.
    pub fn validate(&self) -> Result<(), AppError> {
        let bad = |message: String| Err(AppError::Validation(message));
        match self {
            Self::Fixed { month, day } => {
                if !(1..=12).contains(month) {
                    return bad(format!("Mois « {month} » invalide"));
                }
                // Checked against a leap year, so that 29 February stays legal:
                // it is a real date, and a rule landing on it simply produces
                // nothing three years out of four.
                if *day == 0 || NaiveDate::from_ymd_opt(2024, *month, *day).is_none() {
                    return bad(format!("Le {day} n'existe pas dans ce mois"));
                }
                Ok(())
            }
            Self::Easter { offset, .. } => {
                if !(-400..=400).contains(offset) {
                    return bad("Easter offset out of range (±400 days)".into());
                }
                Ok(())
            }
            Self::NthWeekday { month, weekday, nth } => {
                if !(1..=12).contains(month) {
                    return bad(format!("Mois « {month} » invalide"));
                }
                if !(1..=7).contains(weekday) {
                    return bad("Jour de la semaine invalide (1 = lundi … 7 = dimanche)".into());
                }
                if *nth != -1 && !(1..=5).contains(nth) {
                    return bad("Invalid rank (1 to 5, or -1 for last)".into());
                }
                Ok(())
            }
            Self::Dates { dates } => {
                if dates.is_empty() {
                    return bad("A 'dates' rule must list at least one date".into());
                }
                Ok(())
            }
        }
    }
}

/// A calendar - a territory, or a list an organisation keeps for itself.
#[derive(Debug, Clone, Serialize)]
pub struct HolidayCalendar {
    pub id: Uuid,
    pub code: String,
    pub country_code: Option<String>,
    pub subdivision: Option<String>,
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub names: Value,
    pub is_builtin: bool,
    pub enabled: bool,
    pub coverage_from: Option<i32>,
    pub coverage_to: Option<i32>,
}

impl HolidayCalendar {
    /// The name for a reader of `locale`, falling back the way every localised
    /// field in this product does: their language, then English, then whatever
    /// the source called it.
    pub fn localized_name(&self, locale: &str) -> String {
        localized(&self.names, locale).unwrap_or_else(|| self.name.clone())
    }
}

/// One declared day, before any year is applied to it.
#[derive(Debug, Clone)]
pub struct Holiday {
    pub id: Uuid,
    pub calendar_id: Uuid,
    pub key: String,
    pub name: String,
    pub names: Value,
    pub category: Category,
    pub rule: Rule,
    pub observance: Observance,
    pub from_year: Option<i32>,
    pub to_year: Option<i32>,
    pub color: Option<String>,
    pub enabled: bool,
    pub is_builtin: bool,
    pub is_overridden: bool,
    pub is_orphan: bool,
}

/// Serialised as the **two columns it is stored in** - `kind` and `rule` - and
/// not as the tagged enum's natural shape.
///
/// Derived, `#[serde(flatten)]` on a tagged enum spreads the parameters over the
/// object (`{"kind":"fixed","month":7,"day":14}`), so a client reading
/// `holiday.rule` finds nothing and every rule editor silently opens empty. One
/// shape, from the column to the form, is worth the dozen lines.
impl Serialize for Holiday {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct as _;
        let mut out = serializer.serialize_struct("Holiday", 15)?;
        out.serialize_field("id", &self.id)?;
        out.serialize_field("calendar_id", &self.calendar_id)?;
        out.serialize_field("key", &self.key)?;
        out.serialize_field("name", &self.name)?;
        out.serialize_field("names", &self.names)?;
        out.serialize_field("category", &self.category)?;
        out.serialize_field("kind", self.rule.kind())?;
        out.serialize_field("rule", &self.rule.params())?;
        out.serialize_field("observance", &self.observance)?;
        out.serialize_field("from_year", &self.from_year)?;
        out.serialize_field("to_year", &self.to_year)?;
        out.serialize_field("color", &self.color)?;
        out.serialize_field("enabled", &self.enabled)?;
        out.serialize_field("is_builtin", &self.is_builtin)?;
        out.serialize_field("is_overridden", &self.is_overridden)?;
        out.serialize_field("is_orphan", &self.is_orphan)?;
        out.end()
    }
}

impl Holiday {
    pub fn localized_name(&self, locale: &str) -> String {
        localized(&self.names, locale).unwrap_or_else(|| self.name.clone())
    }
}

/// One day, on one date, for one reader - what a module actually renders.
#[derive(Debug, Clone, Serialize)]
pub struct Occurrence {
    pub date: NaiveDate,
    pub name: String,
    pub key: String,
    pub category: Category,
    /// Where it comes from, so a module can group by territory when two
    /// calendars apply ("Jours fériés - France" / "- Belgique").
    pub calendar_code: String,
    pub calendar_name: String,
    pub color: Option<String>,
    /// Set when the day was moved off a weekend: the date it commemorates. A
    /// module shows "Noël (reporté du samedi 25 décembre)" from this, and
    /// nothing at all when it is `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_from: Option<NaiveDate>,
}

/// The `{locale: name}` lookup, with the source name as the last word.
///
/// Public because the feed resolves names row by row, without building the
/// structs they belong to: one shared lookup is what keeps a calendar's name
/// from being read one way in the console and another in a module.
pub fn localized_name(names: &Value, fallback: &str, locale: &str) -> String {
    localized(names, locale).unwrap_or_else(|| fallback.to_string())
}

/// The `{locale: name}` lookup shared by both localised fields.
fn localized(names: &Value, locale: &str) -> Option<String> {
    let map = names.as_object()?;
    let pick = |key: &str| map.get(key).and_then(Value::as_str).map(str::to_string);
    // The base language answers for a regional form: a `pt-BR` reader is served
    // by `pt` rather than by English.
    let base = locale.split(['-', '_']).next().unwrap_or(locale);
    pick(locale).or_else(|| pick(base)).or_else(|| pick("en"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rule_survives_a_round_trip_through_its_two_columns() {
        let rules = [
            Rule::Fixed { month: 7, day: 14 },
            Rule::Easter { offset: -2, basis: EasterBasis::Gregorian },
            Rule::Easter { offset: 1, basis: EasterBasis::Julian },
            Rule::NthWeekday { month: 5, weekday: 1, nth: -1 },
            Rule::Dates {
                dates: vec![NaiveDate::from_ymd_opt(2026, 3, 20).expect("date valide")],
            },
        ];
        for rule in rules {
            let restored = Rule::from_parts(rule.kind(), &rule.params()).expect("règle relue");
            assert_eq!(rule, restored);
        }
    }

    #[test]
    fn a_day_is_serialised_as_the_two_columns_it_is_stored_in() {
        let holiday = Holiday {
            id: Uuid::nil(),
            calendar_id: Uuid::nil(),
            key: "fete-nationale".into(),
            name: "Fête nationale".into(),
            names: json!({ "en": "National Day" }),
            category: Category::Public,
            rule: Rule::Fixed { month: 7, day: 14 },
            observance: Observance::None,
            from_year: None,
            to_year: None,
            color: None,
            enabled: true,
            is_builtin: true,
            is_overridden: false,
            is_orphan: false,
        };
        let value = serde_json::to_value(&holiday).expect("sérialisable");
        assert_eq!(value["kind"], "fixed");
        assert_eq!(value["rule"], json!({ "month": 7, "day": 14 }));
        // The parameters must NOT also be spread over the object: that is the
        // shape the derived implementation produced, and the one that left every
        // rule editor opening empty.
        assert!(value.get("month").is_none());
    }

    #[test]
    fn a_day_that_never_happens_is_refused() {
        assert!(Rule::from_parts("fixed", &json!({"month": 2, "day": 31})).is_err());
        assert!(Rule::from_parts("fixed", &json!({"month": 13, "day": 1})).is_err());
        // 29 February is a real date, and a rule may legitimately land on it.
        assert!(Rule::from_parts("fixed", &json!({"month": 2, "day": 29})).is_ok());
        assert!(Rule::from_parts("nth_weekday", &json!({"month": 5, "weekday": 8, "nth": 1})).is_err());
        assert!(Rule::from_parts("nth_weekday", &json!({"month": 5, "weekday": 1, "nth": 0})).is_err());
        assert!(Rule::from_parts("dates", &json!({"dates": []})).is_err());
        assert!(Rule::from_parts("moon_phase", &json!({})).is_err());
    }

    #[test]
    fn a_name_is_read_in_the_readers_language_then_english_then_the_source() {
        let names = json!({"fr": "Noël", "en": "Christmas Day"});
        assert_eq!(localized(&names, "fr"), Some("Noël".into()));
        assert_eq!(localized(&names, "fr-CA"), Some("Noël".into()));
        // No German name: English answers rather than nothing.
        assert_eq!(localized(&names, "de"), Some("Christmas Day".into()));
        // Not even English: the caller falls back to the source name.
        assert_eq!(localized(&json!({"zh": "春节"}), "de"), None);
    }
}
