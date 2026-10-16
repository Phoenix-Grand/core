use crate::events::EventBus;
use serde::Serialize;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct WsMessage {
    pub r#type:  String,
    pub module:  Option<String>,
    pub payload: serde_json::Value,
}

pub struct WsHub {
    connections: RwLock<HashMap<Uuid, Vec<mpsc::UnboundedSender<WsMessage>>>>,
}

impl WsHub {
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
        }
    }

    pub async fn connect(&self, user_id: Uuid) -> mpsc::UnboundedReceiver<WsMessage> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.connections
            .write()
            .await
            .entry(user_id)
            .or_default()
            .push(tx);
        rx
    }

    pub async fn disconnect(&self, user_id: Uuid, sender: &mpsc::UnboundedSender<WsMessage>) {
        let mut map = self.connections.write().await;
        if let Some(senders) = map.get_mut(&user_id) {
            senders.retain(|s| !s.same_channel(sender));
            if senders.is_empty() {
                map.remove(&user_id);
            }
        }
    }

    pub async fn send_to_user(&self, user_id: Uuid, msg: WsMessage) {
        let map = self.connections.read().await;
        if let Some(senders) = map.get(&user_id) {
            for tx in senders {
                let _ = tx.send(msg.clone());
            }
        }
    }

    pub async fn broadcast(&self, msg: WsMessage) {
        let map = self.connections.read().await;
        for senders in map.values() {
            for tx in senders {
                let _ = tx.send(msg.clone());
            }
        }
    }
}

impl Default for WsHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Destinataires ciblés d'un event : un `Custom` portant un tableau
/// `recipient_user_ids` dans sa charge n'est délivré qu'à ces utilisateurs
/// (sinon broadcast - comportement historique préservé).
fn targeted_recipients(event: &crate::events::AppEvent) -> Option<Vec<Uuid>> {
    if let crate::events::AppEvent::Custom { payload, .. } = event {
        payload
            .get("recipient_user_ids")
            .and_then(|v| serde_json::from_value::<Vec<Uuid>>(v.clone()).ok())
            .filter(|v| !v.is_empty())
    } else {
        None
    }
}

/// Worker qui écoute l'EventBus et forward vers le WsHub.
pub async fn event_to_ws_worker(bus: Arc<EventBus>, hub: Arc<WsHub>) {
    let mut rx = bus.subscribe();
    loop {
        match rx.recv().await {
            Ok(envelope) => {
                // Facts published for the server's own consumption never leave
                // the process. The bus is a broadcast to every connected
                // client, so an administrative refusal reaching it would be
                // delivered to everybody's browser.
                if envelope.meta.internal {
                    continue;
                }
                // Only the event travels to the browser: the metadata (source
                // module, rule-feedback depth) is server-side bookkeeping.
                let event = &envelope.event;
                if let Ok(payload) = serde_json::to_value(event) {
                    let msg = WsMessage {
                        r#type:  "event".to_string(),
                        module:  None,
                        payload,
                    };
                    match targeted_recipients(event) {
                        Some(ids) => {
                            for uid in ids {
                                hub.send_to_user(uid, msg.clone()).await;
                            }
                        }
                        None => hub.broadcast(msg).await,
                    }
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!("WS worker en retard de {n} events");
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}
