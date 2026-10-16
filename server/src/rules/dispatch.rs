//! The dispatcher: how a matched rule's actions actually run.
//!
//! ## Actions never run on the event path
//!
//! The engine enqueues one job per match ([`ACTION_JOB`]) and returns. Suspending
//! an account, revoking sessions and calling a module are all things that can be
//! slow, fail, or need retrying - and none of them should be able to stall the
//! bus the rest of the instance depends on. The existing runner
//! ([`crate::jobs`]) already has claiming, exponential backoff and crash
//! recovery; the engine borrows all four rather than growing its own.
//!
//! ## A replay never doubles an action
//!
//! Every action carries an idempotency key derived from `(execution, index,
//! action)`, claimed in `core.idempotency_keys` - the **existing** table, the
//! same one that protects an offline client replaying a mutation. A job retried
//! after a crash therefore re-runs the actions that had not been claimed and
//! skips those that had. Two suspensions of the same account for the same event
//! is not a cosmetic defect: it is an audit trail that says something happened
//! twice when it happened once.
//!
//! ## Two transports, one mechanism
//!
//! A module's action is a POST to the internal endpoint it declared. The core's
//! own actions run in process ([`super::actions`]) instead of the core calling
//! itself over HTTP - which would mean a loopback connection, its own TLS
//! configuration, and a failure mode ("the instance cannot reach itself") that
//! exists for no reason. Everything else is shared: declaration, validation,
//! selection by key, idempotency, logging.
//!
//! ## Blocking
//!
//! An action declared `is_blocking` stops the ones after it if it fails. A
//! non-blocking one never does. That is the whole meaning of the flag, and it is
//! why the actions of one match travel in a single job: ordering only exists
//! inside one.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use kubuno_db::{params, DbPool};

use crate::config::settings::ServerSettings;
use crate::crypto::token;
use crate::errors::AppError;
use crate::jobs::{queue, NewJob};

use super::actions::{self, ActionContext};
use super::catalog;
use super::model::ActionSpec;

/// Job type that carries out a matched rule's actions.
pub const ACTION_JOB: &str = "core.rules.action";

/// How long an action's idempotency claim is kept. Long enough to cover every
/// retry the runner will attempt, short enough not to grow without bound.
const IDEMPOTENCY_TTL_HOURS: i64 = 48;

/// Ceiling on one HTTP call to a module. A module that cannot answer an
/// administrative action in this time is a module the rule should not be
/// waiting on.
const MODULE_TIMEOUT: Duration = Duration::from_secs(20);

/// Everything the dispatcher needs, serialised into the job payload.
///
/// Note what is **not** here: the facts. The values a rule inspected do not
/// travel into the job queue, where they would be persisted, replayed and read
/// by anybody with database access. What travels is the structural reference -
/// which account, which resource - plus the parameters the rule's author typed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionJob {
    pub execution_id: i64,
    pub rule_id: Uuid,
    pub rule_version: i32,
    pub rule_name: String,
    pub severity: String,
    pub event_type: String,
    pub subject_user_id: Option<Uuid>,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    /// Feedback depth of the fact that produced this match. Actions that emit
    /// events carry `depth + 1`.
    pub depth: u16,
    pub actions: Vec<ActionSpec>,
}

