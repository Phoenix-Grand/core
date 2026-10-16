//! Endpoint MCP (Streamable HTTP) - agrège les outils déclarés par les modules
//! et proxifie leur exécution. Auth par token API (identité utilisateur).

use async_trait::async_trait;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use kubuno_db::params;
use kubuno_mcp::{handle_message, McpToolProvider, Tool, ToolCallResult};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    auth::{
        middleware::InternalRequest,
        token_scope::{self, TokenGrant},
    },
    errors::AppError,
    state::AppState,
};

/// Provider adossé à `core.module_instances.mcp_tools` + exécution par proxy HTTP.
struct CoreToolProvider {
    state: AppState,
    /// The API token behind the call, when there is one. `None` for the internal
    /// variant, which is authenticated by a module's own secret.
    grant: Option<TokenGrant>,
}

#[async_trait]
impl McpToolProvider for CoreToolProvider {
    async fn list_tools(&self) -> Vec<Tool> {
        let rows = self
            .state
            .db
            .fetch_all_as::<(Value,)>(
                "SELECT mcp_tools FROM core.module_instances
                 WHERE status IN ('healthy', 'starting')",
                params![],
            )
            .await
            .unwrap_or_default();

        let mut out = Vec::new();
        for (tools,) in rows {
            if let Some(arr) = tools.as_array() {
                for t in arr {
                    let Some(name) = t.get("name").and_then(|x| x.as_str()) else { continue };
                    out.push(Tool {
                        name:        name.to_string(),
                        description: t.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        input_schema: t.get("input_schema").cloned()
                            .unwrap_or_else(|| json!({ "type": "object" })),
                        annotations: t.get("annotations").cloned(),
                    });
                }
            }
        }
        out
    }

    async fn call_tool(&self, name: &str, arguments: Value, user_id: Uuid) -> ToolCallResult {
        // Locate the tool (base_url + route + method) among the active instances.
        let rows = self
            .state
            .db
            .fetch_all_as::<(String, String, Value)>(
                "SELECT module_id, base_url, mcp_tools FROM core.module_instances
                 WHERE status IN ('healthy', 'starting')",
                params![],
            )
            .await
            .unwrap_or_else(|e| {
                tracing::error!(error = %e, "MCP: could not read module instances");
                Vec::new()
            });

        // (module_id, base_url, route, method)
        let mut target: Option<(String, String, String, String)> = None;
        for (module_id, base_url, tools) in rows {
            if let Some(arr) = tools.as_array() {
                for t in arr {
                    if t.get("name").and_then(|x| x.as_str()) == Some(name) {
                        // Les outils UI ne s'exécutent pas côté serveur : ils sont
                        // dispatchés dans le client par l'assistant.
                        if t.pointer("/annotations/kubuno_ui").is_some() {
                            return ToolCallResult::error(format!(
                                "L'outil '{name}' est une action d'interface (à dispatcher côté client)."
                            ));
                        }
                        let route  = t.get("route").and_then(|x| x.as_str()).unwrap_or("/").to_string();
                        let method = t.get("method").and_then(|x| x.as_str()).unwrap_or("POST").to_uppercase();
                        target = Some((module_id.clone(), base_url.clone(), route, method));
                        break;
                    }
                }
            }
            if target.is_some() { break }
        }

        let Some((module_id, base_url, route, method)) = target else {
            return ToolCallResult::error(format!("Outil introuvable: {name}"));
        };

        // Charger l'utilisateur pour injecter son identité aux modules.
        // `is_active` is part of the predicate: a suspended account must not keep
        // driving modules through a tool call.
        let user = self
            .state
            .db
            .fetch_optional_as::<crate::models::user::User>(
                "SELECT * FROM core.users WHERE id = $1 AND is_active = TRUE",
                params![user_id],
            )
            .await
            .unwrap_or_else(|e| {
                tracing::error!(error = %e, user_id = %user_id, "MCP: loading the user");
                None
            });
        let Some(user) = user else {
            return ToolCallResult::error("Utilisateur introuvable");
        };

        // The role presented to the module. When the call arrived on an API
        // token, it is derived from that token's scopes - this endpoint
        // authenticates by token and nothing else, so forwarding the owner's role
        // verbatim made it the shortest path in the whole system to untraced
        // administrative access inside every module.
        let role = match self.grant.as_ref() {
            Some(g) => token_scope::module_role_for(g, &user.role),
            None => user.role.clone(),
        };

        let url = format!("{}{}", base_url.trim_end_matches('/'), route);
        // Same signed identity as the module proxy mints: a module that verifies
        // X-Kubuno-Auth (and no longer trusts the plain headers) serves this call too.
        let module_secret = self.state.settings.server.module_secret(&module_id);
        let signed_identity = kubuno_modauth::sign(
            module_secret.as_bytes(),
            &kubuno_modauth::ModuleUser { id: user.id, role: role.clone(), email: user.email.clone() },
            &module_id,
        );
        let client = reqwest::Client::new();
        let req = match method.as_str() {
            "GET" => client.get(&url).query(&arguments),
            _     => client.post(&url).json(&arguments),
        }
        .header("x-kubuno-user-id", user.id.to_string())
        .header("x-kubuno-user-role", role.clone())
        .header("x-kubuno-user-email", user.email.clone())
        .header(kubuno_modauth::TOKEN_HEADER, signed_identity)
        // The target module's internal secret (it compares it with its own value).
        .header("x-internal-secret", module_secret);

        match req.send().await {
            Ok(resp) => {
                let ok = resp.status().is_success();
                let body = resp.text().await.unwrap_or_default();
                if ok { ToolCallResult::text(body) }
                else  { ToolCallResult::error(body) }
            }
            Err(e) => ToolCallResult::error(format!("Erreur d'appel du module: {e}")),
        }
    }
}

