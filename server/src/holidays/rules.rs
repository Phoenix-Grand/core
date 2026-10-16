//! The expander: a rule plus a range gives dates.
//!
//! No database, no clock, no locale - pure arithmetic, which is why this file
//! carries the tests that matter. Every property the feature promises is
//! decided here: that a rule answers for a year nobody generated in advance,
//! that Orthodox Easter is not Western Easter, that "the last Monday of May"
//! survives a month starting on a Sunday, and that a day moved off a weekend
//! still says which date it commemorates.

use chrono::{Datelike, Days, NaiveDate, Weekday};

use super::model::{EasterBasis, Observance, Rule};

/// One date the rule produces, and the date it commemorates when the two differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Expansion {
    pub date: NaiveDate,
    /// `Some` only when the weekend shift moved the day.
    pub observed_from: Option<NaiveDate>,
}

/// Western Easter - the anonymous Gregorian algorithm.
///
/// Reproduced here rather than pulled from a crate on purpose: it is twenty
/// lines, it has been stable since 1582, and it is the single arithmetic the
/// generator and the server must agree on exactly. A dependency mismatch
/// between the two would surface as a country whose Easter Monday is a day off.
pub fn gregorian_easter(year: i32) -> Option<NaiveDate> {
    let a = year % 19;
    let (b, c) = (year / 100, year % 100);
    let (d, e) = (b / 4, b % 4);
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let (i, k) = (c / 4, c % 4);
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = (h + l - 7 * m + 114) % 31 + 1;
    NaiveDate::from_ymd_opt(year, month as u32, day as u32)
}

/// Orthodox Easter, stated in the Gregorian calendar.
pub fn julian_easter(year: i32) -> Option<NaiveDate> {
    let a = year % 4;
    let b = year % 7;
    let c = year % 19;
    let d = (19 * c + 15) % 30;
    let e = (2 * a + 4 * b - d + 34) % 7;
    let month = (d + e + 114) / 31;
    let day = (d + e + 114) % 31 + 1;
    let julian = NaiveDate::from_ymd_opt(year, month as u32, day as u32)?;
    // The Julian calendar drifts one further day behind in 2100, which is
    // inside the window this product will still be running in.
    let drift = if year < 2100 { 13 } else { 14 };
    julian.checked_add_days(Days::new(drift))
}

/// The nth `weekday` (ISO: Monday = 1) of `month`, or the last one when
/// `nth == -1`.
fn nth_weekday_of(year: i32, month: u32, weekday: u32, nth: i32) -> Option<NaiveDate> {
    let target = match weekday {
        1 => Weekday::Mon,
        2 => Weekday::Tue,
        3 => Weekday::Wed,
        4 => Weekday::Thu,
        5 => Weekday::Fri,
        6 => Weekday::Sat,
        7 => Weekday::Sun,
        _ => return None,
    };

    if nth == -1 {
        let first_next = if month == 12 {
            NaiveDate::from_ymd_opt(year + 1, 1, 1)?
        } else {
            NaiveDate::from_ymd_opt(year, month + 1, 1)?
        };
        let mut day = first_next.pred_opt()?;
        while day.weekday() != target {
            day = day.pred_opt()?;
        }
        return Some(day);
    }

    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let shift = (7 + target.num_days_from_monday() - first.weekday().num_days_from_monday()) % 7;
    let day = first.checked_add_days(Days::new(u64::from(shift) + 7 * (nth.max(1) as u64 - 1)))?;
    // A fifth Monday does not exist every May: the rule produces nothing that
    // year rather than spilling into June.
    (day.month() == month).then_some(day)
}