/// Enqueues the actions of one match.
pub async fn enqueue(db: &DbPool, job: &ActionJob) -> Result<(), AppError> {
    let payload = serde_json::to_value(job).map_err(|e| {
        tracing::error!(error = %e, rule_id = %job.rule_id, "rules: sérialisation du travail d'action");
        AppError::Internal(anyhow::anyhow!(e))
    })?;

    queue::enqueue(db, NewJob::new(ACTION_JOB).payload(payload))
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

/// Verdict of one action, as recorded on the execution row.
#[derive(Debug, Clone, Serialize)]
pub struct ActionVerdict {
    pub action: String,
    /// `ok` | `failed` | `skipped_replay` | `skipped_after_failure` | `unknown`
    pub status: &'static str,
    /// English one-liner. Never carries a value the rule inspected - only the
    /// reason the action itself gave.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Counters and verdicts of a whole dispatch.
#[derive(Debug, Default)]
pub struct DispatchOutcome {
    pub ok: i16,
    pub failed: i16,
    pub verdicts: Vec<ActionVerdict>,
}

/// Runs every action of a match, in order.
///
/// `server` is captured at bootstrap and handed down rather than read from the
/// database: it is configuration, it never appears in `core.settings`, and the
/// job runner deliberately carries nothing but a pool. The whole settings block
/// travels rather than one string because calling a module means presenting the
/// secret **of that module** ([`ServerSettings::module_secret`]), which is only
/// derivable from the master - see [`call_module`].
pub async fn run_all(db: &DbPool, job: &ActionJob, server: &ServerSettings) -> DispatchOutcome {
    let mut outcome = DispatchOutcome::default();
    let mut halted = false;

    for (index, spec) in job.actions.iter().enumerate() {
        if halted {
            outcome.verdicts.push(ActionVerdict {
                action: spec.action.clone(),
                status: "skipped_after_failure",
                error: None,
            });
            continue;
        }

        // Idempotency first: a replayed job must not re-run what already ran.
        match claim(db, job.execution_id, index, &spec.action).await {
            Ok(true) => {}
            Ok(false) => {
                outcome.verdicts.push(ActionVerdict {
                    action: spec.action.clone(),
                    status: "skipped_replay",
                    error: None,
                });
                // A replay is a success from the rule's point of view: the
                // effect exists.
                outcome.ok = outcome.ok.saturating_add(1);
                continue;
            }
            Err(e) => {
                // The claim could not be recorded. Refusing to act is the only
                // safe answer: acting without a claim is how a retry doubles an
                // irreversible effect.
                tracing::error!(error = %e, action = %spec.action, "rules: réservation d'idempotence impossible");
                outcome.failed = outcome.failed.saturating_add(1);
                outcome.verdicts.push(ActionVerdict {
                    action: spec.action.clone(),
                    status: "failed",
                    error: Some("idempotency claim failed".into()),
                });
                halted = true;
                continue;
            }
        }

        let (status, error, blocking) = run_one(db, job, spec, server).await;
        if status == "ok" {
            outcome.ok = outcome.ok.saturating_add(1);
        } else {
            outcome.failed = outcome.failed.saturating_add(1);
            // Release the claim so a retry gets another go at an action that
            // did not take effect. Keeping it would turn one transient failure
            // into a permanent skip.
            release(db, job.execution_id, index, &spec.action).await;
            if blocking {
                halted = true;
            }
        }
        outcome.verdicts.push(ActionVerdict {
            action: spec.action.clone(),
            status,
            error,
        });
    }

    outcome
}

/// Runs one action. Returns `(status, error, was_blocking)`.
async fn run_one(
    db: &DbPool,
    job: &ActionJob,
    spec: &ActionSpec,
    server: &ServerSettings,
) -> (&'static str, Option<String>, bool) {
    let resolved = match catalog::resolve_action(db, &spec.action).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            tracing::warn!(action = %spec.action, rule_id = %job.rule_id,
                "rules: action absente du catalogue, ignorée");
            return ("unknown", Some("action not in catalogue".into()), false);
        }
        Err(e) => return ("failed", Some(e.to_string()), true),
    };
    let blocking = resolved.is_blocking;

    // The core's own actions, in process.
    let ctx = ActionContext {
        db,
        job,
        params: &spec.params,
    };
    match actions::run(&ctx, &spec.action).await {
        Ok(true) => return ("ok", None, blocking),
        Ok(false) => { /* not a core action: fall through to the module path */ }
        Err(e) => {
            tracing::error!(error = %e, action = %spec.action, rule_id = %job.rule_id,
                "rules: action du core en échec");
            return ("failed", Some(e.to_string()), blocking);
        }
    }

    // A module's action, over its declared internal endpoint.
    let Some(endpoint) = resolved.endpoint.clone() else {
        tracing::error!(action = %spec.action,
            "rules: action sans endpoint et inconnue du core - déclaration incohérente");
        return ("failed", Some("no endpoint declared".into()), blocking);
    };
    match call_module(db, job, spec, &resolved.module_id, &endpoint, server).await {
        Ok(()) => ("ok", None, blocking),
        Err(e) => {
            tracing::error!(error = %e, action = %spec.action, module_id = %resolved.module_id,
                "rules: action de module en échec");
            ("failed", Some(e.to_string()), blocking)
        }
    }
}

