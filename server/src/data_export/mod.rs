//! Data export - the archive of what the instance holds, produced on demand.
//!
//! ## What this is, and what the backup is
//!
//! [`crate::backup`] writes a **backup**: a data-only dump of the `core` schema,
//! in the text format `psql` restores, for one reader - the operator putting the
//! instance back together at 3 a.m. It covers the core schema and nothing else,
//! it contains every password hash, and it never leaves the server.
//!
//! This writes an **export**: a ZIP archive organised by *account*, reaching into
//! the installed *modules*, carrying no credential of any kind, and meant to be
//! downloaded and handed to somebody. It answers two questions the backup cannot:
//!
//!   * *"We are leaving. Give us our data."* - the organisation-wide export;
//!   * *"What do you hold about me?"* - the single-account export, which is the
//!     same machinery with one subject, deliberately, so the narrow errand can
//!     never drift from the wide one.
//!
//! The two features share a job runner and nothing else.
//!
//! ## The architectural constraint, and the answer to it
//!
//! The core may only read the PostgreSQL schema `core` - that rule is absolute,
//! and it is what makes a module independently installable and removable. An
//! export is worth having precisely because it reaches the modules. Those two
//! facts leave one shape: the core cannot READ a module's data, so it ASKS.
//!
//! [`contract`] is that request, specified in full: two internal routes a module
//! implements, discovered dynamically, with the module answering in whatever
//! format actually means something for its data. A module that has not
//! implemented it simply does not take part, and nothing anywhere in the core
//! names a module.
//!
//! ## The three security properties
//!
//! An export concentrates everything the instance knows about everyone into one
//! file, which makes it the most dangerous verb in the console. Three controls,
//! and each is useless without the other two:
//!
//!   1. **A privilege of its own** (`core.data_export.execute`), granted to no
//!      seeded role. "Can administer" must not imply "can walk out with
//!      everything".
//!   2. **Every administrator is told, at once** ([`notify`]). Nothing about a
//!      request distinguishes a legitimate one from a stolen session, so the
//!      defence is visibility rather than a check.
//!   3. **A hold before the archive can be downloaded** (`data_export.hold_hours`,
//!      48 h by default). That is the window in which somebody else acts on (2).
//!
//! On top of them: an archive that expires and is deleted whether or not it was
//! fetched, prerequisites on the requesting account (age, second factor), an
//! audit entry on the request and on every download, and a redaction rule that
//! is a column list rather than a promise ([`core_data`]).
//!
//! ## The same machinery, opened to the person the data is about
//!
//! Migration `000122` adds the third reader: an account asking for **its own**
//! data, from its own settings. It is not a second feature - it is an `accounts`
//! scope of one, produced by the same job, through the same module contract,
//! under the same redaction rule - and it is governed by one setting,
//! `data_export.self_service`, resolved **per scope** so an organisational unit
//! may differ from the instance. Where it is off, the routes answer `404` and
//! the interface shows nothing: see [`crate::handlers::me_export`], which also
//! explains why the 48 h hold does not apply to one's own data.
//!
//! ## Layout
//!
//! * [`policy`]    - the settings, and the two dates they produce;
//! * [`contract`]  - **the module→core export contract**: the specification;
//! * [`core_data`] - what the core itself contributes, and what it refuses to;
//! * [`archive`]   - staging, path checks, per-file ceiling, sealing;
//! * [`runs`]      - `core.data_export_runs` / `_subjects`;
//! * [`notify`]    - the alert that tells every administrator;
//! * [`jobs`]      - `core.data_export.run` / `.prune`, types of the existing runner.

pub mod archive;
pub mod contract;
pub mod core_data;
pub mod jobs;
pub mod notify;
pub mod policy;
pub mod runs;

pub use policy::{Policy, SelfPolicy};
pub use runs::{ExportRun, ExportSubject};

/// What an archive of this instance contains, as stable identifiers the console
/// translates.
///
/// Kept here rather than in the frontend so the claim and the code that honours
/// it live in one place: whoever widens the export has to walk past this list.
pub const COVERED: &[&str] = &[
    "account_profile",
    "account_memberships",
    "account_devices",
    "account_audit",
    "module_data",
    "instance_directory",
    "instance_settings",
    "instance_audit",
];

/// What it deliberately does not contain. Same reasoning, opposite direction -
/// and this is the half that must never silently shrink.
pub const NOT_COVERED: &[&str] = &[
    "password_hashes",
    "session_tokens",
    "api_tokens",
    "two_factor_secrets",
    "provider_secrets",
    "server_config",
];

/// Privilege keys this feature checks by name.
///
/// Re-exported from [`crate::authz::keys`] rather than redeclared: two constants
/// holding the same string is one refactor away from being two constants holding
/// different strings, and the one that drifts is always the one that fails open.
pub mod keys {
    pub use crate::authz::keys::{DATA_EXPORT_EXECUTE, DATA_EXPORT_READ};
}
