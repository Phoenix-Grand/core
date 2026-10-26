//! Maps an `AppEvent` to a user-facing push notification.
//!
//! Only events with a clear recipient produce a notification; internal events
//! (module lifecycle, etc.) return `None`. A `Custom` event may carry
//! `recipient_user_ids` to address several users explicitly.

use uuid::Uuid;

use crate::events::AppEvent;
use crate::push::PushNotification;

pub fn event_to_push(event: &AppEvent) -> Option<PushNotification> {
    match event {
        AppEvent::UserUpdated { user_id, .. } => Some(PushNotification {
            user_ids: vec![*user_id],
            event_type: "user_updated".into(),
            module: "core".into(),
            title: "Profile updated".into(),
            body: "Your profile has changed.".into(),
            resource_id: None,
        }),
        AppEvent::FileUploaded { file_id, user_id, module_id, .. } => Some(PushNotification {
            user_ids: vec![*user_id],
            event_type: "file_uploaded".into(),
            module: module_id.clone(),
            title: "New file".into(),
            body: "A file was added.".into(),
            resource_id: Some(file_id.to_string()),
        }),
        AppEvent::FileDeleted { file_id, user_id, module_id, .. } => Some(PushNotification {
            user_ids: vec![*user_id],
            event_type: "file_deleted".into(),
            module: module_id.clone(),
            title: "File deleted".into(),
            body: "A file was deleted.".into(),
            resource_id: Some(file_id.to_string()),
        }),
        AppEvent::ShareCreated { share_id, user_id, module_id, .. } => Some(PushNotification {
            user_ids: vec![*user_id],
            event_type: "share_created".into(),
            module: module_id.clone(),
            title: "New share".into(),
            body: "A share was created.".into(),
            resource_id: Some(share_id.to_string()),
        }),
        AppEvent::EventCreated { event_id, user_id, module_id, .. } => Some(PushNotification {
            user_ids: vec![*user_id],
            event_type: "event_created".into(),
            module: module_id.clone(),
            title: "New event".into(),
            body: "An event was added to your calendar.".into(),
            resource_id: Some(event_id.to_string()),
        }),
        AppEvent::TaskCompleted { task_id, user_id, module_id, .. } => Some(PushNotification {
            user_ids: vec![*user_id],
            event_type: "task_completed".into(),
            module: module_id.clone(),
            title: "Task completed".into(),
            body: "A task was marked as complete.".into(),
            resource_id: Some(task_id.to_string()),
        }),
        AppEvent::Custom { event_type, module_id, payload } => {
            let user_ids: Vec<Uuid> = payload
                .get("recipient_user_ids")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            if user_ids.is_empty() {
                return None;
            }
            Some(PushNotification {
                user_ids,
                event_type: event_type.clone(),
                module: module_id.clone(),
                title: payload.get("title").and_then(|v| v.as_str()).unwrap_or("Notification").to_string(),
                body: payload.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                resource_id: payload.get("resource_id").and_then(|v| v.as_str()).map(|s| s.to_string()),
            })
        }
        // Internal / non-actionable events.
        _ => None,
    }
}
