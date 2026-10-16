//! The core's own actions, executed in process.
//!
//! A module's action is an HTTP call to the endpoint it declared. The core's
//! are not, and that is the single asymmetry in the whole mechanism - argued
//! for in [`super::dispatch`]. What is *not* asymmetric: they are declared
//! through the same catalogue path, validated against the same parameter
//! schema, selected by the same key, logged in the same execution row, and
//! covered by the same idempotency key.
//!
//! ## What an action is allowed to touch
//!
//! A `DbPool` and nothing else. No `AppState`, no registry, no HTTP client.
//! That constraint is deliberate: it is what lets an action run inside the job
//! runner, be retried, and be replayed after a crash, without a second
//! dependency graph existing only for rules.

use chrono::Utc;
use serde_json::{json, Value};
use uuid::Uuid;

use kubuno_db::{params, DbPool};

use crate::alerts::{self, NewAlert, Severity};
use crate::audit::{AuditContext, AuditEntry};
use crate::database::notify;
use crate::errors::AppError;
use crate::events::{AppEvent, EventMeta};

use super::dispatch::ActionJob;

/// Label the audit trail records for work the engine did on its own.
pub const ACTOR_LABEL: &str = "Moteur de règles";

/// Reason recorded on a session revoked by a rule.
const REVOKE_REASON: &str = "rule";

/// Everything a local action gets.
pub struct ActionContext<'a> {
    pub db: &'a DbPool,
    pub job: &'a ActionJob,
    pub params: &'a Value,
}

impl ActionContext<'_> {
    fn param_str(&self, name: &str) -> Option<&str> {
        self.params.get(name).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
    }

    /// The account the event was about. Every account-facing action needs one
    /// and refuses rather than guessing.
    fn subject(&self, action: &str) -> Result<Uuid, AppError> {
        self.job.subject_user_id.ok_or_else(|| {
            AppError::Validation(format!(
                "L'action « {action} » vise un compte, mais l'événement n'en désigne aucun"
            ))
        })
    }

    /// Audit context for the engine acting on its own behalf.
    fn audit(&self) -> AuditContext {
        AuditContext::system(ACTOR_LABEL)
    }

    fn entry(&self, action: &str) -> AuditEntry {
        AuditEntry::new(action)
            .module("core")
            .detail(format!(
                "Règle « {} » v{} sur {}",
                self.job.rule_name, self.job.rule_version, self.job.event_type
            ))
    }
}

/// Runs a core action. `Ok(false)` means "not one of mine" - the dispatcher
/// then falls through to the HTTP path.
pub async fn run(ctx: &ActionContext<'_>, key: &str) -> Result<bool, AppError> {
    match key {
        "core.suspend_account" => suspend_account(ctx).await.map(|_| true),
        "core.revoke_sessions" => revoke_sessions(ctx).await.map(|_| true),
        "core.require_password_change" => require_password_change(ctx).await.map(|_| true),
        "core.notify" => notify_account(ctx).await.map(|_| true),
        "core.raise_alert" => raise_alert(ctx).await.map(|_| true),
        // ── The gate's verdicts ──────────────────────────────────────────────
        // Consumed synchronously by `super::gate`, never dispatched. Claiming
        // them here rather than letting them fall through to the HTTP path is
        // what stops a rule that pairs a verdict with an ordinary trigger from
        // failing with "unknown action" - the rule is merely ineffective, which
        // is what it is, and the log says so once.
        super::gate::ACTION_BLOCK | super::gate::ACTION_WARN => {
            tracing::info!(
                rule_id = %ctx.job.rule_id,
                action = %key,
                event_type = %ctx.job.event_type,
                "Verdict de portail hors du portail : sans effet sur un déclencheur asynchrone"
            );
            Ok(true)
        }
        _ => Ok(false),
    }
}

// ── Suspend ──────────────────────────────────────────────────────────────────

/// The three account columns the suspend guard reads.
#[derive(sqlx::FromRow)]
struct AccountRow {
    username: String,
    is_active: bool,
    role: String,
}