/// Where the day is actually taken when it lands on a weekend.
pub fn shift(date: NaiveDate, observance: Observance) -> NaiveDate {
    let forward = |days: u64| date.checked_add_days(Days::new(days)).unwrap_or(date);
    let back = |days: u64| date.checked_sub_days(Days::new(days)).unwrap_or(date);
    match (observance, date.weekday()) {
        (Observance::None, _) => date,
        (Observance::NextWorkday, Weekday::Sat) => forward(2),
        (Observance::NextWorkday, Weekday::Sun) => forward(1),
        (Observance::NearestWorkday, Weekday::Sat) => back(1),
        (Observance::NearestWorkday, Weekday::Sun) => forward(1),
        (Observance::SundayToMonday, Weekday::Sun) => forward(1),
        (Observance::SaturdayToMonday, Weekday::Sat) => forward(2),
        (Observance::SaturdayToFriday, Weekday::Sat) => back(1),
        _ => date,
    }
}

/// Every date `rule` produces in `year`, before the weekend shift.
///
/// A `Vec` rather than an `Option`: a multi-day feast (Chinese New Year, the
/// Russian New Year holidays) is one declared day that occupies several dates,
/// and splitting it into five rows would make it five holidays in the console.
fn dates_in_year(rule: &Rule, year: i32) -> Vec<NaiveDate> {
    match rule {
        Rule::Fixed { month, day } => NaiveDate::from_ymd_opt(year, *month, *day)
            .into_iter()
            .collect(),
        Rule::Easter { offset, basis } => {
            let easter = match basis {
                EasterBasis::Gregorian => gregorian_easter(year),
                EasterBasis::Julian => julian_easter(year),
            };
            easter
                .and_then(|day| {
                    if *offset >= 0 {
                        day.checked_add_days(Days::new(*offset as u64))
                    } else {
                        day.checked_sub_days(Days::new(offset.unsigned_abs()))
                    }
                })
                .into_iter()
                .collect()
        }
        Rule::NthWeekday { month, weekday, nth } => nth_weekday_of(year, *month, *weekday, *nth)
            .into_iter()
            .collect(),
        Rule::Dates { dates } => dates.iter().copied().filter(|d| d.year() == year).collect(),
    }
}

/// Every occurrence between `from` and `to` (both inclusive).
///
/// `from_year`/`to_year` bound the *rule*, not the query: a holiday created in
/// 2021 produces nothing in 2019, which is the difference between a referential
/// and a list of dates.
pub fn expand(
    rule: &Rule,
    observance: Observance,
    from: NaiveDate,
    to: NaiveDate,
    from_year: Option<i32>,
    to_year: Option<i32>,
) -> Vec<Expansion> {
    if from > to {
        return Vec::new();
    }
    let mut out = Vec::new();
    // One year of slack on both sides: a shift can carry 31 December into the
    // next year, and a New Year's Day observed on 2 January belongs to a query
    // that starts on the 2nd.
    for year in (from.year() - 1)..=(to.year() + 1) {
        if from_year.is_some_and(|first| year < first) || to_year.is_some_and(|last| year > last) {
            continue;
        }
        for base in dates_in_year(rule, year) {
            let date = shift(base, observance);
            if date < from || date > to {
                continue;
            }
            out.push(Expansion {
                date,
                observed_from: (date != base).then_some(base),
            });
        }
    }
    out.sort_by_key(|e| e.date);
    out.dedup_by_key(|e| e.date);
    out
}

