//! Instance health - the checks a self-hosted operator has nobody else to run.
//!
//! ## Why this exists
//!
//! A managed service has somebody watching it. A self-hosted instance has its
//! operator, who installed it from a command line six months ago and has had no
//! reason to look since. Nothing in the product tells them that the seeded
//! administrator password is still in place, that the data volume is at 96 %,
//! that the relay they configured has never actually delivered a message, or
//! that there is no backup at all. Every one of those is silent until it is
//! catastrophic.
//!
//! ## The shape of the answer
//!
//! One route, [`crate::handlers::admin::health`], returns a score and a list of
//! checks. Three rules govern it:
//!
//! * **The server computes, the client renders.** The console never derives the
//!   state of a setting from a value it happened to fetch for another screen.
//!   Two readers of the same fact drift, and the one that drifts is always the
//!   one saying "everything is fine".
//! * **The report is filtered by privilege.** A delegated administrator is not
//!   shown a finding they cannot act on - and, since the score is computed over
//!   what they can see, it is not a score about somebody else's problems.
//! * **A check reports a verdict, never a credential.** The internal-secret
//!   check grades the secret and returns one word; there is no code path in
//!   this module that can put the value on the wire.
//!
//! ## Layout
//!
//! * [`model`] - wire types, the score, the counts;
//! * [`facts`] - one pass over the database, the configuration and the request;
//! * [`checks`] - the catalogue, as pure functions over the facts;
//! * [`disk`] - free space of the data volume (`statvfs`);
//! * [`secret`] - the internal-secret verdict.
//!
//! ## Caching
//!
//! The evaluation costs half a dozen small queries and one `statvfs`, and the
//! console asks for it on every admin page (the critical banner). It is cached
//! process-wide for [`CACHE_TTL`] and invalidated on every settings write, so a
//! setting the operator has just changed is never reported with its old value -
//! the single most damaging thing a health page can do to its own credibility.
//!
//! The cache holds the UNFILTERED evaluation. Filtering by privilege happens
//! per request, after the read: caching a filtered report would serve one
//! caller's perimeter to the next.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use kubuno_db::DbPool;

use crate::config::Settings;
use crate::errors::AppError;

pub mod checks;
pub mod disk;
pub mod facts;
pub mod model;
pub mod secret;

pub use facts::RequestProbe;
pub use model::{Block, Check, Counts, Report, Severity, Status};

/// How long an evaluation is reused. Short enough that a change made outside
/// the console (a module crashing, a disk filling) surfaces on the next page,
/// long enough that painting the banner on every admin screen is free.
pub const CACHE_TTL: Duration = Duration::from_secs(60);

struct Cached {
    checks: Vec<Check>,
    generated_at: DateTime<Utc>,
    stored_at: Instant,
}

fn cache() -> &'static Mutex<Option<Cached>> {
    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Drops the cached evaluation.
///
/// Called from every path that changes something a check observes - the
/// settings route, the relay route, the mute endpoints. Cheap, idempotent, and
/// safe to call more often than strictly needed: the cost of an unnecessary
/// invalidation is one extra evaluation, the cost of a missing one is a page
/// telling the operator their fix did not take.
pub fn invalidate() {
    match cache().lock() {
        Ok(mut guard) => *guard = None,
        // A poisoned mutex means a previous evaluation panicked. Clearing it is
        // still the right move, and it must not take the request down with it.
        Err(poisoned) => *poisoned.into_inner() = None,
    }
}

/// Reads the cache, if it is still fresh.
fn cached() -> Option<(Vec<Check>, DateTime<Utc>)> {
    let guard = cache().lock().ok()?;
    let entry = guard.as_ref()?;
    (entry.stored_at.elapsed() < CACHE_TTL)
        .then(|| (entry.checks.clone(), entry.generated_at))
}

fn store(checks: &[Check], generated_at: DateTime<Utc>) {
    if let Ok(mut guard) = cache().lock() {
        *guard = Some(Cached {
            checks: checks.to_vec(),
            generated_at,
            stored_at: Instant::now(),
        });
    }
}

