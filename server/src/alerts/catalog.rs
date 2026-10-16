//! The catalogue of alert types, and the recommended actions each one ships
//! with.
//!
//! ## The rule this file exists to enforce
//!
//! **An alert type without an action is not created.** The instance already has
//! an audit trail and an event log; a queue that only restates them, with a
//! badge on top, teaches its operator to ignore the badge. So every `kind`
//! below answers "what do I do about it?" with at least one addressable
//! surface, and adding a `kind` means adding its actions in the same commit.
//!
//! ## Why the catalogue is Rust and not a table
//!
//! Same reasoning as [`crate::health::checks`]: the wording, the severity and
//! above all the *destination* of an action change with the code. A row in the
//! database would be a copy of the code that drifts from it, and the copy that
//! drifts is always the one telling the operator to open a screen that no
//! longer exists.
//!
//! ## Actions are computed, never stored
//!
//! [`actions_for`] rebuilds them on every read from the alert's `kind` and
//! `payload`. An action serialised into the row at production time would still
//! point at last month's menu after a refactor.

use serde_json::Value;
use uuid::Uuid;

use super::model::{Action, Severity};
use crate::authz::keys;

// ── Sources ──────────────────────────────────────────────────────────────────

pub const SRC_HEALTH: &str = "health";
pub const SRC_AUDIT: &str = "audit";
pub const SRC_MODULES: &str = "modules";
pub const SRC_JOBS: &str = "jobs";
pub const SRC_STORAGE: &str = "storage";
/// The scheduled backup (`crate::backup`).
pub const SRC_BACKUP: &str = "backup";
/// The administration rule engine (`crate::rules`).
pub const SRC_RULES: &str = "rules";
/// The data export (`crate::data_export`).
pub const SRC_DATA_EXPORT: &str = "data_export";

// ── Kinds ────────────────────────────────────────────────────────────────────
//
// `<family>.<subject>`. Stable identifiers: they are the i18n key the console
// translates against (`admin.al_<kind>_title`) and the prefix of every dedup
// key, so renaming one splits an alert's history in two.

/// A health check that is failing at `critical`.
pub const HEALTH_CRITICAL: &str = "health.critical_check";
/// A run of failed sign-ins on one administrator account.
pub const LOGIN_BURST: &str = "security.login_burst";
/// An administrative privilege was granted to somebody.
pub const PRIVILEGE_GRANTED: &str = "security.privilege_granted";
/// A setting that governs who gets in, or how, was changed.
pub const SENSITIVE_SETTING: &str = "security.sensitive_setting";
/// An enabled module is not answering.
pub const MODULE_UNAVAILABLE: &str = "modules.unavailable";
/// A background job type exhausted its attempts and gave up.
pub const JOB_DEAD_LETTER: &str = "jobs.dead_letter";
/// A scheduled or manual backup did not complete.
///
/// Distinct from the health check `continuity.backup`, and the split is
/// deliberate: the check answers "does a recent backup exist?" and goes critical
/// when the answer is no - which the `health.critical_check` producer already
/// turns into an alert, so "no successful backup for N days" is covered without
/// a second kind saying the same thing twice. This one answers "the last attempt
/// broke, and here is the message", which the check cannot carry and an operator
/// cannot act on without.
pub const BACKUP_FAILED: &str = "backup.failed";
/// The data volume is running out of room.
pub const DISK_LOW: &str = "storage.disk_low";
/// An account has reached, or passed, its own quota.
///
/// Distinct from [`DISK_LOW`] because the fix is the opposite one: a full volume
/// is bought or freed by the operator, a full account is raised or cleaned up by
/// its owner. Reporting both as "storage is full" would send an administrator to
/// buy a disk for a single person who never emptied their trash.
pub const QUOTA_EXCEEDED: &str = "storage.quota_exceeded";
/// A module that used to declare its storage consumption has gone quiet.
///
/// Distinct from [`MODULE_UNAVAILABLE`], which says the module is not answering
/// at all. This one fires for a module that is up and serving requests but has
/// stopped declaring: its slice of the storage breakdown is still drawn - it is
/// the last thing known to be true - and is quietly ageing. A module that has
/// **never** declared raises nothing: it promised nothing, and alerting on every
/// module that does not store bytes is how an operator learns to ignore the
/// queue.
pub const USAGE_STALE: &str = "storage.usage_stale";
/// A user told the platform that one of their devices was not them. This is the
/// only alert kind a *user* can raise, and it is the strongest signal the
/// product has: somebody looked at their own session list and did not recognise
/// what they saw.
pub const DEVICE_DISOWNED: &str = "security.device_disowned";
/// An administration rule matched. Raised by `crate::rules::engine` in every
/// mode that alerts; **quarantined** (`is_simulation`) when the rule is only
/// simulating, so a "what if" never reaches a badge.
pub const RULE_MATCHED: &str = "rules.matched";
/// A rule action produced an event that re-triggered a rule, past the
/// configured depth. The chain was cut; this says where.
pub const RULE_FEEDBACK_LOOP: &str = "rules.feedback_loop";
/// A rule matched and its action could not be carried out.
pub const RULE_ACTION_FAILED: &str = "rules.action_failed";
/// An export of the instance's data has been requested.
///
/// The only kind in this catalogue that is raised on a **successful, authorised
/// operation**. It is here because nothing about the request itself
/// distinguishes a legitimate export from one triggered through a stolen
/// administrator session, so the control cannot be a check - it is the fact that
/// every other administrator sees it happen, while the archive is still held and
/// can still be cancelled. See `crate::data_export::notify`.
pub const DATA_EXPORT_STARTED: &str = "security.data_export_started";

