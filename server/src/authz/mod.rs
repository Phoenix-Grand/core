//! Delegated administration: privileges, roles, assignments, and the guards
//! that keep delegation from becoming escalation.
//!
//! ## The model in one paragraph
//!
//! A **privilege** (`<space>.<domain>.<verb>`) is a capability. A **role** is a
//! named bag of privileges - nothing more; it knows no subject and no scope. An
//! **assignment** binds a subject (a user *or* a group, never both) to a role
//! over a scope (the whole instance, or one organisational unit and its
//! subtree), optionally until a date. Keeping the role and the assignment
//! separate is what makes delegation expressible at all: the same "user
//! administrator" role is held by one person instance-wide and by another over a
//! single branch.
//!
//! ```text
//!   core.privileges ──< core.role_privileges >── core.roles ──< core.role_assignments
//!        │                                                            │
//!        └ is_ou_scopable ────────── the rule below ───────────────────┘
//! ```
//!
//! ## The rule that makes the scope real
//!
//! An assignment scoped to an organisational unit is **refused** when its role
//! contains even one privilege that cannot be confined to a subtree
//! ([`guards::ensure_scopable`]). Instance settings, modules, roles, the audit
//! trail and groups (a group crosses units by construction) are not scopable.
//! Without this rule an operator "restricted to Marketing" holding
//! `core.settings.manage` would still reconfigure the entire instance, and the
//! person who granted the role would believe the opposite - which is worse than
//! having no scope at all.
//!
//! ## Where each piece lives
//!
//! * [`model`] - types and the key grammar;
//! * [`catalog`] - what a module may declare, and how orphans are kept;
//! * [`context`] - resolution of the caller's effective privileges, one query;
//! * [`cache`] - the short-lived memory cache and its invalidation;
//! * [`guard`] - the `/admin/*` layer and the `AdminCtx` extractor;
//! * [`guards`] - the five anti-escalation guards.

pub mod bootstrap;
pub mod cache;
pub mod catalog;
pub mod context;
pub mod guard;
pub mod guards;
pub mod model;

pub use context::{AdminContext, PrivilegeScope};
pub use guard::{admin_layer, AdminCtx};
pub use model::{AssignmentScope, Privilege, Role};

