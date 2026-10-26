//! Persistence of the rule engine: rules and their versions, the execution log,
//! the threshold counters, and the notification that reloads the memory index.
//!
//! Every statement targets the `core` schema and nothing else.
//!
//! ## Writing a rule always writes a version
//!
//! [`insert_rule`] and [`update_rule`] take a live transaction - in practice the
//! [`crate::audit::AuditTx`] the handler opened - and write the snapshot in the
//! **same transaction** as the rule. There is no code path that produces a rule
//! row without the matching `core.rule_versions` row, because the two statements
//! are in one function and that function is the only way in. An execution log
//! that names a version which might not exist would be unreadable exactly when
//! somebody needs to know which wording of a rule suspended an account.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use kubuno_db::{params, DbPool, DbQueryBuilder, DbRow, DbTx};

use crate::errors::AppError;

use super::condition::Condition;
use super::model::{ActionSpec, ExecutionRow, Mode, Outcome, Rule, Scope, Subject, VersionRow};

/// PostgreSQL channel woken up whenever a rule changes. Every core process
/// listens and rebuilds its memory index; nothing queries on the hot path.
pub const RULES_CHANNEL: &str = "kubuno_rules";

// The column list every read shares. A macro rather than a `const` so call sites
// can splice it with `concat!`: the result is a single `&'static str` literal,
// which the driver accepts without an audit escape hatch - no query text here is
// ever built at run time.
macro_rules! select_rule {
    () => {
        r#"
    id, name, description, trigger_key, conditions, actions, mode, scope,
    threshold_count, threshold_window_s, rollout_percent, severity, priority,
    version, created_at, updated_at
"#
    };
}

/// The raw shape of a `core.rules` row, decoded by the driver before the JSON
/// columns are parsed into their strong types.
#[derive(sqlx::FromRow)]
struct RawRuleRow {
    id: Uuid,
    name: String,
    description: Option<String>,
    trigger_key: String,
    conditions: Value,
    actions: Value,
    mode: String,
    scope: Value,
    threshold_count: Option<i32>,
    threshold_window_s: Option<i32>,
    rollout_percent: i16,
    severity: String,
    priority: i32,
    version: i32,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl RawRuleRow {
    fn into_rule(self) -> Rule {
        Rule {
            id: self.id,
            name: self.name,
            description: self.description,
            trigger_key: self.trigger_key,
            // A tree stored by an older or newer core that this build cannot read
            // degrades to "matches everything" - never to a panic on the hot path.
            // The console shows the raw JSON so the drift is visible.
            conditions: serde_json::from_value(self.conditions).unwrap_or_default(),
            actions: serde_json::from_value(self.actions).unwrap_or_default(),
            mode: Mode::parse(&self.mode).unwrap_or(Mode::Inactive),
            scope: serde_json::from_value(self.scope).unwrap_or_default(),
            threshold_count: self.threshold_count,
            threshold_window_s: self.threshold_window_s,
            rollout_percent: self.rollout_percent,
            severity: self.severity,
            priority: self.priority,
            version: self.version,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// Hand-maps a rule row read inside a transaction (where `fetch_*_as` is not
/// available), applying the same graceful JSON degradation as [`RawRuleRow`].
fn row_to_rule(r: &DbRow) -> Result<Rule, sqlx::Error> {
    Ok(Rule {
        id: r.try_get("id")?,
        name: r.try_get("name")?,
        description: r.try_get("description")?,
        trigger_key: r.try_get("trigger_key")?,
        conditions: serde_json::from_value(r.try_get::<Value>("conditions")?).unwrap_or_default(),
        actions: serde_json::from_value(r.try_get::<Value>("actions")?).unwrap_or_default(),
        mode: Mode::parse(&r.try_get::<String>("mode")?).unwrap_or(Mode::Inactive),
        scope: serde_json::from_value(r.try_get::<Value>("scope")?).unwrap_or_default(),
        threshold_count: r.try_get("threshold_count")?,
        threshold_window_s: r.try_get("threshold_window_s")?,
        rollout_percent: r.try_get("rollout_percent")?,
        severity: r.try_get("severity")?,
        priority: r.try_get("priority")?,
        version: r.try_get("version")?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
    })
}

// ── Reads ────────────────────────────────────────────────────────────────────

/// Every rule that is not inactive, ordered as the engine runs them.
pub async fn load_active(db: &DbPool) -> Result<Vec<Rule>, AppError> {
    let rows = db
        .fetch_all_as::<RawRuleRow>(
            concat!(
                "SELECT ",
                select_rule!(),
                " FROM core.rules WHERE mode <> 'inactive' ORDER BY priority, created_at"
            ),
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "rules: chargement des règles actives");
            AppError::Database(e)
        })?;
    Ok(rows.into_iter().map(RawRuleRow::into_rule).collect())
}

pub async fn list_rules(db: &DbPool) -> Result<Vec<Rule>, AppError> {
    let rows = db
        .fetch_all_as::<RawRuleRow>(
            concat!(
                "SELECT ",
                select_rule!(),
                " FROM core.rules ORDER BY priority, created_at"
            ),
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "rules: lecture des règles");
            AppError::Database(e)
        })?;
    Ok(rows.into_iter().map(RawRuleRow::into_rule).collect())
}

