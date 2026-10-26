//! Reading the trail: filters, keyset pagination and CSV export.
//!
//! Pagination is **keyset**, never `OFFSET`. The trail grows while it is being
//! read - a busy instance writes entries between two pages - and an offset would
//! then shift every subsequent page, showing some rows twice and skipping
//! others. The cursor is the `(occurred_at, id)` pair of the last row returned,
//! and `id` breaks the tie for entries sharing a timestamp, which happens
//! routinely when one request writes several entries.

use base64::Engine as _;
use chrono::{DateTime, Utc};
use kubuno_db::{params, Backend, DbPool, DbQueryBuilder};
use serde::Deserialize;

use super::model::AuditRow;
use crate::errors::AppError;

/// Page size ceiling. The screen paints a dense table; beyond this the payload
/// costs more than it shows.
pub const MAX_LIMIT: i64 = 200;
pub const DEFAULT_LIMIT: i64 = 50;

/// Rows streamed per database round-trip during a CSV export.
pub const EXPORT_CHUNK: i64 = 500;

/// Opaque position in the descending `(occurred_at, id)` ordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub occurred_at: DateTime<Utc>,
    pub id: i64,
}

impl Cursor {
    /// `<rfc3339 with nanoseconds>|<id>`, base64url without padding. Encoded so
    /// clients treat it as opaque and do not start arithmetic on it.
    pub fn encode(&self) -> String {
        let raw = format!("{}|{}", self.occurred_at.to_rfc3339(), self.id);
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
    }

    pub fn decode(encoded: &str) -> Option<Self> {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded.trim())
            .ok()?;
        let text = String::from_utf8(bytes).ok()?;
        let (at, id) = text.rsplit_once('|')?;
        Some(Self {
            occurred_at: DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&Utc),
            id: id.parse().ok()?,
        })
    }
}

/// Query string of `GET /admin/audit`.
///
/// Unknown parameters are REFUSED rather than ignored. Silently dropping a
/// filter it does not know makes the endpoint answer with the whole journal, and
/// an administrator reading `?result=error` has no way to tell an unfiltered
/// answer from a journal that really holds no failure.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditQuery {
    pub actor_id: Option<uuid::Uuid>,
    /// Exact action, or a prefix: `core.users` matches `core.users.*`.
    pub action: Option<String>,
    pub target_type: Option<String>,
    pub outcome: Option<String>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    /// Free-text over actor label, target label and action.
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

// A macro rather than a `const` so call sites splice it with `concat!` and hand
// the driver one `&'static str` literal: no part of this query text exists
// before compile time, and every filter below travels as a bind parameter.
//
// The `ip_address` column is `inet` on PostgreSQL (read back through
// `host(ip_address)::text`) and plain text elsewhere. It is therefore NOT part
// of this fixed column list: each call site appends `{Backend::inet_text} AS
// ip_address`, so the accessor is spelled for the running engine. `AuditRow`
// decodes by name, so appending the column last is harmless.
macro_rules! select_columns {
    () => {
        r#"
    id, occurred_at, actor_id, actor_label, actor_role, actor_origin, actor_token_id,
    user_agent,
    action, module_id, target_type, target_id, target_label,
    "before", "after", outcome, detail,
    reversible, reverts_entry_id, reverted_by_entry_id
"#
    };
}

/// One page plus the cursor to the next one (`None` when the end is reached).
pub struct Page {
    pub rows: Vec<AuditRow>,
    pub next_cursor: Option<String>,
}

