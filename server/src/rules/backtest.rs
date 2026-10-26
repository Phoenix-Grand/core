//! Retrospective replay: "how many things would this rule have touched last
//! week?"
//!
//! Reads `core.event_log` over a window, rebuilds the facts with the **same**
//! flattening the live path uses ([`super::facts::facts_of_logged`]), and runs
//! them through the **same** gates ([`super::engine::decide`]). There is
//! deliberately no second evaluator: a backtest that answered a slightly
//! different question than the engine would be worse than no backtest, because
//! it would be believed.
//!
//! Nothing acts, nothing alerts, no threshold counter is written. A
//! retrospective question must leave no trace an operator could mistake for a
//! fact.
//!
//! ## The limitation, stated rather than buried
//!
//! `core.event_log` keeps **structural** fields - the serialised event payload -
//! and is purged after 30 days. So:
//!
//! * a rule comparing something the payload never carried cannot be replayed
//!   truthfully, and will simply not match;
//! * scope and rollout are evaluated against **today's** accounts, groups and
//!   units, not against who was where at the time;
//! * a threshold is not replayed at all: counting "N times in T" over history
//!   would require writing the live counters;
//! * `source_module` was never written before migration `000061`, so events
//!   older than the upgrade have none, and a rule comparing it will not match
//!   them.
//!
//! Every one of these travels in the report under `limitations`, in the same
//! payload as the numbers. A number an operator cannot qualify is a number they
//! will over-trust.

