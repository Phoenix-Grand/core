//! Reading, writing and caching detectors.
//!
//! ## Why there is a cache at all
//!
//! Compiling a regular expression costs microseconds to milliseconds. Doing it
//! per request would make the price of the feature proportional to traffic
//! rather than to configuration, and would put a pattern's compile cost on the
//! path of the user whose message is being checked. The compiled set is
//! therefore built once and replaced atomically, exactly like
//! [`super::super::index`] does for rules - and reloaded through the **same**
//! `LISTEN/NOTIFY` channel, so there is one refresh mechanism on the instance
//! rather than two that can disagree about which is stale.
//!
//! ## A detector that will not compile does not stop the others
//!
//! A build failure is logged and that detector is left out of the set. The
//! alternative - refusing to load anything - means one bad pattern disarms every
//! rule on the instance, which is the failure mode a data-protection control can
//! least afford. Validation at write time is what keeps this branch rare; it is
//! not what keeps it impossible, because a `regex` upgrade could in principle
//! reject something it used to accept.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};

use chrono::{DateTime, Utc};
use serde_json::Value;
use uuid::Uuid;

use kubuno_db::dialect::SqlType;
use kubuno_db::{params, DbPool, DbQueryBuilder, DbRow, DbTx, DbValue};

use crate::errors::AppError;

use super::checksum::Checksum;
use super::model::{Detector, Kind};
use super::scan::Compiled;

// ── Rows ─────────────────────────────────────────────────────────────────────

// A macro rather than a `const` so every statement below splices it with
// `concat!` and is a single compile-time literal.
macro_rules! columns {
    () => {
        r#"id, "key", label, description, category, kind, pattern, terms, checksum,
    proximity_terms, proximity_window, proximity_required,
    base_confidence, checksum_bonus, proximity_bonus,
    min_confidence, min_matches, min_unique_matches,
    is_enabled, is_builtin, created_at, updated_at"#
    };
}