/// Evaluates every check, honouring the cache unless `force` is set.
///
/// `probe` describes the request being served - the only way to know whether
/// TLS terminates upstream, since nothing in the configuration says so.
///
/// It is deliberately NOT part of the cache key, and it is deliberately
/// accumulated rather than read fresh (see `facts::observed`). An instance is
/// routinely reachable both through its TLS proxy and on the plain port, so
/// keying the cache on the probe would make the encryption verdict depend on
/// which request last refreshed it - two reloads, two answers, and a page
/// nobody believes any more.
pub async fn evaluate(
    db: &DbPool,
    settings: &Settings,
    probe: RequestProbe,
    force: bool,
) -> Result<(Vec<Check>, DateTime<Utc>, bool), AppError> {
    // Folded in before the cache is consulted, so a request that arrives over
    // TLS still teaches the process about it even when its own answer is served
    // from the cache.
    facts::note_probe(&probe);

    if !force {
        if let Some((checks, at)) = cached() {
            return Ok((checks, at, true));
        }
    }

    let facts = facts::gather(db, settings, probe).await?;
    let checks = checks::evaluate(&facts);
    let generated_at = Utc::now();
    store(&checks, generated_at);
    Ok((checks, generated_at, false))
}

/// Narrows an evaluation to what one caller may see, then scores it.
///
/// The filter is the point: showing a delegated administrator a finding they
/// have no privilege to fix turns the page into a list of other people's
/// problems, and a score computed over it is a grade for somebody else's work.
pub fn report_for(ctx: &crate::authz::AdminContext, checks: Vec<Check>, generated_at: DateTime<Utc>, cached: bool) -> Report {
    let visible: Vec<Check> = checks.into_iter().filter(|c| ctx.has(c.privilege)).collect();
    Report {
        score: model::score_of(&visible),
        generated_at,
        cached,
        counts: model::counts_of(&visible),
        checks: visible,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test, not three: the cache is process-global, and `cargo test` runs
    /// test functions on parallel threads - split assertions would race each
    /// other for the same slot.
    #[test]
    fn cache_lifecycle() {
        invalidate();
        assert!(cached().is_none(), "vider un cache vide est sans effet");

        let at = Utc::now();
        let checks = checks::evaluate(&{
            let mut f = facts_for_test();
            f.superadmins = 2;
            f
        });
        store(&checks, at);
        let (read, read_at) = cached().expect("cache chaud");
        assert_eq!(read.len(), checks.len());
        assert_eq!(read_at, at);

        invalidate();
        assert!(cached().is_none());
    }

    /// The filter is the security boundary of this route: a delegate must see
    /// their own perimeter, and a score computed over it - never a grade for
    /// somebody else's instance.
    #[test]
    fn the_report_is_narrowed_to_what_the_caller_may_read() {
        use crate::audit::ActorOrigin;
        use crate::authz::{context::PrivilegeScope, AdminContext};

        let checks = checks::evaluate(&facts_for_test());
        let at = Utc::now();

        // A delegate holding only the relay key.
        let mut mail_only =
            AdminContext::empty(uuid::Uuid::nil(), ActorOrigin::Session, None);
        mail_only.privileges.insert(
            crate::authz::keys::MAIL_READ.to_string(),
            PrivilegeScope { instance: true, units: Default::default() },
        );

        let report = report_for(&mail_only, checks.clone(), at, false);
        assert!(!report.checks.is_empty(), "le délégué voit son périmètre");
        assert!(
            report.checks.iter().all(|c| c.block == Block::Communications),
            "et rien d'autre : {:?}",
            report.checks.iter().map(|c| c.id).collect::<Vec<_>>(),
        );
        // The counts and the score are computed over the narrowed list.
        assert_eq!(report.counts.total, report.checks.len());

        // Holding nothing at all yields an empty report and no score - not a
        // reassuring 100.
        let nobody = AdminContext::empty(uuid::Uuid::nil(), ActorOrigin::Session, None);
        let empty = report_for(&nobody, checks.clone(), at, false);
        assert!(empty.checks.is_empty());
        assert_eq!(empty.score, None);

        // A super-user sees the whole catalogue.
        let mut root = AdminContext::empty(uuid::Uuid::nil(), ActorOrigin::Session, None);
        root.is_superuser = true;
        assert_eq!(report_for(&root, checks.clone(), at, false).checks.len(), checks.len());
    }

    /// Same neutral facts the catalogue enumeration uses.
    fn facts_for_test() -> facts::Facts {
        facts::Facts {
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
            probe: RequestProbe::default(),
            tls_observed: false,
            proxy_observed: false,
            secret_verdict: secret::SecretVerdict::Strong,
            trusted_proxy_cidrs: Vec::new(),
            trusted_proxies_are_default: false,
            data_path: String::new(),
            disk: None,
            configured_default_quota: None,
            applied_default_quota: crate::models::user::DEFAULT_QUOTA_BYTES,
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
            instance_locale: "en".into(),
            instance_locale_chosen: false,
            instance_timezone: "UTC".into(),
            instance_timezone_chosen: false,
            failing_modules: Vec::new(),
            mutes: std::collections::HashMap::new(),
        }
    }
}
