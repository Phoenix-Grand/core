//! Roaming CLIPBOARD HISTORY - the last things a user copied, whatever the
//! module, kept server-side.
//!
//! The browser clipboard holds one item, is not shared between tabs and is lost
//! on reload; the modules' own slots (the spreadsheet's object clipboard, an
//! editor's cell buffer) are process-local too. This service keeps the recent
//! clips as the same cross-module JSON envelopes `core.data-card` renders, so
//! any module - on any tab, on any device - can paste them back.
//!
//! Rules enforced here, never trusted to the client:
//!   • strictly per user (no sharing, no lookup by id across users);
//!   • payload capped (`MAX_PAYLOAD_BYTES`) so the content blob cannot be used
//!     as free storage;
//!   • deduplicated by SHA-256 fingerprint: re-copying the same thing bumps the
//!     existing row to the top instead of adding a twin;
//!   • trimmed to `MAX_ITEMS` unpinned entries per user after each push.
//!
//! Payloads are NEVER logged: an error mentions the item id, never its content.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use kubuno_db::{dialect::Assign, new_id, params};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use validator::Validate;

use crate::{
    auth::middleware::AuthUser,
    errors::AppError,
    models::clipboard::{ClipboardItem, PushClipboardDto, UpdateClipboardDto},
    state::AppState,
};

/// Biggest payload accepted, in bytes of serialized JSON. Comfortably above a
/// spreadsheet shape or a maps route, far below an embedded picture.
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;
/// How many UNPINNED entries a user keeps. Pinned ones are never trimmed.
const MAX_ITEMS: i64 = 30;
/// Longest stored summary; longer previews are truncated, not rejected.
const MAX_PREVIEW_CHARS: usize = 2000;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>,
}

/// Hex SHA-256 of the canonical payload - the dedup key.
fn fingerprint(payload: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Cut a preview to `MAX_PREVIEW_CHARS` on a char boundary.
fn truncate_preview(preview: Option<String>) -> Option<String> {
    preview.map(|p| {
        if p.chars().count() <= MAX_PREVIEW_CHARS {
            p
        } else {
            p.chars().take(MAX_PREVIEW_CHARS).collect()
        }
    })
}

/// GET /api/v1/clipboard?limit=
///
/// The user's own history, pinned entries first, then most recent.
pub async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = q.limit.unwrap_or(MAX_ITEMS).clamp(1, 100);
    let items = state
        .db
        .fetch_all_as::<ClipboardItem>(
            r#"SELECT id, module, kind, title, preview, payload, href, pinned, created_at, updated_at
                 FROM core.clipboard_items
                WHERE owner_id = $1
                ORDER BY pinned DESC, created_at DESC
                LIMIT $2"#,
            params![user.id, limit],
        )
        .await
        .map_err(|e| {
            tracing::error!("clipboard: lecture de l'historique échouée: {e}");
            e
        })?;

    Ok(Json(json!({ "items": items })))
}

