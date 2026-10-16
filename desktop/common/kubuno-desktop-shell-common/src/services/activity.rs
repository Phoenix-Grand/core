//! The activity log: what the sync loop has been doing.
//!
//! The Tauri build kept this in the web page's state, which no longer exists,
//! so the events are recorded here in a bounded log - the shell runs for weeks
//! and an unbounded list would just grow. The activity page shows it
//! (`activity_page`), the header's bell counts it.

use std::sync::Mutex;
use std::time::Instant;

/// How many events are kept. Enough to explain what happened this morning,
/// small enough to never matter.
const MAX_EVENTS: usize = 100;

#[derive(Debug, Clone)]
pub struct Event {
    /// "synced" | "conflict" | "error", as the daemon reports it.
    pub kind:  String,
    pub title: String,
    pub body:  String,
    pub at:    Instant,
}

static LOG: Mutex<Vec<Event>> = Mutex::new(Vec::new());

/// Records one event, dropping the oldest once the log is full.
pub fn record(kind: &str, title: &str, body: &str) {
    let Ok(mut log) = LOG.lock() else { return };
    log.insert(0, Event { kind: kind.to_string(), title: title.to_string(), body: body.to_string(), at: Instant::now() });
    log.truncate(MAX_EVENTS);
}

/// How many events are logged - what the bell's badge shows.
pub fn count() -> usize {
    LOG.lock().map(|l| l.len()).unwrap_or(0)
}

/// The events, newest first.
pub fn events() -> Vec<Event> {
    LOG.lock().map(|l| l.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_is_bounded_and_newest_first() {
        for i in 0..(MAX_EVENTS + 5) {
            record("synced", &format!("e{i}"), "");
        }
        let events = events();
        assert!(events.len() <= MAX_EVENTS);
        assert_eq!(events[0].title, format!("e{}", MAX_EVENTS + 4));
    }
}