pub async fn get_rule(db: &DbPool, id: Uuid) -> Result<Rule, AppError> {
    let row = db
        .fetch_optional_as::<RawRuleRow>(
            concat!("SELECT ", select_rule!(), " FROM core.rules WHERE id = $1"),
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, rule_id = %id, "rules: lecture d'une règle");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("rule".into()))?;
    Ok(row.into_rule())
}

// ── Writes ───────────────────────────────────────────────────────────────────

/// A validated rule definition, ready to be written.
#[derive(Debug, Clone)]
pub struct RuleDraft {
    pub name: String,
    pub description: Option<String>,
    pub trigger_key: String,
    pub conditions: Condition,
    pub actions: Vec<ActionSpec>,
    pub mode: Mode,
    pub scope: Scope,
    pub threshold_count: Option<i32>,
    pub threshold_window_s: Option<i32>,
    pub rollout_percent: i16,
    pub severity: String,
    pub priority: i32,
}

impl RuleDraft {
    /// The snapshot stored in `core.rule_versions`. Denormalised on purpose:
    /// reading history must not depend on the current shape of `core.rules`.
    fn snapshot(&self, version: i32) -> Value {
        json!({
            "version":            version,
            "name":               self.name,
            "description":        self.description,
            "trigger_key":        self.trigger_key,
            "conditions":         self.conditions,
            "actions":            self.actions,
            "mode":               self.mode.as_str(),
            "scope":              self.scope,
            "threshold_count":    self.threshold_count,
            "threshold_window_s": self.threshold_window_s,
            "rollout_percent":    self.rollout_percent,
            "severity":           self.severity,
            "priority":           self.priority,
        })
    }
}

/// Creates a rule and its first version, atomically.
pub async fn insert_rule(
    tx: &mut DbTx,
    draft: &RuleDraft,
    author: Option<Uuid>,
    note: Option<&str>,
) -> Result<Rule, AppError> {
    // The primary key is invented in Rust so the write needs no RETURNING and
    // the row can be re-read by id on every engine.
    let id = kubuno_db::new_id();
    tx.execute(
        r#"INSERT INTO core.rules
               (id, name, description, trigger_key, conditions, actions, mode, scope,
                threshold_count, threshold_window_s, rollout_percent, severity, priority,
                version, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $15)"#,
        params![
            id,
            &draft.name,
            draft.description.as_deref(),
            &draft.trigger_key,
            serde_json::to_value(&draft.conditions).unwrap_or_default(),
            serde_json::to_value(&draft.actions).unwrap_or_default(),
            draft.mode.as_str(),
            serde_json::to_value(&draft.scope).unwrap_or_default(),
            draft.threshold_count,
            draft.threshold_window_s,
            draft.rollout_percent,
            &draft.severity,
            draft.priority,
            author,
            author
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "rules: création d'une règle");
        AppError::Database(e)
    })?;

    let row = tx
        .fetch_optional_row(
            concat!("SELECT ", select_rule!(), " FROM core.rules WHERE id = $1"),
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "rules: relecture d'une règle");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("rule".into()))?;
    let rule = row_to_rule(&row).map_err(AppError::Database)?;
    insert_version(tx, rule.id, 1, &draft.snapshot(1), author, note).await?;
    Ok(rule)
}