use chrono::{DateTime, Datelike, Duration, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

use kubuno_db::{params, DbPool};

use crate::errors::AppError;

use super::engine;
use super::facts;
use super::model::{Mode, Outcome, Rule};
use super::store::{self, NewExecution};

/// Job type that runs a backtest.
pub const BACKTEST_JOB: &str = "core.rules.backtest";

/// Widest window a backtest may cover: the event log's own retention. Asking
/// for more would return a confident answer about days that were deleted.
pub const MAX_WINDOW_DAYS: i64 = 30;

/// How many matches get an execution row. Beyond this the report's aggregates
/// still count everything; only the per-match rows stop, so a rule that would
/// have matched a million times does not fill the table proving it.
const MAX_LOGGED_MATCHES: usize = 500;

/// Rows read from `core.event_log` per batch.
const BATCH: i64 = 2_000;

/// One replayed row of `core.event_log`.
#[derive(sqlx::FromRow)]
struct EventLogRow {
    id: i64,
    source_module: Option<String>,
    payload: Value,
    depth: i16,
    created_at: DateTime<Utc>,
}

/// Runs the backtest and stores its report.
pub async fn run(db: &DbPool, backtest_id: Uuid) -> Result<(), AppError> {
    let bt = store::get_backtest(db, backtest_id).await?;
    let rule = store::get_rule(db, bt.rule_id).await?;
    store::mark_backtest_running(db, backtest_id).await?;

    match execute(db, &rule, bt.window_from, bt.window_to).await {
        Ok(report) => {
            store::finish_backtest(db, backtest_id, &report, None).await?;
            tracing::info!(
                backtest_id = %backtest_id,
                rule_id = %rule.id,
                "Test rétrospectif terminé"
            );
            Ok(())
        }
        Err(e) => {
            let message = e.to_string();
            store::finish_backtest(db, backtest_id, &json!({}), Some(&message)).await?;
            Err(e)
        }
    }
}

/// The replay itself.
async fn execute(
    db: &DbPool,
    rule: &Rule,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Value, AppError> {
    // The event type the rule's trigger listens to. Filtering in SQL rather
    // than in Rust is what makes a 30-day replay affordable - and it is only
    // possible because `event_type` now stores the real type (see the defect
    // fixed in `crate::events::bus`).
    let event_type: Option<String> = db
        .fetch_optional_scalar::<String>(
            "SELECT event_type FROM core.rule_triggers WHERE \"key\" = $1",
            params![&rule.trigger_key],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "rules: lecture du type d'événement du déclencheur");
            AppError::Database(e)
        })?;
    let Some(event_type) = event_type else {
        return Err(AppError::Validation(
            "This rule's trigger is no longer in the catalog".into(),
        ));
    };

    let cap = store::setting_u64(db, "rules.backtest_max_events", 200_000, 1_000, 5_000_000).await;

    let mut scanned: u64 = 0;
    let mut matched: u64 = 0;
    let mut would_act: u64 = 0;
    let mut out_of_scope: u64 = 0;
    let mut out_of_rollout: u64 = 0;
    let mut logged_matches = 0usize;
    let mut truncated = false;

    let mut by_day: HashMap<String, u64> = HashMap::new();
    let mut by_unit: HashMap<String, u64> = HashMap::new();
    // One lookup per distinct account rather than one per event.
    let mut unit_cache: HashMap<Uuid, Option<Uuid>> = HashMap::new();
    let mut unit_names: HashMap<Uuid, String> = HashMap::new();

    let mut cursor: i64 = 0;

    loop {
        let rows = db
            .fetch_all_as::<EventLogRow>(
                r#"SELECT id, source_module, payload, depth, created_at
                     FROM core.event_log
                    WHERE event_type = $1
                      AND created_at >= $2 AND created_at < $3
                      AND id > $4
                    ORDER BY id
                    LIMIT $5"#,
                params![&event_type, from, to, cursor, BATCH],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "rules: lecture du journal d'événements pour le rejeu");
                AppError::Database(e)
            })?;

        if rows.is_empty() {
            break;
        }

        let batch_len = rows.len() as i64;
        for row in &rows {
            cursor = row.id;
            scanned += 1;
            if scanned > cap {
                truncated = true;
                break;
            }

            let payload = &row.payload;
            let depth: i16 = row.depth;
            let created_at: DateTime<Utc> = row.created_at;

            let f = facts::facts_of_logged(
                &event_type,
                row.source_module.as_deref(),
                payload,
                u16::try_from(depth).unwrap_or(0),
            );

            // The very same gates the live path runs, in Backtest mode: no
            // threshold write, no action, no alert.
            let verdict = engine::decide(db, rule, &f, Mode::Backtest).await?;

            match verdict.outcome {
                Outcome::Matched | Outcome::Acted => {
                    matched += 1;
                    if !rule.actions.is_empty() {
                        would_act += 1;
                    }

                    let day = format!(
                        "{:04}-{:02}-{:02}",
                        created_at.year(),
                        created_at.month(),
                        created_at.day()
                    );
                    *by_day.entry(day).or_insert(0) += 1;

                    let unit = match f.subject_user_id {
                        Some(uid) => resolve_unit(db, uid, &mut unit_cache).await?,
                        None => None,
                    };
                    let bucket = match unit {
                        Some(u) => {
                            if let std::collections::hash_map::Entry::Vacant(e) =
                                unit_names.entry(u)
                            {
                                let name: Option<String> = db
                                    .fetch_optional_scalar::<String>(
                                        "SELECT name FROM core.org_units WHERE id = $1",
                                        params![u],
                                    )
                                    .await
                                    .unwrap_or(None);
                                e.insert(name.unwrap_or_else(|| u.to_string()));
                            }
                            unit_names.get(&u).cloned().unwrap_or_else(|| u.to_string())
                        }
                        None => "(outside the unit)".to_string(),
                    };
                    *by_unit.entry(bucket).or_insert(0) += 1;

                    // Matches are logged, up to a ceiling. Non-matches never
                    // are: a replay of a month of events would otherwise write
                    // a month of "nothing happened".
                    if logged_matches < MAX_LOGGED_MATCHES {
                        logged_matches += 1;
                        let mut exec =
                            NewExecution::new(rule, Mode::Backtest, verdict.outcome, &event_type);
                        exec.actor_user_id = f.subject_user_id;
                        exec.org_unit_id = unit;
                        exec.resource_type = f.resource_type.clone();
                        exec.resource_id = f.resource_id.clone();
                        exec.depth = depth;
                        exec.actions_total =
                            i16::try_from(rule.actions.len()).unwrap_or(i16::MAX);
                        exec.detail = json!({ "replayed_at": created_at });
                        let _ = store::record_execution(db, &exec).await;
                    }
                }
                Outcome::OutOfScope => out_of_scope += 1,
                Outcome::OutOfRollout => out_of_rollout += 1,
                _ => {}
            }
        }

        if truncated || batch_len < BATCH {
            break;
        }
    }

    let mut limitations = vec![
        "Only structural event-log fields can be replayed. A condition on data absent from the payload will never match.".to_string(),
        "Scope and rollout percentage are evaluated against current accounts, groups, and units, rather than those at the time of the event.".to_string(),
        "The event log is purged after 30 days. Older windows are empty, rather than having no matches.".to_string(),
        "Before migration 000061, the source module was never recorded. A 'source_module' condition will not match earlier events.".to_string(),
    ];
    if rule.threshold().is_some() {
        limitations.push(
            "This rule has an 'N times in T' threshold. It is not replayed, because counting it would change the live rule's counters. The matches above ignore the threshold and are therefore an upper bound.".to_string(),
        );
    }
    if truncated {
        limitations.push(format!(
            "Replay stopped at {cap} events (the 'rules.backtest_max_events' limit). Counts are partial."
        ));
    }

    let mut days: Vec<(String, u64)> = by_day.into_iter().collect();
    days.sort_by(|a, b| a.0.cmp(&b.0));
    let mut units: Vec<(String, u64)> = by_unit.into_iter().collect();
    units.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    Ok(json!({
        "window_from":       from,
        "window_to":         to,
        "event_type":        event_type,
        "events_scanned":    scanned.min(cap),
        "matched":           matched,
        "would_act":         would_act,
        "out_of_scope":      out_of_scope,
        "out_of_rollout":    out_of_rollout,
        "truncated":         truncated,
        "logged_matches":    logged_matches,
        "by_day":            days.iter().map(|(d, n)| json!({ "day": d, "count": n })).collect::<Vec<_>>(),
        "by_org_unit":       units.iter().map(|(u, n)| json!({ "unit": u, "count": n })).collect::<Vec<_>>(),
        "limitations":       limitations,
    }))
}