/// Every kind the core produces, in the order the filter select offers them.
pub const ALL_KINDS: &[&str] = &[
    HEALTH_CRITICAL,
    LOGIN_BURST,
    PRIVILEGE_GRANTED,
    SENSITIVE_SETTING,
    MODULE_UNAVAILABLE,
    JOB_DEAD_LETTER,
    BACKUP_FAILED,
    DISK_LOW,
    QUOTA_EXCEEDED,
    USAGE_STALE,
    RULE_MATCHED,
    RULE_FEEDBACK_LOOP,
    RULE_ACTION_FAILED,
    DEVICE_DISOWNED,
    DATA_EXPORT_STARTED,
];

/// The privilege that governs *reading* an alert of this kind.
///
/// The queue is filtered with it, so a delegated operator sees the alerts they
/// can act on rather than a list of somebody else's problems - the same rule the
/// health report follows. Holding `core.alerts.read` is necessary for all of
/// them (the layer checks it once); this narrows it further.
pub fn read_privilege(kind: &str) -> &'static str {
    match kind {
        LOGIN_BURST => keys::USERS_READ,
        // Whoever can read the device inventory is who can act on this one.
        DEVICE_DISOWNED => keys::SESSIONS_READ,
        PRIVILEGE_GRANTED => keys::ROLES_READ,
        SENSITIVE_SETTING => keys::SETTINGS_READ,
        MODULE_UNAVAILABLE => keys::MODULES_READ,
        // The alert names one account and how full it is: whoever may read the
        // storage page is who may read it.
        QUOTA_EXCEEDED => keys::STORAGE_READ,
        // The alert is about the storage breakdown going stale; whoever may read
        // that breakdown is who may read that it is no longer trustworthy.
        USAGE_STALE => keys::STORAGE_READ,
        // Whoever may read the backup history is who may read why one failed.
        BACKUP_FAILED => keys::BACKUP_READ,
        // Deliberately the *read* key and not the execute one: the whole point
        // is that administrators who cannot themselves export are the ones
        // watching those who can.
        DATA_EXPORT_STARTED => keys::DATA_EXPORT_READ,
        // What a rule did is readable by whoever may read the rules - otherwise
        // the queue would explain an automatic suspension to an operator who
        // cannot see the rule that caused it.
        RULE_MATCHED | RULE_FEEDBACK_LOOP | RULE_ACTION_FAILED => keys::RULES_READ,
        // Health, jobs and disk are instance facts with no narrower owner: the
        // alert-centre key is the whole gate.
        _ => super::keys::ALERTS_READ,
    }
}

