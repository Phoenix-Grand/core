//! The catalogue: every check, and the pure function that decides its verdict.
//!
//! Nothing in this file touches the database or the network - it maps
//! [`Facts`] to [`Check`]s. That is what makes the interesting rules testable
//! without a server: the thresholds, the severity escalations, and the handful
//! of places where "not configured" and "configured wrong" must not be
//! conflated.
//!
//! ## What was missing, and is not any more
//!
//! Two checks were left out of the first version rather than faked: **instance
//! language** and **instance time zone** had no setting behind them, so a check
//! reporting "ok" against them would have been an outright lie. Migration
//! `000080` declares both, and - the part that matters - code reads both: the
//! sign-in page obeys `instance.locale` before anybody is authenticated, and
//! every outgoing message is dated in `instance.timezone`. The checks below are
//! therefore about a real thing, and each of them can go red for a reason an
//! operator can act on.
//!
//! Note the shape of the two new verdicts: neither asks "is a value present?" -
//! one always is. They ask "did somebody decide?" and, for the zone, "is what
//! they typed something the formatter can actually use?". A zone name that fails
//! to parse falls back to UTC in [`crate::settings::intl`]; without this check
//! that fallback would be invisible, and every message would be dated in the
//! wrong zone with nothing on any screen saying so.
//!
//! `continuity.backup` used to be permanently `Blocked` - the honest rendering
//! of an instance that had `kubuno db:backup` and nothing that ran it. It now
//! reads the real thing (`crate::backup`): whether a policy is armed, when a
//! backup last actually succeeded, and whether the last attempt failed. The
//! verdict is deliberately about the *outcome*, not the switch: an enabled
//! policy that has produced nothing for a week is not a protected instance, and
//! a check that went green on the switch alone would be the exact lie the
//! feature was built to stop telling.
//!
//! `continuity.restore_tested` sits beside it and is **declarative**: nothing
//! verifies a restore, the wording says so in as many words, and the value comes
//! from an administrator pressing a button that only writes a date. A check that
//! implied the platform had tested a restore it never performed would be worse
//! than no check at all.

use serde_json::json;

use super::facts::Facts;
use super::model::{Action, Block, Check, Observed, Severity, Status};
use super::secret::SecretVerdict;
use crate::authz::keys;

/// Free-space thresholds of the data volume, as fractions still available.
const DISK_WARN_BELOW: f64 = 0.20;
const DISK_CRITICAL_BELOW: f64 = 0.10;

/// A refresh token valid this long, on an instance that never logs an idle
/// session out, is a credential that outlives the laptop it sits on.
const LONG_SESSION_DAYS: i64 = 30;

/// Backup and restore procedure - what the scheduled dump does *not* cover, and
/// how to load one back.
const BACKUP_DOC: &str = "https://github.com/kubuno/core/blob/main/man/kubuno.1";

/// How long a declared restore drill stays meaningful.
///
/// Six months, and not "for ever": the thing a drill proves is that *this*
/// operator, with *this* version and *these* files, can get the instance back.
/// All three drift.
const RESTORE_DRILL_DAYS: i64 = 180;

/// Builds the whole report from the observed state.
///
/// Order matters: the console paints blocks in [`Block::ALL`] order and, inside
/// a block, in the order produced here. Within a block the more damaging checks
/// come first, so a reader who stops after the first line has still read the
/// worst news.
pub fn evaluate(f: &Facts) -> Vec<Check> {
    let mut checks = vec![
        // ── Security ────────────────────────────────────────────────────────
        default_admin_password(f),
        admin_count(f),
        admin_2fa(f),
        registration_policy(f),
        session_policy(f),
        // ── Exposure ────────────────────────────────────────────────────────
        https(f),
        internal_secret(f),
        trusted_proxies(f),
        // ── Continuity ──────────────────────────────────────────────────────
        backup_policy(f),
        restore_tested(f),
        disk_space(f),
        default_quota(f),
        // ── Communications ──────────────────────────────────────────────────
        mail_configured(f),
        mail_tested(f),
        // ── Identity ────────────────────────────────────────────────────────
        instance_name(f),
        instance_locale(f),
        instance_timezone(f),
        non_admin_account(f),
        failing_modules(f),
        audit_retention(f),
    ];

    apply_mutes(f, &mut checks);
    checks
}

/// Turns a failing, ignorable check into an ignored one.
///
/// Three guards, each protecting against a different way this could mislead:
/// a mute never applies to a passing check (so un-muting cannot "break" it),
/// never to a check declared non-ignorable (a default administrator password
/// is not a matter of taste), and never to one that is inapplicable.
fn apply_mutes(f: &Facts, checks: &mut [Check]) {
    for check in checks.iter_mut() {
        let Some(mute) = f.mutes.get(check.id) else { continue };
        if !check.ignorable || !check.status.is_failing() {
            continue;
        }
        check.status = Status::Ignored;
        check.muted = Some(mute.clone());
    }
}

// ── Security ─────────────────────────────────────────────────────────────────

fn default_admin_password(f: &Facts) -> Check {
    let n = f.pending_password_changes;
    Check {
        id: "security.default_admin_password",
        block: Block::Security,
        severity: Severity::Critical,
        status: if n == 0 { Status::Ok } else { Status::Todo },
        title: "No account still carries its seeded password",
        why: "An account that never chose its own password is a published credential: \
              the value is in the installation output and in every copy of the log.",
        value: if n == 0 {
            Observed::new("none_pending", json!({}), "no account pending")
        } else {
            Observed::new("accounts_pending", json!({ "count": n }), format!("{n} account(s) pending"))
        },
        action: (n > 0).then_some(Action {
            tab: "users",
            verb: Some("pending-password"),
            label: "Review the accounts",
        }),
        doc_href: None,
        // The one check nobody may silence: it is the single failure that hands
        // over the whole instance, and it is always fixable in two minutes.
        ignorable: false,
        muted: None,
        privilege: keys::USERS_READ,
    }
}

