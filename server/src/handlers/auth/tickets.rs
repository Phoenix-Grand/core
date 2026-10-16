//! `POST /api/v1/auth/tickets` - mints signed download / stream tickets.
//!
//! See [`crate::auth::tickets`] for the format and the validation side.

use axum::{
    Json,
    extract::State,
    http::HeaderMap,
};
use kubuno_db::params;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    auth::{
        jwt::JwtService,
        tickets::{self, Purpose, TicketClaims},
    },
    errors::AppError,
    models::user::User,
    state::AppState,
};

/// Most URLs one call may ask tickets for (a page of thumbnails).
const MAX_URLS: usize = 200;

#[derive(Debug, Deserialize, ToSchema)]
pub struct TicketRequest {
    /// Same-origin absolute URLs (`/api/v1/...`, `/ws`, `/collab/<room>/sync`),
    /// query string allowed (kept, but not bound).
    pub urls: Vec<String>,
    /// HTTP method the tickets are valid for. Only `GET` (which also admits
    /// `HEAD`) is issued today.
    #[serde(default)]
    pub method: Option<String>,
    /// `view` (default), `download`, `stream`, `socket` - decides the lifetime.
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    pub purpose: Option<Purpose>,
    /// Spend the ticket on its first use (downloads). Incompatible with
    /// `stream` (a media element issues many Range requests).
    #[serde(default)]
    pub once: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct IssuedTicket {
    /// The requested URL with `kt=<ticket>` appended.
    pub url: String,
    /// Expiry, seconds since the epoch.
    pub expires_at: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TicketResponse {
    pub tickets: Vec<IssuedTicket>,
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/tickets",
    tag = "auth",
    request_body = TicketRequest,
    responses(
        (status = 200, description = "One ticketed URL per requested URL, same order", body = TicketResponse),
        (status = 401, description = "No valid session bearer"),
        (status = 403, description = "Caller is not a browser session (API token)"),
        (status = 422, description = "Invalid URL, method or purpose")
    )
)]
pub async fn issue_tickets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TicketRequest>,
) -> Result<Json<TicketResponse>, AppError> {
    // A ticket is minted from a session bearer in the header, and from nothing
    // else: not from a cookie (that would make this endpoint a CSRF target),
    // not from another ticket, not from a personal API token (a script holds a
    // header and has no use for one; its narrowed role must not leak into a
    // session-shaped capability).
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    let jwt = JwtService::new(
        state.settings.auth.jwt_secret.clone(),
        state.settings.auth.access_token_ttl,
    );
    let claims = match jwt.validate_access_token(bearer) {
        Ok(c) => c,
        Err(_) if bearer.starts_with("kubuno_") => return Err(AppError::Forbidden),
        Err(e) => return Err(e),
    };

    // ── Input validation, before anything else ──────────────────────────────
    if req.urls.is_empty() {
        return Err(AppError::Validation("urls: at least one URL is required".into()));
    }
    if req.urls.len() > MAX_URLS {
        return Err(AppError::Validation(format!("urls: at most {MAX_URLS} per call")));
    }
    let method = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    if method != "GET" {
        return Err(AppError::Validation("method: only GET tickets are issued".into()));
    }
    let purpose = req.purpose.unwrap_or_default();
    if req.once && matches!(purpose, Purpose::Stream | Purpose::Socket) {
        return Err(AppError::Validation(
            "once: not available for stream or socket tickets".into(),
        ));
    }
    let mut targets = Vec::with_capacity(req.urls.len());
    for url in &req.urls {
        let path = tickets::validate_target(url)
            .map_err(|m| AppError::Validation(format!("urls: {m}")))?;
        targets.push((url.as_str(), path));
    }

    // The account must still be active (a deactivated account keeps a valid
    // JWT until it expires; it must not mint fresh capabilities with it).
    state
        .db
        .fetch_optional_as::<User>(
            "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
            params![claims.sub],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "tickets: loading the account failed");
            AppError::Database(e)
        })?
        .ok_or(AppError::Unauthorized)?;

    let key = tickets::derive_key(&state.settings.auth.jwt_secret);
    let now = chrono::Utc::now().timestamp();
    let ttl = tickets::ttl_for(&state.settings.auth, purpose);
    let exp = tickets::expiry(now, ttl, req.once);

    let mut issued = Vec::with_capacity(targets.len());
    for (url, path) in targets {
        let audience = tickets::audience_for(&state, &path).await;
        let ticket = tickets::encode(
            &key,
            &TicketClaims {
                uid: claims.sub,
                sid: claims.sid,
                aud: audience,
                path,
                mth: method.clone(),
                pur: purpose,
                exp,
                once: req.once.then(|| uuid::Uuid::new_v4().simple().to_string()),
            },
        );
        issued.push(IssuedTicket { url: tickets::append_to_url(url, &ticket), expires_at: exp });
    }
    Ok(Json(TicketResponse { tickets: issued }))
}
