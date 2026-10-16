//! `POST /internal/rules/gate` - the route a module calls **before** it commits.
//!
//! Authenticated by `X-Internal-Secret` like every other internal route, so the
//! caller is a module the core spawned rather than a browser. It is deliberately
//! *not* an `/api/v1` route: a user must never be able to ask the portal
//! anything directly. Being able to submit arbitrary text and read back
//! allow/block is being able to map the policy one candidate at a time, which is
//! precisely what the response's wording exists to prevent.
//!
//! ## What a module has to do
//!
//! ```text
//!   1. declare, at registration, a trigger with content-part fields
//!      (`"type": "content"`) - or use the core's `core.content_gate`;
//!   2. before committing, POST the structural facts and the parts here;
//!   3. on `block`, refuse the operation and show `message` and `reference`;
//!      on `warn`, proceed and show `message`;
//!   4. on a network error or a timeout of its own, apply the instance's
//!      `rules.gate.fail_mode` - open by default.
//! ```
//!
//! Step 4 is the half the core cannot do for the module: a core that is
//! unreachable cannot tell anybody what to do about it.
//!
//! ## The body is never persisted
//!
//! Not by this handler, not by the engine underneath it, and not by the request
//! log: the tracing middleware records method, path and status, never a body.
//! The parts exist for the length of one call.

use axum::{extract::State, Json};

use crate::auth::middleware::InternalRequest;
use crate::errors::AppError;
use crate::rules::gate::{self, GateRequest, GateResponse};
use crate::state::AppState;

/// `POST /internal/rules/gate`
pub async fn gate(
    State(state): State<AppState>,
    internal: InternalRequest,
    Json(mut request): Json<GateRequest>,
) -> Result<Json<GateResponse>, AppError> {
    if request.trigger.trim().is_empty() {
        return Err(AppError::Validation(
            "Le portail exige le déclencheur auquel l'opération correspond".into(),
        ));
    }

    // The calling module's identity comes from its secret, never from the body.
    // A module that could name itself could write rules' facts about another
    // module, and "block everything office does" would be one field away from
    // being defeated by office itself.
    if let Some(module_id) = internal.module_id() {
        if !request.facts.is_object() {
            // A module that sent no facts at all, or something that is not an
            // object. Normalised here rather than defended against three layers
            // down.
            request.facts = serde_json::Value::Object(Default::default());
        }
        if let serde_json::Value::Object(map) = &mut request.facts {
            map.insert(
                "module".into(),
                serde_json::Value::String(module_id.to_string()),
            );
        }
    }

    Ok(Json(gate::decide(&state.db, request).await))
}