fn admin_count(f: &Facts) -> Check {
    let n = f.superadmins;
    Check {
        id: "security.admin_count",
        block: Block::Security,
        severity: if n <= 1 { Severity::Warning } else { Severity::Info },
        status: if n >= 2 { Status::Ok } else { Status::Todo },
        title: "At least two full administrators",
        why: "With a single administrator, one forgotten password or one departure \
              leaves the instance with nobody able to administer it.",
        value: Observed::new("admins", json!({ "count": n }), format!("{n} administrator(s)")),
        action: (n < 2).then_some(Action {
            tab: "admin-roles",
            verb: Some("assign-role"),
            label: "Appoint an administrator",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::USERS_READ,
    }
}

fn admin_2fa(f: &Facts) -> Check {
    let total = f.superadmins;
    let with = f.superadmins_with_2fa;
    let missing = (total - with).max(0);
    // Two distinct failures behind the same status, and the difference is worth
    // stating: the policy is off (nothing forces anybody), or the policy is on
    // but somebody has not enrolled yet. The second is a transient state with a
    // grace period; the first is a decision nobody took - which is why the
    // severity below, and the value shown, differ even though both read "todo".
    let status = if f.admin_2fa_required && missing == 0 { Status::Ok } else { Status::Todo };
    Check {
        id: "security.admin_2fa",
        block: Block::Security,
        severity: if !f.admin_2fa_required && missing > 0 { Severity::Warning } else { Severity::Info },
        status,
        title: "Administrators carry a second factor",
        why: "An administrator password alone is one phishing page away from full \
              control of every account on the instance.",
        value: if !f.admin_2fa_required {
            Observed::new(
                "twofa_not_required",
                json!({ "with": with, "total": total }),
                format!("not required - {with}/{total} enrolled"),
            )
        } else {
            Observed::new(
                "twofa_required",
                json!({ "with": with, "total": total, "missing": missing }),
                format!("required - {with}/{total} enrolled"),
            )
        },
        action: (status == Status::Todo).then_some(Action {
            tab: "settings",
            verb: Some("admin-2fa"),
            label: "Open the policy",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::SETTINGS_READ,
    }
}

fn registration_policy(f: &Facts) -> Check {
    // "Assumed" is the word: an open instance is a legitimate choice, an open
    // instance that does not even verify the address is an open relay for
    // account creation. Only the second is reported as something to settle.
    let unverified_open = f.registration_open && !f.email_verification;
    Check {
        id: "security.registration_policy",
        block: Block::Security,
        severity: Severity::Warning,
        status: if unverified_open { Status::Todo } else { Status::Ok },
        title: "Public sign-up is a deliberate choice",
        why: "Sign-up left open without address verification lets anyone create \
              accounts on your instance, under any address they like.",
        // One key per case rather than one key plus flags: a catalogue entry is
        // then a fixed sentence, and no translator has to reimplement the
        // branching in thirteen languages.
        value: match (f.registration_open, f.email_verification) {
            (false, _) => Observed::new("registration_closed", json!({}), "closed"),
            (true, true) => {
                Observed::new("registration_open_verified", json!({}), "open, address verified")
            }
            (true, false) => {
                Observed::new("registration_open_unverified", json!({}), "open, no verification")
            }
        },
        action: unverified_open.then_some(Action {
            tab: "settings",
            verb: Some("registration"),
            label: "Open the policy",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::SETTINGS_READ,
    }
}

fn session_policy(f: &Facts) -> Check {
    // A month-long refresh token is fine when an idle session eventually
    // closes; it is a permanent key when nothing ever closes it. Neither half
    // is a problem on its own, which is why the check tests the pair.
    let never_expires = f.idle_timeout_min <= 0 && f.refresh_ttl_days >= LONG_SESSION_DAYS;
    Check {
        id: "security.session_policy",
        block: Block::Security,
        severity: Severity::Info,
        status: if never_expires { Status::Todo } else { Status::Ok },
        title: "Sessions eventually end",
        why: "A month-long session that no inactivity ever closes stays valid on a \
              device long after it left its owner's hands.",
        value: if f.idle_timeout_min > 0 {
            Observed::new(
                "session_idle_on",
                json!({
                    "refresh_days": f.refresh_ttl_days,
                    "idle_minutes": f.idle_timeout_min,
                    "max_sessions": f.max_sessions,
                }),
                format!("{} d refresh, idle logout {} min", f.refresh_ttl_days, f.idle_timeout_min),
            )
        } else {
            Observed::new(
                "session_idle_off",
                json!({
                    "refresh_days": f.refresh_ttl_days,
                    "max_sessions": f.max_sessions,
                }),
                format!("{} d refresh, no idle logout", f.refresh_ttl_days),
            )
        },
        action: never_expires.then_some(Action {
            tab: "settings",
            verb: Some("session-policy"),
            label: "Open the policy",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::SETTINGS_READ,
    }
}

// ── Exposure ─────────────────────────────────────────────────────────────────

fn https(f: &Facts) -> Check {
    // `tls_observed` is sticky (see `facts::observed`): the question is whether
    // an encrypted path to this instance exists, not whether this particular
    // request happened to arrive through it.
    let served = f.native_tls || f.tls_observed;
    let (key, how) = if f.native_tls {
        ("https_native", "native")
    } else if f.tls_observed {
        ("https_upstream", "upstream")
    } else if f.proxy_observed && !f.probe.peer_trusted {
        // A proxy is talking to us but is not in the trusted list, so its
        // `X-Forwarded-Proto` proves nothing. Reporting "encrypted" on the
        // strength of a header anyone can send is exactly the mistake this
        // check is meant to catch.
        ("https_unverified", "unverified")
    } else {
        ("https_plaintext", "plaintext")
    };
    Check {
        id: "exposure.https",
        block: Block::Exposure,
        severity: Severity::Critical,
        status: if served { Status::Ok } else { Status::Todo },
        title: "Traffic is encrypted",
        why: "Over plain HTTP every password and every session cookie travels in the \
              clear, readable by anything between the browser and the server.",
        value: Observed::new(key, json!({ "how": how }), format!("TLS: {how}")),
        action: (!served).then_some(Action {
            tab: "settings",
            verb: None,
            label: "See the exposure settings",
        }),
        doc_href: None,
        // A LAN-only instance behind no proxy is a real deployment; the
        // operator may silence this, and the trail records that they did.
        ignorable: true,
        muted: None,
        privilege: keys::SETTINGS_READ,
    }
}

fn internal_secret(f: &Facts) -> Check {
    let verdict = f.secret_verdict;
    Check {
        id: "exposure.internal_secret",
        block: Block::Exposure,
        severity: Severity::Critical,
        status: if verdict.is_strong() { Status::Ok } else { Status::Blocked },
        title: "The internal shared secret is not guessable",
        why: "That secret is the only thing guarding /internal/*: a guessable value \
              lets anyone register a module and publish events as the server.",
        // A verdict, never the value - see `health::secret`. The key IS the
        // verdict, so there is not even a field a future refactor could widen
        // into carrying something derived from the secret.
        value: Observed::new(
            match verdict {
                SecretVerdict::Strong => "secret_strong",
                SecretVerdict::Missing => "secret_missing",
                SecretVerdict::TooShort => "secret_too_short",
                SecretVerdict::Placeholder => "secret_placeholder",
                SecretVerdict::LowVariety => "secret_low_variety",
            },
            json!({ "verdict": verdict.as_str() }),
            format!("verdict: {}", verdict.as_str()),
        ),
        // Deliberately no action: the secret lives in the configuration file,
        // not in the database, so there is no screen to send the operator to.
        action: None,
        doc_href: None,
        // Silenceable, because the verdict is a heuristic: entropy and a
        // substring list can both be wrong about a genuinely random value, and
        // a finding an operator cannot dismiss is one they learn to scroll past.
        // Whether a check may be silenced is a property of the CATALOGUE, never
        // of the outcome - otherwise the mute endpoint, which knows the id and
        // not the current verdict, would answer differently from this page.
        ignorable: true,
        muted: None,
        privilege: keys::SETTINGS_READ,
    }
}

fn trusted_proxies(f: &Facts) -> Check {
    let count = f.trusted_proxy_cidrs.len();
    // The default list trusts every RFC1918 range. That is a sane default for a
    // first boot and a bad one once a proxy is genuinely in front: any host on
    // the LAN can then forge the client address the rate limiter and the audit
    // trail believe. The check only fires when a proxy is actually observed.
    let too_wide = f.proxy_observed && f.trusted_proxies_are_default;
    let empty_but_proxied = f.proxy_observed && count == 0;
    let status = if too_wide || empty_but_proxied { Status::Todo } else { Status::Ok };
    Check {
        id: "exposure.trusted_proxies",
        block: Block::Exposure,
        severity: Severity::Warning,
        status,
        title: "Trusted proxy ranges match the deployment",
        why: "While whole private ranges are trusted, any machine on the network can \
              forge the client address recorded in the audit trail and counted by the \
              rate limiter.",
        value: {
            let args = json!({ "count": count });
            if !f.proxy_observed {
                Observed::new("proxies_none_observed", args, format!("{count} range(s), no proxy observed"))
            } else if empty_but_proxied {
                Observed::new("proxies_missing", args, "proxy observed, no range configured")
            } else if f.trusted_proxies_are_default {
                Observed::new("proxies_default", args, format!("{count} default range(s), proxy observed"))
            } else {
                Observed::new("proxies_narrowed", args, format!("{count} narrowed range(s)"))
            }
        },
        action: None,
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::SETTINGS_READ,
    }
}

// ── Continuity ───────────────────────────────────────────────────────────────

fn backup_policy(f: &Facts) -> Check {
    // The question is NOT "is the switch on?" - that is the version of this
    // check that would go green while the instance is unprotected. It is "does a
    // recent, successful backup exist?", which is the only form an operator can
    // act on and the only one a disk failure respects.
    let stats = &f.backup_stats;
    let stale_days = f.backup.stale_after_days();
    let age_days = stats
        .last_success_at
        .map(|at| (chrono::Utc::now() - at).num_days());
    let recent = age_days.is_some_and(|d| d <= stale_days);

    // Green only when BOTH hold: a recent backup exists AND the schedule that
    // produced it is still armed. A yesterday's dump with the policy switched
    // off is a countdown, not a protection - reporting it as satisfied would
    // hand the operator a green light for the three days it takes to expire.
    let fresh = recent && f.backup.enabled;
    let status = if fresh { Status::Ok } else { Status::Todo };

    // The action is the same destination in every failing case, and the console
    // can perform it: there is now a page for this.
    let action = (!fresh).then_some(Action {
        tab: "background-jobs",
        verb: Some("configure-backup"),
        label: "Set up the backup policy",
    });

    let args = json!({
        "enabled":            f.backup.enabled,
        "frequency":          f.backup.frequency.as_str(),
        "retention_count":    f.backup.retention_count,
        "stale_after_days":   stale_days,
        "last_success_at":    stats.last_success_at,
        "last_success_bytes": stats.last_success_bytes,
        "age_days":           age_days,
        "total_runs":         stats.total_runs,
        "consecutive_failures": stats.consecutive_failures,
        // The message is composed from the failing step and is already
        // truncated; it never carries a connection string or a credential.
        "last_error":         stats.last_error,
    });

    let value = if fresh {
        Observed::new(
            "backup_recent",
            args,
            match age_days {
                Some(0) => "backed up today".to_string(),
                Some(d) => format!("backed up {d} day(s) ago"),
                None => "backed up".to_string(),
            },
        )
    } else if !f.backup.enabled && stats.last_success_at.is_none() {
        // The genuine "no policy at all" case, which is what most instances
        // upgrading into this feature will read.
        Observed::new("backup_none", args, "no policy - manual command only")
    } else if !f.backup.enabled {
        // Armed once, switched off since. Worth its own wording: the operator
        // remembers configuring it, and needs to be told it is not running -
        // including on the days a still-recent file makes everything look fine.
        Observed::new("backup_disabled", args, "policy switched off")
    } else if let Some(d) = age_days {
        Observed::new("backup_stale", args, format!("last success {d} day(s) ago"))
    } else if stats.total_runs > 0 {
        Observed::new("backup_never_succeeded", args, "scheduled, never succeeded")
    } else {
        Observed::new("backup_pending", args, "scheduled, not run yet")
    };

    Check {
        id: "continuity.backup",
        block: Block::Continuity,
        severity: Severity::Critical,
        status,
        title: "A recent backup exists",
        why: "Nobody backs up a self-hosted instance for you: without a scheduled \
              dump that is proven to have run, a single disk failure is the end of \
              every account. This covers the database only - the stored files are \
              not in it.",
        value,
        action,
        doc_href: Some(BACKUP_DOC),
        // Silenceable: an operator whose hypervisor snapshots the volume has a
        // policy this product cannot see.
        ignorable: true,
        muted: None,
        privilege: keys::BACKUP_READ,
    }
}

/// Has anybody ever proven they can get the data back?
///
/// **Declarative, and labelled as such everywhere it appears.** A restore cannot
/// be exercised automatically without risking the live instance, so what is
/// recorded is an administrator's statement that they restored a backup
/// somewhere else and it worked. That is weaker than a test and stronger than
/// nothing: the reference frameworks all ask the question, and until now the
/// product had no way to answer it at all.
fn restore_tested(f: &Facts) -> Check {
    let tested = f.backup_restore_tested_at;
    let age_days = tested.map(|at| (chrono::Utc::now() - at).num_days());
    let expired = age_days.is_some_and(|d| d > RESTORE_DRILL_DAYS);

    // The premise has to exist first. Asking "have you tested a restore?" of an
    // instance that has never produced a backup answers a question nobody asked,
    // and reads as a second complaint about the same missing thing.
    let has_backup = f.backup_stats.last_success_at.is_some();

    let status = if !has_backup {
        Status::NotApplicable
    } else if tested.is_none() || expired {
        Status::Todo
    } else {
        Status::Ok
    };

    let args = json!({
        "at": tested,
        "age_days": age_days,
        "expires_after_days": RESTORE_DRILL_DAYS,
        "declared": true,
    });

    Check {
        id: "continuity.restore_tested",
        block: Block::Continuity,
        severity: Severity::Warning,
        status,
        title: "A restore has been tested (declared)",
        why: "A backup nobody has ever restored is a file, not a recovery plan. \
              This records a statement by an administrator - the platform verifies \
              nothing and never restores anything on its own.",
        value: if !has_backup {
            Observed::new("restore_no_backup", json!({}), "no backup to restore yet")
        } else {
            match (tested, expired) {
                (None, _) => Observed::new("restore_never_declared", args, "never declared"),
                (Some(at), true) => Observed::new(
                    "restore_declared_stale",
                    args,
                    format!("declared {}, over {RESTORE_DRILL_DAYS} days ago", at.date_naive()),
                ),
                (Some(at), false) => Observed::new(
                    "restore_declared",
                    args,
                    format!("declared {}", at.date_naive()),
                ),
            }
        },
        action: (status == Status::Todo).then_some(Action {
            tab: "background-jobs",
            verb: Some("declare-restore-test"),
            label: "Declare a tested restore",
        }),
        doc_href: Some(BACKUP_DOC),
        ignorable: true,
        muted: None,
        privilege: keys::BACKUP_READ,
    }
}

fn disk_space(f: &Facts) -> Check {
    let (status, severity, value) = match f.disk {
        // Unknown is not "fine". It is reported as such, at the lowest
        // severity, so it neither reassures nor cries wolf.
        None => (
            Status::Blocked,
            Severity::Info,
            Observed::new(
                "disk_unknown",
                json!({ "path": f.data_path }),
                format!("unreadable: {}", f.data_path),
            ),
        ),
        Some(usage) => {
            let ratio = usage.available_ratio();
            let severity = if ratio < DISK_CRITICAL_BELOW {
                Severity::Critical
            } else if ratio < DISK_WARN_BELOW {
                Severity::Warning
            } else {
                Severity::Info
            };
            let status = if ratio < DISK_WARN_BELOW { Status::Todo } else { Status::Ok };
            (
                status,
                severity,
                Observed::new(
                    "disk",
                    json!({
                        "available_bytes": usage.available_bytes,
                        "total_bytes": usage.total_bytes,
                        "available_percent": (ratio * 100.0).round() as i64,
                        "path": f.data_path,
                    }),
                    format!("{} % free", (ratio * 100.0).round() as i64),
                ),
            )
        }
    };
    Check {
        id: "continuity.disk_space",
        block: Block::Continuity,
        severity,
        status,
        title: "The data volume has room left",
        why: "A full data volume stops uploads and can leave the database unable to \
              write - including the log that would have told you why.",
        value,
        action: None,
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::STATS_READ,
    }
}

fn default_quota(f: &Facts) -> Check {
    // The question is not "is a default quota set?" - one always is - but "does
    // the value the operator sees actually apply?". Account creation now reads
    // the setting, so the two agree by construction and this check is the guard
    // that says so: the day somebody reintroduces a constant, it goes red.
    let configured = f.configured_default_quota;
    let applies = configured.map(|c| c == f.applied_default_quota).unwrap_or(false);
    Check {
        id: "continuity.default_quota",
        block: Block::Continuity,
        severity: Severity::Warning,
        status: if applies { Status::Ok } else { Status::Blocked },
        title: "The default quota is the one actually applied",
        why: "A default quota that the creation of an account does not read is a \
              number an operator changes with no effect. This compares the value \
              on the settings page with the one new accounts receive.",
        value: {
            let args = json!({
                "configured_bytes": configured,
                "applied_bytes": f.applied_default_quota,
            });
            match configured {
                Some(c) if c == f.applied_default_quota => {
                    Observed::new("quota_applied", args, format!("{c} bytes, applied"))
                }
                Some(c) => Observed::new(
                    "quota_ignored",
                    args,
                    format!("configured {c}, applied {}", f.applied_default_quota),
                ),
                None => Observed::new(
                    "quota_unset",
                    args,
                    format!("unset, applied {}", f.applied_default_quota),
                ),
            }
        },
        action: None,
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::SETTINGS_READ,
    }
}

// ── Communications ───────────────────────────────────────────────────────────

fn mail_configured(f: &Facts) -> Check {
    let ready = f.mail_enabled && f.mail_host_set && f.mail_from_set;
    Check {
        id: "communications.mail_relay",
        block: Block::Communications,
        severity: Severity::Warning,
        status: if ready { Status::Ok } else { Status::Todo },
        title: "An outbound mail relay is configured",
        why: "Without a relay the instance can send nothing: no password reset, no \
              invitation, no notification - and no warning that it could not.",
        value: {
            let args = json!({ "host": f.mail_host });
            if !f.mail_enabled {
                Observed::new("mail_disabled", args, "disabled")
            } else if !f.mail_host_set {
                Observed::new("mail_no_host", args, "enabled, no host")
            } else if !f.mail_from_set {
                Observed::new("mail_no_from", args, "enabled, no sender address")
            } else {
                Observed::new("mail_ready", args, f.mail_host.clone())
            }
        },
        action: (!ready).then_some(Action {
            tab: "email",
            verb: Some("configure-relay"),
            label: "Configure the relay",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::MAIL_READ,
    }
}

fn mail_tested(f: &Facts) -> Check {
    let configured = f.mail_enabled && f.mail_host_set && f.mail_from_set;
    // A relay that was proven to work, then reconfigured, is an untested relay
    // again. That is the case this check exists for - "it worked last month"
    // is exactly what an operator believes right up to the outage.
    let stale = match (f.mail_last_test_ok, f.mail_settings_changed_at) {
        (Some(tested), Some(changed)) => changed > tested,
        _ => false,
    };
    let status = if !configured {
        Status::NotApplicable
    } else if f.mail_last_test_ok.is_none() || stale {
        Status::Todo
    } else {
        Status::Ok
    };
    Check {
        id: "communications.mail_tested",
        block: Block::Communications,
        severity: Severity::Warning,
        status,
        title: "The relay has actually delivered a message",
        why: "Relay settings that were never exercised fail silently: the first \
              message anyone misses is a password reset.",
        value: {
            let args = json!({ "at": f.mail_last_test_ok, "stale": stale });
            // The premise is absent: reporting "tested last Tuesday" about a
            // relay that is switched off answers a question nobody asked, and
            // reads as reassurance.
            if !configured {
                Observed::new("mail_not_configured", json!({}), "relay not configured")
            } else {
                match f.mail_last_test_ok {
                    None => Observed::new("mail_never_tested", args, "never tested"),
                    Some(at) if stale => Observed::new(
                        "mail_tested_stale",
                        args,
                        format!("tested {}, settings changed since", at.date_naive()),
                    ),
                    Some(at) => {
                        Observed::new("mail_tested", args, format!("tested {}", at.date_naive()))
                    }
                }
            }
        },
        action: (status == Status::Todo).then_some(Action {
            tab: "email",
            verb: Some("test-relay"),
            label: "Send a test",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::MAIL_READ,
    }
}

// ── Identity ─────────────────────────────────────────────────────────────────

fn instance_name(f: &Facts) -> Check {
    let named = f.instance_name_chosen && !f.instance_name.trim().is_empty();
    Check {
        id: "identity.instance_name",
        block: Block::Identity,
        severity: Severity::Info,
        status: if named { Status::Ok } else { Status::Todo },
        title: "The instance is named",
        why: "The name appears in every message the instance sends and on the sign-in \
              page; left at its seeded value it tells users nothing about whose \
              service they are on.",
        value: if named {
            Observed::new("instance_named", json!({ "name": f.instance_name }), f.instance_name.clone())
        } else {
            Observed::new("instance_default", json!({}), "default value")
        },
        action: (!named).then_some(Action {
            tab: "settings",
            verb: Some("instance-profile"),
            label: "Name the instance",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::SETTINGS_READ,
    }
}

/// Did anybody choose the language the instance speaks to strangers in?
///
/// The premise is the sign-in page: it is served before authentication, so no
/// account preference exists yet and the only thing that can decide is the
/// instance. Left at its seeded English, an instance whose users are all French
/// greets every one of them in English - and the operator has no way to know
/// that a setting would have fixed it, because nothing on that page says so.
fn instance_locale(f: &Facts) -> Check {
    let raw = f.instance_locale.trim();
    let known = crate::settings::intl::normalise_locale(raw);
    // Three outcomes, not two. "Unset" and "set to something the product cannot
    // render" are different failures with different fixes, and collapsing them
    // would send an operator who mistyped `fra` to the wrong screen.
    let status = match (known, f.instance_locale_chosen) {
        (None, _) => Status::Blocked,
        (Some(_), false) => Status::Todo,
        (Some(_), true) => Status::Ok,
    };
    Check {
        id: "identity.instance_locale",
        block: Block::Identity,
        severity: if known.is_none() { Severity::Warning } else { Severity::Info },
        status,
        title: "The instance declares the language it speaks",
        why: "The sign-in page is served before anyone is authenticated, so no account \
              preference exists yet: without an instance language it guesses from the \
              browser, and every message sent to an account that never chose one goes \
              out in English.",
        value: match known {
            None => Observed::new(
                "locale_unknown",
                json!({ "locale": raw }),
                format!("'{raw}' — not a supported language"),
            ),
            Some(code) if f.instance_locale_chosen => {
                Observed::new("locale_chosen", json!({ "locale": code }), code.to_string())
            }
            Some(code) => Observed::new(
                "locale_default",
                json!({ "locale": code }),
                format!("{code} (default)"),
            ),
        },
        action: (status != Status::Ok).then_some(Action {
            tab: "settings",
            verb: Some("instance-profile"),
            label: "Choose the language",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::SETTINGS_READ,
    }
}

/// Is the declared zone one the formatter can actually use?
///
/// `settings::intl::timezone_for` falls back to UTC on a name the IANA database
/// does not know, and logs a warning nobody reads. This is what makes that
/// fallback visible: an instance dating every message two hours off, with a
/// settings page showing the value the operator typed, is the exact shape of a
/// setting that only pretends to work.
fn instance_timezone(f: &Facts) -> Check {
    let raw = f.instance_timezone.trim();
    let parsed = crate::settings::intl::parse_timezone(raw);
    let status = match (parsed.is_some(), f.instance_timezone_chosen) {
        (false, _) => Status::Blocked,
        (true, false) => Status::Todo,
        (true, true) => Status::Ok,
    };
    Check {
        id: "identity.instance_timezone",
        block: Block::Identity,
        severity: if parsed.is_none() { Severity::Warning } else { Severity::Info },
        status,
        title: "The instance time zone is one the server can use",
        why: "Every date the instance writes for a human - starting with the timestamp \
              on the messages it sends - is stated in this zone. A name the time-zone \
              database does not know silently falls back to universal time, and every \
              message goes out hours off with nothing saying why.",
        value: match parsed {
            None => Observed::new(
                "timezone_invalid",
                json!({ "timezone": raw }),
                format!("'{raw}' - identifiant IANA inconnu"),
            ),
            Some(_) if f.instance_timezone_chosen => {
                Observed::new("timezone_chosen", json!({ "timezone": raw }), raw.to_string())
            }
            Some(_) => Observed::new(
                "timezone_default",
                json!({ "timezone": raw }),
                format!("{raw} (default)"),
            ),
        },
        action: (status != Status::Ok).then_some(Action {
            tab: "settings",
            verb: Some("instance-profile"),
            label: "Set the time zone",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::SETTINGS_READ,
    }
}

fn non_admin_account(f: &Facts) -> Check {
    let n = f.non_admin_accounts;
    Check {
        id: "identity.non_admin_account",
        block: Block::Identity,
        severity: Severity::Info,
        status: if n > 0 { Status::Ok } else { Status::Todo },
        title: "At least one ordinary account exists",
        why: "Working day to day from an administrator account means every browser \
              tab you open is one that could reconfigure the instance.",
        value: Observed::new("accounts", json!({ "count": n }), format!("{n} ordinary account(s)")),
        action: (n == 0).then_some(Action {
            tab: "users",
            verb: Some("add-user"),
            label: "Create an account",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::USERS_READ,
    }
}

fn failing_modules(f: &Facts) -> Check {
    let ids: Vec<&str> = f.failing_modules.iter().map(|m| m.id.as_str()).collect();
    let n = ids.len();
    Check {
        id: "identity.failing_modules",
        block: Block::Identity,
        severity: Severity::Warning,
        status: if n == 0 { Status::Ok } else { Status::Todo },
        title: "Every enabled module is answering",
        why: "An enabled module that never registered is invisible to its users: its \
              pages simply do not open, with nothing saying why.",
        value: if n == 0 {
            Observed::new("modules_ok", json!({}), "all modules answering")
        } else {
            Observed::new(
                "modules_failing",
                json!({ "count": n, "ids": ids }),
                format!("{n} module(s) down: {}", ids.join(", ")),
            )
        },
        action: (n > 0).then_some(Action {
            tab: "modules",
            verb: None,
            label: "Open the modules",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::MODULES_READ,
    }
}

fn audit_retention(f: &Facts) -> Check {
    // The floor (90 days) is enforced in two places already, so "is the value
    // legal?" is never the question. "Did anybody decide?" is: the seeded 400
    // days is a default, and a default is not a retention policy.
    let chosen = f.audit_retention_chosen;
    Check {
        id: "identity.audit_retention",
        block: Block::Identity,
        severity: Severity::Info,
        status: if chosen { Status::Ok } else { Status::Todo },
        title: "Log retention is a decision",
        why: "How long the administration trail is kept decides what you can still \
              reconstruct after an incident - and it is regulated in most places.",
        value: Observed::new(
            if chosen { "retention_chosen" } else { "retention_default" },
            json!({ "days": f.audit_retention_days }),
            format!(
                "{} days ({})",
                f.audit_retention_days,
                if chosen { "chosen" } else { "default" },
            ),
        ),
        action: (!chosen).then_some(Action {
            tab: "settings",
            verb: Some("audit-retention"),
            label: "Set the retention",
        }),
        doc_href: None,
        ignorable: true,
        muted: None,
        privilege: keys::AUDIT_READ,
    }
}

// ── Catalogue-wide helpers ───────────────────────────────────────────────────

/// Ids of every check, for the mute endpoints: silencing an unknown id must be
/// refused, or the table fills with typos nobody can ever clear from the UI.
pub fn known_ids() -> Vec<&'static str> {
    // Built from a default evaluation so the list cannot drift from `evaluate`.
    evaluate(&blank_facts()).into_iter().map(|c| c.id).collect()
}

/// Is this check one an operator may silence?
pub fn is_ignorable(id: &str) -> Option<bool> {
    evaluate(&blank_facts())
        .into_iter()
        .find(|c| c.id == id)
        .map(|c| c.ignorable)
}

/// A neutral set of facts - used only to enumerate the catalogue, never to
/// answer a request.
fn blank_facts() -> Facts {
    Facts {
        pending_password_changes: 0,
        superadmins: 0,
        superadmins_with_2fa: 0,
        non_admin_accounts: 0,
        admin_2fa_required: false,
        registration_open: false,
        email_verification: false,
        refresh_ttl_days: 30,
        idle_timeout_min: 0,
        max_sessions: 10,
        audit_retention_days: 400,
        audit_retention_chosen: false,
        native_tls: false,
        probe: super::facts::RequestProbe::default(),
        tls_observed: false,
        proxy_observed: false,
        secret_verdict: SecretVerdict::Strong,
        trusted_proxy_cidrs: Vec::new(),
        trusted_proxies_are_default: false,
        data_path: String::new(),
        disk: None,
        configured_default_quota: None,
        applied_default_quota: crate::models::user::DEFAULT_QUOTA_BYTES,
        // A fresh install: the policy exists and is switched off, and nothing
        // has ever run. `Policy::default()` is the seeded row of migration
        // 000085, so the neutral facts stay the neutral facts.
        backup: crate::backup::Policy::default(),
        backup_stats: crate::backup::runs::RunStats::default(),
        backup_restore_tested_at: None,
        mail_enabled: false,
        mail_host_set: false,
        mail_from_set: false,
        mail_host: String::new(),
        mail_last_test_ok: None,
        mail_settings_changed_at: None,
        instance_name: String::new(),
        instance_name_chosen: false,
        // The seeded values of migration 000080: a blank fact set must describe
        // a fresh install, not an impossible one.
        instance_locale: "en".into(),
        instance_locale_chosen: false,
        instance_timezone: "UTC".into(),
        instance_timezone_chosen: false,
        failing_modules: Vec::new(),
        mutes: std::collections::HashMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::disk::DiskUsage;
    use crate::health::facts::{FailingModule, RequestProbe};
    use crate::health::model::Muted;
    use chrono::{TimeZone, Utc};

    fn facts() -> Facts {
        blank_facts()
    }

    fn find<'a>(checks: &'a [Check], id: &str) -> &'a Check {
        checks.iter().find(|c| c.id == id).expect("check présent")
    }

    fn one(f: &Facts, id: &str) -> Check {
        find(&evaluate(f), id).clone()
    }

    // ── Catalogue integrity ─────────────────────────────────────────────────

    #[test]
    fn every_check_id_is_unique_and_well_formed() {
        let ids = known_ids();
        let unique: std::collections::BTreeSet<_> = ids.iter().collect();
        assert_eq!(ids.len(), unique.len(), "identifiants dupliqués");
        for id in &ids {
            let (block, subject) = id.split_once('.').expect("format <bloc>.<sujet>");
            assert!(!subject.is_empty());
            assert!(
                Block::ALL.iter().any(|b| b.as_str() == block),
                "bloc inconnu dans {id}",
            );
        }
    }

    #[test]
    fn every_check_declares_a_privilege_and_an_actionable_target() {
        for c in evaluate(&facts()) {
            assert!(!c.privilege.is_empty(), "{} sans privilège", c.id);
            // An action must never point at a group: `?tab=` addresses leaves.
            if let Some(a) = &c.action {
                assert!(!a.tab.is_empty(), "{} : onglet vide", c.id);
            }
        }
    }

    // ── Security ────────────────────────────────────────────────────────────

    #[test]
    fn a_seeded_password_is_critical_and_cannot_be_silenced() {
        let mut f = facts();
        f.pending_password_changes = 1;
        let c = one(&f, "security.default_admin_password");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.severity, Severity::Critical);
        assert!(!c.ignorable);

        // And a mute row for it is inert, not merely refused at the API.
        f.mutes.insert(
            "security.default_admin_password".into(),
            Muted { by: None, by_label: None, at: Utc::now(), reason: None },
        );
        assert_eq!(one(&f, "security.default_admin_password").status, Status::Todo);
    }

    #[test]
    fn the_bus_factor_check_turns_green_at_two_administrators() {
        let mut f = facts();
        f.superadmins = 1;
        assert_eq!(one(&f, "security.admin_count").status, Status::Todo);
        assert_eq!(one(&f, "security.admin_count").severity, Severity::Warning);
        f.superadmins = 2;
        assert_eq!(one(&f, "security.admin_count").status, Status::Ok);
    }

    #[test]
    fn two_factor_distinguishes_no_policy_from_incomplete_enrolment() {
        let mut f = facts();
        f.superadmins = 2;

        // Policy off, nobody enrolled: a decision nobody took.
        assert_eq!(one(&f, "security.admin_2fa").status, Status::Todo);
        assert_eq!(one(&f, "security.admin_2fa").severity, Severity::Warning);
        assert_eq!(one(&f, "security.admin_2fa").value.key, "twofa_not_required");

        // Policy on, one administrator still to enrol: transient, informational.
        f.admin_2fa_required = true;
        f.superadmins_with_2fa = 1;
        let c = one(&f, "security.admin_2fa");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.severity, Severity::Info);
        assert_eq!(c.value.key, "twofa_required");

        f.superadmins_with_2fa = 2;
        assert_eq!(one(&f, "security.admin_2fa").status, Status::Ok);
    }

    #[test]
    fn open_registration_is_only_flagged_without_verification() {
        let mut f = facts();
        f.registration_open = true;
        assert_eq!(one(&f, "security.registration_policy").status, Status::Todo);
        // Verified sign-up is a legitimate open instance, not a finding.
        f.email_verification = true;
        assert_eq!(one(&f, "security.registration_policy").status, Status::Ok);
        // Closed is fine either way.
        f.registration_open = false;
        f.email_verification = false;
        assert_eq!(one(&f, "security.registration_policy").status, Status::Ok);
    }

    #[test]
    fn session_policy_needs_both_halves_to_fail() {
        let mut f = facts();
        f.refresh_ttl_days = 30;
        f.idle_timeout_min = 0;
        assert_eq!(one(&f, "security.session_policy").status, Status::Todo);

        // An idle logout rescues a long refresh window…
        f.idle_timeout_min = 30;
        assert_eq!(one(&f, "security.session_policy").status, Status::Ok);

        // …and so does a short refresh window on its own.
        f.idle_timeout_min = 0;
        f.refresh_ttl_days = 7;
        assert_eq!(one(&f, "security.session_policy").status, Status::Ok);
    }

    // ── Exposure ────────────────────────────────────────────────────────────

    #[test]
    fn https_accepts_native_tls_and_a_trusted_upstream_only() {
        let mut f = facts();
        assert_eq!(one(&f, "exposure.https").status, Status::Todo);

        f.native_tls = true;
        assert_eq!(one(&f, "exposure.https").status, Status::Ok);
        assert_eq!(one(&f, "exposure.https").value.key, "https_native");

        f.native_tls = false;
        f.tls_observed = true;
        f.proxy_observed = true;
        f.probe = RequestProbe { forwarded: true, peer_trusted: true, forwarded_https: true };
        assert_eq!(one(&f, "exposure.https").status, Status::Ok);
        assert_eq!(one(&f, "exposure.https").value.key, "https_upstream");
    }

    #[test]
    fn an_untrusted_proxy_claiming_https_does_not_satisfy_the_check() {
        // The whole point: `X-Forwarded-Proto` from a peer outside the trusted
        // ranges is an assertion by a stranger.
        let mut f = facts();
        f.proxy_observed = true;
        f.probe = RequestProbe { forwarded: true, peer_trusted: false, forwarded_https: false };
        let c = one(&f, "exposure.https");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.value.key, "https_unverified");
    }

    #[test]
    fn the_secret_check_reports_a_verdict_and_never_a_value() {
        let mut f = facts();
        f.secret_verdict = SecretVerdict::Placeholder;
        let c = one(&f, "exposure.internal_secret");
        assert_eq!(c.status, Status::Blocked);
        assert_eq!(c.value.key, "secret_placeholder");
        // Nothing that could carry the secret: one key, one enum word.
        let obj = c.value.args.as_object().expect("objet");
        assert_eq!(obj.len(), 1);
        assert_eq!(obj["verdict"], "placeholder");
        // Ignorability is a catalogue property: the same answer whatever the
        // verdict, because the mute endpoint only ever knows the id.
        assert!(c.ignorable);
        f.secret_verdict = SecretVerdict::LowVariety;
        assert!(one(&f, "exposure.internal_secret").ignorable);
        f.secret_verdict = SecretVerdict::Strong;
        assert_eq!(one(&f, "exposure.internal_secret").status, Status::Ok);
    }

    #[test]
    fn wide_proxy_ranges_are_only_a_problem_once_a_proxy_is_observed() {
        let mut f = facts();
        f.trusted_proxies_are_default = true;
        // No proxy in front: the default list harms nobody.
        assert_eq!(one(&f, "exposure.trusted_proxies").status, Status::Ok);

        f.proxy_observed = true;
        f.probe = RequestProbe { forwarded: true, peer_trusted: true, forwarded_https: true };
        assert_eq!(one(&f, "exposure.trusted_proxies").status, Status::Todo);

        // Narrowed to the actual proxy: settled.
        f.trusted_proxies_are_default = false;
        f.trusted_proxy_cidrs = vec!["10.42.0.7/32".into()];
        assert_eq!(one(&f, "exposure.trusted_proxies").status, Status::Ok);

        // Proxied but nothing configured: the headers are dropped, and the
        // recorded client address is the proxy's - also worth saying.
        f.trusted_proxy_cidrs.clear();
        assert_eq!(one(&f, "exposure.trusted_proxies").status, Status::Todo);
    }

    // ── Continuity ──────────────────────────────────────────────────────────

    #[test]
    fn an_instance_with_no_policy_reports_no_policy() {
        let c = one(&facts(), "continuity.backup");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.severity, Severity::Critical);
        assert_eq!(c.value.key, "backup_none");
        // There IS a screen now, and it is named.
        assert_eq!(c.action.as_ref().map(|a| a.tab), Some("background-jobs"));
        assert!(c.doc_href.is_some(), "la procédure doit rester pointée");
    }

    /// The whole point of the check, as a test: the switch is not the verdict.
    /// A policy that is armed and has produced nothing for a week must stay red,
    /// or the indicator becomes a report on an intention.
    #[test]
    fn an_enabled_policy_that_produced_nothing_is_still_critical() {
        let mut f = facts();
        f.backup.enabled = true;
        assert_eq!(one(&f, "continuity.backup").status, Status::Todo);
        assert_eq!(one(&f, "continuity.backup").value.key, "backup_pending");

        // It ran, and failed, repeatedly.
        f.backup_stats.total_runs = 3;
        f.backup_stats.consecutive_failures = 3;
        f.backup_stats.last_status = Some("failed".into());
        let c = one(&f, "continuity.backup");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.value.key, "backup_never_succeeded");

        // A success older than the staleness window of the cadence.
        f.backup_stats.last_success_at = Some(Utc::now() - chrono::Duration::days(9));
        let c = one(&f, "continuity.backup");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.value.key, "backup_stale");

        // And a fresh one turns it green.
        f.backup_stats.last_success_at = Some(Utc::now() - chrono::Duration::hours(2));
        assert_eq!(one(&f, "continuity.backup").status, Status::Ok);
        assert!(one(&f, "continuity.backup").action.is_none());
    }

    /// A weekly policy gets a wider window than a daily one - otherwise every
    /// weekly instance is permanently red six days out of seven.
    #[test]
    fn the_staleness_window_follows_the_cadence() {
        let mut f = facts();
        f.backup.enabled = true;
        f.backup_stats.total_runs = 1;
        f.backup_stats.last_success_at = Some(Utc::now() - chrono::Duration::days(5));

        f.backup.frequency = crate::backup::Frequency::Daily;
        assert_eq!(one(&f, "continuity.backup").status, Status::Todo);

        f.backup.frequency = crate::backup::Frequency::Weekly;
        assert_eq!(one(&f, "continuity.backup").status, Status::Ok);
    }

    /// A policy configured then switched off must not read like one that was
    /// never set up: the operator remembers doing it, and needs to be told it
    /// stopped.
    #[test]
    fn a_disabled_policy_that_once_worked_says_so() {
        let mut f = facts();
        f.backup.enabled = false;
        f.backup_stats.total_runs = 12;
        f.backup_stats.last_success_at = Some(Utc::now() - chrono::Duration::days(30));
        let c = one(&f, "continuity.backup");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.value.key, "backup_disabled");

        // And the case that would otherwise be a green light with a countdown
        // behind it: a backup taken this morning, schedule switched off since.
        f.backup_stats.last_success_at = Some(Utc::now() - chrono::Duration::hours(3));
        let c = one(&f, "continuity.backup");
        assert_eq!(c.status, Status::Todo, "une politique éteinte n'est jamais satisfaite");
        assert_eq!(c.value.key, "backup_disabled");
    }

    #[test]
    fn the_restore_drill_is_not_asked_before_a_backup_exists() {
        let mut f = facts();
        // Nothing to restore yet: the question does not apply.
        assert_eq!(one(&f, "continuity.restore_tested").status, Status::NotApplicable);

        f.backup.enabled = true;
        f.backup_stats.last_success_at = Some(Utc::now() - chrono::Duration::hours(1));
        let c = one(&f, "continuity.restore_tested");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.value.key, "restore_never_declared");
        assert_eq!(c.action.as_ref().and_then(|a| a.verb), Some("declare-restore-test"));

        // Declared today: satisfied. Declared a year ago: expired, because what
        // a drill proves goes stale with the version and the operator.
        f.backup_restore_tested_at = Some(Utc::now() - chrono::Duration::days(3));
        assert_eq!(one(&f, "continuity.restore_tested").status, Status::Ok);
        f.backup_restore_tested_at = Some(Utc::now() - chrono::Duration::days(400));
        let c = one(&f, "continuity.restore_tested");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.value.key, "restore_declared_stale");
        // Never a claim that the platform tested anything.
        assert!(c.title.contains("declared"));
        assert!(c.value.args["declared"].as_bool().unwrap_or(false));
    }

    #[test]
    fn disk_thresholds_escalate_and_unknown_is_not_reassuring() {
        let mut f = facts();

        f.disk = Some(DiskUsage { total_bytes: 1000, available_bytes: 500 });
        let c = one(&f, "continuity.disk_space");
        assert_eq!(c.status, Status::Ok);
        assert_eq!(c.severity, Severity::Info);

        f.disk = Some(DiskUsage { total_bytes: 1000, available_bytes: 150 });
        let c = one(&f, "continuity.disk_space");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.severity, Severity::Warning);

        f.disk = Some(DiskUsage { total_bytes: 1000, available_bytes: 50 });
        let c = one(&f, "continuity.disk_space");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.severity, Severity::Critical);

        f.disk = None;
        let c = one(&f, "continuity.disk_space");
        assert_eq!(c.status, Status::Blocked, "inconnu n'est pas « tout va bien »");
        assert_eq!(c.value.key, "disk_unknown");
    }

    #[test]
    fn the_quota_check_catches_a_setting_that_does_not_apply() {
        let mut f = facts();
        // Seeded value: it matches what the code applies.
        f.configured_default_quota = Some(crate::models::user::DEFAULT_QUOTA_BYTES);
        assert_eq!(one(&f, "continuity.default_quota").status, Status::Ok);

        // The operator raised it - and nothing changed.
        f.configured_default_quota = Some(50 * 1024 * 1024 * 1024);
        assert_eq!(one(&f, "continuity.default_quota").status, Status::Blocked);
    }

    // ── Communications ──────────────────────────────────────────────────────

    #[test]
    fn the_test_check_is_inapplicable_until_the_relay_is_configured() {
        let mut f = facts();
        let inapplicable = one(&f, "communications.mail_tested");
        assert_eq!(inapplicable.status, Status::NotApplicable);
        // …and it says so, rather than reporting a stale success about a relay
        // that is switched off.
        assert_eq!(inapplicable.value.key, "mail_not_configured");
        assert_eq!(one(&f, "communications.mail_relay").status, Status::Todo);

        f.mail_enabled = true;
        f.mail_host_set = true;
        f.mail_from_set = true;
        assert_eq!(one(&f, "communications.mail_relay").status, Status::Ok);
        assert_eq!(one(&f, "communications.mail_tested").status, Status::Todo);
    }

    #[test]
    fn reconfiguring_the_relay_invalidates_a_previous_successful_test() {
        let mut f = facts();
        f.mail_enabled = true;
        f.mail_host_set = true;
        f.mail_from_set = true;

        let tested = Utc.with_ymd_and_hms(2026, 1, 10, 12, 0, 0).unwrap();
        f.mail_last_test_ok = Some(tested);
        f.mail_settings_changed_at = Some(Utc.with_ymd_and_hms(2026, 1, 5, 12, 0, 0).unwrap());
        assert_eq!(one(&f, "communications.mail_tested").status, Status::Ok);

        // Settings touched after the last success: untested again.
        f.mail_settings_changed_at = Some(Utc.with_ymd_and_hms(2026, 2, 1, 12, 0, 0).unwrap());
        let c = one(&f, "communications.mail_tested");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.value.key, "mail_tested_stale");
    }

    // ── Identity ────────────────────────────────────────────────────────────

    #[test]
    fn a_seeded_instance_name_does_not_count_as_named() {
        let mut f = facts();
        f.instance_name = "Kubuno".into();
        f.instance_name_chosen = false;
        assert_eq!(one(&f, "identity.instance_name").status, Status::Todo);

        f.instance_name_chosen = true;
        f.instance_name = "Martinien OLINGA".into();
        assert_eq!(one(&f, "identity.instance_name").status, Status::Ok);

        // Chosen but blanked out is not named either.
        f.instance_name = "   ".into();
        assert_eq!(one(&f, "identity.instance_name").status, Status::Todo);
    }

    #[test]
    fn the_language_check_separates_unset_from_unusable() {
        let mut f = facts();
        // Fresh install: English, nobody decided.
        assert_eq!(one(&f, "identity.instance_locale").status, Status::Todo);
        assert_eq!(one(&f, "identity.instance_locale").value.key, "locale_default");

        // Decided - even when the decision is the same value.
        f.instance_locale_chosen = true;
        assert_eq!(one(&f, "identity.instance_locale").status, Status::Ok);
        f.instance_locale = "fr".into();
        assert_eq!(one(&f, "identity.instance_locale").status, Status::Ok);
        assert_eq!(one(&f, "identity.instance_locale").value.args["locale"], "fr");

        // A value nothing can render is a different failure, and says so.
        f.instance_locale = "fra".into();
        let c = one(&f, "identity.instance_locale");
        assert_eq!(c.status, Status::Blocked);
        assert_eq!(c.value.key, "locale_unknown");
        assert_eq!(c.severity, Severity::Warning);
    }

    #[test]
    fn the_zone_check_catches_the_silent_fallback_to_universal_time() {
        let mut f = facts();
        assert_eq!(one(&f, "identity.instance_timezone").status, Status::Todo);

        f.instance_timezone = "Europe/Paris".into();
        f.instance_timezone_chosen = true;
        assert_eq!(one(&f, "identity.instance_timezone").status, Status::Ok);

        // The whole reason this check exists: a typo parses to nothing, the
        // formatter quietly uses UTC, and only this line says so.
        f.instance_timezone = "Europe/Pariz".into();
        let c = one(&f, "identity.instance_timezone");
        assert_eq!(c.status, Status::Blocked);
        assert_eq!(c.value.key, "timezone_invalid");

        // An abbreviation is not an identifier - same verdict.
        f.instance_timezone = "CEST".into();
        assert_eq!(one(&f, "identity.instance_timezone").status, Status::Blocked);

        // UTC deliberately chosen is a decision like any other.
        f.instance_timezone = "UTC".into();
        assert_eq!(one(&f, "identity.instance_timezone").status, Status::Ok);
    }

    #[test]
    fn a_module_that_never_registered_counts_as_failing() {
        let mut f = facts();
        assert_eq!(one(&f, "identity.failing_modules").status, Status::Ok);
        f.failing_modules = vec![
            FailingModule { id: "drive".into(), status: "never_registered".into() },
            FailingModule { id: "mail".into(), status: "stopped".into() },
        ];
        let c = one(&f, "identity.failing_modules");
        assert_eq!(c.status, Status::Todo);
        assert_eq!(c.value.args["count"], 2);
    }

    #[test]
    fn retention_asks_whether_somebody_decided_not_whether_the_value_is_legal() {
        let mut f = facts();
        f.audit_retention_days = 400;
        f.audit_retention_chosen = false;
        assert_eq!(one(&f, "identity.audit_retention").status, Status::Todo);
        // The same legal value, explicitly chosen, passes.
        f.audit_retention_chosen = true;
        assert_eq!(one(&f, "identity.audit_retention").status, Status::Ok);
    }

    // ── Mutes ───────────────────────────────────────────────────────────────

    #[test]
    fn a_mute_hides_a_failure_and_only_a_failure() {
        let mut f = facts();
        f.superadmins = 1;
        f.mutes.insert(
            "security.admin_count".into(),
            Muted { by: None, by_label: Some("root".into()), at: Utc::now(), reason: Some("solo".into()) },
        );
        let c = one(&f, "security.admin_count");
        assert_eq!(c.status, Status::Ignored);
        assert_eq!(c.muted.as_ref().and_then(|m| m.by_label.clone()), Some("root".into()));

        // Fixed for real while muted: it reads as passing, not as ignored, so
        // un-muting later cannot resurrect a finding that no longer exists.
        f.superadmins = 3;
        let c = one(&f, "security.admin_count");
        assert_eq!(c.status, Status::Ok);
        assert!(c.muted.is_none());
    }

    #[test]
    fn is_ignorable_answers_for_known_ids_only() {
        assert_eq!(is_ignorable("security.admin_count"), Some(true));
        assert_eq!(is_ignorable("security.default_admin_password"), Some(false));
        assert_eq!(is_ignorable("nope.nope"), None);
    }
}
