//! The in-process event bus, and the two defects of `publish_and_log` that made
//! `core.event_log` unusable for anything but eyeballing.
//!
//! ## Defect 1 - `source_module` was never written
//!
//! The column has existed since migration `000003`. The insert never bound it,
//! so every row on every instance carried `NULL`. "Which module emitted this"
//! was unanswerable from the table that exists to answer it.
//!
//! ## Defect 2 - the stored type was the name of an internal enum variant
//!
//! Modules publish through [`AppEvent::Custom`], whose `event_type` field
//! carries the real type (`office.document_shared`). The logger stored the
//! *variant* name, so nearly every row said `Custom` and filtering by type
//! selected almost everything or almost nothing. [`event_type_name`] now
//! returns the inner type for `Custom`, which is what every reader assumed it
//! was reading all along.
//!
//! Both are fixed here rather than at the call sites: there is one logger, and
//! a fix in one place cannot be forgotten by the next caller.
//!
//! ## The envelope
//!
//! Subscribers receive an [`EventEnvelope`]: the event plus the metadata the
//! event itself cannot carry - where it came from, and **how deep in a chain of
//! rule actions it is**. A rule action that changes a setting emits an event
//! that is itself a trigger; without a counter travelling alongside, the loop is
//! invisible until it has run a few thousand times. See
//! [`crate::rules::engine`] for the guard that reads it.

use std::sync::Arc;

use kubuno_db::{params, DbPool};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use super::AppEvent;

/// What travels with an event but is not part of it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EventMeta {
    /// Module that emitted the event. `None` means the core.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_module: Option<String>,
    /// How many rule actions deep this event is. `0` for anything a human or a
    /// module did on its own.
    #[serde(default)]
    pub depth: u16,
    /// The rule whose action caused this event, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause_rule_id: Option<Uuid>,
    /// Server-side only: never delivered to a browser or a push device.
    ///
    /// The bus has always been a broadcast to every connected client, which is
    /// fine for "a file was uploaded" and catastrophic for "an administrator's
    /// sign-in was refused". Facts that exist so the **server** can react to
    /// them - the audit bridge in [`crate::audit`] - carry this flag, and the
    /// WebSocket and push workers drop them before they leave the process.
    #[serde(default)]
    pub internal: bool,
}

impl EventMeta {
    pub fn from_module(module_id: impl Into<String>) -> Self {
        Self {
            source_module: Some(module_id.into()),
            ..Default::default()
        }
    }

    /// Metadata for an event emitted *by* a rule action: one level deeper, and
    /// carrying the rule that caused it.
    pub fn caused_by_rule(rule_id: Uuid, parent_depth: u16) -> Self {
        Self {
            source_module: None,
            depth: parent_depth.saturating_add(1),
            cause_rule_id: Some(rule_id),
            internal: false,
        }
    }

    /// Metadata for a fact the server publishes for its own consumption.
    pub fn internal() -> Self {
        Self {
            internal: true,
            ..Default::default()
        }
    }
}

/// An event and its metadata, as delivered to subscribers.
#[derive(Debug, Clone)]
pub struct EventEnvelope {
    pub event: AppEvent,
    pub meta: EventMeta,
}

pub struct EventBus {
    sender: broadcast::Sender<Arc<EventEnvelope>>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    /// Publishes an event with no particular provenance.
    pub fn publish(&self, event: AppEvent) -> usize {
        self.publish_with(event, EventMeta::default())
    }

