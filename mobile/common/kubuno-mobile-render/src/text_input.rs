//! Text input for the general input controls of the shared vocabulary (`SearchField`, `TextField`): which field holds
//! the keyboard focus, what has been typed into each field, and what the keyboard's keys do.
//!
//! This is engine behaviour, the same for every app and every input control: an app never handles a key itself. The
//! shell only *translates* its platform key events into a [`Key`] and hands it to [`handle_key`], which edits the
//! focused field and returns the events the view declared for it, for the shell to pass to the app:
//!
//! - a character / Backspace edits the field (honouring `MaxLength`) and raises its `OnTextChanged`;
//! - Enter on a `SearchField` raises its `OnSearch` and closes the keyboard;
//! - Enter on a `TextField` raises its `OnKeyDown` (key `Enter`) when it declares one, then moves the focus to the next
//!   field of the view (by `TabIndex`, else in document order), or closes the keyboard after the last one;
//! - Escape drops the focus.
//!
//! Each field keeps its typed value (keyed by its `x:Name`) until the app replaces or clears it, so a form keeps what was
//! typed in a field after the focus moved on, and the app reads it with [`value`]. The painter draws the value (masked
//! for a password field) and a caret in the focused field. Like the data context, this lives on the UI thread; every
//! change bumps a version the painter folds into its cache key.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::TapEvent;

/// What makes an element an editable text field, read from its attributes.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldSpec {
    /// The control: `SearchField` or `TextField`.
    pub control: String,
    /// The text is masked: `InputType="Password"`, `UseSystemPasswordChar="true"` or a `PasswordChar`.
    pub masked: bool,
    /// The character a masked field shows for each typed one (`PasswordChar`, else `•`).
    pub mask: char,
    /// `MaxLength`, when set (characters).
    pub max_len: Option<usize>,
    /// `TabIndex`, when set: the order Enter walks the fields in (document order otherwise).
    pub tab_index: Option<i32>,
}

/// A key, as a shell translates its platform key event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Key {
    /// Committed text: a typed character, or an input method's commit string.
    Text(String),
    Backspace,
    /// Enter / the soft keyboard's action key (Go, Search, Next, Done).
    Enter,
    /// Escape / dismiss: drops the focus.
    Escape,
}

/// An editable field of the view on screen (collected by the painter with the tappable targets).
#[derive(Clone, Debug)]
pub(crate) struct ViewField {
    pub name: String,
    pub spec: FieldSpec,
    /// Its static `Text` (resolved): the starting value until something is typed.
    pub initial: String,
    /// Its event handlers, `(event, handler)`.
    pub events: Vec<(String, String)>,
}

impl ViewField {
    fn handler(&self, event: &str) -> Option<String> {
        self.events.iter().find(|(e, _)| e == event).map(|(_, h)| h.clone())
    }
}

#[derive(Default)]
struct Input {
    /// The `x:Name` of the focused field.
    focused: Option<String>,
    /// What has been typed into each field (by `x:Name`), kept until the app replaces or clears it.
    values: HashMap<String, String>,
    /// The editable fields of the view on screen, in tab order.
    fields: Vec<ViewField>,
}

thread_local! {
    static INPUT: RefCell<Input> = RefCell::new(Input::default());
}

/// Bumped on every change so the painter re-rasterises when a value or the focus changes.
static VERSION: AtomicU64 = AtomicU64::new(0);

fn bump() {
    VERSION.fetch_add(1, Ordering::Relaxed);
}

/// The text-input version, folded into the painter's cache key.
pub(crate) fn version() -> u64 {
    VERSION.load(Ordering::Relaxed)
}