/// The raw shape of a `core.content_detectors` row: the JSON list columns and
/// the enum-backed text columns are decoded plainly, then parsed into their
/// strong types.
#[derive(sqlx::FromRow)]
struct RawDetectorRow {
    id: Uuid,
    key: String,
    label: String,
    description: Option<String>,
    category: String,
    kind: String,
    pattern: Option<String>,
    terms: Value,
    checksum: Option<String>,
    proximity_terms: Value,
    proximity_window: i32,
    proximity_required: bool,
    base_confidence: f32,
    checksum_bonus: f32,
    proximity_bonus: f32,
    min_confidence: f32,
    min_matches: i32,
    min_unique_matches: i32,
    is_enabled: bool,
    is_builtin: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl RawDetectorRow {
    fn into_detector(self) -> Detector {
        Detector {
            id: self.id,
            key: self.key,
            label: self.label,
            description: self.description,
            category: self.category,
            // A row whose kind the binary does not know reads as a plain pattern
            // rather than failing the whole load. The CHECK constraint makes this
            // unreachable today; it stops being unreachable the day a downgrade
            // meets a newer schema.
            kind: Kind::parse(&self.kind).unwrap_or(Kind::Regex),
            pattern: self.pattern,
            terms: string_list(&self.terms),
            checksum: self.checksum.as_deref().and_then(Checksum::parse),
            proximity_terms: string_list(&self.proximity_terms),
            proximity_window: self.proximity_window,
            proximity_required: self.proximity_required,
            base_confidence: self.base_confidence,
            checksum_bonus: self.checksum_bonus,
            proximity_bonus: self.proximity_bonus,
            min_confidence: self.min_confidence,
            min_matches: self.min_matches,
            min_unique_matches: self.min_unique_matches,
            is_enabled: self.is_enabled,
            is_builtin: self.is_builtin,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// Hand-maps a detector row read inside a transaction (where `fetch_*_as` is not
/// available) by rebuilding [`RawDetectorRow`] column by column.
fn detector_from_row(r: &DbRow) -> Result<Detector, sqlx::Error> {
    Ok(RawDetectorRow {
        id: r.try_get("id")?,
        key: r.try_get("key")?,
        label: r.try_get("label")?,
        description: r.try_get("description")?,
        category: r.try_get("category")?,
        kind: r.try_get("kind")?,
        pattern: r.try_get("pattern")?,
        terms: r.try_get("terms")?,
        checksum: r.try_get("checksum")?,
        proximity_terms: r.try_get("proximity_terms")?,
        proximity_window: r.try_get("proximity_window")?,
        proximity_required: r.try_get("proximity_required")?,
        base_confidence: r.try_get("base_confidence")?,
        checksum_bonus: r.try_get("checksum_bonus")?,
        proximity_bonus: r.try_get("proximity_bonus")?,
        min_confidence: r.try_get("min_confidence")?,
        min_matches: r.try_get("min_matches")?,
        min_unique_matches: r.try_get("min_unique_matches")?,
        is_enabled: r.try_get("is_enabled")?,
        is_builtin: r.try_get("is_builtin")?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
    }
    .into_detector())
}

fn string_list(raw: &Value) -> Vec<String> {
    match raw {
        Value::Array(items) => items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

// ── Reads ────────────────────────────────────────────────────────────────────

pub async fn list(db: &DbPool) -> Result<Vec<Detector>, AppError> {
    let sql = concat!(
        "SELECT ",
        columns!(),
        " FROM core.content_detectors ORDER BY category, label"
    );
    let rows = db
        .fetch_all_as::<RawDetectorRow>(sql, params![])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "detectors: lecture du catalogue");
            AppError::Database(e)
        })?;
    Ok(rows.into_iter().map(RawDetectorRow::into_detector).collect())
}

pub async fn get(db: &DbPool, id: Uuid) -> Result<Detector, AppError> {
    let sql = concat!("SELECT ", columns!(), " FROM core.content_detectors WHERE id = $1");
    db.fetch_optional_as::<RawDetectorRow>(sql, params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "detectors: lecture d'un détecteur");
            AppError::Database(e)
        })?
        .map(RawDetectorRow::into_detector)
        .ok_or_else(|| AppError::NotFound("détecteur".into()))
}

pub async fn key_exists(db: &DbPool, key: &str, except: Option<Uuid>) -> Result<bool, AppError> {
    // Built dynamically so the "ignore this id" clause is present only when there
    // is an id to ignore - no `$2::uuid IS NULL` placeholder trick. The probe
    // selects a constant cast to a single decodable width.
    let mut qb = DbQueryBuilder::new(
        db.backend(),
        format!(
            "SELECT {} FROM core.content_detectors WHERE \"key\" = ",
            db.backend().cast("1", SqlType::BigInt)
        ),
    );
    qb.push_bind(key);
    if let Some(except) = except {
        qb.push(" AND id <> ").push_bind(except);
    }
    qb.push(" LIMIT 1");
    let found = qb
        .fetch_optional_scalar::<i64>(db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "detectors: vérification d'unicité de clé");
            AppError::Database(e)
        })?
        .is_some();
    Ok(found)
}

// ── Writes ───────────────────────────────────────────────────────────────────

/// A detector as it is about to be stored, already validated.
#[derive(Debug, Clone)]
pub struct DetectorDraft {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
    pub category: String,
    pub kind: Kind,
    pub pattern: Option<String>,
    pub terms: Vec<String>,
    pub checksum: Option<Checksum>,
    pub proximity_terms: Vec<String>,
    pub proximity_window: i32,
    pub proximity_required: bool,
    pub base_confidence: f32,
    pub checksum_bonus: f32,
    pub proximity_bonus: f32,
    pub min_confidence: f32,
    pub min_matches: i32,
    pub min_unique_matches: i32,
    pub is_enabled: bool,
}

/// The eighteen draft columns, in the order the INSERT and UPDATE both list them.
fn draft_values(d: &DetectorDraft) -> Vec<DbValue> {
    params![
        &d.key,
        &d.label,
        d.description.as_deref(),
        &d.category,
        d.kind.as_str(),
        d.pattern.as_deref(),
        Value::from(d.terms.clone()),
        d.checksum.map(|c| c.as_str()),
        Value::from(d.proximity_terms.clone()),
        d.proximity_window,
        d.proximity_required,
        d.base_confidence,
        d.checksum_bonus,
        d.proximity_bonus,
        d.min_confidence,
        d.min_matches,
        d.min_unique_matches,
        d.is_enabled
    ]
}