/// The read privilege of an administration tab.
///
/// Mirrors `adminNav.ts`, and exists so an action is never offered to somebody
/// the destination would refuse. A button that 403s is worse than no button: it
/// tells the operator the console is broken rather than that they lack a key.
fn privilege_for_tab(tab: &str) -> &'static str {
    match tab {
        "users" => keys::USERS_READ,
        "groups" => keys::GROUPS_READ,
        "org-units" => keys::ORG_UNITS_READ,
        "modules" => keys::MODULES_READ,
        "marketplace" => keys::MARKETPLACE_MANAGE,
        "sso" => keys::AUTH_PROVIDERS_READ,
        "settings" => keys::SETTINGS_READ,
        "apparence" => keys::THEMES_READ,
        "email" => keys::MAIL_READ,
        "audit" | "event-log" => keys::AUDIT_READ,
        "device-sessions" => keys::SESSIONS_READ,
        "admin-roles" => keys::ROLES_READ,
        "dashboard" => keys::STATS_READ,
        "storage" => keys::STORAGE_READ,
        // The background-tasks page carries the backup policy, its history and
        // the manual trigger.
        "background-jobs" => keys::BACKUP_READ,
        "data-export" => keys::DATA_EXPORT_READ,
        // The health report narrows itself server-side and is open to every
        // administrator; so is the alert centre's own surface.
        _ => super::keys::ALERTS_READ,
    }
}

fn str_of(payload: &Value, key: &str) -> Option<String> {
    payload.get(key).and_then(Value::as_str).map(str::to_string)
}

// ── Recommended actions ──────────────────────────────────────────────────────