/// Install the editable fields of the view now on screen (the painter calls it each time it lays a view out). They are
/// sorted into tab order. If the focused field is not on this view any more, the focus is dropped.
pub(crate) fn set_view_fields(mut fields: Vec<ViewField>) {
    // Stable: fields without a TabIndex keep their document order, after those that have one.
    fields.sort_by_key(|f| f.spec.tab_index.unwrap_or(i32::MAX));
    let dropped = INPUT.with(|i| {
        let mut i = i.borrow_mut();
        i.fields = fields;
        let gone = i.focused.as_ref().is_some_and(|n| !i.fields.iter().any(|f| &f.name == n));
        if gone {
            i.focused = None;
        }
        gone
    });
    if dropped {
        bump();
    }
}

/// Give the keyboard focus to field `name` (a tap on it does this; an app may too, e.g. to open a screen with the
/// keyboard up). The field keeps any value already typed into it.
pub fn focus(name: &str) {
    let changed = INPUT.with(|i| {
        let mut i = i.borrow_mut();
        if i.focused.as_deref() == Some(name) {
            return false;
        }
        i.focused = Some(name.to_string());
        true
    });
    if changed {
        bump();
    }
}

/// Drop the keyboard focus. Typed values are kept.
pub fn blur() {
    let had = INPUT.with(|i| i.borrow_mut().focused.take().is_some());
    if had {
        bump();
    }
}

/// The `x:Name` of the focused field, if any. The shell shows the soft keyboard while there is one.
pub fn focused() -> Option<String> {
    INPUT.with(|i| i.borrow().focused.clone())
}

/// Whether field `name` holds the keyboard focus.
pub fn is_focused(name: &str) -> bool {
    INPUT.with(|i| i.borrow().focused.as_deref() == Some(name))
}

/// What has been typed into field `name` (or set by the app), `None` if nothing was — the field then shows its static
/// `Text`.
pub fn value(name: &str) -> Option<String> {
    INPUT.with(|i| i.borrow().values.get(name).cloned())
}

/// Set field `name`'s value (prefill, or reset). Shown at once.
pub fn set_value(name: &str, value: &str) {
    INPUT.with(|i| i.borrow_mut().values.insert(name.to_string(), value.to_string()));
    bump();
}

/// Forget every typed value and drop the focus (e.g. once a sign-in form has been sent, so no password stays in memory).
pub fn clear() {
    INPUT.with(|i| {
        let mut i = i.borrow_mut();
        i.values.clear();
        i.focused = None;
    });
    bump();
}

