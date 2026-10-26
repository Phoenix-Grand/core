//! What the **core** contributes to the catalogue.
//!
//! This file is the core acting as one more module. Everything here goes
//! through [`super::catalog::register_core`], which is
//! [`super::catalog::register_module`] with one different argument - the same
//! validation, the same forced prefixing, the same two tables, the same orphan
//! handling. If this file were deleted the engine would still work; it would
//! simply have nothing of the core's own to offer.
//!
//! That is the test of the design: nothing in `crate::rules` names a module,
//! and the only module identifier written anywhere in it is the `"core"` of
//! [`super::catalog::CORE_NAMESPACE`], used right here.

use kubuno_db::DbPool;

use crate::errors::AppError;

use super::catalog::{self, ActionDef, FieldDef, ParamDef, TriggerDef};
use super::condition::Operator;

/// Event types the core publishes purely so a rule can react to them.
///
/// They travel as [`crate::events::AppEvent::Custom`], which is the same vehicle
/// a module uses - the engine cannot tell the difference, and that is the point.
///
/// The first two are produced by the **audit bridge** (see
/// [`crate::audit::AuditContext::record`]): whatever the trail records outside a
/// mutation is republished under its own action name. That is why the core did
/// not have to grow a `publish` call in the sign-in path to gain a trigger on
/// refused sign-ins.
pub mod events {
    /// Written by the trail whenever an administrator's sign-in is refused.
    pub const LOGIN_FAILED: &str = "core.auth.login_failed";
    /// Written by the `/admin/*` layer guard on a refusal.
    pub const ADMIN_DENIED: &str = "core.admin.denied";
    /// Published by the role-assignment handler after it commits.
    pub const PRIVILEGE_GRANTED: &str = "core.authz.privilege_granted";
    /// Emitted by the `core.notify` action. A rule may react to it like any
    /// other event - which is precisely how a feedback loop gets built, and why
    /// the depth guard exists.
    pub const NOTIFICATION_SENT: &str = "core.rules.notification";
}

/// The fields every audit-bridged trigger carries, because the bridge builds
/// one payload shape for all of them.
fn audit_fields() -> Vec<FieldDef> {
    vec![
        field("user_id", "uuid", "Affected account", STRING_OPS),
        field("actor_user_id", "uuid", "Account making the request", STRING_OPS),
        field("actor_label", "string", "Actor name", STRING_OPS),
        field("actor_origin", "string", "Origin (session, API token…)", STRING_OPS),
        field("outcome", "string", "Outcome (success, denied, error)", STRING_OPS),
        field("reason", "string", "Recorded reason", STRING_OPS),
        field("ip", "string", "Source address", STRING_OPS),
        field("target_type", "string", "Target type", STRING_OPS),
        field("target_label", "string", "Target label", STRING_OPS),
        field("action", "string", "Audited action", STRING_OPS),
    ]
}

const STRING_OPS: &[Operator] = &[
    Operator::Eq,
    Operator::Ne,
    Operator::Contains,
    Operator::NotContains,
    Operator::StartsWith,
    Operator::EndsWith,
    Operator::In,
    Operator::NotIn,
    Operator::Exists,
    Operator::NotExists,
];

const NUMBER_OPS: &[Operator] = &[
    Operator::Eq,
    Operator::Ne,
    Operator::Lt,
    Operator::Lte,
    Operator::Gt,
    Operator::Gte,
];

const BOOL_OPS: &[Operator] = &[Operator::IsTrue, Operator::IsFalse, Operator::Eq];

fn field(name: &str, value_type: &str, label: &str, ops: &[Operator]) -> FieldDef {
    FieldDef {
        name: name.to_string(),
        value_type: value_type.to_string(),
        label: label.to_string(),
        operators: ops.to_vec(),
    }
}

/// Fields every trigger carries, because [`super::facts`] adds them to every
/// fact regardless of the event.
fn ambient_fields() -> Vec<FieldDef> {
    vec![
        field("event_type", "string", "Event type", STRING_OPS),
        field("source_module", "string", "Source module", STRING_OPS),
        field(
            "depth",
            "number",
            "Feedback depth (0 = human action)",
            NUMBER_OPS,
        ),
    ]
}

/// A **content part**: text the synchronous gate submits for inspection.
///
/// No operator, deliberately - see [`catalog::CONTENT_TYPE`]. A part is
/// something a detector reads, never something a comparison touches.
fn content_part(name: &str, label: &str) -> FieldDef {
    FieldDef {
        name: name.to_string(),
        value_type: catalog::CONTENT_TYPE.to_string(),
        label: label.to_string(),
        operators: Vec::new(),
    }
}

