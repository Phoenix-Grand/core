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
        field("user_id", "uuid", "Compte concerné", STRING_OPS),
        field("actor_user_id", "uuid", "Compte à l'origine de l'appel", STRING_OPS),
        field("actor_label", "string", "Nom de l'auteur", STRING_OPS),
        field("actor_origin", "string", "Origine (session, jeton d'API…)", STRING_OPS),
        field("outcome", "string", "Issue (success, denied, error)", STRING_OPS),
        field("reason", "string", "Motif consigné", STRING_OPS),
        field("ip", "string", "Adresse d'origine", STRING_OPS),
        field("target_type", "string", "Type de cible", STRING_OPS),
        field("target_label", "string", "Libellé de la cible", STRING_OPS),
        field("action", "string", "Action auditée", STRING_OPS),
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
        field("event_type", "string", "Type d'événement", STRING_OPS),
        field("source_module", "string", "Module émetteur", STRING_OPS),
        field(
            "depth",
            "number",
            "Profondeur de rétroaction (0 = action humaine)",
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
            "Compte créé",
            "Un compte utilisateur vient d'être créé, par inscription ou par un administrateur.",
            vec![
                field("user_id", "uuid", "Identifiant du compte", STRING_OPS),
                field("email", "string", "Adresse du compte", STRING_OPS),
            ],
        ),
        trigger(
            "account_updated",
            "UserUpdated",
            "Compte modifié",
            "Un compte a été modifié. `fields` liste les champs touchés.",
            vec![field("user_id", "uuid", "Identifiant du compte", STRING_OPS)],
        ),
        trigger(
            "login_failed",
            events::LOGIN_FAILED,
            "Échec de connexion",
            "Une tentative de connexion a échoué sur un compte d'administration. Combiné à un seuil « N fois en T », c'est le déclencheur d'une réaction au bourrage d'identifiants.",
            audit_fields(),
        ),
        trigger(
            "admin_call_denied",
            events::ADMIN_DENIED,
            "Appel d'administration refusé",
            "Une requête d'administration a été refusée faute de privilège. Une rafale sur un même compte mérite d'être regardée.",
            audit_fields(),
        ),
        trigger(
            "setting_changed",
            "SettingChanged",
            "Réglage modifié",
            "Un réglage a changé à une portée quelconque. La valeur n'est jamais transmise : l'événement traverse tous les modules et certains réglages portent des identifiants.",
            vec![
                field("key", "string", "Clé du réglage", STRING_OPS),
                field("scope_type", "string", "Portée", STRING_OPS),
                field("module_id", "string", "Module propriétaire", STRING_OPS),
                field("locked", "bool", "Verrouillé", BOOL_OPS),
                field("value_set", "bool", "Valeur posée (faux = retour à l'héritage)", BOOL_OPS),
            ],
        ),
        trigger(
            "privilege_granted",
            events::PRIVILEGE_GRANTED,
            "Privilège accordé",
            "Un rôle d'administration a été affecté à un compte ou à un groupe.",
            vec![
                field("user_id", "uuid", "Compte bénéficiaire", STRING_OPS),
                field("group_id", "uuid", "Groupe bénéficiaire", STRING_OPS),
                field("role_slug", "string", "Rôle affecté", STRING_OPS),
                field("role_name", "string", "Nom du rôle", STRING_OPS),
                field("scope", "string", "Portée de l'affectation", STRING_OPS),
                field("granted_by", "uuid", "Compte ayant accordé", STRING_OPS),
            ],
        ),
        trigger(
            "notification_sent",
            events::NOTIFICATION_SENT,
            "Notification envoyée par une règle",
            "Une règle a notifié un compte. Réagir à cet événement crée une chaîne : le champ « depth » dit à quelle profondeur de rétroaction on se trouve, et le moteur coupe au-delà du plafond configuré.",
            vec![
                field("user_id", "uuid", "Compte notifié", STRING_OPS),
                field("title", "string", "Titre de la notification", STRING_OPS),
                field("rule_id", "uuid", "Règle à l'origine", STRING_OPS),
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
            label: "Contenu soumis avant validation (portail)".into(),
            description: Some(
                "Un module demande, AVANT de valider une opération, si elle est autorisée. Une règle attachée à ce déclencheur peut autoriser, avertir ou bloquer. Les parties de contenu sont inspectées puis oubliées : elles ne sont jamais journalisées ni stockées.".into(),
            ),
            fields: {
                let mut fields = vec![
                    field("operation", "string", "Opération demandée (envoi, partage, export…)", STRING_OPS),
                    field("module", "string", "Module demandeur", STRING_OPS),
                    field("actor_user_id", "uuid", "Compte à l'origine de l'opération", STRING_OPS),
                    field("destination", "string", "Destination (interne, externe, publique…)", STRING_OPS),
                    field("recipient_domain", "string", "Domaine du destinataire", STRING_OPS),
                    field("recipient_count", "number", "Nombre de destinataires", NUMBER_OPS),
                    field("mime_type", "string", "Type de contenu", STRING_OPS),
                    field("size", "number", "Taille en octets", NUMBER_OPS),
                    // Content parts. They declare NO operator, which is what
                    // makes a comparison against them refused at write time -
                    // and content never enters the facts, so there would be
                    // nothing to compare even if one slipped through. The only
                    // thing a rule may say about them is a detector leaf.
                    content_part("title", "Titre ou objet"),
                    content_part("body", "Corps du contenu"),
                    content_part("attachment_text", "Texte extrait des pièces jointes"),
                    content_part("filename", "Nom de fichier"),
                ];
                fields.extend(ambient_fields());
                fields
            },
        },
        trigger(
            "module_health_changed",
            "ModuleHealthChanged",
            "Santé d'un module modifiée",
            "Un module est passé d'un état de santé à un autre.",
            vec![
                field("module_id", "string", "Module concerné", STRING_OPS),
                field("status", "string", "Nouvel état", STRING_OPS),
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
            label: "Suspendre le compte".into(),
            description: Some(
                "Désactive le compte visé par l'événement. Il ne peut plus se connecter ; ses données sont intactes.".into(),
            ),
            endpoint: None,
            params: vec![ParamDef {
                name: "reason".into(),
                value_type: "string".into(),
                label: "Motif consigné dans le journal d'audit".into(),
                required: false,
                values: None,
            }],
            blocking: true,
            reversible: true,
        },
        ActionDef {
            key: "revoke_sessions".into(),
            label: "Révoquer les sessions".into(),
            description: Some(
                "Invalide toutes les sessions actives du compte visé. Irréversible : les appareils devront se reconnecter.".into(),
            ),
            endpoint: None,
            params: vec![],
            blocking: false,
            reversible: false,
        },
        ActionDef {
            key: "require_password_change".into(),
            label: "Exiger un changement de mot de passe".into(),
            description: Some(
                "Le compte devra choisir un nouveau mot de passe à sa prochaine connexion.".into(),
            ),
            endpoint: None,
            params: vec![],
            blocking: false,
            reversible: true,
        },
        ActionDef {
            key: "notify".into(),
            label: "Notifier le compte".into(),
            description: Some(
                "Envoie une notification au compte visé, distribuée par le hub WebSocket.".into(),
            ),
            endpoint: None,
            params: vec![
                ParamDef {
                    name: "title".into(),
                    value_type: "string".into(),
                    label: "Titre".into(),
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
            label: "Lever une alerte".into(),
            description: Some(
                "Ouvre une alerte dans le centre d'alertes. En mode simulation, l'alerte est isolée : jamais comptée, jamais notifiée.".into(),
            ),
            endpoint: None,
            params: vec![
                ParamDef {
                    name: "title".into(),
                    value_type: "string".into(),
                    label: "Titre de l'alerte".into(),
                    required: true,
                    values: None,
                },
                ParamDef {
                    name: "summary".into(),
                    value_type: "string".into(),
                    label: "Résumé".into(),
                    required: false,
                    values: None,
                },
                ParamDef {
                    name: "severity".into(),
                    value_type: "enum".into(),
                    label: "Gravité (par défaut : celle de la règle)".into(),
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
            label: "Bloquer l'opération".into(),
            description: Some(
                "Refuse l'opération auprès du module demandeur. N'a d'effet que sur un déclencheur de portail (contenu soumis avant validation) et en mode « actif avec actions » : en simulation et en observation, la règle journalise ce qu'elle aurait bloqué et laisse passer.".into(),
            ),
            endpoint: None,
            params: vec![],
            blocking: true,
            reversible: true,
        },
        ActionDef {
            key: "warn_operation".into(),
            label: "Avertir sans bloquer".into(),
            description: Some(
                "L'opération est autorisée, le module demandeur reçoit un avertissement à présenter à l'utilisateur. Même condition que le blocage : un déclencheur de portail et le mode « actif avec actions ».".into(),
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