async fn mcp_enabled(state: &AppState) -> bool {
    state
        .db
        .fetch_optional_scalar::<Value>(
            "SELECT value FROM core.settings WHERE \"key\" = 'mcp.enabled'",
            params![],
        )
        .await
        .ok()
        .flatten()
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// POST /mcp - point d'entrée JSON-RPC (Streamable HTTP, réponses JSON).
pub async fn mcp_endpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !mcp_enabled(&state).await {
        return (StatusCode::NOT_FOUND, "Serveur MCP désactivé").into_response();
    }

    // Auth: personal API token, and nothing else - no session, no cookie. That
    // makes this the one route where the scoping rules cannot be a second line of
    // defence behind an interactive check; they are the only line.
    let Some(token) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return (StatusCode::UNAUTHORIZED, "Token API requis").into_response();
    };

    let grant = match token_scope::resolve_grant(&state.db, token).await {
        Ok(g) => g,
        // Carries the distinguishable codes: a legacy token past its window gets
        // API_TOKEN_LEGACY_EXPIRED rather than a bare 401 it would keep retrying.
        Err(e) => return e.into_response(),
    };

    // A scoped token must say it may do this. A legacy token is admitted during
    // its grace window - it predates the scope it is now missing - and every one
    // of its uses is logged and audited by `resolve_grant`.
    if !grant.may_carry(token_scope::MCP_EXECUTE) {
        tracing::warn!(
            token_id = %grant.token_id,
            user_id = %grant.user_id,
            "MCP refusé : le jeton ne porte pas la portée core.mcp.execute"
        );
        return AppError::ApiTokenScopeMissing(token_scope::MCP_EXECUTE.to_string())
            .into_response();
    }

    let user_id = grant.user_id;
    dispatch(&state, user_id, Some(grant), body).await
}

/// POST /internal/mcp - internal variant for trusted modules (e.g. the assistant module)
/// agissant au nom d'un utilisateur. Auth : `x-internal-secret` (extracteur
/// `InternalRequest`) + identité via l'en-tête `x-kubuno-user-id`, au lieu d'un
/// token API personnel (que l'assistant ne possède pas en cours de conversation).
pub async fn internal_mcp_endpoint(
    _internal: InternalRequest,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !mcp_enabled(&state).await {
        return (StatusCode::NOT_FOUND, "Serveur MCP désactivé").into_response();
    }

    let user_id = headers
        .get("x-kubuno-user-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok());
    let Some(user_id) = user_id else {
        return (StatusCode::BAD_REQUEST, "En-tête x-kubuno-user-id requis").into_response();
    };

    dispatch(&state, user_id, None, body).await
}

/// Traite un message JSON-RPC unique ou un lot (array), au nom de `user_id`.
async fn dispatch(
    state: &AppState,
    user_id: Uuid,
    grant: Option<TokenGrant>,
    body: Value,
) -> Response {
    let provider = CoreToolProvider { state: state.clone(), grant };
    let version = env!("CARGO_PKG_VERSION");

    if let Some(arr) = body.as_array() {
        let mut out = Vec::new();
        for m in arr {
            if let Some(r) = handle_message(&provider, user_id, "Kubuno", version, m).await {
                out.push(r);
            }
        }
        if out.is_empty() { return StatusCode::ACCEPTED.into_response() }
        Json(Value::Array(out)).into_response()
    } else {
        match handle_message(&provider, user_id, "Kubuno", version, &body).await {
            Some(r) => Json(r).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        }
    }
}
