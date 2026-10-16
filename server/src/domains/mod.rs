//! The domains this instance answers for - declared, and *proven*.
//!
//! ## The one idea
//!
//! Anybody can type a domain into a form. What makes this a model rather than a
//! text field is that the instance goes and reads a record only the domain's
//! controller could have published ([`dns`]). Everything the registry is allowed
//! to govern hangs off that proof, and nothing hangs off the claim.
//!
//! ## What it governs today, and what it does not
//!
//! Stated plainly, because a console page whose controls govern nothing is the
//! defect this product tries hardest to avoid:
//!
//! * **It governs** self-service registration, when
//!   `auth.registration_domains_only` is on: an address at an unverified domain
//!   is refused ([`store::is_verified`], read by `handlers::auth::register`).
//! * **It offers** the verified names wherever an administrator types an
//!   address, so the console stops being a free-text field.
//! * **It diagnoses** the mail configuration of each domain - MX, SPF, DMARC -
//!   as a reading, never a verdict: the core does not run the mail service and
//!   has no business declaring somebody's zone wrong.
//! * **It does not** route mail, create mailboxes, or rewrite anybody's address.
//!   Promoting a primary domain changes what the *instance* is called; it does
//!   not touch the accounts, and the console says so before the click.

pub mod dns;
pub mod model;
pub mod store;

pub use model::{Domain, DomainKind};