/// Replaces a rule's definition, bumping its version and writing the snapshot in
/// the same transaction.
pub async fn update_rule(
    tx: &mut DbTx,
    id: Uuid,
    draft: &RuleDraft,
    author: Option<Uuid>,
    note: Option<&str>,
) -> Result<Rule, AppError> {
    let affected = tx
        .execute(
            r#"UPDATE core.rules
                  SET name = $2, description = $3, trigger_key = $4, conditions = $5,
                      actions = $6, mode = $7, scope = $8, threshold_count = $9,
                      threshold_window_s = $10, rollout_percent = $11, severity = $12,
                      priority = $13, version = version + 1, updated_by = $14
                WHERE id = $1"#,
            params![
                id,
                &draft.name,
                draft.description.as_deref(),
                &draft.trigger_key,
                serde_json::to_value(&draft.conditions).unwrap_or_default(),
                serde_json::to_value(&draft.actions).unwrap_or_default(),
                draft.mode.as_str(),
                serde_json::to_value(&draft.scope).unwrap_or_default(),
                draft.threshold_count,
                draft.threshold_window_s,
                draft.rollout_percent,
                &draft.severity,
                draft.priority,
                author
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, rule_id = %id, "rules: mise à jour d'une règle");
            AppError::Database(e)
        })?;
    if affected == 0 {
        return Err(AppError::NotFound("rule".into()));
    }

    let row = tx
        .fetch_optional_row(
            concat!("SELECT ", select_rule!(), " FROM core.rules WHERE id = $1"),
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, rule_id = %id, "rules: relecture d'une règle");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("rule".into()))?;
    let rule = row_to_rule(&row).map_err(AppError::Database)?;
    insert_version(
        tx,
        rule.id,
        rule.version,
        &draft.snapshot(rule.version),
        author,
        note,
    )
    .await?;
    Ok(rule)
}

async fn insert_version(
    tx: &mut DbTx,
    rule_id: Uuid,
    version: i32,
    snapshot: &Value,
    author: Option<Uuid>,
    note: Option<&str>,
) -> Result<(), AppError> {
    tx.execute(
        r#"INSERT INTO core.rule_versions (rule_id, version, snapshot, change_note, changed_by)
           VALUES ($1, $2, $3, $4, $5)"#,
        params![rule_id, version, snapshot.clone(), note, author],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, rule_id = %rule_id, version, "rules: écriture d'une version");
        AppError::Database(e)
    })?;
    Ok(())
}

pub async fn delete_rule(tx: &mut DbTx, id: Uuid) -> Result<(), AppError> {
    let affected = tx
        .execute("DELETE FROM core.rules WHERE id = $1", params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, rule_id = %id, "rules: suppression d'une règle");
            AppError::Database(e)
        })?;
    if affected == 0 {
        return Err(AppError::NotFound("rule".into()));
    }
    Ok(())
}

pub async fn versions(db: &DbPool, rule_id: Uuid) -> Result<Vec<VersionRow>, AppError> {
    db.fetch_all_as::<VersionRow>(
        r#"SELECT v.version, v.snapshot, v.change_note, v.changed_by, v.created_at,
                  COALESCE(NULLIF(u.display_name, ''), u.username) AS changed_by_label
             FROM core.rule_versions v
             LEFT JOIN core.users u ON u.id = v.changed_by
            WHERE v.rule_id = $1
            ORDER BY v.version DESC"#,
        params![rule_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, rule_id = %rule_id, "rules: lecture des versions");
        AppError::Database(e)
    })
}

/// Wakes every core process so it rebuilds its memory index. On PostgreSQL this
/// is a `pg_notify`; on the other engines it lands in the event outbox.
pub async fn notify_reload(db: &DbPool) {
    if let Err(e) = kubuno_db::events::notify(db, crate::database::SCHEMA, RULES_CHANNEL, "").await
    {
        tracing::error!(error = %e, "rules: pg_notify sur le canal des règles");
    }
}

// ── Execution log ────────────────────────────────────────────────────────────

/// One line to append. Structural fields and counters only - see the header of
/// migration `000061` for why the inspected content is not among them.
#[derive(Debug, Clone)]
pub struct NewExecution {
    pub rule_id: Uuid,
    pub rule_version: i32,
    pub mode: Mode,
    pub outcome: Outcome,
    pub event_type: String,
    pub actor_user_id: Option<Uuid>,
    pub org_unit_id: Option<Uuid>,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub detail: Value,
    pub actions_total: i16,
    pub actions_ok: i16,
    pub actions_failed: i16,
    pub depth: i16,
    pub duration_ms: i32,
    /// The reference handed to a user the synchronous gate stopped. `None` for
    /// every execution that did not come from the gate - which is what makes
    /// the column a usable index rather than one that is set on every row.
    pub gate_reference: Option<String>,
}