fn trigger(key: &str, event_type: &str, label: &str, description: &str, mut fields: Vec<FieldDef>) -> TriggerDef {
    fields.extend(ambient_fields());
    TriggerDef {
        key: key.to_string(),
        event_type: event_type.to_string(),
        label: label.to_string(),
        description: Some(description.to_string()),
        fields,
    }
}

/// The core's triggers.
pub fn triggers() -> Vec<TriggerDef> {
    vec![
        trigger(
            "account_created",
            "UserCreated",
            "Account created",
            "A user account was created through registration or by an administrator.",
            vec![
                field("user_id", "uuid", "Account ID", STRING_OPS),
                field("email", "string", "Account address", STRING_OPS),
            ],
        ),
        trigger(
            "account_updated",
            "UserUpdated",
            "Account updated",
            "An account was updated. `fields` lists the changed fields.",
            vec![field("user_id", "uuid", "Account ID", STRING_OPS)],
        ),
        trigger(
            "login_failed",
            events::LOGIN_FAILED,
            "Sign-in failed",
            "An administrator sign-in attempt failed. Combine this with an 'N times in T' threshold to respond to credential stuffing.",
            audit_fields(),
        ),
        trigger(
            "admin_call_denied",
            events::ADMIN_DENIED,
            "Administrative request denied",
            "An administrative request was denied for lack of privileges. A burst from the same account deserves attention.",
            audit_fields(),
        ),
        trigger(
            "setting_changed",
            "SettingChanged",
            "Setting changed",
            "A setting changed at a scope. Its value is never sent: the event reaches every module, and some settings contain credentials.",
            vec![
                field("key", "string", "Setting key", STRING_OPS),
                field("scope_type", "string", "Scope", STRING_OPS),
                field("module_id", "string", "Owning module", STRING_OPS),
                field("locked", "bool", "Locked", BOOL_OPS),
                field("value_set", "bool", "Value set (false = return to inheritance)", BOOL_OPS),
            ],
        ),
        trigger(
            "privilege_granted",
            events::PRIVILEGE_GRANTED,
            "Privilege granted",
            "An administrative role was assigned to an account or group.",
            vec![
                field("user_id", "uuid", "Recipient account", STRING_OPS),
                field("group_id", "uuid", "Recipient group", STRING_OPS),
                field("role_slug", "string", "Assigned role", STRING_OPS),
                field("role_name", "string", "Role name", STRING_OPS),
                field("scope", "string", "Assignment scope", STRING_OPS),
                field("granted_by", "uuid", "Granting account", STRING_OPS),
            ],
        ),
        trigger(
            "notification_sent",
            events::NOTIFICATION_SENT,
            "Notification sent by a rule",
            "A rule notified an account. Reacting to this event creates a chain: 'depth' indicates the feedback depth, and the engine stops beyond the configured limit.",
            vec![
                field("user_id", "uuid", "Notified account", STRING_OPS),
                field("title", "string", "Notification title", STRING_OPS),
                field("rule_id", "uuid", "Originating rule", STRING_OPS),
            ],
        ),
        // ── The gate's own trigger ───────────────────────────────────────────
        // Declared by the core through the ordinary path, like everything else
        // here. Its `event_type` names no bus event on purpose: nothing
        // publishes `core.rules.gate`, so a rule attached to it is reachable
        // **only** through `POST /internal/rules/gate` - which is what makes
        // "this rule can stop an operation" a property of the rule rather than
        // a mode of the engine.
        //
        // A module that wants richer parts (an attachment's extracted text, a
        // spreadsheet cell range) declares its own trigger with its own content
        // fields. This one is the general-purpose entry every module can use on
        // day one without the core knowing it exists.
        TriggerDef {
            key: "content_gate".into(),
            event_type: "core.rules.gate".into(),
            label: "Content submitted before committing (gate)".into(),
            description: Some(
                "Before committing an operation, a module asks whether it is allowed. A rule attached to this trigger can allow, warn, or block it. Content parts are inspected and then discarded; they are never logged or stored.".into(),
            ),
            fields: {
                let mut fields = vec![
                    field("operation", "string", "Requested operation (send, share, export…)", STRING_OPS),
                    field("module", "string", "Requesting module", STRING_OPS),
                    field("actor_user_id", "uuid", "Account initiating the operation", STRING_OPS),
                    field("destination", "string", "Destination (internal, external, public…)", STRING_OPS),
                    field("recipient_domain", "string", "Recipient domain", STRING_OPS),
                    field("recipient_count", "number", "Recipient count", NUMBER_OPS),
                    field("mime_type", "string", "Content type", STRING_OPS),
                    field("size", "number", "Size in bytes", NUMBER_OPS),
                    // Content parts. They declare NO operator, which is what
                    // makes a comparison against them refused at write time -
                    // and content never enters the facts, so there would be
                    // nothing to compare even if one slipped through. The only
                    // thing a rule may say about them is a detector leaf.
                    content_part("title", "Title or subject"),
                    content_part("body", "Content body"),
                    content_part("attachment_text", "Text extracted from attachments"),
                    content_part("filename", "File name"),
                ];
                fields.extend(ambient_fields());
                fields
            },
        },
        trigger(
            "module_health_changed",
            "ModuleHealthChanged",
            "Module health changed",
            "A module changed from one health state to another.",
            vec![
                field("module_id", "string", "Affected module", STRING_OPS),
                field("status", "string", "New state", STRING_OPS),
            ],
        ),
    ]
}