    /// Publishes an event together with its metadata.
    pub fn publish_with(&self, event: AppEvent, meta: EventMeta) -> usize {
        self.sender
            .send(Arc::new(EventEnvelope { event, meta }))
            .unwrap_or(0)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<EventEnvelope>> {
        self.sender.subscribe()
    }

    pub async fn publish_and_log(&self, event: AppEvent, db: &DbPool) {
        self.publish_and_log_with(event, EventMeta::default(), db).await
    }

    /// Publishes, then records the event in `core.event_log`.
    ///
    /// The log write is best-effort: an unavailable database must not silence
    /// the bus, which several features depend on for correctness.
    pub async fn publish_and_log_with(&self, event: AppEvent, meta: EventMeta, db: &DbPool) {
        log_event(db, &event, &meta).await;
        self.publish_with(event, meta);
    }
}

/// Appends one row to `core.event_log`.
///
/// Split out of [`EventBus::publish_and_log_with`] because the audit bridge
/// ([`crate::audit`]) has a pool but no bus, and an event that reaches the
/// engine without reaching the log cannot be replayed by a backtest - the two
/// must not drift apart.
///
/// Best-effort: an unavailable database must not silence the bus, which several
/// features depend on for correctness.
pub async fn log_event(db: &DbPool, event: &AppEvent, meta: &EventMeta) {
    let event_type = event_type_name(event);
    let source_module = source_module_of(event, meta);
    let payload = serde_json::to_value(event).unwrap_or_default();
    let depth = i16::try_from(meta.depth).unwrap_or(i16::MAX);

    if let Err(e) = db
        .execute(
            "INSERT INTO core.event_log (event_type, source_module, payload, depth, cause_rule_id)
         VALUES ($1, $2, $3, $4, $5)",
            params![
                &event_type,
                source_module.as_deref(),
                payload,
                depth,
                meta.cause_rule_id
            ],
        )
        .await
    {
        tracing::error!(error = %e, event_type = %event_type, "Failed to log event to the database");
    }
}

/// The event's type **as a reader expects it**.
///
/// For [`AppEvent::Custom`] that is the inner `event_type`, not the string
/// `"Custom"`: modules publish through that variant, so storing the variant name
/// collapsed most of the log into one useless label.
pub fn event_type_name(event: &AppEvent) -> String {
    match event {
        AppEvent::Custom { event_type, .. } => event_type.clone(),
        other => variant_name(other).to_string(),
    }
}

/// Name of the enum variant. Kept separate from [`event_type_name`] so the
/// distinction between "the shape on the bus" and "the type a rule matches on"
/// stays explicit.
pub fn variant_name(event: &AppEvent) -> &'static str {
    match event {
        AppEvent::UserCreated { .. } => "UserCreated",
        AppEvent::UserDeleted { .. } => "UserDeleted",
        AppEvent::UserUpdated { .. } => "UserUpdated",
        AppEvent::QuotaUpdated { .. } => "QuotaUpdated",
        AppEvent::FileUploaded { .. } => "FileUploaded",
        AppEvent::FileDeleted { .. } => "FileDeleted",
        AppEvent::FileMoved { .. } => "FileMoved",
        AppEvent::ShareCreated { .. } => "ShareCreated",
        AppEvent::ShareRevoked { .. } => "ShareRevoked",
        AppEvent::MessageSent { .. } => "MessageSent",
        AppEvent::TaskCreated { .. } => "TaskCreated",
        AppEvent::TaskUpdated { .. } => "TaskUpdated",
        AppEvent::TaskDeleted { .. } => "TaskDeleted",
        AppEvent::TaskCompleted { .. } => "TaskCompleted",
        AppEvent::EventCreated { .. } => "EventCreated",
        AppEvent::FormSubmitted { .. } => "FormSubmitted",
        AppEvent::NoteCreated { .. } => "NoteCreated",
        AppEvent::PhotoImported { .. } => "PhotoImported",
        AppEvent::AiIndexRequested { .. } => "AiIndexRequested",
        AppEvent::ContactUpdated { .. } => "ContactUpdated",
        AppEvent::SettingChanged { .. } => "SettingChanged",
        AppEvent::ModuleRegistered { .. } => "ModuleRegistered",
        AppEvent::ModuleUnregistered { .. } => "ModuleUnregistered",
        AppEvent::ModuleHealthChanged { .. } => "ModuleHealthChanged",
        AppEvent::Custom { .. } => "Custom",
    }
}