/// Apply a key to the focused field and return the events the view declared for what happened, in order, for the
/// shell to hand to the app. Nothing happens (and no event is returned) when no field is focused.
pub fn handle_key(key: Key) -> Vec<TapEvent> {
    let mut events = Vec::new();
    let changed = INPUT.with(|i| {
        let mut i = i.borrow_mut();
        let Some(name) = i.focused.clone() else { return false };
        // The focused field's declaration (a field focused before its view was laid out behaves as a plain TextField).
        let field = i.fields.iter().find(|f| f.name == name).cloned().unwrap_or_else(|| ViewField {
            name: name.clone(),
            spec: FieldSpec { control: "TextField".into(), masked: false, mask: '•', max_len: None, tab_index: None },
            initial: String::new(),
            events: Vec::new(),
        });
        let event = |handler: String, text: &str, key: Option<&str>| TapEvent {
            name: Some(name.clone()),
            handler,
            x: 0.0,
            y: 0.0,
            text: Some(text.to_string()),
            key: key.map(str::to_string),
        };
        match key {
            Key::Text(s) => {
                let value = i.values.entry(name.clone()).or_insert_with(|| field.initial.clone());
                let mut edited = false;
                for c in s.chars().filter(|c| !c.is_control()) {
                    if field.spec.max_len.is_some_and(|m| value.chars().count() >= m) {
                        break;
                    }
                    value.push(c);
                    edited = true;
                }
                if edited {
                    if let Some(h) = field.handler("TextChanged") {
                        events.push(event(h, value, None));
                    }
                }
                edited
            }
            Key::Backspace => {
                let value = i.values.entry(name.clone()).or_insert_with(|| field.initial.clone());
                let edited = value.pop().is_some();
                if edited {
                    if let Some(h) = field.handler("TextChanged") {
                        events.push(event(h, value, None));
                    }
                }
                edited
            }
            Key::Enter => {
                let value = i.values.get(&name).cloned().unwrap_or_else(|| field.initial.clone());
                if field.spec.control == "SearchField" {
                    if let Some(h) = field.handler("Search") {
                        events.push(event(h, &value, Some("Enter")));
                    }
                    i.focused = None;
                } else {
                    if let Some(h) = field.handler("KeyDown") {
                        events.push(event(h, &value, Some("Enter")));
                    }
                    // Move on to the next field of the view, or close the keyboard after the last one.
                    let pos = i.fields.iter().position(|f| f.name == name);
                    i.focused = pos.and_then(|p| i.fields.get(p + 1)).map(|f| f.name.clone());
                }
                true
            }
            Key::Escape => {
                i.focused = None;
                true
            }
        }
    });
    if changed {
        bump();
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(name: &str, control: &str, events: &[(&str, &str)], tab: Option<i32>) -> ViewField {
        ViewField {
            name: name.into(),
            spec: FieldSpec { control: control.into(), masked: false, mask: '•', max_len: None, tab_index: tab },
            initial: String::new(),
            events: events.iter().map(|(e, h)| (e.to_string(), h.to_string())).collect(),
        }
    }

    #[test]
    fn typing_edits_the_focused_field_and_raises_text_changed() {
        clear();
        set_view_fields(vec![field("query", "SearchField", &[("TextChanged", "typed"), ("Search", "run")], None)]);
        assert!(handle_key(Key::Text("x".into())).is_empty(), "no focus: keys are ignored");
        focus("query");
        let ev = handle_key(Key::Text("musé".into()));
        assert_eq!(ev[0].handler, "typed");
        assert_eq!(ev[0].text.as_deref(), Some("musé"));
        handle_key(Key::Text("e".into()));
        handle_key(Key::Backspace);
        assert_eq!(value("query").as_deref(), Some("musé"));
        let v = version();
        handle_key(Key::Text("e".into()));
        assert!(version() > v, "an edit re-rasterises");
        // Enter on a SearchField raises OnSearch with the text and closes the keyboard; the value stays in the field.
        let ev = handle_key(Key::Enter);
        assert_eq!((ev[0].handler.as_str(), ev[0].text.as_deref(), ev[0].key.as_deref()), ("run", Some("musée"), Some("Enter")));
        assert!(focused().is_none());
        assert_eq!(value("query").as_deref(), Some("musée"));
    }

    #[test]
    fn enter_walks_the_form_in_tab_order_then_raises_key_down_on_the_last_field() {
        clear();
        set_view_fields(vec![
            field("password", "TextField", &[("KeyDown", "sign_in")], Some(2)),
            field("login", "TextField", &[], Some(1)),
        ]);
        focus("login");
        handle_key(Key::Text("zoe".into()));
        assert!(handle_key(Key::Enter).is_empty());
        assert_eq!(focused().as_deref(), Some("password"), "Enter moves to the next field by TabIndex");
        handle_key(Key::Text("secret".into()));
        let ev = handle_key(Key::Enter);
        assert_eq!((ev[0].handler.as_str(), ev[0].key.as_deref()), ("sign_in", Some("Enter")));
        assert!(focused().is_none(), "after the last field the keyboard closes");
        assert_eq!((value("login").as_deref(), value("password").as_deref()), (Some("zoe"), Some("secret")));
        clear();
        assert!(value("password").is_none(), "clear forgets every value");
    }

    #[test]
    fn max_length_caps_the_value_and_a_vanished_field_loses_the_focus() {
        clear();
        let mut code = field("code", "TextField", &[], None);
        code.spec.max_len = Some(6);
        set_view_fields(vec![code]);
        focus("code");
        handle_key(Key::Text("12345678".into()));
        assert_eq!(value("code").as_deref(), Some("123456"));
        set_view_fields(Vec::new());
        assert!(focused().is_none());
    }
}