/// The core's actions.
///
/// `endpoint` is `None` for all of them: the core executes its own actions in
/// process rather than posting to itself over HTTP. See [`super::dispatch`] for
/// why that is the only asymmetry in the mechanism, and why it is not a special
/// case in the catalogue.
pub fn actions() -> Vec<ActionDef> {
    vec![
        ActionDef {
            key: "suspend_account".into(),
            label: "Suspend account".into(),
            description: Some(
                "Disables the account targeted by the event. It can no longer sign in; its data remains intact.".into(),
            ),
            endpoint: None,
            params: vec![ParamDef {
                name: "reason".into(),
                value_type: "string".into(),
                label: "Reason recorded in the audit log".into(),
                required: false,
                values: None,
            }],
            blocking: true,
            reversible: true,
        },
        ActionDef {
            key: "revoke_sessions".into(),
            label: "Revoke sessions".into(),
            description: Some(
                "Invalidates all active sessions of the targeted account. This cannot be undone; devices must sign in again.".into(),
            ),
            endpoint: None,
            params: vec![],
            blocking: false,
            reversible: false,
        },
        ActionDef {
            key: "require_password_change".into(),
            label: "Require password change".into(),
            description: Some(
                "The account must choose a new password at its next sign-in.".into(),
            ),
            endpoint: None,
            params: vec![],
            blocking: false,
            reversible: true,
        },
        ActionDef {
            key: "notify".into(),
            label: "Notify account".into(),
            description: Some(
                "Sends a notification to the targeted account through the WebSocket hub.".into(),
            ),
            endpoint: None,
            params: vec![
                ParamDef {
                    name: "title".into(),
                    value_type: "string".into(),
                    label: "Title".into(),
                    required: true,
                    values: None,
                },
                ParamDef {
                    name: "body".into(),
                    value_type: "string".into(),
                    label: "Message".into(),
                    required: false,
                    values: None,
                },
            ],
            blocking: false,
            reversible: false,
        },
        ActionDef {
            key: "raise_alert".into(),
            label: "Raise an alert".into(),
            description: Some(
                "Opens an alert in the alert center. In simulation mode, the alert is isolated: never counted or notified.".into(),
            ),
            endpoint: None,
            params: vec![
                ParamDef {
                    name: "title".into(),
                    value_type: "string".into(),
                    label: "Alert title".into(),
                    required: true,
                    values: None,
                },
                ParamDef {
                    name: "summary".into(),
                    value_type: "string".into(),
                    label: "Summary".into(),
                    required: false,
                    values: None,
                },
                ParamDef {
                    name: "severity".into(),
                    value_type: "enum".into(),
                    label: "Severity (defaults to the rule's severity)".into(),
                    required: false,
                    values: Some(vec![
                        serde_json::json!("critical"),
                        serde_json::json!("warning"),
                        serde_json::json!("info"),
                    ]),
                },
            ],
            blocking: false,
            reversible: false,
        },
        // ── The two verdicts of the synchronous gate ─────────────────────────
        // Declared through the same path as every other action so the editor
        // offers them without a special case - but *read* rather than
        // dispatched: the gate computes the strongest verdict its matched rules
        // express and answers with it, in the same request. Nothing is
        // enqueued, which is why both are reversible: they change nothing.
        //
        // Neither takes a message parameter, and that is a decision. An
        // administrator-authored sentence would sooner or later say "IBAN
        // detected by rule Finance-03", and the whole point of the response is
        // that a user with a text box cannot map the policy by bisection.
        ActionDef {
            key: "block_operation".into(),
            label: "Block the operation".into(),
            description: Some(
                "Refuses the operation requested by the module. Only takes effect for a gate trigger (content submitted before committing) in 'active with actions' mode. In simulation and observation modes, the rule logs what it would have blocked and allows the operation.".into(),
            ),
            endpoint: None,
            params: vec![],
            blocking: true,
            reversible: true,
        },
        ActionDef {
            key: "warn_operation".into(),
            label: "Warn without blocking".into(),
            description: Some(
                "Allows the operation and returns a warning for the requesting module to show the user. Requires a gate trigger and 'active with actions' mode, just like blocking.".into(),
            ),
            endpoint: None,
            params: vec![],
            blocking: false,
            reversible: true,
        },
    ]
}

