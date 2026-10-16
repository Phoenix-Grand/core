//! Public holidays and special days - the instance's answer to "is that day
//! off, and where".
//!
//! ## What lives here
//!
//! * [`model`] - the closed grammar of a rule, and the shapes the API speaks.
//! * [`rules`] - the expander: a rule plus a date range gives occurrences. Pure
//!   arithmetic, no database, fully tested.
//! * [`store`] - reading and writing the referential, and folding the
//!   organisational-unit overlay into it.
//! * [`seed`] - loading the shipped dataset without ever undoing an edit.
//! * [`resolve`] - which calendars apply to a given reader.
//!
//! ## The rule that governs the whole module
//!
//! A holiday is **information**, not a permission. Every signed-in account may
//! read the feed for any calendar; `core.holidays.manage` gates writing, and
//! `core.holidays.read` gates the administration console - not the answer to
//! "what day is the 14th of July". A calendar that hid public holidays from
//! ordinary members would be a bug wearing a policy's clothes.
//!
//! ## Why the core owns it rather than the calendar module
//!
//! Several modules read it and none owns it: an agenda draws it, a task board
//! keeps a deadline off it, a workflow delays a run because of it. Putting it in
//! the module that happened to need it first would make every other module
//! depend on that one, which the polyrepo architecture forbids outright.

pub mod model;
pub mod resolve;
pub mod rules;
pub mod seed;
pub mod store;

pub use model::{Category, Holiday, HolidayCalendar, Observance, Occurrence, Rule};
