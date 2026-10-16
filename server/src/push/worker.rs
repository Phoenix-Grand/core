//! Background worker: EventBus → push notifications.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use kubuno_db::dialect::SqlType;
use kubuno_db::{params, DbPool};
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

use crate::events::EventBus;
use crate::push::{mapping, unifiedpush::UnifiedPush, PushNotification, PushProvider};

pub async fn push_worker(bus: Arc<EventBus>, db: DbPool) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let unifiedpush = UnifiedPush;

    let mut rx = bus.subscribe();
    loop {
        match rx.recv().await {
            Ok(envelope) => {
                // Server-side facts (the audit bridge) are never notifications.
                if envelope.meta.internal {
                    continue;
                }
                if let Some(notif) = mapping::event_to_push(&envelope.event) {
                    deliver(&client, &db, &unifiedpush, &notif).await;
                }
            }
            Err(RecvError::Lagged(n)) => {
                tracing::warn!("Worker push en retard de {n} events");
            }
            Err(RecvError::Closed) => break,
        }
    }
}

async fn deliver(
    client: &reqwest::Client,
    db: &DbPool,
    unifiedpush: &UnifiedPush,
    notif: &PushNotification,
) {
    for &user_id in &notif.user_ids {
        if !preference_enabled(db, user_id, &notif.module, &notif.event_type).await {
            continue;
        }

        let devices = match db
            .fetch_all_as::<(Uuid, String, String)>(
                "SELECT id, provider, device_token FROM core.push_devices WHERE user_id = $1",
                params![user_id],
            )
            .await
        {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(error = %e, "Lecture push_devices échouée");
                continue;
            }
        };

        for (device_id, provider, token) in devices {
            let result = match provider.as_str() {
                "unifiedpush" => unifiedpush.send(client, &token, notif).await,
                // APNs/FCM acceptés à l'enregistrement, livraison ajoutée plus tard.
                other => {
                    tracing::debug!(provider = %other, "Provider push non encore implémenté - device ignoré");
                    continue;
                }
            };

            match result {
                Ok(true) => {
                    let _ = db
                        .execute(
                            "UPDATE core.push_devices SET last_seen_at = $1 WHERE id = $2",
                            params![Utc::now(), device_id],
                        )
                        .await;
                }
                Ok(false) => {
                    // Endpoint gone (404/410) → purge the device.
                    let _ = db
                        .execute(
                            "DELETE FROM core.push_devices WHERE id = $1",
                            params![device_id],
                        )
                        .await;
                    tracing::info!(%device_id, "Push device purged (endpoint gone)");
                }
                Err(e) => {
                    tracing::warn!(error = %e, %device_id, "Envoi push échoué");
                }
            }
        }
    }
}

/// Push enabled unless an opt-out row matches. The most specific row wins.
async fn preference_enabled(db: &DbPool, user_id: Uuid, module: &str, event_type: &str) -> bool {
    let backend = db.backend();
    // Boolean-to-int cast in the ORDER BY specificity score, made portable.
    let module_specificity = backend.cast("module_id <> '*'", SqlType::Int);
    let event_specificity = backend.cast("event_type <> '*'", SqlType::Int);
    let sql = format!(
        r#"SELECT enabled FROM core.push_preferences
           WHERE user_id = $1
             AND module_id IN ($2, '*')
             AND event_type IN ($3, '*')
           ORDER BY ({module_specificity} + {event_specificity}) DESC
           LIMIT 1"#
    );
    db.fetch_optional_scalar::<bool>(&sql, params![user_id, module, event_type])
        .await
        .ok()
        .flatten()
        .unwrap_or(true)
}