/// Fetches one page. `limit` is clamped to [`MAX_LIMIT`].
pub async fn list(db: &DbPool, q: &AuditQuery) -> Result<Page, AppError> {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let cursor = q.cursor.as_deref().and_then(Cursor::decode);

    // The former fixed statement with `$n::type IS NULL OR …` guards becomes a
    // builder that only appends the filters the caller supplied. Free-text search
    // uses `dialect::ilike`, inlined so the builder can number each bind; the
    // keyset comparison `(occurred_at, id) < (…)` is expanded to its portable form.
    let backend = db.backend();
    let mut qb = DbQueryBuilder::new(
        backend,
        format!(
            "SELECT {cols}, {ip} AS ip_address FROM core.admin_audit",
            cols = select_columns!().trim(),
            ip = backend.inet_text("ip_address"),
        ),
    );
    qb.push(" WHERE 1 = 1");
    if let Some(actor) = q.actor_id {
        qb.push(" AND actor_id = ").push_bind(actor);
    }
    if let Some(action) = q.action.as_deref().filter(|s| !s.is_empty()) {
        // Exact action, or a prefix match `action.*`.
        qb.push(" AND (action = ")
            .push_bind(action)
            .push(" OR action LIKE ")
            .push_bind(format!("{action}.%"))
            .push(")");
    }
    if let Some(tt) = q.target_type.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND target_type = ").push_bind(tt);
    }
    if let Some(outcome) = q.outcome.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND outcome = ").push_bind(outcome);
    }
    if let Some(from) = q.from {
        qb.push(" AND occurred_at >= ").push_bind(from);
    }
    if let Some(to) = q.to {
        qb.push(" AND occurred_at <= ").push_bind(to);
    }
    if let Some(text) = q.q.as_deref().filter(|s| !s.is_empty()) {
        let pat = format!("%{text}%");
        qb.push(" AND (");
        for (i, col) in ["actor_label", "target_label", "action"].iter().enumerate() {
            if i > 0 {
                qb.push(" OR ");
            }
            match backend {
                Backend::Postgres => {
                    qb.push(*col).push(" ILIKE ").push_bind(pat.clone());
                }
                _ => {
                    qb.push("LOWER(")
                        .push(*col)
                        .push(") LIKE LOWER(")
                        .push_bind(pat.clone())
                        .push(")");
                }
            }
        }
        qb.push(")");
    }
    if let Some(c) = cursor {
        qb.push(" AND (occurred_at < ")
            .push_bind(c.occurred_at)
            .push(" OR (occurred_at = ")
            .push_bind(c.occurred_at)
            .push(" AND id < ")
            .push_bind(c.id)
            .push("))");
    }
    qb.push_order_by("occurred_at DESC, id DESC");
    // One extra row tells us whether a next page exists without a COUNT.
    qb.push(" LIMIT ").push_bind(limit + 1);

    let rows: Vec<AuditRow> = qb.fetch_all_as::<AuditRow>(db).await.map_err(|e| {
        tracing::error!(error = %e, "audit: lecture de la page");
        AppError::Database(e)
    })?;

    let has_more = rows.len() as i64 > limit;
    let mut mapped: Vec<AuditRow> = rows.into_iter().take(limit as usize).collect();

    let next_cursor = if has_more {
        mapped.last().map(|r| {
            Cursor { occurred_at: r.occurred_at, id: r.id }.encode()
        })
    } else {
        None
    };

    // Defensive: never hand back a page whose last row is missing.
    mapped.shrink_to_fit();
    Ok(Page { rows: mapped, next_cursor })
}

/// Fetches a single entry.
pub async fn get(db: &DbPool, id: i64) -> Result<AuditRow, AppError> {
    let sql = format!(
        "SELECT {cols}, {ip} AS ip_address FROM core.admin_audit WHERE id = $1",
        cols = select_columns!().trim(),
        ip = db.backend().inet_text("ip_address"),
    );
    db.fetch_optional_as::<AuditRow>(&sql, params![id])
        .await
        .map_err(|e| {
            tracing::error!(error = %e, entry_id = id, "audit: lecture de l'entrée");
            AppError::Database(e)
        })?
        .ok_or_else(|| AppError::NotFound(format!("Audit entry {id}")))
}

/// Escapes one CSV field (RFC 4180) and neutralises spreadsheet formula
/// injection: a field starting with `=`, `+`, `-` or `@` is prefixed with a
/// quote so a `=HYPERLINK(...)` crafted into a display name cannot execute when
/// the export is opened.
pub fn csv_field(value: &str) -> String {
    let sanitised = match value.chars().next() {
        Some('=' | '+' | '-' | '@') => format!("'{value}"),
        _ => value.to_string(),
    };
    if sanitised.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", sanitised.replace('"', "\"\""))
    } else {
        sanitised
    }
}

pub const CSV_HEADER: &str = "occurred_at,actor_label,actor_role,actor_origin,ip_address,action,module_id,target_type,target_id,target_label,outcome,detail\n";

