//! Backup policy - the scheduler, the dump, and the proof it ran.
//!
//! ## The gap this closes
//!
//! The core shipped `kubuno db:backup` and nothing that ran it. Two earlier
//! attempts at this feature correctly refused to add the *setting* on its own:
//! a backup switch with no scheduler behind it turns the health indicator green
//! while the instance is still one disk failure from total loss, which is the
//! exact opposite of the service rendered. So the setting arrives here together
//! with the three things that make it true: something that runs it, something
//! that records what happened, and something that shouts when it did not.
//!
//! ## Why the dump is written in Rust
//!
//! `kubuno-seccomp` forbids `execve` in the server process, and that is a
//! security property of this product rather than a preference: the whole point
//! of the sandbox is that a compromised handler cannot spawn anything. So
//! `pg_dump` is not available to the scheduler, and reintroducing a spawn to get
//! it would trade the sandbox for a convenience.
//!
//! The alternative that was weighed and rejected - *schedule and supervise only,
//! leave the execution to a systemd unit* - fails on its own terms: the feature
//! would ship a scheduler that produces nothing, an operator would still have to
//! write and install the unit by hand, and the console would report on a file it
//! never made. That is a monitor for a backup that does not exist yet.
//!
//! What is left is the option that needs neither: a **logical, data-only dump of
//! every Kubuno schema, written from the connection pool** - `COPY … TO STDOUT`
//! on PostgreSQL, a portable NDJSON stream on MySQL/SQLite - **gzip-compressed**
//! on the way to disk. No external binary, no credential handed to a child
//! process, no second thing to install. The archive restores **in process**, so
//! the admin console can trigger a hot restore without `psql` - see [`dump`],
//! [`portable`] and [`restore`].
//!
//! ## What is covered, and what is not
//!
//! Covered: every row of every table of **every schema this instance owns** - the
//! core plus each installed module (drive, calendar, mail…) and their secondary
//! schemas - plus the sequence positions. On a shared server (PostgreSQL/MySQL)
//! the schemas are discovered dynamically; on SQLite the core backs up the
//! schemas attached to its connection.
//!
//! **Not covered**, and said on screen in as many words:
//!
//! * the **stored files** (`storage.local_path`, or the S3 bucket). What users
//!   uploaded is not in the database and is not copied by this;
//! * the **DDL**. The dump is data-only and restores onto an instance whose
//!   migrations have already run - which is also what keeps it small;
//! * the **configuration file**, where the JWT and internal secrets live. It is
//!   never copied into a file on disk by this feature.
//!
//! ## Layout
//!
//! * [`policy`]   - the settings, and when the next run is due;
//! * [`archive`]  - gzip streaming, schema discovery, naming, the listing;
//! * [`dump`]     - the PostgreSQL writer and in-process COPY loader;
//! * [`portable`] - the MySQL/SQLite writer and loader;
//! * [`restore`]  - the hot restore: safety backup, then load, recorded;
//! * [`runs`]     - `core.backup_runs`: open, close, list, prune;
//! * [`jobs`]     - `core.backup.run`, a type of the existing runner.
//!
//! Health and alerts are **not** duplicated here. `continuity.backup` and
//! `continuity.restore_tested` live in [`crate::health::checks`] with every
//! other check, and the failure alert lives in [`crate::alerts`] with every
//! other producer.

pub mod archive;
pub mod dump;
pub mod jobs;
pub mod policy;
pub mod portable;
pub mod restore;
pub mod runs;

pub use policy::{Frequency, Policy};
pub use runs::{BackupRun, Trigger};

/// What a backup file of this instance contains, as a list of stable identifiers
/// the console translates.
///
/// Kept here rather than in the frontend so the claim and the code that honours
/// it live in one place: whoever widens [`dump`] to cover something new has to
/// walk past this list.
pub const COVERED: &[&str] = &["all_schema_rows", "database_sequences"];

/// What it deliberately does not contain. Same reasoning, opposite direction -
/// and this is the half that must never silently shrink.
pub const NOT_COVERED: &[&str] = &["stored_files", "database_ddl", "config_file"];
