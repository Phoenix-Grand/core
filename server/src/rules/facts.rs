//! Turning an event into the flat JSON object a rule is evaluated against.
//!
//! The engine never matches on a Rust type. It matches on **facts**: a JSON
//! object whose keys are exactly what the trigger's catalogue entry declares as
//! queryable. That indirection is what keeps the core module-agnostic - a
//! module's event is a `Custom` envelope carrying an arbitrary payload, and the
//! only thing the core does with it is flatten it and hand it to the evaluator.
//!
//! ```text
//!   AppEvent::Custom{ event_type: "office.document_shared",
//!                     module_id: "office",
//!                     payload: { "document_id": …, "user_id": … } }
//!            │
//!            ▼   facts_of()
//!   { "event_type": "office.document_shared", "source_module": "office",
//!     "depth": 0, "document_id": …, "user_id": … }
//! ```
//!
//! Nothing here is persisted. The facts exist for the length of one evaluation;
//! what survives is the structural reference the execution row keeps (which
//! account, which resource), never the values a rule inspected.

use serde_json::{Map, Value};
use uuid::Uuid;

use crate::events::{bus, AppEvent, EventEnvelope};

/// Keys that identify the account an event is *about*, in order of preference.
const SUBJECT_KEYS: &[&str] = &["subject_user_id", "user_id", "actor_user_id", "from_user_id"];

/// One evaluation's input, plus the structural references the execution log
/// keeps once the values are gone.
#[derive(Debug, Clone)]
pub struct Facts {
    pub event_type: String,
    pub values: Value,
    pub subject_user_id: Option<Uuid>,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub depth: u16,
}

impl Facts {
    /// Identity used to count threshold hits and to place a subject inside or
    /// outside a progressive rollout.
    ///
    /// Falls back to the resource, then to the event type, so a rule with a
    /// threshold on an event that names nobody still counts *something* stable
    /// rather than silently counting everything as one.
    pub fn subject_key(&self) -> String {
        if let Some(id) = self.subject_user_id {
            return format!("user:{id}");
        }
        match (&self.resource_type, &self.resource_id) {
            (Some(kind), Some(id)) => format!("{kind}:{id}"),
            _ => format!("event:{}", self.event_type),
        }
    }
}

/// Builds the facts for an event delivered on the bus.
pub fn facts_of(envelope: &EventEnvelope) -> Facts {
    let event_type = bus::event_type_name(&envelope.event);
    let mut values = flatten(&envelope.event);

    let subject_user_id = SUBJECT_KEYS
        .iter()
        .find_map(|k| values.get(*k).and_then(parse_uuid));
    let (resource_type, resource_id) = resource_of(&values);

    if let Value::Object(map) = &mut values {
        map.insert("event_type".into(), Value::String(event_type.clone()));
        map.insert(
            "source_module".into(),
            match &envelope.meta.source_module {
                Some(m) => Value::String(m.clone()),
                None => Value::String("core".into()),
            },
        );
        map.insert("depth".into(), Value::from(envelope.meta.depth));
    }

    Facts {
        event_type,
        values,
        subject_user_id,
        resource_type,
        resource_id,
        depth: envelope.meta.depth,
    }
}

/// Same, for a row replayed out of `core.event_log` by a backtest.
///
/// The stored payload is the serialised `AppEvent`, so the flattening is the
/// same one the live path applies - there is deliberately no second reader.
pub fn facts_of_logged(
    event_type: &str,
    source_module: Option<&str>,
    payload: &Value,
    depth: u16,
) -> Facts {
    let mut values = flatten_payload(payload);

    let subject_user_id = SUBJECT_KEYS
        .iter()
        .find_map(|k| values.get(*k).and_then(parse_uuid));
    let (resource_type, resource_id) = resource_of(&values);

    if let Value::Object(map) = &mut values {
        map.insert("event_type".into(), Value::String(event_type.to_string()));
        map.insert(
            "source_module".into(),
            Value::String(source_module.unwrap_or("core").to_string()),
        );
        map.insert("depth".into(), Value::from(depth));
    }

    Facts {
        event_type: event_type.to_string(),
        values,
        subject_user_id,
        resource_type,
        resource_id,
        depth,
    }
}

/// Serialises the event and lifts its content to the top level.
fn flatten(event: &AppEvent) -> Value {
    let raw = serde_json::to_value(event).unwrap_or(Value::Null);
    flatten_payload(&raw)
}

/// `AppEvent` serialises as `{"type": …, "payload": {…}}`; a `Custom` nests one
/// level further, its real payload sitting under `payload.payload`. Both are
/// lifted so a rule writes `document_id`, never `payload.payload.document_id`.
fn flatten_payload(raw: &Value) -> Value {
    let content = raw.get("payload").unwrap_or(raw);
    let inner = match (content.get("event_type"), content.get("payload")) {
        // The `Custom` shape: an event type, a module, and the module's own object.
        (Some(Value::String(_)), Some(Value::Object(_))) => content
            .get("payload")
            .unwrap_or(content),
        _ => content,
    };
    match inner {
        Value::Object(map) => Value::Object(map.clone()),
        _ => Value::Object(Map::new()),
    }
}