impl NewExecution {
    pub fn new(rule: &Rule, mode: Mode, outcome: Outcome, event_type: impl Into<String>) -> Self {
        Self {
            rule_id: rule.id,
            rule_version: rule.version,
            mode,
            outcome,
            event_type: event_type.into(),
            actor_user_id: None,
            org_unit_id: None,
            resource_type: None,
            resource_id: None,
            detail: json!({}),
            actions_total: 0,
            actions_ok: 0,
            actions_failed: 0,
            depth: 0,
            duration_ms: 0,
            gate_reference: None,
        }
    }
}

pub async fn record_execution(db: &DbPool, exec: &NewExecution) -> Result<i64, AppError> {
    // `core.rule_executions.id` is engine-assigned (BIGSERIAL / AUTO_INCREMENT /
    // rowid), so it is learnt after the write: PostgreSQL and SQLite read it back
    // with `RETURNING id`, MySQL from `SELECT LAST_INSERT_ID()`. Both statements
    // must run on the same connection, so the insert is wrapped in a short
    // transaction (`insert_returning_scalar` picks the per-engine path).
    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, rule_id = %exec.rule_id, "rules: ouverture du journal d'exécution");
        AppError::Database(e)
    })?;
    let id = kubuno_db::returning::insert_returning_scalar::<i64>(
        &mut tx,
        r#"INSERT INTO core.rule_executions
               (rule_id, rule_version, mode, outcome, event_type, actor_user_id,
                org_unit_id, resource_type, resource_id, detail,
                actions_total, actions_ok, actions_failed, depth, duration_ms,
                gate_reference)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)"#,
        params![
            exec.rule_id,
            exec.rule_version,
            exec.mode.as_str(),
            exec.outcome.as_str(),
            &exec.event_type,
            exec.actor_user_id,
            exec.org_unit_id,
            exec.resource_type.as_deref(),
            exec.resource_id.as_deref(),
            exec.detail.clone(),
            exec.actions_total,
            exec.actions_ok,
            exec.actions_failed,
            exec.depth,
            exec.duration_ms,
            exec.gate_reference.as_deref()
        ],
        "id",
        "SELECT CAST(LAST_INSERT_ID() AS SIGNED)",
        params![],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, rule_id = %exec.rule_id, "rules: écriture du journal d'exécution");
        AppError::Database(e)
    })?;
    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, rule_id = %exec.rule_id, "rules: commit du journal d'exécution");
        AppError::Database(e)
    })?;
    Ok(id)
}

/// Updates the action counters of an execution once the dispatcher is done.
pub async fn settle_execution(
    db: &DbPool,
    execution_id: i64,
    ok: i16,
    failed: i16,
    detail: &Value,
) -> Result<(), AppError> {
    // The CASE re-reads `failed` and `ok`; each placeholder is bound exactly once
    // (kubuno_db rewrites `$n` positionally), so the two values are bound twice.
    db.execute(
        r#"UPDATE core.rule_executions
              SET actions_ok = $2, actions_failed = $3, detail = $4,
                  outcome = CASE WHEN $5 > 0 AND $6 = 0 THEN 'error' ELSE outcome END
            WHERE id = $1"#,
        params![execution_id, ok, failed, detail.clone(), failed, ok],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, execution_id, "rules: clôture d'une exécution");
        AppError::Database(e)
    })?;
    Ok(())
}

/// Filters accepted by the execution log endpoint.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct ExecutionQuery {
    pub rule_id: Option<Uuid>,
    pub mode: Option<String>,
    pub outcome: Option<String>,
    /// The reference a user was given by the gate. The whole point of handing
    /// one out: somebody who may read the run log pastes it and lands on the
    /// exact execution, without the user ever having learnt which rule it was.
    pub reference: Option<String>,
    pub limit: Option<i64>,
}

pub const MAX_EXECUTION_LIMIT: i64 = 200;

