//! Public CAPTCHA challenge endpoint (`GET /auth/captcha`).
//!
//! The sign-in form calls this once the login response tells it a CAPTCHA is
//! required (`code = "CAPTCHA_REQUIRED"`). It returns the challenge - its id,
//! its `type`, and whatever that type needs to be drawn (an image, a pair of
//! images for the slider, or a prompt for the sum). The id and the person's
//! answer come back on the next `POST /auth/login`. Self-hosted, no third party
//! (see [`crate::auth::captcha`]).

use crate::{auth::captcha, errors::AppError, state::AppState};
use axum::{extract::State, Json};
use serde_json::Value;

#[utoipa::path(
    get,
    path = "/api/v1/auth/captcha",
    tag = "auth",
    responses(
        (status = 200, description = "Un défi CAPTCHA : { challenge_id, type, … } selon le type configuré (image, puzzle, ou opération).")
    )
)]
pub async fn captcha_challenge(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let challenge = captcha::generate(&state.db).await?;
    Ok(Json(challenge.payload))
}