async fn resolve_unit(
    db: &DbPool,
    user_id: Uuid,
    cache: &mut HashMap<Uuid, Option<Uuid>>,
) -> Result<Option<Uuid>, AppError> {
    if let Some(hit) = cache.get(&user_id) {
        return Ok(*hit);
    }
    // The scalar is decoded as `Option<Uuid>`: the column is nullable, so a row
    // with no unit is a present-but-null value, not a missing row.
    let unit: Option<Uuid> = db
        .fetch_optional_scalar::<Option<Uuid>>(
            "SELECT org_unit_id FROM core.users WHERE id = $1",
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "rules: lecture de l'unité d'un compte pour le rejeu");
            AppError::Database(e)
        })?
        .flatten();
    cache.insert(user_id, unit);
    Ok(unit)
}

/// Clamps a requested window to what the event log can honestly answer.
pub fn clamp_window(
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
) -> Result<(DateTime<Utc>, DateTime<Utc>), AppError> {
    let now = Utc::now();
    let to = to.unwrap_or(now).min(now);
    let from = from.unwrap_or_else(|| to - Duration::days(7));
    if from >= to {
        return Err(AppError::Validation(
            "The backtest window is empty".into(),
        ));
    }
    let floor = now - Duration::days(MAX_WINDOW_DAYS);
    // Silently shortening would produce a confident answer about deleted days.
    if from < floor {
        return Err(AppError::Validation(format!(
            "The event log is retained for {MAX_WINDOW_DAYS} days; an older window cannot be replayed"
        )));
    }
    Ok((from, to))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_window_is_the_last_seven_days() {
        let (from, to) = clamp_window(None, None).expect("fenêtre par défaut");
        let span = to - from;
        assert_eq!(span.num_days(), 7);
    }

    #[test]
    fn a_window_older_than_the_retention_is_refused_rather_than_shortened() {
        // Shortening it would answer confidently about days that were deleted.
        let to = Utc::now();
        let from = to - Duration::days(MAX_WINDOW_DAYS + 5);
        assert!(clamp_window(Some(from), Some(to)).is_err());

        let from = to - Duration::days(MAX_WINDOW_DAYS - 1);
        assert!(clamp_window(Some(from), Some(to)).is_ok());
    }

    #[test]
    fn an_empty_or_inverted_window_is_refused() {
        let now = Utc::now();
        assert!(clamp_window(Some(now), Some(now)).is_err());
        assert!(clamp_window(Some(now), Some(now - Duration::days(1))).is_err());
    }

    #[test]
    fn a_future_end_is_pulled_back_to_now() {
        let (_, to) = clamp_window(None, Some(Utc::now() + Duration::days(400)))
            .expect("fenêtre valide");
        assert!(to <= Utc::now() + Duration::seconds(1));
    }
}
