//! Admin API over the administrative audit trail.
//!
//! Read-only by design: nothing here writes an entry, and there is no delete
//! route. Retention (`crate::audit::retention`) is the only thing that removes
//! rows, and it removes them by age alone - a trail an administrator can prune
//! selectively is not a trail.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::stream;
use kubuno_db::params;
use serde_json::json;

use crate::{
    authz::{keys, AdminCtx},
    audit::{
        query::{self, AuditQuery, Cursor},
        redact, AdminAudit,
    },
    auth::middleware::AdminUser,
    errors::AppError,
    state::AppState,
};

/// `GET /api/v1/admin/audit` - one page of the trail, newest first.
///
/// Pagination is by cursor (`occurred_at` + `id`), never by offset: entries are
/// written while the operator reads, and an offset would shift every page under
/// them.
pub async fn list_audit(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Query(q): Query<AuditQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::AUDIT_READ)?;
    let page = query::list(&state.db, &q).await?;
    Ok(Json(json!({
        "entries":     page.rows,
        "next_cursor": page.next_cursor,
    })))
}

/// `GET /api/v1/admin/audit/verify` - recompute the tamper-evidence hash chain.
///
/// Returns how many chained rows were checked and, if the chain is broken, the id
/// of the first offending row and a short reason (`content` = a row was edited,
/// `link` = a row was reordered or one before it removed).
pub async fn verify_audit(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::AUDIT_READ)?;
    let report = crate::audit::chain::verify_chain(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "audit: vérification de la chaîne impossible");
            AppError::Database(e)
        })?;
    Ok(Json(json!({ "report": report })))
}

/// `GET /api/v1/admin/audit/:id` - one entry plus its field-by-field diff.
pub async fn get_audit_entry(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::AUDIT_READ)?;
    let row = query::get(&state.db, id).await?;
    let diff = redact::diff(row.before.as_ref(), row.after.as_ref());
    Ok(Json(json!({ "entry": row, "diff": diff })))
}

/// `GET /api/v1/admin/audit/facets` - distinct values for the filter selects.
///
/// Bounded lists (a few dozen action names at most), so this stays cheap; it
/// saves the screen from hard-coding a catalogue that would drift the moment a
/// module adds an action.
pub async fn audit_facets(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::AUDIT_READ)?;
    // Single-column reads go through a one-field tuple: the pool has no
    // `fetch_all` for a bare scalar, only `fetch_all_as` over a `FromRow` type.
    let actions: Vec<String> = state
        .db
        .fetch_all_as::<(String,)>(
            "SELECT DISTINCT action FROM core.admin_audit ORDER BY action LIMIT 200",
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "audit_facets: actions"); AppError::Database(e) })?
        .into_iter()
        .map(|(a,)| a)
        .collect();

    let target_types: Vec<String> = state
        .db
        .fetch_all_as::<(String,)>(
            "SELECT DISTINCT target_type FROM core.admin_audit WHERE target_type IS NOT NULL ORDER BY 1 LIMIT 100",
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "audit_facets: cibles"); AppError::Database(e) })?
        .into_iter()
        .map(|(t,)| t)
        .collect();

    let actors: Vec<(uuid::Uuid, String)> = state
        .db
        .fetch_all_as::<(uuid::Uuid, String)>(
            r#"SELECT DISTINCT actor_id, actor_label FROM core.admin_audit
               WHERE actor_id IS NOT NULL ORDER BY actor_label LIMIT 200"#,
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "audit_facets: acteurs"); AppError::Database(e) })?;

    Ok(Json(json!({
        "actions":      actions,
        "target_types": target_types,
        "actors":       actors.into_iter()
            .map(|(id, label)| json!({ "id": id, "label": label }))
            .collect::<Vec<_>>(),
        "outcomes":     ["success", "denied", "error"],
    })))
}

/// `GET /api/v1/admin/audit/export` - the filtered trail as a CSV stream.
///
/// Streamed in chunks rather than materialised: an export of a year of activity
/// must not have to fit in memory, on either side of the wire. The export is
/// itself audited - reading the whole trail is an act worth recording.
pub async fn export_audit_csv(
    State(state): State<AppState>,
    audit: AdminAudit,
    ctx: AdminCtx,
    Query(q): Query<AuditQuery>,
) -> Result<Response, AppError> {
    ctx.require(keys::AUDIT_READ)?;
    audit
        .record(
            &state.db,
            crate::audit::AuditEntry::new("core.audit.export")
                .module("core")
                .target_kind("audit", "Journal d'audit")
                .after(json!({
                    "actor_id":    q.actor_id,
                    "action":      q.action,
                    "target_type": q.target_type,
                    "outcome":     q.outcome,
                    "from":        q.from,
                    "to":          q.to,
                })),
        )
        .await;

    let db = state.db.clone();
    // Each step fetches one chunk positioned by the previous chunk's cursor, so
    // memory stays flat whatever the trail's size.
    let initial = (db, q, Some(String::new()), true);

    let body_stream = stream::unfold(initial, |(db, mut q, cursor, first)| async move {
        let cursor = cursor?;
        let mut page_query = AuditQuery {
            actor_id: q.actor_id,
            action: q.action.clone(),
            target_type: q.target_type.clone(),
            outcome: q.outcome.clone(),
            from: q.from,
            to: q.to,
            q: q.q.clone(),
            limit: Some(query::EXPORT_CHUNK),
            cursor: if cursor.is_empty() { None } else { Some(cursor) },
        };
        // Keep the caller's own cursor for the very first chunk.
        if first {
            page_query.cursor = q.cursor.take();
        }

        let page = match query::list(&db, &page_query).await {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(error = %e, "audit: export CSV interrompu");
                return None;
            }
        };

        let mut chunk = String::new();
        if first {
            chunk.push_str(query::CSV_HEADER);
        }
        for row in &page.rows {
            chunk.push_str(&query::csv_line(row));
        }

        let next = page.next_cursor;
        if chunk.is_empty() {
            return None;
        }
        Some((
            Ok::<_, std::io::Error>(bytes::Bytes::from(chunk)),
            (db, q, next, false),
        ))
    });

    let filename = format!(
        "kubuno-audit-{}.csv",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        Body::from_stream(body_stream),
    )
        .into_response())
}

/// `GET /api/v1/admin/audit/retention` - current window and the floor, so the
/// screen can explain why a lower value is refused.
pub async fn audit_retention(
    State(state): State<AppState>,
    _admin: AdminUser,
    ctx: AdminCtx,
) -> Result<Json<serde_json::Value>, AppError> {
    ctx.require(keys::AUDIT_READ)?;
    let days = crate::audit::retention::configured_days(&state.db).await;
    let backend = state.db.backend();
    let total: i64 = state
        .db
        .fetch_scalar::<i64>(
            &format!("SELECT {} FROM core.admin_audit", backend.count_bigint("*")),
            params![],
        )
        .await
        .map_err(|e| { tracing::error!(error = %e, "audit_retention: comptage"); AppError::Database(e) })?;

    Ok(Json(json!({
        "retention_days": days,
        "min_days":       crate::audit::retention::MIN_RETENTION_DAYS,
        "entries":        total,
    })))
}

/// Decoding helper exposed for the tests of the route layer.
pub fn decode_cursor(raw: &str) -> Option<Cursor> {
    Cursor::decode(raw)
}