pub async fn insert(
    tx: &mut DbTx,
    draft: &DetectorDraft,
    author: Option<Uuid>,
) -> Result<Detector, AppError> {
    // The UUID primary key is generated in Rust so the write needs no RETURNING
    // and the row can be re-read by id afterwards.
    let id = kubuno_db::new_id();
    let mut values = vec![DbValue::from(id)];
    values.extend(draft_values(draft));
    values.push(DbValue::from(author));
    values.push(DbValue::from(author));

    tx.execute(
        r#"INSERT INTO core.content_detectors
               (id, "key", label, description, category, kind, pattern, terms, checksum,
                proximity_terms, proximity_window, proximity_required,
                base_confidence, checksum_bonus, proximity_bonus,
                min_confidence, min_matches, min_unique_matches,
                is_enabled, is_builtin, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,FALSE,$20,$21)"#,
        values,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, key = %draft.key, "detectors: création");
        AppError::Database(e)
    })?;

    reselect(tx, id).await
}

pub async fn update(
    tx: &mut DbTx,
    id: Uuid,
    draft: &DetectorDraft,
    author: Option<Uuid>,
) -> Result<Detector, AppError> {
    let mut values = draft_values(draft);
    values.push(DbValue::from(author));
    values.push(DbValue::from(id));

    let affected = tx
        .execute(
            r#"UPDATE core.content_detectors SET
                   "key" = $1, label = $2, description = $3, category = $4, kind = $5,
                   pattern = $6, terms = $7, checksum = $8,
                   proximity_terms = $9, proximity_window = $10, proximity_required = $11,
                   base_confidence = $12, checksum_bonus = $13, proximity_bonus = $14,
                   min_confidence = $15, min_matches = $16, min_unique_matches = $17,
                   is_enabled = $18, updated_by = $19
               WHERE id = $20"#,
            values,
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, %id, "detectors: modification");
            AppError::Database(e)
        })?;
    if affected == 0 {
        return Err(AppError::NotFound("détecteur".into()));
    }
    reselect(tx, id).await
}

/// Reads a detector back inside the write transaction and hand-maps it.
async fn reselect(tx: &mut DbTx, id: Uuid) -> Result<Detector, AppError> {
    let row = tx
        .fetch_optional_row(
            concat!("SELECT ", columns!(), " FROM core.content_detectors WHERE id = $1"),
            params![id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, %id, "detectors: relecture");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound("détecteur".into()))?;
    detector_from_row(&row).map_err(AppError::Database)
}

/// Deletes a detector. Built-ins are refused by the caller, not here.
pub async fn delete(tx: &mut DbTx, id: Uuid) -> Result<(), AppError> {
    tx.execute(
        "DELETE FROM core.content_detectors WHERE id = $1",
        params![id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, %id, "detectors: suppression");
        AppError::Database(e)
    })?;
    Ok(())
}

/// A single `name` column, so a one-column read can go through `fetch_all_as`.
#[derive(sqlx::FromRow)]
struct NameRow {
    name: String,
}

/// Which rules reference this detector, by name.
///
/// Asked before a deletion, so the console can say "three rules use this" rather
/// than leaving an operator to find out from a rule that quietly stopped
/// blocking. The condition tree is JSONB, so the question is a containment test
/// rather than a foreign key - a detector leaf can sit at any depth.
pub async fn rules_using(db: &DbPool, key: &str) -> Result<Vec<String>, AppError> {
    // The `%…%` pattern is built in Rust and bound. `CAST(conditions AS TEXT)`
    // reads the JSONB tree as text on PostgreSQL; the containment `LIKE` is a
    // heuristic, not a foreign key.
    let pattern = format!("%{key}%");
    let rows = db
        .fetch_all_as::<NameRow>(
            r#"SELECT name FROM core.rules
                WHERE CAST(conditions AS TEXT) LIKE $1
                ORDER BY name"#,
            params![pattern],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "detectors: recherche des règles utilisatrices");
            AppError::Database(e)
        })?;
    Ok(rows.into_iter().map(|r| r.name).collect())
}