/// POSTs an action to the module that declared it.
///
/// The call carries the internal secret **of the target module**, not the master
/// one: handing a module the master secret would hand it the key to every other
/// module, so one compromised module would compromise all of them. This is the
/// same rule the proxy ([`crate::modules::proxy`]) and event delivery
/// ([`crate::events::dispatch`]) follow.
async fn call_module(
    db: &DbPool,
    job: &ActionJob,
    spec: &ActionSpec,
    module_id: &str,
    endpoint: &str,
    server: &ServerSettings,
) -> Result<(), AppError> {
    // Resolved from the database rather than from the in-memory registry: the
    // job runner holds a pool and nothing else, which is what makes an action
    // runnable by any core process.
    let base_url: Option<String> = db
        .fetch_optional_scalar::<String>(
            "SELECT base_url FROM core.module_instances WHERE module_id = $1 ORDER BY registered_at DESC LIMIT 1",
            params![module_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, module_id = %module_id, "rules: résolution de l'adresse du module");
            AppError::Database(e)
        })?;

    let Some(base_url) = base_url else {
        return Err(AppError::Validation(format!(
            "Le module « {module_id} » n'est pas actif : son action ne peut pas être exécutée"
        )));
    };

    let client = reqwest::Client::builder()
        .timeout(MODULE_TIMEOUT)
        .build()
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;

    let url = format!("{}{}", base_url.trim_end_matches('/'), endpoint);
    let body = json!({
        "action":          spec.action,
        "params":          spec.params,
        "rule_id":         job.rule_id,
        "rule_version":    job.rule_version,
        "event_type":      job.event_type,
        "subject_user_id": job.subject_user_id,
        "resource_type":   job.resource_type,
        "resource_id":     job.resource_id,
    });

    let response = client
        .post(&url)
        .header("X-Internal-Secret", secret_for(server, module_id))
        // The feedback counter travels with the call. A module that emits an
        // event as a consequence must echo it, or its own chain is invisible to
        // the guard - documented in the module contract, and the only part of
        // the loop protection the core cannot enforce alone.
        .header("X-Kubuno-Rule-Depth", (job.depth + 1).to_string())
        .header("X-Kubuno-Rule-Id", job.rule_id.to_string())
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            AppError::Validation(format!("Module « {module_id} » injoignable : {e}"))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(AppError::Validation(format!(
            "Le module « {module_id} » a refusé l'action ({status})"
        )));
    }
    Ok(())
}

/// The `X-Internal-Secret` value a call to `module_id` must carry.
///
/// One line, but a named one: it is the single place the engine decides which
/// secret leaves the process, and the regression it guards against - sending the
/// master secret, i.e. the key to every module - is silent when it happens.
fn secret_for(server: &ServerSettings, module_id: &str) -> String {
    server.module_secret(module_id)
}

// ── Idempotency ──────────────────────────────────────────────────────────────

/// Deterministic identity of one action of one evaluation.
fn idempotency_hash(execution_id: i64, index: usize, action: &str) -> String {
    token::hash_token(&format!("rules|{execution_id}|{index}|{action}"))
}

/// Claims the right to run an action. `false` means somebody already did.
async fn claim(
    db: &DbPool,
    execution_id: i64,
    index: usize,
    action: &str,
) -> Result<bool, sqlx::Error> {
    let id_hash = idempotency_hash(execution_id, index, action);
    let expires = chrono::Utc::now() + chrono::Duration::hours(IDEMPOTENCY_TTL_HOURS);

    // The empty body is bound as empty bytes rather than written as `''::bytea`,
    // and the "do nothing on conflict" clause is emitted per engine.
    let backend = db.backend();
    let sql = format!(
        "INSERT {}INTO core.idempotency_keys \
             (id_hash, actor_hash, method, path, status_code, content_type, body, expires_at) \
         VALUES ($1, $2, 'RULE', $3, 200, NULL, $4, $5){}",
        backend.insert_ignore_prefix(),
        backend.on_conflict_do_nothing(&["id_hash"]),
    );
    let affected = db
        .execute(
            &sql,
            params![
                &id_hash,
                token::hash_token("rules-engine"),
                action,
                Vec::<u8>::new(),
                expires
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, action = %action, "rules: écriture de la clé d'idempotence");
            e
        })?;

    Ok(affected == 1)
}