/// POST /api/v1/clipboard
///
/// Push a clip. Re-copying the same content bumps the existing row (its
/// `created_at` moves to now) rather than creating a duplicate.
pub async fn push(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(dto): Json<PushClipboardDto>,
) -> Result<Json<Value>, AppError> {
    dto.validate().map_err(|e| AppError::Validation(e.to_string()))?;

    let payload_size = dto.payload.to_string().len();
    if payload_size > MAX_PAYLOAD_BYTES {
        return Err(AppError::Validation(format!(
            "Contenu trop volumineux pour l'historique du presse-papiers ({} Ko, maximum {} Ko)",
            payload_size / 1024,
            MAX_PAYLOAD_BYTES / 1024
        )));
    }
    if dto.payload.is_null() {
        return Err(AppError::Validation("Contenu vide".into()));
    }

    let fp = fingerprint(&dto.payload);
    let preview = truncate_preview(dto.preview);

    let mut tx = state.db.begin().await?;

    // No RETURNING inside a tx (a DbTx cannot read a struct): the row is written
    // here and read back by its dedup key once the transaction commits. The id is
    // generated in Rust; on conflict the stored id is kept, so the reselect keys
    // on (owner_id, fingerprint) rather than that generated id.
    let backend = tx.backend();
    let clause = backend.upsert(
        "core.clipboard_items",
        &["owner_id", "fingerprint"],
        &[
            Assign::Incoming("created_at"),
            Assign::Incoming("title"),
            Assign::Incoming("preview"),
            Assign::Incoming("href"),
            Assign::Incoming("module"),
            Assign::Incoming("kind"),
        ],
    );
    let insert_sql = format!(
        "INSERT INTO core.clipboard_items \
              (id, owner_id, module, kind, title, preview, payload, href, pinned, fingerprint, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, FALSE), $10, $11){clause}"
    );
    let now = chrono::Utc::now();
    tx.execute(
        &insert_sql,
        params![
            new_id(),
            user.id,
            dto.module,
            dto.kind,
            dto.title,
            preview,
            dto.payload,
            dto.href,
            dto.pinned,
            fp.clone(),
            now
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!("clipboard: enregistrement d'un élément échoué: {e}");
        e
    })?;

    // Trim: keep the newest MAX_ITEMS unpinned entries of this user.
    // `owner_id` is matched in both the outer and the inner query; the value is
    // bound twice because a positional placeholder is never reused across engines.
    // The kept set is a derived table (`kept`): MySQL/MariaDB reject `LIMIT`
    // directly inside `IN (...)` and a subquery on the table being deleted from.
    tx.execute(
        r#"DELETE FROM core.clipboard_items
            WHERE owner_id = $1 AND pinned = FALSE
              AND id NOT IN (
                    SELECT id FROM (
                        SELECT id FROM core.clipboard_items
                         WHERE owner_id = $2 AND pinned = FALSE
                         ORDER BY created_at DESC
                         LIMIT $3) kept)"#,
        params![user.id, user.id, MAX_ITEMS],
    )
    .await
    .map_err(|e| {
        tracing::error!("clipboard: purge de l'historique échouée: {e}");
        e
    })?;

    tx.commit().await?;

    let item = state
        .db
        .fetch_one_as::<ClipboardItem>(
            r#"SELECT id, module, kind, title, preview, payload, href, pinned, created_at, updated_at
                 FROM core.clipboard_items
                WHERE owner_id = $1 AND fingerprint = $2"#,
            params![user.id, fp],
        )
        .await
        .map_err(|e| {
            tracing::error!("clipboard: relecture d'un élément échouée: {e}");
            e
        })?;
    Ok(Json(json!({ "item": item })))
}

/// PATCH /api/v1/clipboard/:id - pin / unpin.
pub async fn update(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(dto): Json<UpdateClipboardDto>,
) -> Result<Json<Value>, AppError> {
    dto.validate().map_err(|e| AppError::Validation(e.to_string()))?;
    let Some(pinned) = dto.pinned else {
        return Err(AppError::Validation("Rien à modifier".into()));
    };

    // No RETURNING on the update (MySQL has none): flip the pin on the identity
    // guard, and only reselect the row when this call actually matched one - a
    // missing row and someone else's are the same 404, no existence leak.
    let affected = state
        .db
        .execute(
            "UPDATE core.clipboard_items SET pinned = $1 WHERE id = $2 AND owner_id = $3",
            params![pinned, id, user.id],
        )
        .await
        .map_err(|e| {
            tracing::error!("clipboard: épinglage de {id} échoué: {e}");
            e
        })?;
    if affected == 0 {
        return Err(AppError::NotFound("Élément introuvable".into()));
    }

    let item = state
        .db
        .fetch_one_as::<ClipboardItem>(
            r#"SELECT id, module, kind, title, preview, payload, href, pinned, created_at, updated_at
                 FROM core.clipboard_items WHERE id = $1 AND owner_id = $2"#,
            params![id, user.id],
        )
        .await
        .map_err(|e| {
            tracing::error!("clipboard: relecture de {id} échouée: {e}");
            e
        })?;

    Ok(Json(json!({ "item": item })))
}

/// DELETE /api/v1/clipboard/:id
pub async fn delete(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let done = state
        .db
        .execute(
            "DELETE FROM core.clipboard_items WHERE id = $1 AND owner_id = $2",
            params![id, user.id],
        )
        .await
        .map_err(|e| {
            tracing::error!("clipboard: suppression de {id} échouée: {e}");
            e
        })?;
    if done == 0 {
        return Err(AppError::NotFound("Élément introuvable".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/v1/clipboard - clear the history, keeping pinned entries.
pub async fn clear(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, AppError> {
    let done = state
        .db
        .execute(
            "DELETE FROM core.clipboard_items WHERE owner_id = $1 AND pinned = FALSE",
            params![user.id],
        )
        .await
        .map_err(|e| {
            tracing::error!("clipboard: vidage de l'historique échoué: {e}");
            e
        })?;
    Ok(Json(json!({ "deleted": done })))
}
