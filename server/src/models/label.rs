use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;
use validator::Validate;

/// A user-owned, cross-module label.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Label {
    pub id:          Uuid,
    pub owner_id:    Uuid,
    pub name:        String,
    pub color:       String,
    pub description: Option<String>,
    pub created_at:  DateTime<Utc>,
    pub updated_at:  DateTime<Utc>,
}

/// A link between a label and an element of any module. `envelope` holds the
/// full cross-module JSON envelope so the browser can render a rich card.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct LabelLink {
    pub id:            Uuid,
    pub label_id:      Uuid,
    pub module:        String,
    pub resource_type: String,
    pub resource_id:   String,
    pub title:         Option<String>,
    pub href:          Option<String>,
    pub envelope:      Option<serde_json::Value>,
    pub created_at:    DateTime<Utc>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct CreateLabelDto {
    #[validate(length(min = 1, max = 100, message = "Name: 1-100 characters"))]
    pub name:        String,
    #[validate(length(max = 20))]
    pub color:       Option<String>,
    #[validate(length(max = 2000))]
    pub description: Option<String>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct UpdateLabelDto {
    #[validate(length(min = 1, max = 100, message = "Name: 1-100 characters"))]
    pub name:        Option<String>,
    #[validate(length(max = 20))]
    pub color:       Option<String>,
    #[validate(length(max = 2000))]
    pub description: Option<String>,
}

/// One share entry of a label: a named user OR a whole group, never both.
/// `can_manage` = full co-ownership (rename, recolor, re-share, delete) and
/// visibility over the elements labelled by the other members.
#[derive(Debug, Clone, Deserialize, Serialize, Validate)]
pub struct LabelShareDto {
    pub user_id:    Option<Uuid>,
    pub group_id:   Option<Uuid>,
    #[serde(default)]
    pub can_manage: bool,
}

/// Replaces the whole audience of a label in one atomic call.
#[derive(Debug, Deserialize, Validate)]
pub struct SetLabelSharesDto {
    #[validate(length(max = 200, message = "Trop de destinataires (200 max)"))]
    pub shares: Vec<LabelShareDto>,
}

/// Replaces the label set of ONE resource in a single call (the picker's save).
#[derive(Debug, Deserialize, Validate)]
pub struct SetResourceLabelsDto {
    #[validate(length(min = 1, max = 100))]
    pub module:        String,
    #[validate(length(min = 1, max = 100))]
    pub resource_type: String,
    #[validate(length(min = 1, max = 255))]
    pub resource_id:   String,
    #[validate(length(max = 500))]
    pub title:         Option<String>,
    #[validate(length(max = 1000))]
    pub href:          Option<String>,
    pub envelope:      Option<serde_json::Value>,
    pub label_ids:     Vec<Uuid>,
}
