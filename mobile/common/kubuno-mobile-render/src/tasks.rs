//! Getting the result of background work back onto the UI thread.
//!
//! The app's state and data context live on the UI thread (the host-control registry and the data context are
//! `thread_local`), so a worker thread - a network call, a file read - cannot touch them directly. Instead it hands
//! the UI thread a closure with [`post_ui`]: the shell drains and runs those closures on its own thread each frame
//! ([`run_ui_tasks`]), and the closure is where the app applies the result (updates its state, calls
//! [`crate::set_data`]). Posting also fires the shell's waker ([`set_waker`]), so the loop wakes at once instead of
//! waiting for its next poll. The queue is process-global (the shell is a single foreground app), unlike the
//! per-thread registry.
//!
//! A module's app therefore does background work with plain threads:
//! ```ignore
//! std::thread::spawn(move || {
//!     let places = fetch_places();                 // worker thread: the network call
//!     kubuno_mobile_render::post_ui(move || {       // back on the UI thread:
//!         kubuno_mobile_render::set_data(to_scope(places));   // apply the result
//!     });
//! });
//! ```

use std::sync::Mutex;

/// Closures posted from worker threads, to run on the UI thread on the next drain.
static INBOX: Mutex<Vec<Box<dyn FnOnce() + Send>>> = Mutex::new(Vec::new());
/// The shell's wake-up, called after a post so the UI loop runs the task promptly.
static WAKER: Mutex<Option<Box<dyn Fn() + Send + Sync>>> = Mutex::new(None);

/// Hand the UI thread a closure to run on its next frame (callable from any thread), and wake the shell. The closure
/// is where the app applies a background result - it runs on the UI thread, so it may touch the app's state and the
/// data context.
pub fn post_ui(task: impl FnOnce() + Send + 'static) {
    if let Ok(mut inbox) = INBOX.lock() {
        inbox.push(Box::new(task));
    }
    wake();
}

/// Run every posted closure, oldest first, on the calling (UI) thread. The shell calls this once per loop iteration,
/// before rendering.
pub fn run_ui_tasks() {
    let tasks = INBOX.lock().map(|mut inbox| std::mem::take(&mut *inbox)).unwrap_or_default();
    for task in tasks {
        task();
    }
}

/// Install the shell's wake-up: a `Fn` that nudges the UI loop to run (`AndroidAppWaker::wake`, a winit
/// `EventLoopProxy`…). Called once by the shell at start-up.
pub fn set_waker(f: impl Fn() + Send + Sync + 'static) {
    if let Ok(mut waker) = WAKER.lock() {
        *waker = Some(Box::new(f));
    }
}

fn wake() {
    if let Ok(waker) = WAKER.lock() {
        if let Some(wake) = waker.as_ref() {
            wake();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn a_posted_task_wakes_then_runs_only_on_drain() {
        let woke = Arc::new(AtomicUsize::new(0));
        let w = woke.clone();
        set_waker(move || {
            w.fetch_add(1, Ordering::SeqCst);
        });
        let ran = Arc::new(AtomicUsize::new(0));
        let r = ran.clone();
        // Post from a worker thread, as the app would after a network call.
        std::thread::spawn(move || post_ui(move || { r.fetch_add(1, Ordering::SeqCst); })).join().unwrap();
        assert!(woke.load(Ordering::SeqCst) >= 1, "posting fired the waker");
        assert_eq!(ran.load(Ordering::SeqCst), 0, "the task does not run until the UI thread drains it");
        run_ui_tasks();
        assert_eq!(ran.load(Ordering::SeqCst), 1, "the task ran on drain");
    }
}
