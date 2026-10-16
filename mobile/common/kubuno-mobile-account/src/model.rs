//! The shapes the Kubuno auth API returns to a native client, and the account they describe.

use serde::Deserialize;

/// The token pair a native sign-in / refresh returns in the JSON body (`NativeTokenResponse` on the server): a
/// 15-minute access JWT and a 30-day opaque refresh token, plus who it belongs to. Unknown fields are ignored.
#[derive(Clone, Debug, Deserialize)]
pub struct NativeTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// When the refresh token expires (RFC 3339, server clock); kept as text — only the access token's own `exp`
    /// drives refresh scheduling.
    #[serde(default)]
    pub refresh_expires_at: Option<String>,
    pub user: User,
}

/// The signed-in user, as the server returns it. Only the fields the app needs are named; the rest is ignored.
#[derive(Clone, Debug, Deserialize)]
pub struct User {
    pub id: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
}

impl User {
    /// A human label for the account (display name, else username, else email, else the id).
    pub fn label(&self) -> String {
        self.display_name
            .clone()
            .or_else(|| self.username.clone())
            .or_else(|| self.email.clone())
            .unwrap_or_else(|| self.id.clone())
    }
}

/// An account signed in on this device: which server, who, and the stable device key sent on every request
/// (`X-Kubuno-Device-Key`). The refresh token is **not** here — it lives only in the OS secret store.
#[derive(Clone, Debug)]
pub struct Account {
    pub server: String,
    pub user_id: String,
    pub label: String,
    pub device_key: String,
}
