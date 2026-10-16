//! LDAP and Active Directory: connecting the instance to a corporate directory.
//!
//! ## Why there is no external tool anywhere in here
//!
//! `kubuno-seccomp` refuses `execve`, so `ldapsearch` and every other helper
//! binary are impossible by construction, not merely discouraged. This is a
//! pure-Rust LDAPv3 client (`ldap3`) talking BER over a socket the core opens
//! itself, with rustls for the transport - the same rustls 0.23 + ring provider
//! the HTTPS listener, the database driver and the mail relay already use.
//!
//! ## The map
//!
//! | module | what it owns |
//! |---|---|
//! | [`model`] | the row, the admin view, the DTOs, the two attribute presets |
//! | [`config`] | reading directories, and the encryption of the service password |
//! | [`filter`] | building a search filter without letting a login become syntax |
//! | [`mapping`] | one directory entry → the fields an account is made of |
//! | [`client`] | connect, TLS (private authority included), bind, search |
//! | [`auth`] | **which authenticator governs an account**, and search-then-bind |
//! | [`provision`] | linking and creating accounts |
//! | [`sync`] | importing people and groups, and the "no longer there" policy |
//! | [`probe`] | the two diagnostic buttons of the console |
//! | [`job`] | the periodic import, registered into `crate::jobs` |
//!
//! ## The three rules worth knowing before reading the code
//!
//! **The password typed at sign-in is never stored, not even hashed.** The
//! directory is the authority; a copy here would be a second authority to keep
//! in step and a second place to leak from.
//!
//! **An account holding a local password hash is authenticated locally, always.**
//! That is [`auth::authority_for`], and it is what makes the instance
//! impossible to lock out: the seeded administrator has a hash, so no sign-in of
//! theirs ever depends on a reachable directory.
//!
//! **Nothing is ever deleted.** An account the directory stopped returning is
//! deactivated at most ([`model::OnMissing`]), and even that is refused when the
//! run looks like an incident ([`sync::disable_guard`]).

pub mod auth;
pub mod client;
pub mod config;
pub mod filter;
pub mod job;
pub mod mapping;
pub mod model;
pub mod probe;
pub mod provision;
pub mod sync;

pub use client::DirectoryError;
pub use model::{AdminLdapDirectory, AttributeMap, LdapDirectory, OnMissing, Security};