pub async fn list_executions(
    db: &DbPool,
    q: &ExecutionQuery,
) -> Result<Vec<ExecutionRow>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, MAX_EXECUTION_LIMIT);
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        r#"SELECT e.id, e.rule_id, r.name AS rule_name, e.rule_version, e.mode, e.outcome,
                  e.event_type, e.actor_user_id, e.org_unit_id, e.resource_type, e.resource_id,
                  e.detail, e.actions_total, e.actions_ok, e.actions_failed, e.depth,
                  e.duration_ms, e.occurred_at, e.gate_reference
             FROM core.rule_executions e
             LEFT JOIN core.rules r ON r.id = e.rule_id
            WHERE 1 = 1"#,
    );
    if let Some(rule_id) = q.rule_id {
        qb.push(" AND e.rule_id = ").push_bind(rule_id);
    }
    if let Some(mode) = q.mode.as_deref() {
        qb.push(" AND e.mode = ").push_bind(mode);
    }
    if let Some(outcome) = q.outcome.as_deref() {
        qb.push(" AND e.outcome = ").push_bind(outcome);
    }
    if let Some(reference) = q
        .reference
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        qb.push(" AND e.gate_reference = UPPER(")
            .push_bind(reference)
            .push(")");
    }
    qb.push_order_by("e.occurred_at DESC, e.id DESC");
    qb.push_limit_offset(limit, 0);

    qb.fetch_all_as::<ExecutionRow>(db).await.map_err(|e| {
        tracing::error!(error = %e, "rules: lecture du journal d'exécution");
        AppError::Database(e)
    })
}

// ── Thresholds ───────────────────────────────────────────────────────────────

/// Records a match and returns how many happened inside the window, this one
/// included.
///
/// Rolling, not tumbling: "more than five times in fifteen minutes" must be true
/// at every instant, not only inside an arbitrary quarter-hour.
///
/// ## Two statements, on purpose
///
/// The obvious one-round-trip form -
/// `WITH inserted AS (INSERT …) SELECT COUNT(*) FROM core.rule_hits …` - is
/// **wrong**, and silently so. Every sub-statement of a `WITH` sees the snapshot
/// taken at the start of the whole statement, so the `SELECT` cannot see the row
/// the `INSERT` just wrote: the count came back one short, for ever, and a rule
/// asking for five occurrences fired on the sixth. An integration test is what
/// caught it. Two statements in one transaction cost one extra round trip and
/// are simply correct.
pub async fn hit_and_count(
    db: &DbPool,
    rule_id: Uuid,
    subject_key: &str,
    window_s: i32,
) -> Result<i64, AppError> {
    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, rule_id = %rule_id, "rules: transaction de comptage du seuil");
        AppError::Database(e)
    })?;

    // FLAG: `core.rule_hits.id` is BIGSERIAL; the insert leans on the database to
    // supply the key (no RETURNING is needed here). PostgreSQL-shaped.
    tx.execute(
        "INSERT INTO core.rule_hits (rule_id, subject_key) VALUES ($1, $2)",
        params![rule_id, subject_key],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, rule_id = %rule_id, "rules: écriture d'une occurrence de seuil");
        AppError::Database(e)
    })?;

    // The window edge is computed in Rust and bound, so the query carries no
    // engine-specific interval arithmetic.
    let cutoff = Utc::now() - chrono::Duration::seconds(i64::from(window_s));
    let count = tx
        .fetch_optional_scalar::<i64>(
            &format!(
                "SELECT {} FROM core.rule_hits \
                  WHERE rule_id = $1 AND subject_key = $2 AND occurred_at > $3",
                db.backend().count_bigint("*")
            ),
            params![rule_id, subject_key, cutoff],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, rule_id = %rule_id, "rules: comptage du seuil");
            AppError::Database(e)
        })?
        .unwrap_or(0);

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, rule_id = %rule_id, "rules: commit du comptage du seuil");
        AppError::Database(e)
    })?;

    Ok(count)
}

