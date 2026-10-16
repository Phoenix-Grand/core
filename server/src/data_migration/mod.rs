//! Importing an organisation's data from a third-party provider.
//!
//! ## The core orchestrates; it never migrates
//!
//! The rule this whole feature is shaped by: the core writes the `core` schema
//! and nothing else. A mailbox lives in the `mail` schema, an address book in
//! `contacts` - so the core cannot copy a single message, and pretending
//! otherwise would mean a second writer on tables it does not own.
//!
//! What it *can* own is the plan and the ledger: which service, which source
//! server, which source login goes to which local account, how far each of them
//! has got, and what failed. That is [`store`]. The actual copying is a call to
//! the module that owns the destination ([`dispatch`]), driven by a background
//! job on `core.jobs` ([`jobs`]).
//!
//! ## The contract with the module
//!
//! Two internal routes, presented with `X-Internal-Secret`:
//!
//! * `POST /internal/migration/probe` - open a session on the source and answer
//!   with the folders it holds. Used to compose the campaign, never during it.
//! * `POST /internal/migration/run` - copy for at most `budget_secs`, then stop
//!   and hand back an **opaque cursor**. The core stores that cursor and passes
//!   it to the next chunk.
//!
//! The cursor is what makes this work without the core understanding anything
//! about the service. Folder names, IMAP UIDs, special-use flags, modified
//! UTF-7 - all of it stays inside the module that knows what they mean. The
//! core reads exactly three fields of the answer: how many items were copied,
//! how many there are in total, and whether it is finished.
//!
//! It also makes the whole thing resumable for free. A chunk is bounded work
//! with a saved position, so a restart, a paused campaign and a retry after a
//! failure are the same operation: call again with the cursor you have.
//!
//! ## What a chunk must be
//!
//! Idempotent. The core will re-send a cursor after a crash between "the module
//! copied" and "the core recorded", and a module that duplicates on replay
//! turns every restart into a corrupted mailbox. The pilot satisfies this
//! because its ingestion is keyed on `(account, folder, source uid)`.

pub mod dispatch;
pub mod jobs;
pub mod model;
pub mod store;

pub use model::{Campaign, MigrationAccount, ServiceKind, SourceSpec};