fn parse_uuid(value: &Value) -> Option<Uuid> {
    value.as_str().and_then(|s| Uuid::parse_str(s).ok())
}

/// Best-effort structural reference: the first `<thing>_id` key that is not an
/// account identifier. Module-agnostic on purpose - the core has no table of
/// what a module's resources are called, and never should.
fn resource_of(values: &Value) -> (Option<String>, Option<String>) {
    let Value::Object(map) = values else {
        return (None, None);
    };
    // An emitter may state it outright, which always wins over the guess.
    if let (Some(Value::String(kind)), Some(id)) = (map.get("resource_type"), map.get("resource_id"))
    {
        return (Some(kind.clone()), stringify(id));
    }
    for (key, value) in map {
        if SUBJECT_KEYS.contains(&key.as_str()) {
            continue;
        }
        if let Some(kind) = key.strip_suffix("_id") {
            if let Some(id) = stringify(value) {
                return (Some(kind.to_string()), Some(id));
            }
        }
    }
    (None, None)
}

fn stringify(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventMeta;
    use serde_json::json;

    fn envelope(event: AppEvent, meta: EventMeta) -> EventEnvelope {
        EventEnvelope { event, meta }
    }

    #[test]
    fn a_core_event_flattens_to_its_payload_plus_the_context() {
        let uid = Uuid::from_bytes([3; 16]);
        let f = facts_of(&envelope(
            AppEvent::UserCreated {
                user_id: uid,
                email: "Alice@example.org".into(),
            },
            EventMeta::default(),
        ));

        assert_eq!(f.event_type, "UserCreated");
        assert_eq!(f.values["email"], json!("Alice@example.org"));
        assert_eq!(f.values["event_type"], json!("UserCreated"));
        assert_eq!(f.values["source_module"], json!("core"));
        assert_eq!(f.values["depth"], json!(0));
        assert_eq!(f.subject_user_id, Some(uid));
        assert_eq!(f.subject_key(), format!("user:{uid}"));
    }

    #[test]
    fn a_module_event_is_flattened_without_the_core_knowing_the_module() {
        let uid = Uuid::from_bytes([4; 16]);
        let f = facts_of(&envelope(
            AppEvent::Custom {
                event_type: "office.document_shared".into(),
                module_id: "office".into(),
                payload: json!({ "document_id": "doc-7", "user_id": uid, "public": true }),
            },
            EventMeta::from_module("office"),
        ));

        // The real type, not `Custom` - the defect fixed in `events::bus`.
        assert_eq!(f.event_type, "office.document_shared");
        assert_eq!(f.values["document_id"], json!("doc-7"));
        assert_eq!(f.values["public"], json!(true));
        assert_eq!(f.values["source_module"], json!("office"));
        assert_eq!(f.subject_user_id, Some(uid));
        assert_eq!(f.resource_type.as_deref(), Some("document"));
        assert_eq!(f.resource_id.as_deref(), Some("doc-7"));
    }

    #[test]
    fn the_depth_travels_into_the_facts_so_a_rule_can_see_it() {
        let f = facts_of(&envelope(
            AppEvent::SettingChanged {
                key: "security.max_sessions".into(),
                scope_type: "instance".into(),
                scope_id: None,
                module_id: None,
                value_set: true,
                locked: false,
            },
            EventMeta::caused_by_rule(Uuid::from_bytes([1; 16]), 1),
        ));
        assert_eq!(f.depth, 2);
        assert_eq!(f.values["depth"], json!(2));
        assert_eq!(f.values["key"], json!("security.max_sessions"));
    }

    #[test]
    fn replaying_a_logged_row_produces_the_same_shape_as_the_live_path() {
        let uid = Uuid::from_bytes([5; 16]);
        let live = facts_of(&envelope(
            AppEvent::Custom {
                event_type: "core.auth.login_failed".into(),
                module_id: "core".into(),
                payload: json!({ "user_id": uid, "reason": "bad_password" }),
            },
            EventMeta::default(),
        ));
        let stored = serde_json::to_value(AppEvent::Custom {
            event_type: "core.auth.login_failed".into(),
            module_id: "core".into(),
            payload: json!({ "user_id": uid, "reason": "bad_password" }),
        })
        .expect("sérialisable");

        let replayed = facts_of_logged("core.auth.login_failed", Some("core"), &stored, 0);
        assert_eq!(replayed.values, live.values);
        assert_eq!(replayed.subject_user_id, live.subject_user_id);
    }

    #[test]
    fn a_subject_less_event_still_has_a_stable_counting_key() {
        let f = facts_of(&envelope(
            AppEvent::ModuleHealthChanged {
                module_id: "drive".into(),
                status: "degraded".into(),
            },
            EventMeta::from_module("drive"),
        ));
        assert_eq!(f.subject_user_id, None);
        // `module_id` is the only `_id` key, so it becomes the resource.
        assert_eq!(f.subject_key(), "module:drive");
    }
}