/// Gives the claim back after a failed attempt, so a retry may try again.
async fn release(db: &DbPool, execution_id: i64, index: usize, action: &str) {
    let id_hash = idempotency_hash(execution_id, index, action);
    if let Err(e) = db
        .execute(
            "DELETE FROM core.idempotency_keys WHERE id_hash = $1",
            params![&id_hash],
        )
        .await
    {
        // The action will be skipped on retry. Worth an error line: the effect
        // did not happen and nothing will make it happen.
        tracing::error!(error = %e, action = %action,
            "rules: libération de la clé d'idempotence impossible - l'action ne sera pas retentée");
    }
}

/// Verdicts as the execution row stores them.
pub fn detail_of(outcome: &DispatchOutcome) -> Value {
    json!({ "actions": outcome.verdicts })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::internal_secret::InternalCaller;

    /// 64 hex characters, i.e. what `openssl rand -hex 32` produces.
    const MASTER: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn server(derive: bool) -> ServerSettings {
        let mut s: ServerSettings = serde_json::from_value(json!({
            "host":            "127.0.0.1",
            "port":            8080,
            "frontend_dist":   "./frontend/dist",
            "internal_secret": MASTER,
            "modules_dir":     "/usr/lib/kubuno/modules",
            "themes_dir":      "/var/lib/kubuno/themes",
        }))
        .expect("les réglages serveur de test doivent se désérialiser");
        s.derive_module_secrets = derive;
        s
    }

    /// The regression this guards: an action sent to a module used to carry the
    /// master secret, i.e. a value that opens every other module.
    #[test]
    fn an_action_carries_the_secret_of_the_module_it_targets() {
        let server = server(true);

        let mail = secret_for(&server, "mail");
        let drive = secret_for(&server, "drive");

        assert_ne!(mail, MASTER, "le secret maître ne doit jamais partir vers un module");
        assert_ne!(mail, drive, "chaque module doit recevoir sa propre valeur");

        // And the core recognises it as coming from that module, exactly like
        // the proxy's and the event delivery's.
        assert_eq!(
            server.authenticate_internal(&mail),
            Some(InternalCaller::Module("mail".into()))
        );
    }

    /// Derivation off (the default) is the historical behaviour: one shared
    /// secret. The dispatcher must follow the setting, not second-guess it.
    #[test]
    fn without_derivation_the_shared_secret_is_still_used() {
        let server = server(false);
        assert_eq!(secret_for(&server, "mail"), MASTER);
    }

    /// A module listed as exempt keeps the shared secret even with derivation
    /// on - it talks to its peers directly and compares for equality.
    #[test]
    fn an_exempt_module_keeps_the_shared_secret() {
        let mut server = server(true);
        server.shared_secret_modules = vec!["drive".into()];
        assert_eq!(secret_for(&server, "drive"), MASTER);
        assert_ne!(secret_for(&server, "mail"), MASTER);
    }

    #[test]
    fn the_idempotency_identity_separates_actions_and_evaluations() {
        let a = idempotency_hash(10, 0, "core.suspend_account");
        // Same everything = same identity: that is what makes a replay a no-op.
        assert_eq!(a, idempotency_hash(10, 0, "core.suspend_account"));
        // A different position in the same rule is a different action.
        assert_ne!(a, idempotency_hash(10, 1, "core.suspend_account"));
        // The same action for a different event must run again.
        assert_ne!(a, idempotency_hash(11, 0, "core.suspend_account"));
        // A different action at the same position is not the same effect.
        assert_ne!(a, idempotency_hash(10, 0, "core.revoke_sessions"));
        // The stored value is a hash, never the readable key.
        assert_eq!(a.len(), 64);
        assert!(!a.contains("suspend"));
    }

    #[test]
    fn a_job_payload_carries_no_inspected_content() {
        // The guarantee stated in the type's doc comment, as a test: the fields
        // are structural references and the author's own parameters. If a
        // `facts` field is ever added here, this fails and asks why.
        let job = ActionJob {
            execution_id: 1,
            rule_id: Uuid::nil(),
            rule_version: 1,
            rule_name: "essai".into(),
            severity: "warning".into(),
            event_type: "UserCreated".into(),
            subject_user_id: None,
            resource_type: None,
            resource_id: None,
            depth: 0,
            actions: vec![],
        };
        let value = serde_json::to_value(&job).expect("sérialisable");
        let keys: Vec<&str> = value
            .as_object()
            .expect("objet")
            .keys()
            .map(String::as_str)
            .collect();
        assert!(!keys.contains(&"facts"));
        assert!(!keys.contains(&"payload"));
        assert!(!keys.contains(&"values"));
    }
}
