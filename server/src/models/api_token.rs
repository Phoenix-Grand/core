use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;
use validator::Validate;

/// One row of `core.api_tokens`.
///
/// `token_hash` is loaded (resolution needs it) and never serialised: the
/// `skip_serializing` below is what keeps it out of every JSON body, and the
/// audit whitelist keeps it out of the trail. Neither the token nor its hash
/// leaves the process.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ApiToken {
    pub id:           Uuid,
    pub user_id:      Uuid,
    pub name:         String,
    #[serde(skip_serializing)]
    pub token_hash:   String,
    /// Privilege keys the bearer may exercise. Empty **only** for a legacy token.
    /// Stored as a JSON array (portable across engines); the PostgreSQL column
    /// is migrated `TEXT[]` → `JSONB` on the schema-consolidation side.
    #[sqlx(json)]
    pub scopes:       Vec<String>,
    /// Issued before scopes existed; runs on a grace window.
    pub is_legacy:    bool,
    /// When the token was marked legacy. The deadline is derived from it and the
    /// current setting, so it is never stale.
    pub legacy_since: Option<DateTime<Utc>>,
    pub expires_at:   Option<DateTime<Utc>>,
    pub created_at:   DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at:   Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct CreateApiTokenDto {
    #[validate(length(min = 1, max = 255, message = "Name: 1-255 characters"))]
    pub name: String,

    /// Privilege keys the token may exercise.
    ///
    /// Mandatory, and validated against both the catalogue and what the creator
    /// holds. There is deliberately no default and no "all" value: the previous
    /// behaviour - a token inheriting every privilege of its owner, for ever -
    /// is exactly what this field exists to remove, so an omitted list must be a
    /// refusal rather than a fallback. `#[serde(default)]` makes a missing field
    /// arrive as an empty list, which `policy::validate_requested` then rejects
    /// with a message that says why.
    #[serde(default)]
    pub scopes: Vec<String>,

    /// Expiration en jours. `None` = sans expiration, refusé dès qu'une portée
    /// « core.* » en écriture est demandée. Plafonné par
    /// `security.api_token_max_ttl_days`.
    pub expires_in_days: Option<u32>,
}