// ── The compiled set ─────────────────────────────────────────────────────────

/// Every enabled detector, compiled, keyed by its catalogue key.
#[derive(Debug, Default)]
pub struct DetectorSet {
    by_key: HashMap<String, Arc<Compiled>>,
}

impl DetectorSet {
    pub fn get(&self, key: &str) -> Option<&Arc<Compiled>> {
        self.by_key.get(key)
    }

    pub fn len(&self) -> usize {
        self.by_key.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_key.is_empty()
    }
}

static SET: LazyLock<RwLock<Arc<DetectorSet>>> =
    LazyLock::new(|| RwLock::new(Arc::new(DetectorSet::default())));

/// The current set. One lock acquisition and an `Arc` clone.
pub fn snapshot() -> Arc<DetectorSet> {
    match SET.read() {
        Ok(guard) => Arc::clone(&guard),
        Err(poisoned) => {
            // Same reasoning as the rule index: serving a possibly stale value
            // beats propagating a panic into the gate, which would take the
            // portal down for every module at once.
            tracing::error!("detectors: verrou du jeu compilé empoisonné, lecture forcée");
            Arc::clone(&poisoned.into_inner())
        }
    }
}

/// Rebuilds the compiled set from the database. Called at startup and from the
/// rules reload listener.
pub async fn reload(db: &DbPool) -> Result<usize, AppError> {
    let detectors = list(db).await?;
    let mut by_key = HashMap::new();
    let mut skipped = 0usize;

    for d in detectors.into_iter().filter(|d| d.is_enabled) {
        let key = d.key.clone();
        match Compiled::build(d) {
            Ok(c) => {
                by_key.insert(key, Arc::new(c));
            }
            Err(e) => {
                skipped += 1;
                // Loud, and only about this one detector: one unbuildable
                // pattern must not disarm every rule on the instance.
                tracing::error!(error = %e, detector = %key,
                    "Détecteur ignoré : son motif ne compile pas");
            }
        }
    }

    let loaded = by_key.len();
    let set = Arc::new(DetectorSet { by_key });
    match SET.write() {
        Ok(mut guard) => *guard = set,
        Err(poisoned) => *poisoned.into_inner() = set,
    }
    if skipped > 0 {
        tracing::warn!(ignorés = skipped, chargés = loaded, "Détecteurs de contenu rechargés");
    }
    Ok(loaded)
}

// ── Settings ─────────────────────────────────────────────────────────────────

/// A string setting, trimmed, with a fallback. `core.settings.value` is JSONB,
/// so a value written as a bare string and one written as a JSON string both
/// have to read.
pub async fn setting_str(db: &DbPool, key: &str, default: &str) -> String {
    let raw: Option<Value> = db
        .fetch_optional_scalar::<Value>("SELECT value FROM core.settings WHERE \"key\" = $1", params![key])
        .await
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, key = %key, "detectors: lecture d'un réglage");
            None
        });

    raw.as_ref()
        .map(|v| match v {
            Value::String(s) => s.trim().to_string(),
            other => other.to_string(),
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

pub async fn setting_bool(db: &DbPool, key: &str, default: bool) -> bool {
    let raw: Option<Value> = db
        .fetch_optional_scalar::<Value>("SELECT value FROM core.settings WHERE \"key\" = $1", params![key])
        .await
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, key = %key, "detectors: lecture d'un réglage");
            None
        });
    raw.as_ref().and_then(Value::as_bool).unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_json_array_of_anything_else_reads_as_no_terms() {
        assert_eq!(string_list(&serde_json::json!(["a", "b"])), vec!["a", "b"]);
        // Numbers and nested objects are dropped rather than stringified: a
        // term that is not text is a term nobody typed.
        assert_eq!(string_list(&serde_json::json!(["a", 3, {}])), vec!["a"]);
        assert!(string_list(&serde_json::json!({})).is_empty());
        assert!(string_list(&Value::Null).is_empty());
    }

    #[test]
    fn an_empty_set_answers_none_rather_than_panicking() {
        let set = DetectorSet::default();
        assert!(set.get("core.iban").is_none());
        assert!(set.is_empty());
        assert_eq!(set.len(), 0);
    }
}