/// Registers the core's own catalogue entries. Called once at bootstrap.
pub async fn register(db: &DbPool) -> Result<(), AppError> {
    let mut tx = db.begin().await.map_err(|e| {
        tracing::error!(error = %e, "rules: ouverture de la transaction de déclaration du core");
        AppError::Database(e)
    })?;

    catalog::register_core(&mut tx, &triggers(), &actions()).await?;

    tx.commit().await.map_err(|e| {
        tracing::error!(error = %e, "rules: commit de la déclaration du core");
        AppError::Database(e)
    })?;

    tracing::info!(
        déclencheurs = triggers().len(),
        actions = actions().len(),
        "Catalogue de règles du core déclaré"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_core_declaration_survives_qualification() {
        // The same validation a module's declaration goes through. A typo here
        // would silently drop a trigger at startup, which is exactly the class
        // of bug the shared path exists to catch.
        for t in triggers() {
            assert!(
                !t.key.contains('.'),
                "un déclencheur déclare un nom simple : {}",
                t.key
            );
            assert!(!t.event_type.trim().is_empty(), "{} sans type d'événement", t.key);
            assert!(!t.fields.is_empty(), "{} sans champ interrogeable", t.key);
        }
        for a in actions() {
            assert!(!a.key.contains('.'), "une action déclare un nom simple : {}", a.key);
            // In process, by construction: the core does not call itself over HTTP.
            assert!(a.endpoint.is_none(), "{} ne doit pas déclarer d'endpoint", a.key);
        }
    }

    #[test]
    fn every_field_offers_at_least_one_operator_unless_it_is_content() {
        // A field with no operator is a field no rule can ever compare, which
        // reads in the console as a bug in the engine rather than in the
        // declaration.
        //
        // Content parts are the one exception, and the exception *is* the
        // mechanism: declaring no operator is what makes a comparison against
        // inspected text refused at write time. They may only be read by a
        // detector leaf.
        for t in triggers() {
            for f in &t.fields {
                if f.value_type == catalog::CONTENT_TYPE {
                    assert!(
                        f.operators.is_empty(),
                        "{}.{} est une partie de contenu et ne doit autoriser aucun opérateur",
                        t.key,
                        f.name
                    );
                    continue;
                }
                assert!(
                    !f.operators.is_empty(),
                    "{}.{} n'autorise aucun opérateur",
                    t.key,
                    f.name
                );
            }
        }
    }

    #[test]
    fn the_gate_trigger_carries_content_parts_and_listens_to_no_bus_event() {
        let gate = triggers()
            .into_iter()
            .find(|t| t.key == "content_gate")
            .expect("le déclencheur de portail est déclaré");
        let parts = catalog::content_parts(&gate.fields);
        assert!(
            !parts.is_empty(),
            "un déclencheur de portail sans partie de contenu ne peut porter aucune détection"
        );
        assert!(parts.contains(&"body"));
        // Nothing publishes this type: the trigger is reachable only through
        // the internal gate route.
        assert_eq!(gate.event_type, "core.rules.gate");
    }

    #[test]
    fn the_verdict_actions_take_no_message_parameter() {
        // An administrator-authored sentence would eventually name the rule,
        // and the response is the one surface a user can probe.
        let acts = actions();
        for key in ["block_operation", "warn_operation"] {
            let a = acts.iter().find(|a| a.key == key).expect("action déclarée");
            assert!(a.params.is_empty(), "{key} ne doit prendre aucun paramètre");
            assert!(a.reversible, "{key} ne change rien");
        }
    }

    #[test]
    fn the_ambient_fields_are_on_every_trigger() {
        // `depth` in particular: an administrator must be able to write "only
        // when a human did this", and that is a comparison on the ambient field.
        for t in triggers() {
            for name in ["event_type", "source_module", "depth"] {
                assert!(
                    t.fields.iter().any(|f| f.name == name),
                    "{} n'expose pas le champ ambiant {name}",
                    t.key
                );
            }
        }
    }

    #[test]
    fn actions_that_cannot_be_undone_say_so() {
        let acts = actions();
        let by_key = |k: &str| acts.iter().find(|a| a.key == k).expect("action déclarée").clone();
        assert!(by_key("suspend_account").reversible);
        assert!(by_key("require_password_change").reversible);
        // Revoking a session cannot be walked back: the device is logged out.
        assert!(!by_key("revoke_sessions").reversible);
    }
}