/// Privilege keys the core checks by name. Constants rather than string
/// literals scattered through the handlers: a typo in a literal fails **open**
/// on a `has()` that is never true only if the key is also never granted - and
/// silently closed otherwise. Here a typo does not compile at the call site.
pub mod keys {
    pub const USERS_READ: &str = "core.users.read";
    pub const USERS_CREATE: &str = "core.users.create";
    pub const USERS_UPDATE: &str = "core.users.update";
    pub const USERS_DELETE: &str = "core.users.delete";
    pub const USER_SUSPENSION: &str = "core.user_suspension.execute";
    pub const USER_PASSWORD: &str = "core.user_password.execute";
    pub const SESSIONS_READ: &str = "core.sessions.read";
    pub const SESSIONS_DELETE: &str = "core.sessions.delete";
    pub const ORG_UNITS_READ: &str = "core.org_units.read";
    pub const ORG_UNITS_MANAGE: &str = "core.org_units.manage";
    pub const GROUPS_READ: &str = "core.groups.read";
    pub const GROUPS_MANAGE: &str = "core.groups.manage";
    /// Reading target audiences: the curated recipient lists an instance offers
    /// at share time, their members and where they are applied.
    pub const AUDIENCES_READ: &str = "core.audiences.read";
    /// Composing an audience - creating it, renaming it, changing who is in it.
    pub const AUDIENCES_MANAGE: &str = "core.audiences.manage";
    /// Deciding where an audience is *offered*: which module, which unit, in
    /// what order.
    ///
    /// Separate from [`AUDIENCES_MANAGE`] because the two are different powers.
    /// Composing a list prepares something; applying it changes what every
    /// account in a unit sees the next time they share a file, which is the part
    /// that can widen exposure across an organisation.
    ///
    /// Named on the *domain* rather than the verb (`audience_policy.execute`,
    /// not `audiences.apply`): `core.privileges` enforces
    /// `key = namespace.domain.verb` against a closed verb vocabulary that has
    /// no `apply`. Same shape as [`USER_SUSPENSION`].
    pub const AUDIENCES_APPLY: &str = "core.audience_policy.execute";
    /// Reading the buildings, their floors, the bookable resources and the
    /// features attached to them. Also what the internal catalogue answers on.
    pub const RESOURCES_READ: &str = "core.resources.read";
    /// Writing any of them.
    ///
    /// Held apart from [`RESOURCES_READ`] because the two are different powers:
    /// knowing where a room is and how many seats it has is what a delegated
    /// operator - or a module rendering a booking list - needs, while changing it
    /// alters what the whole organisation is offered the next time they book
    /// something. Renaming a building's key or a feature rewrites the composed
    /// name of every resource that mentions it, which is a wide edit behind a
    /// small field.
    pub const RESOURCES_MANAGE: &str = "core.resources.manage";
    pub const ROLES_READ: &str = "core.roles.read";
    pub const ROLES_MANAGE: &str = "core.roles.manage";
    pub const SETTINGS_READ: &str = "core.settings.read";
    pub const SETTINGS_MANAGE: &str = "core.settings.manage";
    pub const STATS_READ: &str = "core.stats.read";
    pub const MODULES_READ: &str = "core.modules.read";
    pub const MODULES_MANAGE: &str = "core.modules.manage";
    pub const MARKETPLACE_MANAGE: &str = "core.marketplace.manage";
    pub const AUTH_PROVIDERS_READ: &str = "core.auth_providers.read";
    pub const AUTH_PROVIDERS_MANAGE: &str = "core.auth_providers.manage";
    pub const THEMES_READ: &str = "core.themes.read";
    pub const THEMES_MANAGE: &str = "core.themes.manage";
    pub const MAIL_READ: &str = "core.mail.read";
    pub const MAIL_MANAGE: &str = "core.mail.manage";
    pub const AUDIT_READ: &str = "core.audit.read";
    /// Opening the storage page: what the instance holds, how it is spread, and
    /// which accounts hold most of it.
    ///
    /// Its own key rather than a reuse of [`STATS_READ`]: the page names accounts
    /// and the volume each of them carries, which is a narrower thing to be
    /// trusted with than an instance total. There is no `storage.manage`
    /// counterpart - the page writes through [`USERS_UPDATE`] (one account's
    /// quota) and [`SETTINGS_MANAGE`] (the default policy), and a third key would
    /// name a power that is enforced elsewhere.
    pub const STORAGE_READ: &str = "core.storage.read";
    /// Reading the backup policy, the run history and the state of the last run
    /// (`crate::backup`).
    pub const BACKUP_READ: &str = "core.backup.read";
    /// Running a backup now, and declaring that a restore was tested.
    ///
    /// Its own key rather than a reuse of [`SETTINGS_MANAGE`]: a backup file
    /// holds every account, every password hash and every setting of the
    /// instance, so "may write it out on demand" is a narrower thing to be
    /// trusted with than "may edit a setting". Changing the *policy* stays
    /// governed by [`SETTINGS_MANAGE`], through the ordinary settings route.
    pub const BACKUP_MANAGE: &str = "core.backup.manage";
    /// Reading the data-export history, its progress, and downloading an archive
    /// that has been produced (`crate::data_export`).
    ///
    /// Its own key rather than a reuse of [`AUDIT_READ`]: the page names every
    /// account an archive covered and hands out the archive itself. Whoever may
    /// read the audit trail may legitimately be denied that.
    pub const DATA_EXPORT_READ: &str = "core.data_export.read";
    /// Triggering the production of an archive, cancelling one, deleting one.
    ///
    /// Held apart from every other administrative key, and granted by no seeded
    /// role - the same treatment [`RULES_MANAGE`] gets, for the same kind of
    /// reason. One archive concentrates everything the instance holds about
    /// everyone, and it is meant to leave the server. "Can administer" must not
    /// imply "can walk out with all of it", and an operator who needs this must
    /// be given it deliberately, by somebody who can see they now hold it.
    ///
    /// Three further controls ride on top and are not expressible as a
    /// privilege: every administrator is alerted the instant an export starts,
    /// the archive cannot be downloaded until the configured hold has elapsed,
    /// and the requesting account must meet the age and second-factor
    /// prerequisites of the policy.
    pub const DATA_EXPORT_EXECUTE: &str = "core.data_export.execute";
    /// Opening the alert centre (`crate::alerts`).
    pub const ALERTS_READ: &str = "core.alerts.read";
    /// Taking, assigning, closing or ignoring an alert, and running the actions
    /// the alert centre performs itself.
    pub const ALERTS_MANAGE: &str = "core.alerts.manage";
    /// Reading the administration rules, their catalogue and their run log
    /// (`crate::rules`).
    pub const RULES_READ: &str = "core.rules.read";
    /// Writing an administration rule.
    ///
    /// Held apart from every other administrative key on purpose: a rule can
    /// suspend accounts and revoke sessions, at machine speed, over a population
    /// its author describes rather than names. "Can administer" must not imply
    /// "can arm that".
    pub const RULES_MANAGE: &str = "core.rules.manage";
    /// Opening the holiday referential (`crate::holidays`) and seeing what each
    /// organisational unit observes.
    ///
    /// Gates the *console*, never the feed: `/api/v1/holidays` answers every
    /// signed-in account, because a public holiday is public information and a
    /// calendar that hid it from ordinary members would be a defect, not a
    /// policy.
    pub const HOLIDAYS_READ: &str = "core.holidays.read";
    /// Writing it: creating or correcting a day, disabling a territory, and
    /// adjusting what a unit observes.
    pub const HOLIDAYS_MANAGE: &str = "core.holidays.manage";
    /// Reading the domains this instance answers for (`crate::domains`).
    pub const DOMAINS_READ: &str = "core.domains.read";
    /// Declaring a domain, proving it, promoting the primary one, removing one.
    ///
    /// Held apart from [`SETTINGS_MANAGE`]: a domain says which addresses belong
    /// to this instance and - where the registration policy is on - who may open
    /// an account at all. That is a wider power than editing a setting.
    pub const DOMAINS_MANAGE: &str = "core.domains.manage";
    /// Opening the data-migration page: the campaigns, which source account is
    /// mapped to which local one, and how far each has got.
    pub const DATA_MIGRATION_READ: &str = "core.data_migration.read";
    /// Composing a campaign, storing the source credentials, starting it,
    /// interrupting it and retrying an account.
    ///
    /// Held apart from [`SETTINGS_MANAGE`] and from [`USERS_UPDATE`]: running a
    /// migration authenticates against a third-party server on behalf of the
    /// whole organisation and writes into other people's mailboxes. Neither of
    /// the two neighbouring keys names that power, and granting one of them to
    /// obtain it would grant a great deal else.
    pub const DATA_MIGRATION_MANAGE: &str = "core.data_migration.manage";
}