/// The actions an operator should consider, most useful first.
///
/// `alert_id` is needed by the verbs the alert centre performs itself (retrying
/// a dead-lettered job), which address the alert rather than the underlying
/// object: the job ids live in the payload and change between two passes, the
/// alert does not.
pub fn actions_for(kind: &str, payload: &Value, alert_id: Uuid) -> Vec<Action> {
    match kind {
        HEALTH_CRITICAL => {
            let mut out = Vec::new();
            // The health check ships its own destination. Reusing it rather than
            // re-deriving one is what keeps the two features from disagreeing
            // about where a finding is fixed.
            if let Some(tab) = payload.get("action_tab").and_then(Value::as_str) {
                let mut action = Action::open(
                    "fix-health-check",
                    tab,
                    payload
                        .get("action_label")
                        .and_then(Value::as_str)
                        .unwrap_or("Fix this"),
                    privilege_for_tab(tab),
                );
                if let Some(verb) = payload.get("action_verb").and_then(Value::as_str) {
                    action = action.verb(verb);
                }
                out.push(action);
            }
            out.push(Action::open(
                "open-health",
                "security-health",
                "Open the health report",
                privilege_for_tab("security-health"),
            ));
            out
        }

        LOGIN_BURST => {
            let user = str_of(payload, "user_id");
            let mut out = Vec::new();
            if let Some(uid) = user.as_deref() {
                out.push(
                    Action::open("open-account", "users", "Open the account", keys::USERS_READ)
                        .param("user", uid),
                );
                out.push(
                    Action::open(
                        "reset-password",
                        "users",
                        "Reset the password and revoke the sessions",
                        keys::USER_PASSWORD,
                    )
                    .param("user", uid)
                    .verb("reset-password"),
                );
            }
            out.push(
                Action::open("review-audit", "audit", "Review the failed sign-ins", keys::AUDIT_READ)
                    .param("audit_action", "core.auth.login_failed")
                    .param("audit_actor", user.unwrap_or_default()),
            );
            out
        }

        PRIVILEGE_GRANTED => vec![
            Action::open(
                "review-roles",
                "admin-roles",
                "Review roles and assignments",
                keys::ROLES_READ,
            ),
            Action::open("review-audit", "audit", "Read the audit entry", keys::AUDIT_READ)
                .param("audit_action", "core.role_assignments.create"),
        ],

        SENSITIVE_SETTING => {
            let mut audit = Action::open("review-audit", "audit", "Read the audit entry", keys::AUDIT_READ)
                .param("audit_action", "core.settings.change");
            if let Some(key) = str_of(payload, "setting_key") {
                audit = audit.param("q", key);
            }
            vec![
                Action::open("open-settings", "settings", "Open the settings", keys::SETTINGS_READ),
                audit,
            ]
        }

        MODULE_UNAVAILABLE => {
            let mut out = Vec::new();
            if let Some(module) = str_of(payload, "module_id") {
                out.push(
                    Action::open(
                        "module-settings",
                        "modules",
                        "Open the module",
                        keys::MODULES_READ,
                    )
                    .verb("settings")
                    .id_param(module),
                );
            }
            out.push(Action::open(
                "open-modules",
                "modules",
                "Review the installed modules",
                keys::MODULES_READ,
            ));
            out
        }

        // The breakdown is going stale, so the two useful destinations are the
        // page whose figure is ageing and the module that stopped refreshing it.
        // Both are readings: nothing an administrator clicks makes a module
        // declare again, and offering a button that pretends otherwise would be
        // worse than offering none.
        USAGE_STALE => {
            let mut out = vec![Action::open(
                "open-storage",
                "storage",
                "Review the storage breakdown",
                keys::STORAGE_READ,
            )];
            if let Some(module) = str_of(payload, "module_id") {
                out.push(
                    Action::open(
                        "module-settings",
                        "modules",
                        "Open the module that stopped declaring",
                        keys::MODULES_READ,
                    )
                    .verb("settings")
                    .id_param(module),
                );
            }
            out
        }

        JOB_DEAD_LETTER => vec![
            // Both verbs are claimed by the alert centre itself and executed by
            // `POST /admin/alerts/:id/<verb>`: there is no background-jobs screen
            // to send the operator to, and an alert whose only advice is "look
            // in the database" is the kind this catalogue refuses to create.
            Action::open(
                "retry-jobs",
                "alerts",
                "Put the failed jobs back in the queue",
                super::keys::ALERTS_MANAGE,
            )
            .verb("retry-jobs")
            .id_param(alert_id)
            .executed_here(),
            Action::open(
                "discard-jobs",
                "alerts",
                "Discard the failed jobs",
                super::keys::ALERTS_MANAGE,
            )
            .verb("discard-jobs")
            .id_param(alert_id)
            .executed_here(),
        ],

        // Two actions, in the order an operator actually needs them: try again
        // now (most failures are transient - a full volume that has since been
        // freed, a destination that has since been created), then read what the
        // policy is pointing at. The retry is claimed by the page itself.
        BACKUP_FAILED => vec![
            Action::open(
                "run-backup",
                "background-jobs",
                "Run a backup now",
                keys::BACKUP_MANAGE,
            )
            .verb("run-backup"),
            Action::open(
                "configure-backup",
                "background-jobs",
                "Review the backup policy",
                keys::BACKUP_READ,
            )
            .verb("configure-backup"),
        ],

        // The two things somebody who did not ask for this export needs, in the
        // order they need them: stop it while the hold is still running, then
        // read who asked and for what. The cancellation is a WRITE, offered only
        // to somebody who holds the execute key - an operator who merely watches
        // is shown the page and the audit trail, never a button that would 403.
        DATA_EXPORT_STARTED => {
            let mut out = Vec::new();
            if let Some(export_id) = str_of(payload, "export_id") {
                out.push(
                    Action::open(
                        "cancel-export",
                        "data-export",
                        "Cancel this export",
                        keys::DATA_EXPORT_EXECUTE,
                    )
                    .verb("cancel")
                    .id_param(export_id),
                );
            }
            out.push(Action::open(
                "open-data-export",
                "data-export",
                "Open the data-export page",
                keys::DATA_EXPORT_READ,
            ));
            let mut audit =
                Action::open("review-audit", "audit", "Read the audit entry", keys::AUDIT_READ)
                    .param("audit_action", "core.data_export.request");
            if let Some(actor) = str_of(payload, "actor_id") {
                audit = audit.param("audit_actor", actor);
            }
            out.push(audit);
            out
        }

        DISK_LOW => vec![
            // The storage page first: it is where the consumption that filled
            // the volume is broken down, and where a quota is lowered. The
            // health report says the same thing in one line and no more.
            Action::open(
                "open-storage",
                "storage",
                "Review storage consumption",
                keys::STORAGE_READ,
            ),
            Action::open(
                "open-health",
                "security-health",
                "Open the health report",
                privilege_for_tab("security-health"),
            ),
        ],

        // A full account has exactly two outcomes: somebody raises the ceiling,
        // or somebody empties the account. Both are offered, in that order,
        // because only the first is something an administrator can do alone.
        QUOTA_EXCEEDED => {
            let mut out = Vec::new();
            if let Some(uid) = str_of(payload, "user_id") {
                // The quota is edited on the ACCOUNT SHEET, in place, like every
                // other field of an account - the storage page used to carry its
                // own dialog, which made three surfaces for one value. The link
                // below still points at the storage page: it lands on the
                // consumption that justifies the change, and the verb it carries
                // is forwarded from there to the sheet with its editor already
                // open.
                out.push(
                    Action::open(
                        "raise-quota",
                        "storage",
                        "Adjust this account's quota",
                        keys::USERS_UPDATE,
                    )
                    .verb("set-quota")
                    .id_param(&uid),
                );
                out.push(
                    Action::open("open-account", "users", "Open the account", keys::USERS_READ)
                        .param("user", uid),
                );
            }
            out.push(Action::open(
                "open-storage",
                "storage",
                "Review storage consumption",
                keys::STORAGE_READ,
            ));
            out
        }

        // A user disowned one of their own devices. Everything they could do
        // themselves has already happened - every session revoked, a password
        // change forced. What remains is the operator's half: look at what that
        // device did, and at the account it reached.
        DEVICE_DISOWNED => {
            let user = str_of(payload, "user_id");
            let mut out = vec![Action::open(
                "open-devices",
                "device-sessions",
                "Open the device inventory",
                keys::SESSIONS_READ,
            )];
            if let Some(uid) = user.as_deref() {
                out.push(
                    Action::open("open-account", "users", "Open the account", keys::USERS_READ)
                        .param("user", uid),
                );
            }
            out.push(
                Action::open("review-audit", "audit", "Review what this device did", keys::AUDIT_READ)
                    .param("audit_actor", user.unwrap_or_default()),
            );
            out
        }

        // ── Rule engine ─────────────────────────────────────────────────────
        // Every one of these points at the rule first. The question an operator
        // asks when an account is suspended by a machine is never "what
        // happened" - the alert already says that - it is "which rule, and who
        // wrote it", and the answer is one click away or the feature is hostile.
        RULE_MATCHED | RULE_ACTION_FAILED | RULE_FEEDBACK_LOOP => {
            let rule_id = str_of(payload, "rule_id");
            let mut out = Vec::new();
            if let Some(id) = rule_id.as_deref() {
                out.push(
                    Action::open("open-rule", "rules", "Open the rule", keys::RULES_READ)
                        .param("rule", id),
                );
                out.push(
                    Action::open(
                        "rule-runs",
                        "rules",
                        "Review this rule's run log",
                        keys::RULES_READ,
                    )
                    .param("rule", id)
                    .param("view", "runs"),
                );
                if kind == RULE_FEEDBACK_LOOP || kind == RULE_ACTION_FAILED {
                    // The one action that stops the bleeding, offered only to
                    // somebody who may actually write a rule.
                    out.push(
                        Action::open(
                            "disable-rule",
                            "rules",
                            "Disable the rule",
                            keys::RULES_MANAGE,
                        )
                        .param("rule", id)
                        .verb("disable"),
                    );
                }
            }
            if let Some(uid) = str_of(payload, "subject_user_id") {
                out.push(
                    Action::open("open-account", "users", "Open the account", keys::USERS_READ)
                        .param("user", uid),
                );
            }
            if out.is_empty() {
                // A rule alert with no rule id should not exist, but the
                // catalogue's promise is unconditional.
                out.push(Action::open(
                    "open-rules",
                    "rules",
                    "Open the rules",
                    keys::RULES_READ,
                ));
            }
            out
        }

        // An unknown kind (an older row after a rename) still opens the queue
        // rather than showing nothing at all.
        _ => Vec::new(),
    }
}

