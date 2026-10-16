use crate::{errors::AppError, state::AppState};
use axum::{
    extract::{
        Query,
        State,
        WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct WsQuery {
    /// Socket ticket (`POST /api/v1/auth/tickets`, purpose `socket`) - web.
    #[serde(default)]
    pub kt: Option<String>,
    /// Access token - native clients.
    #[serde(default)]
    pub token: Option<String>,
}

pub async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
    let user_id = crate::auth::tickets::socket_user(
        &state,
        query.kt.as_deref(),
        query.token.as_deref(),
        "/ws",
    )
    .await?;

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state, user_id)))
}

async fn handle_socket(socket: WebSocket, state: AppState, user_id: uuid::Uuid) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.ws_hub.connect(user_id).await;

    // Forward EventBus → WebSocket client
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if sender.send(Message::Text(json)).await.is_err() {
                    break;
                }
            }
        }
    });

    // Lire les messages client (ping/pong ou fermeture)
    while let Some(Ok(msg)) = receiver.next().await {
        if matches!(msg, Message::Close(_)) {
            break;
        }
    }

    send_task.abort();
    tracing::debug!(user_id = %user_id, "WebSocket déconnecté");
}
