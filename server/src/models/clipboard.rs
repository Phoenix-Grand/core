use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;
use validator::Validate;

/// One entry of a user's roaming clipboard history.
///
/// `payload` is the cross-module JSON envelope the producing module copied, so
/// the frontend renders history entries through the very same `core.data-card`
/// renderers it uses when pasting.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ClipboardItem {
    pub id:         Uuid,
    pub module:     String,
    pub kind:       String,
    pub title:      Option<String>,
    pub preview:    Option<String>,
    pub payload:    serde_json::Value,
    pub href:       Option<String>,
    pub pinned:     bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Push a clip. The server computes the fingerprint (dedup) and enforces the
/// size cap - a client is never trusted with either.
#[derive(Debug, Deserialize, Validate)]
pub struct PushClipboardDto {
    #[validate(length(min = 1, max = 100, message = "Module: 1-100 characters"))]
    pub module:  String,
    #[validate(length(min = 1, max = 100, message = "Type: 1-100 characters"))]
    pub kind:    String,
    #[validate(length(max = 500))]
    pub title:   Option<String>,
    /// Human-readable summary; truncated server-side rather than rejected, so a
    /// long copy never fails for a cosmetic reason.
    pub preview: Option<String>,
    pub payload: serde_json::Value,
    #[validate(length(max = 1000))]
    pub href:    Option<String>,
    /// Pin the entry right away (rare; the pane's pin button is the usual path).
    pub pinned:  Option<bool>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct UpdateClipboardDto {
    pub pinned: Option<bool>,
}
