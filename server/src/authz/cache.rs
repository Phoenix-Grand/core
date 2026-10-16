//! Short-lived memory cache of resolved administrative contexts.
//!
//! The resolution query runs once per HTTP request, which is already cheap, but
//! the administration console fires a dozen requests per screen and every one of
//! them would pay a recursive subtree expansion. A few seconds of caching
//! removes that without changing any answer.
//!
//! ## Why the TTL is small, and why invalidation is global
//!
//! A cache on an authorisation decision is a window during which a **revoked**
//! privilege still works. That window is the only thing that matters here, so:
//!
//!  * the TTL is seconds, not minutes;
//!  * every write to a role, a role's privileges, or an assignment calls
//!    [`invalidate_all`] - not "invalidate the subject", because an assignment
//!    made to a *group* changes the context of everyone in that group, and a
//!    privilege removed from a *role* changes it for everyone holding the role.
//!    Working out that closure correctly on every write is exactly the kind of
//!    thing that is right on the day it is written and wrong six months later;
//!    dropping the whole map costs one resolution per active administrator.
//!
//! The cache is process-global on purpose: the core is a single process, and
//! threading a handle through `AppState` would buy nothing but ceremony.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::context::AdminContext;

/// How long a resolved context may be reused. Short enough that a revocation
/// takes effect within a page refresh.
const TTL: Duration = Duration::from_secs(5);

/// Beyond this many entries the map is cleared wholesale rather than grown: an
/// instance with thousands of administrators is not a thing, and an unbounded
/// process-global map is a slow leak.
const MAX_ENTRIES: usize = 512;

struct Entry {
    stored_at: Instant,
    ctx: AdminContext,
}

fn store() -> &'static RwLock<HashMap<Uuid, Entry>> {
    static STORE: OnceLock<RwLock<HashMap<Uuid, Entry>>> = OnceLock::new();
    STORE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Returns the cached context for `user_id` if it is still fresh.
pub fn get(user_id: Uuid) -> Option<AdminContext> {
    // A poisoned lock must not deny service: falling back to "no cache" means
    // one extra query, never a wrong answer.
    let guard = store().read().ok()?;
    let entry = guard.get(&user_id)?;
    if entry.stored_at.elapsed() > TTL {
        return None;
    }
    Some(entry.ctx.clone())
}

/// Caches a freshly resolved context.
pub fn put(user_id: Uuid, ctx: &AdminContext) {
    let Ok(mut guard) = store().write() else {
        return;
    };
    if guard.len() >= MAX_ENTRIES {
        guard.clear();
    }
    guard.insert(
        user_id,
        Entry { stored_at: Instant::now(), ctx: ctx.clone() },
    );
}

/// Drops every cached context **and** the roster below. Called after **any**
/// write to a role, its privileges, or an assignment.
pub fn invalidate_all() {
    if let Ok(mut guard) = store().write() {
        guard.clear();
    }
    if let Ok(mut guard) = roster_store().write() {
        *guard = None;
    }
}

// ── The roster: who holds an assignment at all ───────────────────────────────
//
// `GET /api/v1/me` now answers with the caller's effective privileges, and `/me`
// is called on every page load by *every* account - overwhelmingly by accounts
// that administer nothing. Resolving those would add two queries per page load
// (the resolution, then the fallback that reads the caller's own unit) to pay for
// an answer that is always "holds nothing".
//
// The roster is the fast path: one small set, shared by the whole process, of the
// accounts that hold at least one live assignment - directly or through a group.
// An account absent from it resolves to the empty context with **no query at
// all**. It is one query per TTL for the entire instance instead of two per
// ordinary page load, and it cannot answer "no" wrongly: the same
// [`invalidate_all`] that already runs after every write to a role or an
// assignment drops it, so a freshly granted delegate is visible on their next
// request.

/// The set of accounts holding at least one assignment, when it is small enough
/// to keep in memory.
#[derive(Clone)]
pub enum Roster {
    /// The complete set. An account absent from it holds nothing.
    Holders(Arc<HashSet<Uuid>>),
    /// Too many holders to enumerate (an assignment carried by a group with
    /// thousands of members). No fast path - everyone resolves normally, which is
    /// the behaviour that predates this cache.
    Unbounded,
}

struct RosterEntry {
    stored_at: Instant,
    roster: Roster,
}

fn roster_store() -> &'static RwLock<Option<RosterEntry>> {
    static STORE: OnceLock<RwLock<Option<RosterEntry>>> = OnceLock::new();
    STORE.get_or_init(|| RwLock::new(None))
}

/// The roster, if one was loaded recently enough.
pub fn get_roster() -> Option<Roster> {
    let guard = roster_store().read().ok()?;
    let entry = guard.as_ref()?;
    if entry.stored_at.elapsed() > TTL {
        return None;
    }
    Some(entry.roster.clone())
}

/// Stores a freshly loaded roster.
pub fn put_roster(roster: Roster) {
    if let Ok(mut guard) = roster_store().write() {
        *guard = Some(RosterEntry { stored_at: Instant::now(), roster });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::ActorOrigin;

    /// The cache is a process-wide static, so these tests cannot run in
    /// parallel: one of them calls `invalidate_all()` and wipes what another
    /// has just stored, between its own `put` and `get`. The race decides by
    /// scheduling, which is why the suite passed on one machine and failed on
    /// another the first time it was actually run.
    fn exclusive() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        // A test that panicked while holding the lock must not poison the rest.
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn a_stored_context_is_returned_then_dropped_on_invalidation() {
        let _serialised = exclusive();
        let id = Uuid::new_v4();
        let mut ctx = AdminContext::empty(id, ActorOrigin::Session, None);
        ctx.is_superuser = true;

        put(id, &ctx);
        let got = get(id).expect("contexte en cache");
        assert!(got.is_superuser);

        invalidate_all();
        assert!(get(id).is_none(), "l'invalidation doit vider le cache");
    }

    #[test]
    fn an_unknown_subject_is_a_miss() {
        let _serialised = exclusive();
        invalidate_all();
        assert!(get(Uuid::new_v4()).is_none());
    }

    #[test]
    fn the_roster_is_dropped_by_the_same_invalidation_as_the_contexts() {
        let _serialised = exclusive();
        let holder = Uuid::new_v4();
        put_roster(Roster::Holders(Arc::new(HashSet::from([holder]))));
        match get_roster() {
            Some(Roster::Holders(set)) => assert!(set.contains(&holder)),
            _ => panic!("le registre doit être en cache"),
        }

        // A grant is a write, and every write already calls this.
        invalidate_all();
        assert!(
            get_roster().is_none(),
            "un privilège fraîchement accordé ne doit pas attendre l'expiration du registre"
        );
    }
}
