//! Value types of the administrative audit trail: who, from where, what, and
//! how it ended.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::IpAddr;
use uuid::Uuid;

/// How the actor reached the server.
///
/// `AuthUser` accepts either a JWT (a human at a browser) or a personal API
/// token (a program) and returns the same `User`. Without this discriminator the
/// trail cannot tell an operator clicking a button from a script holding a
/// long-lived credential - which is precisely the distinction that matters when
/// reading the log after an incident.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorOrigin {
    /// Access token issued by an interactive sign-in.
    Session,
    /// Personal API token (`kubuno_…`). Only its row id is recorded.
    ApiToken,
    /// Module → core call authenticated by an internal secret.
    Internal,
    /// The server acting on its own behalf (seeding, retention purge, startup).
    System,
}

impl ActorOrigin {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::ApiToken => "api_token",
            Self::Internal => "internal",
            Self::System => "system",
        }
    }
}

/// Outcome of the audited attempt.
///
/// `Denied` is not an error to swallow: a refused administrative call is a
/// first-order security signal and must land in the trail like any other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Denied,
    Error,
}

impl Outcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Denied => "denied",
            Self::Error => "error",
        }
    }
}

/// Identity of whoever performed the action, resolved once per request.
#[derive(Debug, Clone)]
pub struct AuditActor {
    pub id: Option<Uuid>,
    /// Denormalised, survives the deletion of the account.
    pub label: String,
    pub role: Option<String>,
    pub origin: ActorOrigin,
    /// `core.api_tokens.id` when `origin == ApiToken`. Never the token itself.
    pub token_id: Option<Uuid>,
}

impl AuditActor {
    /// Actor used by background work that no human triggered.
    pub fn system(label: &str) -> Self {
        Self {
            id: None,
            label: label.to_string(),
            role: None,
            origin: ActorOrigin::System,
            token_id: None,
        }
    }
}

/// What the action was performed on.
#[derive(Debug, Clone, Default)]
pub struct TargetRef {
    pub kind: Option<String>,
    pub id: Option<String>,
    pub label: Option<String>,
}

/// One row of the trail, built by the handler and written by [`super::AuditTx`].
///
/// Construction goes through [`AuditEntry::new`] plus the chained setters below,
/// so a handler cannot forget a mandatory field: `action` is the only required
/// one and it is a constructor argument.
#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub action: String,
    pub module_id: Option<String>,
    pub target: TargetRef,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub outcome: Outcome,
    pub detail: Option<String>,
    pub reversible: bool,
    pub reverts_entry_id: Option<i64>,
}

impl AuditEntry {
    /// `action` follows `<module>.<subject>.<verb>`, e.g. `core.users.update`.
    pub fn new(action: impl Into<String>) -> Self {
        let action = action.into();
        // The module segment is the prefix of the action; explicit `module()`
        // overrides it for cross-module operations.
        let module_id = action.split('.').next().map(str::to_string);
        Self {
            action,
            module_id,
            target: TargetRef::default(),
            before: None,
            after: None,
            outcome: Outcome::Success,
            detail: None,
            reversible: false,
            reverts_entry_id: None,
        }
    }

    pub fn module(mut self, module_id: impl Into<String>) -> Self {
        self.module_id = Some(module_id.into());
        self
    }

    pub fn target(
        mut self,
        kind: impl Into<String>,
        id: impl std::fmt::Display,
        label: impl Into<String>,
    ) -> Self {
        self.target = TargetRef {
            kind: Some(kind.into()),
            id: Some(id.to_string()),
            label: Some(label.into()),
        };
        self
    }

    /// Target without a stable identifier (a whole collection, a route…).
    pub fn target_kind(mut self, kind: impl Into<String>, label: impl Into<String>) -> Self {
        self.target = TargetRef {
            kind: Some(kind.into()),
            id: None,
            label: Some(label.into()),
        };
        self
    }

    /// Snapshot before the mutation. Callers pass a value already filtered by
    /// [`super::redact`]; passing raw rows is what the whitelist exists to stop.
    pub fn before(mut self, value: Value) -> Self {
        self.before = Some(value);
        self
    }

    pub fn after(mut self, value: Value) -> Self {
        self.after = Some(value);
        self
    }

    pub fn outcome(mut self, outcome: Outcome) -> Self {
        self.outcome = outcome;
        self
    }

    pub fn denied(mut self, reason: impl Into<String>) -> Self {
        self.outcome = Outcome::Denied;
        self.detail = Some(reason.into());
        self
    }

    pub fn failed(mut self, reason: impl Into<String>) -> Self {
        self.outcome = Outcome::Error;
        self.detail = Some(reason.into());
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Marks the entry as carrying enough information to be replayed backwards
    /// (a `before` snapshot of a whitelisted, writable shape).
    pub fn reversible(mut self) -> Self {
        self.reversible = true;
        self
    }

    /// This entry undoes `entry_id`; the back-pointer is written by the writer.
    pub fn reverts(mut self, entry_id: i64) -> Self {
        self.reverts_entry_id = Some(entry_id);
        self
    }
}

/// A row read back from `core.admin_audit`, as served by the admin API.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AuditRow {
    pub id: i64,
    pub occurred_at: chrono::DateTime<chrono::Utc>,
    pub actor_id: Option<Uuid>,
    pub actor_label: String,
    pub actor_role: Option<String>,
    pub actor_origin: String,
    pub actor_token_id: Option<Uuid>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub action: String,
    pub module_id: Option<String>,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub target_label: Option<String>,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub outcome: String,
    pub detail: Option<String>,
    pub reversible: bool,
    pub reverts_entry_id: Option<i64>,
    pub reverted_by_entry_id: Option<i64>,
}

/// Request-scoped context: the actor plus where the request came from.
#[derive(Debug, Clone)]
pub struct AuditContext {
    pub actor: AuditActor,
    pub ip: Option<IpAddr>,
    pub user_agent: Option<String>,
}

impl AuditContext {
    /// Context for work with no HTTP request behind it.
    pub fn system(label: &str) -> Self {
        Self {
            actor: AuditActor::system(label),
            ip: None,
            user_agent: None,
        }
    }
}
