//! Turning a request into an [`AuditContext`], and the extractor administrative
//! handlers use in place of `AdminUser`.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;

use super::model::{ActorOrigin, AuditActor, AuditContext, AuditEntry};
use super::redact;
use crate::{
    auth::client_ip::ClientIp,
    auth::middleware::{AdminUser, AuthSource},
    errors::AppError,
    models::user::User,
    state::AppState,
};

/// Longest `User-Agent` kept. Browsers stay well under this; the cap only stops
/// a crafted header from bloating the table.
const MAX_USER_AGENT: usize = 512;

fn user_agent(parts: &Parts) -> Option<String> {
    parts
        .headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(MAX_USER_AGENT).collect())
}

/// Human-readable, denormalised actor label: what the trail shows once the
/// account is gone.
fn label_of(user: &User) -> String {
    match user.display_name.as_deref() {
        Some(name) if !name.is_empty() => format!("{name} <{}>", user.email),
        _ => format!("{} <{}>", user.username, user.email),
    }
}

/// Builds the context from an already-authenticated user and the request parts.
///
/// The address comes from [`crate::auth::client_ip`] - the trusted-proxy aware
/// resolver - and never from reading `X-Forwarded-For` here.
pub fn context_from(parts: &Parts, user: &User) -> AuditContext {
    let source = parts
        .extensions
        .get::<AuthSource>()
        .cloned()
        .unwrap_or_else(AuthSource::session);

    let ip = ClientIp::from_parts(parts).0;

    AuditContext {
        actor: AuditActor {
            id: Some(user.id),
            label: label_of(user),
            role: Some(user.role.clone()),
            origin: source.origin,
            token_id: source.token_id,
        },
        ip,
        user_agent: user_agent(parts),
    }
}

/// Context for the sign-in routes, which run *before* any extractor has
/// resolved a user.
///
/// The origin is always `Session`: a personal API token is issued, never used,
/// on this path. The address still comes from [`crate::auth::client_ip`], passed
/// in by the handler's own `ClientIp` extractor.
pub fn login_context(headers: &axum::http::HeaderMap, ip: ClientIp, user: &User) -> AuditContext {
    AuditContext {
        actor: AuditActor {
            id: Some(user.id),
            label: label_of(user),
            role: Some(user.role.clone()),
            origin: ActorOrigin::Session,
            token_id: None,
        },
        ip: ip.0,
        user_agent: headers
            .get("user-agent")
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
            .map(|v| v.chars().take(MAX_USER_AGENT).collect()),
    }
}

/// Context for a request whose actor could not be identified (anonymous probe,
/// failed sign-in). The label states that plainly instead of inventing an
/// identity.
pub fn anonymous_context(parts: &Parts, label: impl Into<String>) -> AuditContext {
    AuditContext {
        actor: AuditActor {
            id: None,
            label: label.into(),
            role: None,
            origin: ActorOrigin::Session,
            token_id: None,
        },
        ip: ClientIp::from_parts(parts).0,
        user_agent: user_agent(parts),
    }
}

/// The administrative extractor **with** an audit context attached.
///
/// Handlers that mutate anything take this instead of `AdminUser`: it performs
/// the exact same authorisation (one database round-trip, same refusals) and
/// additionally hands over the context needed to open an audited transaction.
/// Having the two arrive together removes the ordering trap of extracting the
/// user in one argument and the request metadata in another.
pub struct AdminAudit {
    pub admin: User,
    pub ctx: AuditContext,
}

impl AdminAudit {
    /// Opens the audited transaction. See [`super::AuditTx`]: it cannot be
    /// committed without an entry.
    pub async fn begin(&self, db: &kubuno_db::DbPool) -> Result<super::AuditTx, AppError> {
        self.ctx.begin(db).await
    }

    /// Records a standalone entry (refusal, failure, detached work).
    pub async fn record(&self, db: &kubuno_db::DbPool, entry: AuditEntry) -> Option<i64> {
        self.ctx.record(db, entry).await
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AdminAudit {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let AdminUser(admin) = AdminUser::from_request_parts(parts, state).await?;
        let ctx = context_from(parts, &admin);
        Ok(Self { admin, ctx })
    }
}

/// Records a refused administrative call.
///
/// Called from the `AdminUser` extractor so **every** admin route is covered,
/// including those with no other instrumentation: an attempt outside an
/// operator's perimeter is a signal in its own right, and the route it targeted
/// is the useful part of it.
pub async fn record_refusal(state: &AppState, parts: &Parts, user: &User, reason: &str) {
    let ctx = context_from(parts, user);
    let entry = AuditEntry::new("core.admin.denied")
        .module("core")
        .target(
            redact::target::ROUTE,
            parts.uri.path(),
            format!("{} {}", parts.method, parts.uri.path()),
        )
        .denied(reason);
    ctx.record(&state.db, entry).await;
}
