//! Public ACME HTTP-01 challenge endpoint.
//!
//! The ACME server (Let's Encrypt) proves domain control by fetching
//! `http://<domain>/.well-known/acme-challenge/<token>` and checking the body.
//! This route is deliberately unauthenticated and served over plain HTTP - that
//! is the whole point of the challenge - and returns only a response the core
//! itself put there for a pending order (see [`crate::network::acme`]).

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
};

use crate::state::AppState;

/// GET /.well-known/acme-challenge/:token
pub async fn http01_challenge(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> impl IntoResponse {
    match state.tls.acme_challenge(&token) {
        Some(key_authorization) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain")],
            key_authorization,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