/// Default severity of a kind, before a producer refines it from what it
/// observed.
pub fn default_severity(kind: &str) -> Severity {
    match kind {
        HEALTH_CRITICAL | MODULE_UNAVAILABLE => Severity::Critical,
        // A feedback loop that had to be cut is a defect in a rule that is
        // running right now: never merely informational.
        RULE_FEEDBACK_LOOP => Severity::Critical,
        LOGIN_BURST | PRIVILEGE_GRANTED | SENSITIVE_SETTING | JOB_DEAD_LETTER | DISK_LOW
        | QUOTA_EXCEEDED | RULE_ACTION_FAILED | BACKUP_FAILED => Severity::Warning,
        // Warning and not info: nothing is broken, but somebody is copying every
        // account's data out of the instance and there is a deadline on doing
        // something about it. An informational badge next to a stale figure is
        // not what that deserves.
        DATA_EXPORT_STARTED => Severity::Warning,
        // Nothing is broken for a user: a figure on one console page is ageing.
        // Raising it above informational would put it beside a full disk.
        USAGE_STALE => Severity::Info,
        _ => Severity::Info,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The rule of the feature, as a test: no kind ships without advice.
    #[test]
    fn every_kind_ships_at_least_one_action() {
        let id = Uuid::nil();
        for kind in ALL_KINDS {
            // A payload rich enough for every kind - the actions that need a
            // field simply skip it when it is absent, and the fallback link
            // must still be there.
            let payload = json!({
                "action_tab": "settings",
                "action_verb": "test",
                "action_label": "Do it",
                "user_id": "11111111-1111-1111-1111-111111111111",
                "module_id": "drive",
                "setting_key": "auth.registration_open",
                "job_type": "core.selftest",
            });
            let actions = actions_for(kind, &payload, id);
            assert!(
                !actions.is_empty(),
                "le type d'alerte « {kind} » ne propose aucune action"
            );
        }
    }

    /// An action offered to somebody the destination refuses is worse than no
    /// action: every one of them must name a privilege the console can test.
    #[test]
    fn every_action_declares_a_privilege_and_a_tab() {
        for kind in ALL_KINDS {
            for a in actions_for(kind, &json!({ "module_id": "drive" }), Uuid::nil()) {
                assert!(!a.tab.is_empty(), "{kind}/{} sans onglet", a.id);
                assert!(a.privilege.starts_with("core."), "{kind}/{} sans privilège", a.id);
            }
        }
    }

    #[test]
    fn a_dead_letter_alert_can_actually_be_acted_upon() {
        let id = Uuid::new_v4();
        let actions = actions_for(JOB_DEAD_LETTER, &json!({ "job_type": "core.selftest" }), id);
        let retry = actions.iter().find(|a| a.id == "retry-jobs").expect("relance");
        assert!(retry.executes, "la relance est exécutée par le centre d'alertes");
        assert_eq!(retry.verb.as_deref(), Some("retry-jobs"));
        assert_eq!(retry.target_id.as_deref(), Some(id.to_string()).as_deref());
    }

    #[test]
    fn a_login_burst_points_at_the_account_it_is_about() {
        let uid = "22222222-2222-2222-2222-222222222222";
        let actions = actions_for(LOGIN_BURST, &json!({ "user_id": uid }), Uuid::nil());
        let open = actions.iter().find(|a| a.id == "open-account").expect("compte");
        assert!(open.params.iter().any(|(k, v)| k == "user" && v == uid));
    }

    #[test]
    fn a_health_alert_reuses_the_checks_own_destination() {
        let actions = actions_for(
            HEALTH_CRITICAL,
            &json!({ "action_tab": "users", "action_verb": "reset-password", "action_label": "Change it" }),
            Uuid::nil(),
        );
        let fix = actions.first().expect("action de correction");
        assert_eq!(fix.tab, "users");
        assert_eq!(fix.verb.as_deref(), Some("reset-password"));
        assert_eq!(fix.privilege, keys::USERS_READ);
    }
}