/// Deactivates the account the event was about.
///
/// Refuses to remove the **last active administrator**. A rule is written once
/// and runs forever; the day its condition happens to match the only account
/// that can undo it, the instance is locked out with no path back that does not
/// involve a database client. That guard belongs here, in the action, rather
/// than in the console - the console is not what will be running at 3am.
async fn suspend_account(ctx: &ActionContext<'_>) -> Result<(), AppError> {
    let user_id = ctx.subject("core.suspend_account")?;

    let row = ctx
        .db
        .fetch_optional_as::<AccountRow>(
            "SELECT username, is_active, role FROM core.users WHERE id = $1",
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "rules: lecture du compte à suspendre");
            AppError::Database(e)
        })?;

    let Some(AccountRow {
        username,
        is_active,
        role,
    }) = row
    else {
        return Err(AppError::NotFound("compte".into()));
    };
    if !is_active {
        // Already suspended. Not an error: the rule's intent is satisfied, and
        // failing here would burn the job's attempts on a no-op.
        tracing::debug!(user_id = %user_id, "rules: compte déjà suspendu");
        return Ok(());
    }

    if role == "admin" {
        let remaining: i64 = ctx
            .db
            .fetch_scalar::<i64>(
                &format!(
                    "SELECT {} FROM core.users WHERE role = 'admin' AND is_active AND id <> $1",
                    ctx.db.backend().count_bigint("*")
                ),
                params![user_id],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "rules: comptage des administrateurs actifs");
                AppError::Database(e)
            })?;
        if remaining == 0 {
            let refusal = "Suspension refusée : ce compte est le dernier administrateur actif";
            tracing::error!(user_id = %user_id, rule_id = %ctx.job.rule_id, "{refusal}");
            ctx.audit()
                .record(
                    ctx.db,
                    ctx.entry("core.rules.suspend_account")
                        .target(crate::audit::redact::target::USER, user_id, username)
                        .denied(refusal),
                )
                .await;
            return Err(AppError::Validation(refusal.into()));
        }
    }

    let mut tx = ctx.audit().begin(ctx.db).await?;
    tx.execute(
        "UPDATE core.users SET is_active = FALSE WHERE id = $1",
        params![user_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, user_id = %user_id, "rules: suspension d'un compte");
        AppError::Database(e)
    })?;

    let mut entry = ctx
        .entry("core.rules.suspend_account")
        .target(crate::audit::redact::target::USER, user_id, username)
        .before(json!({ "is_active": true }))
        .after(json!({ "is_active": false }))
        .reversible();
    if let Some(reason) = ctx.param_str("reason") {
        entry = entry.detail(format!(
            "Règle « {} » v{} - motif : {reason}",
            ctx.job.rule_name, ctx.job.rule_version
        ));
    }
    tx.commit(entry).await?;

    tracing::info!(user_id = %user_id, rule_id = %ctx.job.rule_id, "Compte suspendu par une règle");
    Ok(())
}

// ── Revoke sessions ──────────────────────────────────────────────────────────

async fn revoke_sessions(ctx: &ActionContext<'_>) -> Result<(), AppError> {
    let user_id = ctx.subject("core.revoke_sessions")?;

    let mut tx = ctx.audit().begin(ctx.db).await?;
    let revoked = tx
        .execute(
            r#"UPDATE core.refresh_tokens
                  SET revoked_at = $2, revoke_reason = $3
                WHERE user_id = $1 AND revoked_at IS NULL"#,
            params![user_id, Utc::now(), REVOKE_REASON],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "rules: révocation des sessions");
            AppError::Database(e)
        })?;

    tx.commit(
        ctx.entry("core.rules.revoke_sessions")
            .target_kind(
                crate::audit::redact::target::SESSION,
                format!("{revoked} session(s)"),
            )
            // Counters, never a token or a device fingerprint.
            .after(json!({ "revoked": revoked })),
    )
    .await?;

    tracing::info!(user_id = %user_id, revoked, "Sessions révoquées par une règle");
    Ok(())
}

// ── Force a password change ──────────────────────────────────────────────────

