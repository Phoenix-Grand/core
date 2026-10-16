use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A configured generic OIDC identity provider. The `client_secret_enc` column
/// holds the AES-GCM-encrypted secret and must never be serialized to clients.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OAuthProvider {
    pub id:                Uuid,
    pub slug:              String,
    pub display_name:      String,
    pub issuer_url:        String,
    pub client_id:         String,
    pub client_secret_enc: String,
    pub scopes:            String,
    pub button_color:      Option<String>,
    pub enabled:           bool,
    pub allow_signup:      bool,
    pub position:          i32,
    /// Claim names feeding our fields. Dotted paths allowed - see
    /// [`crate::auth::oauth::ClaimMap`].
    pub claim_username:     String,
    pub claim_email:        String,
    pub claim_display_name: String,
    pub claim_groups:       String,
    /// Place the person in the groups named by `claim_groups`.
    pub sync_groups:        bool,
    pub created_at:        DateTime<Utc>,
    pub updated_at:        DateTime<Utc>,
}

impl OAuthProvider {
    pub fn claims(&self) -> crate::auth::oauth::ClaimMap {
        crate::auth::oauth::ClaimMap {
            username:     self.claim_username.clone(),
            email:        self.claim_email.clone(),
            display_name: self.claim_display_name.clone(),
            groups:       self.claim_groups.clone(),
        }
    }
}

/// Admin-facing view - exposes everything EXCEPT the secret (only whether one is set).
#[derive(Debug, Serialize)]
pub struct AdminOAuthProvider {
    pub id:           Uuid,
    pub slug:         String,
    pub display_name: String,
    pub issuer_url:   String,
    pub client_id:    String,
    pub has_secret:   bool,
    pub scopes:       String,
    pub button_color: Option<String>,
    pub enabled:      bool,
    pub allow_signup: bool,
    pub position:     i32,
    pub claim_username:     String,
    pub claim_email:        String,
    pub claim_display_name: String,
    pub claim_groups:       String,
    pub sync_groups:        bool,
}

impl From<OAuthProvider> for AdminOAuthProvider {
    fn from(p: OAuthProvider) -> Self {
        Self {
            has_secret:   !p.client_secret_enc.is_empty(),
            id:           p.id,
            slug:         p.slug,
            display_name: p.display_name,
            issuer_url:   p.issuer_url,
            client_id:    p.client_id,
            scopes:       p.scopes,
            button_color: p.button_color,
            enabled:      p.enabled,
            allow_signup: p.allow_signup,
            position:     p.position,
            claim_username:     p.claim_username,
            claim_email:        p.claim_email,
            claim_display_name: p.claim_display_name,
            claim_groups:       p.claim_groups,
            sync_groups:        p.sync_groups,
        }
    }
}

/// Public view shown on the login page (enabled providers only, no secrets).
#[derive(Debug, Serialize)]
pub struct PublicOAuthProvider {
    pub slug:         String,
    pub display_name: String,
    pub button_color: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct CreateOAuthProviderDto {
    pub slug:          String,
    pub display_name:  String,
    pub issuer_url:    String,
    pub client_id:     String,
    #[serde(default)]
    pub client_secret: String,
    pub scopes:        Option<String>,
    pub button_color:  Option<String>,
    #[serde(default = "default_true")]
    pub enabled:       bool,
    #[serde(default = "default_true")]
    pub allow_signup:  bool,
    #[serde(default)]
    pub position:      i32,
    pub claim_username:     Option<String>,
    pub claim_email:        Option<String>,
    pub claim_display_name: Option<String>,
    pub claim_groups:       Option<String>,
    #[serde(default)]
    pub sync_groups:        bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdateOAuthProviderDto {
    pub display_name: Option<String>,
    pub issuer_url:   Option<String>,
    pub client_id:    Option<String>,
    /// Non-empty → replace the stored secret; absent/empty → keep the existing one.
    pub client_secret: Option<String>,
    pub scopes:       Option<String>,
    pub button_color: Option<String>,
    pub enabled:      Option<bool>,
    pub allow_signup: Option<bool>,
    pub position:     Option<i32>,
    pub claim_username:     Option<String>,
    pub claim_email:        Option<String>,
    pub claim_display_name: Option<String>,
    pub claim_groups:       Option<String>,
    pub sync_groups:        Option<bool>,
}
