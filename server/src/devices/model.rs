//! Value types of the device inventory.
//!
//! The one that matters is [`Tri`]. Everything else is shape.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// A signal that can be **unknown**, and whose unknown value must never be
/// mistaken for a negative - or, far worse, absorbed into a positive.
///
/// This exists because `Option<bool>` invites `unwrap_or(false)`, and because a
/// plain `bool` column with `DEFAULT FALSE` turns "we never asked" into "we
/// checked and it is not encrypted". Those are different sentences, and a
/// console that conflates them is lying to an operator about a fleet it has no
/// agent on.
///
/// [`Tri::is_encrypted`] is deliberately the *only* way to ask the positive
/// question, and it answers `false` for [`Tri::Unknown`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Tri {
    /// Nothing was declared, or declared signals are switched off.
    #[default]
    Unknown,
    Yes,
    No,
}

impl Tri {
    pub const fn from_option(value: Option<bool>) -> Self {
        match value {
            None => Self::Unknown,
            Some(true) => Self::Yes,
            Some(false) => Self::No,
        }
    }

    pub const fn to_option(self) -> Option<bool> {
        match self {
            Self::Unknown => None,
            Self::Yes => Some(true),
            Self::No => Some(false),
        }
    }

    /// True only when the device positively declared the signal.
    ///
    /// The name is the point: a caller writing `if tri.is_satisfied()` over an
    /// unknown value gets `false`, which is the safe answer for every policy
    /// question ("is this disk encrypted?", "does this screen lock?").
    pub const fn is_satisfied(self) -> bool {
        matches!(self, Self::Yes)
    }

    /// Alias reading at the call site as the question actually being asked.
    pub const fn is_encrypted(self) -> bool {
        self.is_satisfied()
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Yes => "yes",
            Self::No => "no",
        }
    }
}

/// How much the server can vouch for what it shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalLevel {
    /// Read off the request. Verifiable.
    Observed,
    /// Stated by a native application. Displayed as such, everywhere, always.
    Declared,
    /// Hardware/OS attestation. Out of scope: nothing produces this.
    Attested,
}

impl SignalLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Observed => "observed",
            Self::Declared => "declared",
            Self::Attested => "attested",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "observed" => Some(Self::Observed),
            "declared" => Some(Self::Declared),
            "attested" => Some(Self::Attested),
            _ => None,
        }
    }
}

/// Operator verdict on a device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Approval {
    Pending,
    Approved,
    /// The only state with teeth: sessions are revoked and refreshes refused.
    Blocked,
}

impl Approval {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Blocked => "blocked",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pending" => Some(Self::Pending),
            "approved" => Some(Self::Approved),
            "blocked" => Some(Self::Blocked),
            _ => None,
        }
    }
}

/// Kinds recorded on [`crate::devices`] timelines. String constants rather than
/// an enum because the console translates them by name and a value written a
/// year ago must still render.
pub mod event_kind {
    pub const FIRST_SEEN: &str = "first_seen";
    pub const SESSION_OPENED: &str = "session_opened";
    pub const DECLARED: &str = "declared";
    pub const APPROVED: &str = "approved";
    pub const BLOCKED: &str = "blocked";
    pub const UNBLOCKED: &str = "unblocked";
    pub const SIGNED_OUT: &str = "signed_out";
    pub const RENAMED: &str = "renamed";
    /// The user said "this was not me".
    pub const DISOWNED: &str = "disowned";
}

/// One inventory row as served by the API.
///
/// `correlation_hash` is **absent by construction**: it is not a field of this
/// struct, so no `SELECT *` and no future `#[serde(flatten)]` can leak it. Every
/// query in [`super::store`] lists its columns explicitly for the same reason.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DeviceRow {
    pub id: Uuid,
    pub user_id: Uuid,
    /// Denormalised for the administration list, which is read across accounts.
    #[sqlx(default)]
    pub user_label: Option<String>,
    pub correlation_kind: String,
    pub label: Option<String>,
    pub device_type: String,
    pub client_kind: Option<String>,
    pub platform: Option<String>,
    pub platform_version: Option<String>,
    pub browser: Option<String>,
    pub browser_version: Option<String>,
    pub signal_level: String,
    /// Serialised as `"unknown" | "yes" | "no"`, never as a nullable boolean:
    /// a JSON `null` is one `??` away from becoming `false` in the console.
    #[sqlx(rename = "disk_encrypted")]
    pub disk_encrypted_raw: Option<bool>,
    #[sqlx(rename = "screen_lock")]
    pub screen_lock_raw: Option<bool>,
    pub declared_platform: Option<String>,
    pub declared_version: Option<String>,
    pub declared_app_version: Option<String>,
    pub declared_at: Option<DateTime<Utc>>,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub last_ip: Option<String>,
    pub last_country: Option<String>,
    pub approval: String,
    pub approval_by: Option<Uuid>,
    pub approval_label: Option<String>,
    pub approval_at: Option<DateTime<Utc>>,
    pub approval_reason: Option<String>,
    /// Live sessions attached to this device, counted by the query.
    #[sqlx(default)]
    pub active_sessions: i64,
}

