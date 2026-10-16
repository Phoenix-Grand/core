//! User-facing endpoints to register push devices and tune preferences.

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use kubuno_db::{dialect::Assign, new_id, params};

use crate::{auth::middleware::AuthUser, errors::AppError, state::AppState};

#[derive(Deserialize)]
pub struct RegisterDeviceDto {
    pub provider:     String, // 'unifiedpush' | 'apns' | 'fcm'
    pub device_token: String, // endpoint URL (unifiedpush) or push token
    pub app_id:       Option<String>,
    pub locale:       Option<String>,
}

/// POST /api/v1/me/push/devices - register (or refresh) a device.
pub async fn register_device(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(dto): Json<RegisterDeviceDto>,
) -> Result<Json<Value>, AppError> {
    if !matches!(dto.provider.as_str(), "unifiedpush" | "apns" | "fcm") {
        return Err(AppError::Validation("provider inconnu".into()));
    }
    if dto.device_token.trim().is_empty() {
        return Err(AppError::Validation("device_token requis".into()));
    }

    // Re-registering the same (provider, token) re-binds it to this user.
    let backend = state.db.backend();
    let clause = backend.upsert(
        "core.push_devices",
        &["provider", "device_token"],
        &[
            Assign::Incoming("user_id"),
            Assign::Incoming("app_id"),
            Assign::Incoming("locale"),
            Assign::Incoming("last_seen_at"),
        ],
    );
    let sql = format!(
        "INSERT INTO core.push_devices \
             (id, user_id, provider, device_token, app_id, locale, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7){clause}"
    );
    let now = chrono::Utc::now();
    state
        .db
        .execute(
            &sql,
            params![
                new_id(),
                user.id,
                &dto.provider,
                &dto.device_token,
                dto.app_id.as_deref(),
                dto.locale.as_deref(),
                now
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "register_device");
            AppError::Database(e)
        })?;

    // Read the row's id back: on conflict the stored id was kept, not the one
    // we tried to insert, so a reselect on the unique key is authoritative.
    let id: uuid::Uuid = state
        .db
        .fetch_scalar::<uuid::Uuid>(
            "SELECT id FROM core.push_devices WHERE provider = $1 AND device_token = $2",
            params![&dto.provider, &dto.device_token],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "register_device");
            AppError::Database(e)
        })?;

    Ok(Json(json!({ "id": id })))
}

/// DELETE /api/v1/me/push/devices/:id - unregister a device.
pub async fn delete_device(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(device_id): Path<uuid::Uuid>,
) -> Result<Json<Value>, AppError> {
    let affected = state
        .db
        .execute(
            "DELETE FROM core.push_devices WHERE id = $1 AND user_id = $2",
            params![device_id, user.id],
        )
        .await?;

    if affected == 0 {
        return Err(AppError::NotFound("Device introuvable".into()));
    }
    Ok(Json(json!({ "message": "Device supprimé" })))
}

/// GET /api/v1/me/push/preferences - list opt-out preferences.
pub async fn list_preferences(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, AppError> {
    let rows = state
        .db
        .fetch_all_as::<(String, String, bool)>(
            "SELECT module_id, event_type, enabled FROM core.push_preferences WHERE user_id = $1",
            params![user.id],
        )
        .await?;

    let prefs: Vec<Value> = rows
        .into_iter()
        .map(|(module_id, event_type, enabled)| json!({
            "module_id": module_id, "event_type": event_type, "enabled": enabled,
        }))
        .collect();
    Ok(Json(json!({ "preferences": prefs })))
}

#[derive(Deserialize)]
pub struct SetPreferenceDto {
    pub module_id:  Option<String>,
    pub event_type: Option<String>,
    pub enabled:    bool,
}

/// PATCH /api/v1/me/push/preferences - upsert one preference.
pub async fn set_preference(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(dto): Json<SetPreferenceDto>,
) -> Result<Json<Value>, AppError> {
    let module_id = dto.module_id.unwrap_or_else(|| "*".into());
    let event_type = dto.event_type.unwrap_or_else(|| "*".into());

    let backend = state.db.backend();
    let clause = backend.upsert(
        "core.push_preferences",
        &["user_id", "module_id", "event_type"],
        &[Assign::Incoming("enabled")],
    );
    let sql = format!(
        "INSERT INTO core.push_preferences (user_id, module_id, event_type, enabled) \
         VALUES ($1, $2, $3, $4){clause}"
    );
    state
        .db
        .execute(&sql, params![user.id, &module_id, &event_type, dto.enabled])
        .await?;

    Ok(Json(json!({ "message": "Préférence enregistrée" })))
}