/// Which module emitted the event.
///
/// Prefers the explicit metadata, then the `module_id` the payload already
/// carries for most variants, and falls back to `None` - the core.
fn source_module_of(event: &AppEvent, meta: &EventMeta) -> Option<String> {
    if let Some(m) = &meta.source_module {
        return Some(m.clone());
    }
    match event {
        AppEvent::FileUploaded { module_id, .. }
        | AppEvent::FileDeleted { module_id, .. }
        | AppEvent::FileMoved { module_id, .. }
        | AppEvent::ShareCreated { module_id, .. }
        | AppEvent::ShareRevoked { module_id, .. }
        | AppEvent::MessageSent { module_id, .. }
        | AppEvent::TaskCreated { module_id, .. }
        | AppEvent::TaskUpdated { module_id, .. }
        | AppEvent::TaskDeleted { module_id, .. }
        | AppEvent::TaskCompleted { module_id, .. }
        | AppEvent::EventCreated { module_id, .. }
        | AppEvent::FormSubmitted { module_id, .. }
        | AppEvent::NoteCreated { module_id, .. }
        | AppEvent::PhotoImported { module_id, .. }
        | AppEvent::AiIndexRequested { module_id, .. }
        | AppEvent::ContactUpdated { module_id, .. }
        | AppEvent::ModuleRegistered { module_id, .. }
        | AppEvent::ModuleUnregistered { module_id }
        | AppEvent::ModuleHealthChanged { module_id, .. }
        | AppEvent::Custom { module_id, .. } => Some(module_id.clone()),
        AppEvent::SettingChanged { module_id, .. } => module_id.clone(),
        AppEvent::UserCreated { .. }
        | AppEvent::UserDeleted { .. }
        | AppEvent::UserUpdated { .. }
        | AppEvent::QuotaUpdated { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_custom_event_is_logged_under_its_real_type_not_under_custom() {
        // The defect: four rows out of five said `Custom`, and the type a
        // reader actually wanted was buried in the payload.
        let event = AppEvent::Custom {
            event_type: "office.document_shared".into(),
            module_id: "office".into(),
            payload: json!({}),
        };
        assert_eq!(event_type_name(&event), "office.document_shared");
        assert_eq!(variant_name(&event), "Custom");
    }

    #[test]
    fn a_core_event_keeps_its_variant_name() {
        let event = AppEvent::UserCreated {
            user_id: Uuid::nil(),
            email: "a@b.test".into(),
        };
        assert_eq!(event_type_name(&event), "UserCreated");
    }

    #[test]
    fn the_source_module_is_recovered_from_the_payload_or_the_metadata() {
        // From the payload, for every variant that carries one…
        let from_payload = AppEvent::Custom {
            event_type: "drive.file_scanned".into(),
            module_id: "drive".into(),
            payload: json!({}),
        };
        assert_eq!(
            source_module_of(&from_payload, &EventMeta::default()).as_deref(),
            Some("drive")
        );

        // …from the metadata when the caller states it explicitly…
        let core_event = AppEvent::UserDeleted { user_id: Uuid::nil() };
        assert_eq!(
            source_module_of(&core_event, &EventMeta::from_module("mail")).as_deref(),
            Some("mail")
        );

        // …and `None` for a core event nobody attributed, which is the core.
        assert_eq!(source_module_of(&core_event, &EventMeta::default()), None);
    }

    #[test]
    fn a_rule_caused_event_carries_one_more_level_of_depth() {
        let rule = Uuid::from_bytes([7; 16]);
        let meta = EventMeta::caused_by_rule(rule, 2);
        assert_eq!(meta.depth, 3);
        assert_eq!(meta.cause_rule_id, Some(rule));
        // Saturating rather than wrapping: an overflow that resets the counter
        // to zero would disarm the loop guard exactly when it is needed.
        assert_eq!(EventMeta::caused_by_rule(rule, u16::MAX).depth, u16::MAX);
    }

    #[test]
    fn the_bus_delivers_the_envelope_to_its_subscribers() {
        let bus = EventBus::new(8);
        let mut rx = bus.subscribe();
        bus.publish_with(
            AppEvent::UserDeleted { user_id: Uuid::nil() },
            EventMeta::from_module("drive"),
        );
        let env = rx.try_recv().expect("un envelope publié");
        assert_eq!(env.meta.source_module.as_deref(), Some("drive"));
        assert_eq!(variant_name(&env.event), "UserDeleted");
    }
}