impl DeviceRow {
    pub fn disk_encrypted(&self) -> Tri {
        Tri::from_option(self.disk_encrypted_raw)
    }

    pub fn screen_lock(&self) -> Tri {
        Tri::from_option(self.screen_lock_raw)
    }

    /// Wire form. The two tri-states are rendered as strings and the raw
    /// booleans are dropped, so a client cannot read them as nullable booleans.
    pub fn to_json(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).unwrap_or(serde_json::Value::Null);
        if let Some(object) = value.as_object_mut() {
            object.remove("disk_encrypted_raw");
            object.remove("screen_lock_raw");
            object.insert(
                "disk_encrypted".into(),
                serde_json::Value::String(self.disk_encrypted().as_str().into()),
            );
            object.insert(
                "screen_lock".into(),
                serde_json::Value::String(self.screen_lock().as_str().into()),
            );
        }
        value
    }
}

/// One line of a device timeline.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DeviceEventRow {
    pub id: i64,
    pub occurred_at: DateTime<Utc>,
    pub kind: String,
    pub ip_address: Option<String>,
    pub country: Option<String>,
    pub actor_id: Option<Uuid>,
    pub actor_label: Option<String>,
    pub detail: Option<String>,
}

/// A live session, as shown on a device sheet and in the global session list.
///
/// `token_hash` is not a field here either, for the same structural reason.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct SessionRow {
    pub id: Uuid,
    pub user_id: Uuid,
    #[sqlx(default)]
    pub user_label: Option<String>,
    pub device_id: Option<Uuid>,
    #[sqlx(default)]
    pub device_label: Option<String>,
    pub device_name: Option<String>,
    pub device_type: Option<String>,
    pub client_type: Option<String>,
    pub ip_address: Option<String>,
    pub country: Option<String>,
    pub auth_strength: Option<String>,
    pub user_agent: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// How the holder proved their identity when the session opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStrength {
    Password,
    PasswordTotp,
    BackupCode,
    Sso,
    Unknown,
}

impl AuthStrength {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PasswordTotp => "password_totp",
            Self::BackupCode => "backup_code",
            Self::Sso => "sso",
            Self::Unknown => "unknown",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule the whole tri-state exists for.
    #[test]
    fn unknown_never_satisfies_encrypted() {
        assert!(!Tri::Unknown.is_encrypted());
        assert!(!Tri::Unknown.is_satisfied());
        assert!(!Tri::No.is_encrypted());
        assert!(Tri::Yes.is_encrypted());
    }

    #[test]
    fn unknown_is_the_default() {
        assert_eq!(Tri::default(), Tri::Unknown);
        assert_eq!(Tri::from_option(None), Tri::Unknown);
        assert_eq!(Tri::from_option(Some(false)), Tri::No);
        assert_eq!(Tri::from_option(Some(true)), Tri::Yes);
    }

    /// A missing signal must not travel as `null`: the console would read it
    /// with `?? false` and turn "we never asked" into "not encrypted".
    #[test]
    fn tri_serialises_as_a_word_not_a_nullable_boolean() {
        assert_eq!(serde_json::to_string(&Tri::Unknown).ok(), Some("\"unknown\"".into()));
        assert_eq!(serde_json::to_string(&Tri::Yes).ok(), Some("\"yes\"".into()));
        assert_eq!(serde_json::to_string(&Tri::No).ok(), Some("\"no\"".into()));
    }

    #[test]
    fn round_trips_through_option() {
        for tri in [Tri::Unknown, Tri::Yes, Tri::No] {
            assert_eq!(Tri::from_option(tri.to_option()), tri);
        }
    }

    #[test]
    fn states_parse_back_from_their_stored_form() {
        for a in [Approval::Pending, Approval::Approved, Approval::Blocked] {
            assert_eq!(Approval::parse(a.as_str()), Some(a));
        }
        for s in [SignalLevel::Observed, SignalLevel::Declared, SignalLevel::Attested] {
            assert_eq!(SignalLevel::parse(s.as_str()), Some(s));
        }
        assert_eq!(Approval::parse("wiped"), None);
    }
}
