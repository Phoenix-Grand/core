//! Serveur MCP (Model Context Protocol) - cœur protocolaire réutilisable par le core.
//!
//! Implémente le sous-ensemble JSON-RPC 2.0 nécessaire : `initialize`,
//! `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
//! Le transport (Streamable HTTP) et l'exécution réelle des outils sont fournis
//! par l'appelant via le trait [`McpToolProvider`].

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// Définition d'un outil exposé via MCP.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub name:        String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema des arguments d'entrée.
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
    /// Annotations facultatives (spec MCP) - transmises telles quelles. Kubuno
    /// y place p.ex. `confirm`/`destructiveHint` ou `kubuno_ui` (outil à
    /// dispatcher dans le client plutôt qu'exécuté côté serveur).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
}

/// Résultat d'un appel d'outil.
#[derive(Debug, Clone)]
pub struct ToolCallResult {
    pub text:     String,
    pub is_error: bool,
}

impl ToolCallResult {
    pub fn text(s: impl Into<String>) -> Self { Self { text: s.into(), is_error: false } }
    pub fn error(s: impl Into<String>) -> Self { Self { text: s.into(), is_error: true } }
}

/// Fournit la liste des outils et leur exécution. Implémenté par le core.
#[async_trait]
pub trait McpToolProvider: Send + Sync {
    async fn list_tools(&self) -> Vec<Tool>;
    /// Exécute un outil au nom de l'utilisateur authentifié.
    async fn call_tool(&self, name: &str, arguments: Value, user_id: Uuid) -> ToolCallResult;
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}
fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Traite une requête JSON-RPC MCP. Retourne `None` pour les notifications
/// (pas de réponse attendue), sinon `Some(reponse_json)`.
pub async fn handle_message(
    provider: &dyn McpToolProvider,
    user_id: Uuid,
    server_name: &str,
    server_version: &str,
    msg: &Value,
) -> Option<Value> {
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = msg.get("id").cloned();

    // Notifications (pas d'id) → aucune réponse
    let id = id?;

    match method {
        "initialize" => Some(rpc_result(id, json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": server_name, "version": server_version },
        }))),

        "ping" => Some(rpc_result(id, json!({}))),

        "tools/list" => {
            let tools = provider.list_tools().await;
            Some(rpc_result(id, json!({ "tools": tools })))
        }

        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if name.is_empty() {
                return Some(rpc_error(id, -32602, "Missing 'name' parameter"));
            }
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let res = provider.call_tool(name, args, user_id).await;
            Some(rpc_result(id, json!({
                "content": [ { "type": "text", "text": res.text } ],
                "isError": res.is_error,
            })))
        }

        other => Some(rpc_error(id, -32601, &format!("Unknown method: {other}"))),
    }
}