async fn require_password_change(ctx: &ActionContext<'_>) -> Result<(), AppError> {
    let user_id = ctx.subject("core.require_password_change")?;

    let mut tx = ctx.audit().begin(ctx.db).await?;
    let affected = tx
        .execute(
            "UPDATE core.users SET must_change_password = TRUE WHERE id = $1 AND NOT must_change_password",
            params![user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "rules: exigence de changement de mot de passe");
            AppError::Database(e)
        })?;

    tx.commit(
        ctx.entry("core.rules.require_password_change")
            .target(crate::audit::redact::target::USER, user_id, "compte")
            .after(json!({ "must_change_password": true }))
            .reversible(),
    )
    .await?;

    if affected == 0 {
        tracing::debug!(user_id = %user_id, "rules: changement de mot de passe déjà exigé");
    }
    Ok(())
}

// ── Notify ───────────────────────────────────────────────────────────────────

/// Sends a notification to the account the event was about.
///
/// Published on the event channel rather than pushed into the hub directly: the
/// action holds a pool and nothing else, and `pg_notify` is the path every core
/// process listens to - so the notification reaches the operator's browser
/// whichever process ran the job.
async fn notify_account(ctx: &ActionContext<'_>) -> Result<(), AppError> {
    let user_id = ctx.subject("core.notify")?;
    let title = ctx.param_str("title").unwrap_or("Notification");
    let body = ctx.param_str("body").unwrap_or_default();

    let event = AppEvent::Custom {
        event_type: "core.rules.notification".into(),
        module_id: "core".into(),
        // `recipient_user_ids` is what the WebSocket hub reads to target a
        // delivery instead of broadcasting.
        payload: json!({
            "recipient_user_ids": [user_id],
            // Also under the name the fact builder looks for, so a rule can
            // react to a notification *about a given account* - and so the
            // feedback counter has a subject to key its threshold on.
            "user_id": user_id,
            "title": title,
            "body":  body,
            "rule_id": ctx.job.rule_id,
        }),
    };
    // One level deeper than the fact that produced it: a notification that
    // re-triggered a rule must be visible to the loop guard like any other
    // consequence.
    let meta = EventMeta::caused_by_rule(ctx.job.rule_id, ctx.job.depth);

    notify::pg_notify_with(ctx.db, &event, &meta)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %user_id, "rules: publication de la notification");
            AppError::Internal(e)
        })?;
    Ok(())
}

// ── Raise an alert ───────────────────────────────────────────────────────────

/// Opens an alert with the rule author's own wording.
///
/// Distinct from the alert the engine raises on every match: this one exists so
/// a rule can say something the generic "rule X matched" cannot.
async fn raise_alert(ctx: &ActionContext<'_>) -> Result<(), AppError> {
    let title = ctx
        .param_str("title")
        .unwrap_or(&ctx.job.rule_name)
        .to_string();
    let severity = ctx
        .param_str("severity")
        .and_then(Severity::parse)
        .or_else(|| Severity::parse(&ctx.job.severity))
        .unwrap_or(Severity::Warning);

    let mut alert = NewAlert::new(
        alerts::catalog::RULE_MATCHED,
        alerts::catalog::SRC_RULES,
        severity,
        title,
    )
    .payload(json!({
        "rule_id":         ctx.job.rule_id,
        "rule_name":       ctx.job.rule_name,
        "rule_version":    ctx.job.rule_version,
        "event_type":      ctx.job.event_type,
        "subject_user_id": ctx.job.subject_user_id,
        "custom":          true,
    }))
    // One row per (rule, subject) whose counter grows, rather than one row per
    // occurrence - the whole reason the alert centre deduplicates.
    .dedup(format!(
        "{}:{}",
        ctx.job.rule_id,
        ctx.job
            .subject_user_id
            .map(|u| u.to_string())
            .unwrap_or_else(|| "-".into())
    ));

    if let Some(summary) = ctx.param_str("summary") {
        alert = alert.summary(summary.to_string());
    }
    if let Some(uid) = ctx.job.subject_user_id {
        alert = alert.subject(uid);
    }

    alerts::raise(ctx.db, alert).await?;
    Ok(())
}
