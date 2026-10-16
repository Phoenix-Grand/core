//! The focused text field and its edit buffer — the one piece of mutable UI state the renderer keeps itself, so a
//! `SearchField` / `TextField` can be typed into.
//!
//! A tap on a text field focuses it here (seeding the buffer with the field's current text); the shell then shows the
//! soft keyboard and feeds key input back through [`insert_str`] / [`backspace`] / [`submit`]. The painter draws the
//! buffer (and a caret) in the focused field instead of its static `Text`. On submit the app learns the typed text
//! through the [`crate::TapEvent`] the field's `OnSubmit` handler carries. Like the data context and the host-control
//! registry, this lives on the UI thread; changing it bumps a version the painter folds into its cache key.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::TapEvent;

/// The focused field and what has been typed into it.
#[derive(Default)]
struct Input {
    /// The `x:Name` of the focused field, or `None` when nothing is focused.
    focused: Option<String>,
    /// What the user has typed so far (the live value of the focused field).
    buffer: String,
    /// The field's `OnSubmit` handler, fired when the keyboard submits (Enter / "go").
    submit: Option<String>,
}

thread_local! {
    static INPUT: RefCell<Input> = RefCell::new(Input::default());
}

/// Bumped on every change so the painter re-rasterises when the buffer or the focus changes.
static VERSION: AtomicU64 = AtomicU64::new(0);

fn bump() {
    VERSION.fetch_add(1, Ordering::Relaxed);
}

/// The edit-state version, folded into the painter's cache key.
pub(crate) fn version() -> u64 {
    VERSION.load(Ordering::Relaxed)
}

/// Give the keyboard focus to field `name`, seeding its buffer with `initial` (its current text) and remembering its
/// submit handler. Re-focusing the already-focused field keeps the buffer (only refreshes the handler), so opening the
/// same field twice does not wipe what was typed.
pub fn focus(name: &str, initial: &str, submit: Option<&str>) {
    INPUT.with(|i| {
        let mut i = i.borrow_mut();
        if i.focused.as_deref() == Some(name) {
            i.submit = submit.map(str::to_string);
            return;
        }
        i.focused = Some(name.to_string());
        i.buffer = initial.to_string();
        i.submit = submit.map(str::to_string);
    });
    bump();
}

/// Drop the keyboard focus (nothing is focused, the buffer is cleared).
pub fn blur() {
    let had = INPUT.with(|i| {
        let mut i = i.borrow_mut();
        let had = i.focused.is_some();
        *i = Input::default();
        had
    });
    if had {
        bump();
    }
}

/// The `x:Name` of the focused field, if any. The shell reads it to show or hide the soft keyboard.
pub fn focused() -> Option<String> {
    INPUT.with(|i| i.borrow().focused.clone())
}

/// Whether field `name` currently holds the keyboard focus (the painter asks, to draw the live buffer and a caret).
pub fn is_focused(name: &str) -> bool {
    INPUT.with(|i| i.borrow().focused.as_deref() == Some(name))
}

/// The focused field's current edit buffer.
pub fn buffer() -> String {
    INPUT.with(|i| i.borrow().buffer.clone())
}

/// Append committed text (a typed character, or an IME commit string) to the focused field. No-op if nothing is
/// focused.
pub fn insert_str(s: &str) {
    if s.is_empty() {
        return;
    }
    let changed = INPUT.with(|i| {
        let mut i = i.borrow_mut();
        if i.focused.is_none() {
            return false;
        }
        i.buffer.push_str(s);
        true
    });
    if changed {
        bump();
    }
}

/// Delete the last character of the focused field's buffer (backspace). No-op if the buffer is empty or nothing is
/// focused.
pub fn backspace() {
    let changed = INPUT.with(|i| {
        let mut i = i.borrow_mut();
        if i.focused.is_none() {
            return false;
        }
        i.buffer.pop().is_some()
    });
    if changed {
        bump();
    }
}

/// Submit the focused field (the keyboard's Enter / "go"): returns the field's submit event — its `x:Name`, its
/// `OnSubmit` handler and the typed text — and drops the focus. `None` (keeping the focus) when nothing is focused or
/// the field declares no `OnSubmit`.
pub fn submit() -> Option<TapEvent> {
    let ev = INPUT.with(|i| {
        let i = i.borrow();
        let name = i.focused.clone()?;
        let handler = i.submit.clone()?;
        Some(TapEvent { name: Some(name), handler, x: 0.0, y: 0.0, text: Some(i.buffer.clone()) })
    });
    if ev.is_some() {
        blur();
    }
    ev
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typing_fills_the_focused_field_then_submit_carries_the_text() {
        blur();
        assert!(focused().is_none());
        // Focusing seeds the buffer with the field's current text; typing appends; backspace removes.
        focus("query", "mus", Some("run_search"));
        assert!(is_focused("query"));
        assert_eq!(buffer(), "mus");
        insert_str("é");
        insert_str("e");
        assert_eq!(buffer(), "musée");
        backspace();
        assert_eq!(buffer(), "musé");
        // A version is bumped on every change, so the painter re-rasterises.
        let v = version();
        insert_str("e");
        assert!(version() > v);
        // Submit returns the handler + the typed text, and drops the focus.
        let ev = submit().expect("submit event");
        assert_eq!(ev.handler, "run_search");
        assert_eq!(ev.text.as_deref(), Some("musée"));
        assert!(focused().is_none());
        // A stray key with nothing focused is ignored.
        insert_str("x");
        assert_eq!(buffer(), "");
    }
}