/// Renders one row as a CSV line.
pub fn csv_line(r: &AuditRow) -> String {
    let f = |v: Option<&str>| csv_field(v.unwrap_or(""));
    format!(
        "{},{},{},{},{},{},{},{},{},{},{},{}\n",
        csv_field(&r.occurred_at.to_rfc3339()),
        csv_field(&r.actor_label),
        f(r.actor_role.as_deref()),
        csv_field(&r.actor_origin),
        f(r.ip_address.as_deref()),
        csv_field(&r.action),
        f(r.module_id.as_deref()),
        f(r.target_type.as_deref()),
        f(r.target_id.as_deref()),
        f(r.target_label.as_deref()),
        csv_field(&r.outcome),
        f(r.detail.as_deref()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s)
            .expect("horodatage de test valide")
            .with_timezone(&Utc)
    }

    #[test]
    fn cursor_round_trips() {
        let c = Cursor { occurred_at: at("2026-08-03T10:11:12.123456Z"), id: 4242 };
        let decoded = Cursor::decode(&c.encode()).expect("curseur décodable");
        assert_eq!(decoded.id, c.id);
        assert_eq!(decoded.occurred_at, c.occurred_at);
    }

    #[test]
    fn cursor_is_opaque_not_a_plain_integer() {
        let c = Cursor { occurred_at: Utc.timestamp_opt(0, 0).single().unwrap_or_default(), id: 7 };
        let encoded = c.encode();
        assert!(encoded.parse::<i64>().is_err());
        assert!(!encoded.contains('|'));
    }

    #[test]
    fn malformed_cursors_are_rejected_not_panicked_on() {
        assert!(Cursor::decode("").is_none());
        assert!(Cursor::decode("not-base64!!!").is_none());
        // Valid base64, meaningless payload.
        let junk = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("hello");
        assert!(Cursor::decode(&junk).is_none());
        let no_id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("2026-08-03T00:00:00Z|abc");
        assert!(Cursor::decode(&no_id).is_none());
    }

    #[test]
    fn cursor_ordering_is_strict_so_a_page_never_repeats_its_boundary() {
        // Two entries written by the same request share a timestamp; the id must
        // break the tie, otherwise the boundary row comes back on the next page.
        let same = at("2026-08-03T10:00:00Z");
        let a = Cursor { occurred_at: same, id: 10 };
        let b = Cursor { occurred_at: same, id: 9 };
        assert_ne!(a.encode(), b.encode());
        assert!((b.occurred_at, b.id) < (a.occurred_at, a.id));
    }

    #[test]
    fn cursor_survives_sub_second_precision() {
        // Truncating to whole seconds would make two entries in the same second
        // indistinguishable and re-serve rows.
        let a = Cursor { occurred_at: at("2026-08-03T10:00:00.000001Z"), id: 1 };
        let b = Cursor { occurred_at: at("2026-08-03T10:00:00.000002Z"), id: 1 };
        let da = Cursor::decode(&a.encode()).expect("a");
        let db = Cursor::decode(&b.encode()).expect("b");
        assert!(da.occurred_at < db.occurred_at);
    }

    #[test]
    fn csv_escapes_quotes_and_separators() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("line\nbreak"), "\"line\nbreak\"");
    }

    #[test]
    fn csv_neutralises_formula_injection() {
        assert_eq!(csv_field("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
        assert!(csv_field("+1").starts_with('\''));
        assert!(csv_field("@SUM(A1)").starts_with('\''));
        assert!(csv_field("-2").starts_with('\''));
    }

    #[test]
    fn csv_header_and_line_have_the_same_arity() {
        let row = AuditRow {
            id: 1,
            occurred_at: at("2026-08-03T10:00:00Z"),
            actor_id: None,
            actor_label: "alice <a@b.c>".into(),
            actor_role: Some("admin".into()),
            actor_origin: "session".into(),
            actor_token_id: None,
            ip_address: Some("127.0.0.1".into()),
            user_agent: None,
            action: "core.users.update".into(),
            module_id: Some("core".into()),
            target_type: Some("user".into()),
            target_id: Some("42".into()),
            target_label: Some("bob".into()),
            before: None,
            after: None,
            outcome: "success".into(),
            detail: None,
            reversible: true,
            reverts_entry_id: None,
            reverted_by_entry_id: None,
        };
        let header_cols = CSV_HEADER.trim_end().split(',').count();
        let line = csv_line(&row);
        assert_eq!(line.trim_end().split(',').count(), header_cols);
    }
}