/// Drops hits older than the widest window any rule declares. Called by the
/// maintenance job; the table is otherwise unbounded.
pub async fn purge_hits(db: &DbPool) -> Result<u64, AppError> {
    // The retention window is per rule (its threshold window plus one hour), so
    // there is no single cut-off. In place of the PostgreSQL-only
    // `DELETE … USING … make_interval`, each rule's window is read, the cut-off
    // is computed in Rust, and the rules are grouped by window so there is one
    // `DELETE … WHERE rule_id IN (…) AND occurred_at < $cutoff` per distinct
    // window (a handful) rather than one statement per rule.
    let rules = db
        .fetch_all_as::<(Uuid, Option<i32>)>(
            "SELECT id, threshold_window_s FROM core.rules",
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "rules: lecture des fenêtres de seuil");
            AppError::Database(e)
        })?;

    let now = Utc::now();
    let mut by_window: std::collections::HashMap<i64, Vec<Uuid>> = std::collections::HashMap::new();
    for (id, window) in rules {
        // The `+ 3600` keeps the original one-hour grace past the window.
        let secs = i64::from(window.unwrap_or(0).max(0)) + 3_600;
        by_window.entry(secs).or_default().push(id);
    }

    let mut total: u64 = 0;
    for (secs, ids) in by_window {
        if ids.is_empty() {
            continue;
        }
        let cutoff = now - chrono::Duration::seconds(secs);
        let mut qb =
            DbQueryBuilder::new(db.backend(), "DELETE FROM core.rule_hits WHERE occurred_at < ");
        qb.push_bind(cutoff);
        qb.push(" AND rule_id");
        qb.push_in(ids);
        total += qb.execute(db).await.map_err(|e| {
            tracing::error!(error = %e, "rules: purge des occurrences de seuil");
            AppError::Database(e)
        })?;
    }
    Ok(total)
}

/// Drops executions past the configured retention.
pub async fn purge_executions(db: &DbPool, days: i64) -> Result<u64, AppError> {
    let cutoff = Utc::now() - chrono::Duration::days(days.clamp(1, 3_650));
    let rows = db
        .execute(
            "DELETE FROM core.rule_executions WHERE occurred_at < $1",
            params![cutoff],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "rules: purge du journal d'exécution");
            AppError::Database(e)
        })?;
    Ok(rows)
}

// ── Subject resolution ───────────────────────────────────────────────────────

/// Everything a scope test needs about an account.
///
/// Called **only after a rule's conditions matched and its scope is non-empty**.
/// The hot path - deciding which rules an event concerns - is served entirely
/// from the memory index and never touches the database.
///
/// Rebuilt as portable steps: the original folded the ancestor chain with the
/// PostgreSQL-only `core.org_unit_ancestors(...)` and `jsonb_agg`. The ancestor
/// walk now runs through the portable recursive CTE of `database::compat`, whose
/// depth guard (64) comfortably exceeds the console's org-unit ceiling, so the
/// chain is never truncated for a legal tree.
pub async fn resolve_subject(db: &DbPool, user_id: Uuid) -> Result<Subject, AppError> {
    let fail = |e: sqlx::Error| {
        tracing::error!(error = %e, user_id = %user_id, "rules: résolution du sujet");
        AppError::Database(e)
    };

    // The account and its unit. A vanished account (no row) is covered by
    // nothing that names anybody.
    let Some(org_unit_id) = db
        .fetch_optional_scalar::<Option<Uuid>>(
            "SELECT org_unit_id FROM core.users WHERE id = $1",
            params![user_id],
        )
        .await
        .map_err(fail)?
    else {
        return Ok(Subject::default());
    };

    // Every group the account belongs to.
    let group_ids: Vec<Uuid> = db
        .fetch_all_as::<(Uuid,)>(
            "SELECT group_id FROM core.user_group_members WHERE user_id = $1",
            params![user_id],
        )
        .await
        .map_err(fail)?
        .into_iter()
        .map(|(g,)| g)
        .collect();

    // The unit's ancestor chain (itself included), nearest first.
    let mut unit_chain: Vec<Uuid> = Vec::new();
    if let Some(own) = org_unit_id {
        let sql = format!(
            "SELECT a.id FROM {} a ORDER BY a.depth",
            crate::database::compat::org_unit_ancestors(1)
        );
        unit_chain = db
            .fetch_all_as::<(Uuid,)>(&sql, params![own])
            .await
            .map_err(fail)?
            .into_iter()
            .map(|(id,)| id)
            .collect();
        // The walk starts at the unit itself; the defensive insert keeps the
        // chain correct even if that ever stops being true.
        if !unit_chain.contains(&own) {
            unit_chain.push(own);
        }
    }

    Ok(Subject {
        user_id: Some(user_id),
        org_unit_id,
        unit_chain,
        group_ids,
    })
}