/// The dates a rule produces in one year, shift included - what the console's
/// preview column shows.
pub fn preview(rule: &Rule, observance: Observance, year: i32) -> Vec<Expansion> {
    let (from, to) = (
        NaiveDate::from_ymd_opt(year, 1, 1),
        NaiveDate::from_ymd_opt(year, 12, 31),
    );
    match (from, to) {
        (Some(from), Some(to)) => expand(rule, observance, from, to, None, None),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("date valide")
    }

    fn dates(rule: &Rule, observance: Observance, year: i32) -> Vec<NaiveDate> {
        preview(rule, observance, year).into_iter().map(|e| e.date).collect()
    }

    #[test]
    fn western_easter_matches_the_published_dates() {
        // The reference the generator was checked against, and the years an
        // off-by-one in the algorithm gets wrong first.
        assert_eq!(gregorian_easter(2024), Some(day(2024, 3, 31)));
        assert_eq!(gregorian_easter(2025), Some(day(2025, 4, 20)));
        assert_eq!(gregorian_easter(2026), Some(day(2026, 4, 5)));
        assert_eq!(gregorian_easter(2027), Some(day(2027, 3, 28)));
        assert_eq!(gregorian_easter(2038), Some(day(2038, 4, 25)));
        assert_eq!(gregorian_easter(2049), Some(day(2049, 4, 18)));
    }

    #[test]
    fn orthodox_easter_is_not_western_easter() {
        assert_eq!(julian_easter(2024), Some(day(2024, 5, 5)));
        assert_eq!(julian_easter(2025), Some(day(2025, 4, 20))); // the years they coincide
        assert_eq!(julian_easter(2026), Some(day(2026, 4, 12)));
        assert_eq!(julian_easter(2027), Some(day(2027, 5, 2)));
    }

    #[test]
    fn easter_relative_days_land_where_they_should() {
        // Good Friday, Easter Monday, Ascension, Whit Monday - 2026.
        let good_friday = Rule::Easter { offset: -2, basis: EasterBasis::Gregorian };
        let easter_monday = Rule::Easter { offset: 1, basis: EasterBasis::Gregorian };
        let ascension = Rule::Easter { offset: 39, basis: EasterBasis::Gregorian };
        let whit_monday = Rule::Easter { offset: 50, basis: EasterBasis::Gregorian };
        assert_eq!(dates(&good_friday, Observance::None, 2026), vec![day(2026, 4, 3)]);
        assert_eq!(dates(&easter_monday, Observance::None, 2026), vec![day(2026, 4, 6)]);
        assert_eq!(dates(&ascension, Observance::None, 2026), vec![day(2026, 5, 14)]);
        assert_eq!(dates(&whit_monday, Observance::None, 2026), vec![day(2026, 5, 25)]);
    }

    #[test]
    fn the_last_monday_of_may_is_the_last_one_and_not_the_fourth() {
        let memorial = Rule::NthWeekday { month: 5, weekday: 1, nth: -1 };
        assert_eq!(dates(&memorial, Observance::None, 2026), vec![day(2026, 5, 25)]);
        // 2027: May has five Mondays, which is where "the fourth" gets it wrong.
        assert_eq!(dates(&memorial, Observance::None, 2027), vec![day(2027, 5, 31)]);
    }

    #[test]
    fn an_nth_weekday_that_does_not_exist_produces_nothing() {
        // February 2026 has four Sundays, so "the fifth Sunday" is not a date -
        // and must not silently become the first of March.
        let ghost = Rule::NthWeekday { month: 2, weekday: 7, nth: 5 };
        assert!(dates(&ghost, Observance::None, 2026).is_empty());
        // A month that does have five: August 2026 (Sundays 2, 9, 16, 23, 30).
        let real = Rule::NthWeekday { month: 8, weekday: 7, nth: 5 };
        assert_eq!(dates(&real, Observance::None, 2026), vec![day(2026, 8, 30)]);
    }

    #[test]
    fn thanksgiving_and_labor_day_land_on_their_published_dates() {
        let thanksgiving = Rule::NthWeekday { month: 11, weekday: 4, nth: 4 };
        assert_eq!(dates(&thanksgiving, Observance::None, 2026), vec![day(2026, 11, 26)]);
        let labor_day = Rule::NthWeekday { month: 9, weekday: 1, nth: 1 };
        assert_eq!(dates(&labor_day, Observance::None, 2026), vec![day(2026, 9, 7)]);
    }

    #[test]
    fn a_weekend_shift_moves_the_day_and_remembers_the_date_it_commemorates() {
        // 4 July 2026 is a Saturday: the United States takes Friday the 3rd.
        let independence = Rule::Fixed { month: 7, day: 4 };
        let occurrences = preview(&independence, Observance::NearestWorkday, 2026);
        assert_eq!(occurrences.len(), 1);
        assert_eq!(occurrences[0].date, day(2026, 7, 3));
        assert_eq!(occurrences[0].observed_from, Some(day(2026, 7, 4)));

        // 2027: a Sunday, so it moves forward instead.
        let occurrences = preview(&independence, Observance::NearestWorkday, 2027);
        assert_eq!(occurrences[0].date, day(2027, 7, 5));

        // 2025: a Friday. Nothing moves, and nothing claims it did.
        let occurrences = preview(&independence, Observance::NearestWorkday, 2025);
        assert_eq!(occurrences[0].date, day(2025, 7, 4));
        assert_eq!(occurrences[0].observed_from, None);
    }

    #[test]
    fn next_workday_sends_both_weekend_days_to_monday() {
        let boxing = Rule::Fixed { month: 12, day: 26 };
        // 26 December 2026 is a Saturday.
        assert_eq!(dates(&boxing, Observance::NextWorkday, 2026), vec![day(2026, 12, 28)]);
        // 2027: a Sunday.
        assert_eq!(dates(&boxing, Observance::NextWorkday, 2027), vec![day(2027, 12, 27)]);
    }

    #[test]
    fn a_shift_across_the_new_year_is_still_returned_by_a_january_query() {
        // 1 January 2028 is a Saturday; an instance shifting to the next
        // workday takes Monday the 3rd. A query over January 2028 must contain
        // it - the case a naive "iterate over the query's years" loop drops
        // when the base date belongs to the previous year instead.
        let new_year = Rule::Fixed { month: 1, day: 1 };
        let found = expand(
            &new_year,
            Observance::NextWorkday,
            day(2028, 1, 2),
            day(2028, 1, 31),
            None,
            None,
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].date, day(2028, 1, 3));
        assert_eq!(found[0].observed_from, Some(day(2028, 1, 1)));
    }

    #[test]
    fn a_rule_that_did_not_exist_yet_produces_nothing() {
        let recent = Rule::Fixed { month: 6, day: 19 };
        let found = expand(&recent, Observance::None, day(2019, 1, 1), day(2019, 12, 31), Some(2021), None);
        assert!(found.is_empty());
        let found = expand(&recent, Observance::None, day(2022, 1, 1), day(2022, 12, 31), Some(2021), None);
        assert_eq!(found.len(), 1);
        // And one that was abolished stops.
        let found = expand(&recent, Observance::None, day(2026, 1, 1), day(2026, 12, 31), None, Some(2024));
        assert!(found.is_empty());
    }

    #[test]
    fn an_explicit_date_list_answers_only_inside_the_window_it_covers() {
        let eid = Rule::Dates {
            dates: vec![day(2026, 3, 20), day(2027, 3, 9)],
        };
        assert_eq!(dates(&eid, Observance::None, 2026), vec![day(2026, 3, 20)]);
        // Past the list, nothing - never a guessed date.
        assert!(dates(&eid, Observance::None, 2030).is_empty());
    }

    #[test]
    fn a_multi_day_feast_stays_one_holiday_on_several_dates() {
        let spring_festival = Rule::Dates {
            dates: vec![day(2026, 2, 17), day(2026, 2, 18), day(2026, 2, 19)],
        };
        assert_eq!(dates(&spring_festival, Observance::None, 2026).len(), 3);
    }

    #[test]
    fn the_29th_of_february_happens_only_in_a_leap_year() {
        let leap = Rule::Fixed { month: 2, day: 29 };
        assert_eq!(dates(&leap, Observance::None, 2028), vec![day(2028, 2, 29)]);
        assert!(dates(&leap, Observance::None, 2026).is_empty());
    }

    #[test]
    fn a_backwards_range_answers_nothing_rather_than_looping() {
        let rule = Rule::Fixed { month: 1, day: 1 };
        assert!(expand(&rule, Observance::None, day(2026, 12, 31), day(2026, 1, 1), None, None).is_empty());
    }
}
