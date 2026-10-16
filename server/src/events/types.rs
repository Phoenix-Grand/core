use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum AppEvent {
    // Core → modules
    UserCreated     { user_id: Uuid, email: String },
    UserDeleted     { user_id: Uuid },
    UserUpdated     { user_id: Uuid, fields: Vec<String> },
    QuotaUpdated    { user_id: Uuid, used_bytes: i64, quota_bytes: i64 },

    // Module → core + autres modules
    FileUploaded    { file_id: Uuid, user_id: Uuid, mime_type: String, size_bytes: i64, module_id: String },
    FileDeleted     { file_id: Uuid, user_id: Uuid, module_id: String },
    FileMoved       { file_id: Uuid, user_id: Uuid, module_id: String },
    ShareCreated    { share_id: Uuid, user_id: Uuid, token: String, resource_type: String, module_id: String },
    ShareRevoked    { share_id: Uuid, module_id: String },

    // Modules métier
    MessageSent     { chat_id: Uuid, from_user_id: Uuid, module_id: String },
    TaskCreated     { task_id: Uuid, user_id: Uuid, module_id: String },
    TaskUpdated     { task_id: Uuid, user_id: Uuid, module_id: String },
    TaskDeleted     { task_id: Uuid, user_id: Uuid, module_id: String },
    TaskCompleted   { task_id: Uuid, user_id: Uuid, module_id: String },
    EventCreated    { event_id: Uuid, user_id: Uuid, module_id: String },
    FormSubmitted   { form_id: Uuid, response_id: Uuid, module_id: String },
    NoteCreated     { note_id: Uuid, user_id: Uuid, module_id: String },
    PhotoImported   { photo_id: Uuid, user_id: Uuid, module_id: String },
    AiIndexRequested { resource_id: Uuid, resource_type: String, user_id: Uuid, module_id: String },
    ContactUpdated  { contact_id: Uuid, user_id: Uuid, module_id: String },

    /// A setting changed at one scope. Emitted by every scoped write, including
    /// "revert to inherited" (`value_set = false`) and lock changes.
    ///
    /// The value itself is deliberately absent: this event reaches every module
    /// and the WebSocket hub, and some settings hold credentials. Subscribers
    /// that need the new value re-read it through the resolver for the scope
    /// they care about - which is also the only way to get inheritance right.
    SettingChanged {
        key:        String,
        scope_type: String,
        scope_id:   Option<Uuid>,
        /// Owning module, `None` for a core setting.
        module_id:  Option<String>,
        /// `false` when the scope went back to inheriting.
        value_set:  bool,
        locked:     bool,
    },

    // Core interne
    ModuleRegistered    { module_id: String, base_url: String },
    ModuleUnregistered  { module_id: String },
    ModuleHealthChanged { module_id: String, status: String },

    // Générique
    Custom { event_type: String, module_id: String, payload: serde_json::Value },
}