// ── Settings ─────────────────────────────────────────────────────────────────

/// Reads one numeric knob from `core.settings`, clamped to a sane range.
pub async fn setting_u64(db: &DbPool, key: &str, default: u64, min: u64, max: u64) -> u64 {
    let raw: Option<Value> = db
        .fetch_optional_scalar::<Value>("SELECT value FROM core.settings WHERE \"key\" = $1", params![key])
        .await
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, key = %key, "rules: lecture d'un réglage");
            None
        });

    raw.as_ref()
        .and_then(Value::as_u64)
        .unwrap_or(default)
        .clamp(min, max)
}

/// Is the engine armed at all?
pub async fn engine_enabled(db: &DbPool) -> bool {
    let raw: Option<Value> = db
        .fetch_optional_scalar::<Value>(
            "SELECT value FROM core.settings WHERE \"key\" = 'rules.enabled'",
            params![],
        )
        .await
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "rules: lecture de rules.enabled");
            None
        });
    raw.as_ref().and_then(Value::as_bool).unwrap_or(true)
}

// ── Backtests ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct BacktestRow {
    pub id: Uuid,
    pub rule_id: Uuid,
    pub rule_version: i32,
    pub window_from: DateTime<Utc>,
    pub window_to: DateTime<Utc>,
    pub status: String,
    pub report: Value,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

const BACKTEST_COLS: &str = r#"id, rule_id, rule_version, window_from, window_to, status,
                  report, error, created_at, completed_at"#;

pub async fn create_backtest(
    db: &DbPool,
    rule: &Rule,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    requested_by: Option<Uuid>,
) -> Result<BacktestRow, AppError> {
    // UUID primary key generated in Rust: the write needs no RETURNING and the
    // row is re-read by id.
    let id = kubuno_db::new_id();
    db.execute(
        r#"INSERT INTO core.rule_backtests
               (id, rule_id, rule_version, window_from, window_to, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6)"#,
        params![id, rule.id, rule.version, from, to, requested_by],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, rule_id = %rule.id, "rules: création d'un test rétrospectif");
        AppError::Database(e)
    })?;
    get_backtest(db, id).await
}

pub async fn get_backtest(db: &DbPool, id: Uuid) -> Result<BacktestRow, AppError> {
    db.fetch_optional_as::<BacktestRow>(
        &format!("SELECT {BACKTEST_COLS} FROM core.rule_backtests WHERE id = $1"),
        params![id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, backtest_id = %id, "rules: lecture d'un test rétrospectif");
        AppError::Database(e)
    })?
    .ok_or_else(|| AppError::NotFound("backtest".into()))
}

pub async fn list_backtests(db: &DbPool, rule_id: Uuid) -> Result<Vec<BacktestRow>, AppError> {
    db.fetch_all_as::<BacktestRow>(
        &format!(
            "SELECT {BACKTEST_COLS} FROM core.rule_backtests WHERE rule_id = $1 \
             ORDER BY created_at DESC LIMIT 20"
        ),
        params![rule_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, rule_id = %rule_id, "rules: lecture des tests rétrospectifs");
        AppError::Database(e)
    })
}

pub async fn mark_backtest_running(db: &DbPool, id: Uuid) -> Result<(), AppError> {
    db.execute(
        "UPDATE core.rule_backtests SET status = 'running' WHERE id = $1",
        params![id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, backtest_id = %id, "rules: passage en cours d'un test rétrospectif");
        AppError::Database(e)
    })?;
    Ok(())
}

pub async fn finish_backtest(
    db: &DbPool,
    id: Uuid,
    report: &Value,
    error: Option<&str>,
) -> Result<(), AppError> {
    // The CASE re-reads the error, so it is bound a second time; the completion
    // timestamp is computed in Rust rather than with `NOW()`.
    db.execute(
        r#"UPDATE core.rule_backtests
              SET status = CASE WHEN $4 IS NULL THEN 'done' ELSE 'failed' END,
                  report = $2, error = $3, completed_at = $5
            WHERE id = $1"#,
        params![id, report.clone(), error, error, Utc::now()],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, backtest_id = %id, "rules: clôture d'un test rétrospectif");
        AppError::Database(e)
    })?;
    Ok(())
}
