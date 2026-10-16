//! The app's data context: the values a view binds to (`{Bind name}`) and the lists a `Repeater` expands over.
//!
//! The renderer stays free of app logic: a module's app builds a [`Scope`] from its state and installs it with
//! [`set_data`] (from its `setup` and its event handlers - the state changes only then, so the data is set only
//! then). The renderer reads it while laying a view out, resolving each `{Bind …}` against the current repeater item
//! scope, then the root. Setting the data bumps a version the painter folds into its cache key, so a changed context
//! re-rasterises even when the view source did not change. Like the host-control registry, it lives on the UI thread.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

/// A value a view can bind to: a piece of text, or a list of records for a `Repeater`.
#[derive(Clone, Debug)]
pub enum Value {
    Text(String),
    List(Vec<Scope>),
}

/// A record the view binds against: named values, and named lists for repeaters. Built with the chaining setters.
#[derive(Clone, Debug, Default)]
pub struct Scope {
    fields: HashMap<String, Value>,
}

impl Scope {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a text value (`{Bind key}`).
    #[must_use]
    pub fn set(mut self, key: impl Into<String>, text: impl Into<String>) -> Self {
        self.fields.insert(key.into(), Value::Text(text.into()));
        self
    }

    /// Set a list a `Repeater Items="key"` expands over (one built subtree per item scope).
    #[must_use]
    pub fn list(mut self, key: impl Into<String>, items: Vec<Scope>) -> Self {
        self.fields.insert(key.into(), Value::List(items));
        self
    }

    /// The text bound to `key`, if any.
    pub fn text(&self, key: &str) -> Option<&str> {
        match self.fields.get(key) {
            Some(Value::Text(t)) => Some(t),
            _ => None,
        }
    }

    /// The list bound to `key`, if any.
    pub fn items(&self, key: &str) -> Option<&[Scope]> {
        match self.fields.get(key) {
            Some(Value::List(l)) => Some(l),
            _ => None,
        }
    }
}

thread_local! {
    static ROOT: RefCell<Scope> = RefCell::new(Scope::new());
    static VERSION: Cell<u64> = const { Cell::new(0) };
}

/// Replace the app's root data context (from the app's `setup` / event handlers). Bumps the version so the next
/// paint re-rasterises.
pub fn set_data(scope: Scope) {
    ROOT.with(|r| *r.borrow_mut() = scope);
    VERSION.with(|v| v.set(v.get().wrapping_add(1)));
}

/// Read the root context.
pub(crate) fn with_root<R>(f: impl FnOnce(&Scope) -> R) -> R {
    ROOT.with(|r| f(&r.borrow()))
}

/// The context version, part of the painter's cache key.
pub(crate) fn version() -> u64 {
    VERSION.with(Cell::get)
}
