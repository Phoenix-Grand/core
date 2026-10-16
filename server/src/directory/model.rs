//! Types of a connected LDAP / Active Directory, and the two presets an
//! operator picks from.
//!
//! The row type and the admin-facing view are kept apart for the same reason as
//! [`crate::models::oauth_provider`]: the row carries the encrypted service
//! password, the view carries a boolean. Nothing that can be serialised to a
//! client is ever built from the row by accident - the conversion drops it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Transport security ───────────────────────────────────────────────────────

/// How the connection to the directory is protected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// Plain LDAP on 389. Credentials cross the wire in the clear during the
    /// bind - only defensible on a loopback or an already-encrypted link.
    None,
    /// Connect in the clear, then upgrade with the StartTLS extended operation.
    Starttls,
    /// TLS from the first byte, port 636.
    Ldaps,
}

impl Security {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Starttls => "starttls",
            Self::Ldaps => "ldaps",
        }
    }

    /// Parses the stored string. Anything unknown - a typo, or a value written
    /// by a future version - resolves to StartTLS rather than to plain LDAP: an
    /// unreadable setting must never be the reason a bind password crosses the
    /// network unprotected.
    pub fn parse(value: &str) -> Self {
        match value {
            "none" => Self::None,
            "ldaps" | "ssl" | "tls" => Self::Ldaps,
            _ => Self::Starttls,
        }
    }

    /// URL scheme `ldap3` expects. StartTLS keeps the plain scheme and is
    /// negotiated afterwards, which is what the protocol says.
    pub const fn url_scheme(self) -> &'static str {
        match self {
            Self::Ldaps => "ldaps",
            _ => "ldap",
        }
    }

    /// The port an operator most likely wants when they pick this mode.
    pub const fn default_port(self) -> u16 {
        match self {
            Self::Ldaps => 636,
            _ => 389,
        }
    }
}

// ── Search scope ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Base,
    OneLevel,
    Subtree,
}

impl Scope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::OneLevel => "onelevel",
            Self::Subtree => "subtree",
        }
    }

    /// Unknown values fall back to `subtree`: the widest search finds the
    /// person, and a search that finds nobody is diagnosed as "wrong filter"
    /// for hours before anyone suspects the scope.
    pub fn parse(value: &str) -> Self {
        match value {
            "base" => Self::Base,
            "onelevel" | "one" => Self::OneLevel,
            _ => Self::Subtree,
        }
    }

    pub const fn to_ldap3(self) -> ldap3::Scope {
        match self {
            Self::Base => ldap3::Scope::Base,
            Self::OneLevel => ldap3::Scope::OneLevel,
            Self::Subtree => ldap3::Scope::Subtree,
        }
    }
}

// ── What happens to an account the directory no longer returns ───────────────

/// Deliberately not an open set, and deliberately without a `Delete`.
///
/// A deletion cascades through every module's data and cannot be undone, and
/// the input that would trigger it - "the directory did not return this person" -
/// is exactly what a network incident, an expired service password or a typo
/// in the base DN produces. Disabling is reversible by one click; deleting is
/// reversible by a restore.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnMissing {
    /// Deactivate the account (`is_active = FALSE`). Sessions stop working, the
    /// data stays, an operator can undo it.
    Disable,
    /// Leave it alone. For instances where the directory is one population
    /// among several and absence means nothing.
    Ignore,
}

impl OnMissing {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Disable => "disable",
            Self::Ignore => "ignore",
        }
    }

    /// Anything unknown means "do nothing". A policy that cannot be read must
    /// not be interpreted as permission to deactivate people.
    pub fn parse(value: &str) -> Self {
        match value {
            "disable" => Self::Disable,
            _ => Self::Ignore,
        }
    }
}

// ── Attribute mapping ────────────────────────────────────────────────────────

/// Which directory attribute feeds which of our fields.
///
/// Held apart from the row so the mapping can be exercised without a database
/// and without a directory (see [`super::mapping`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttributeMap {
    pub username:     String,
    pub email:        String,
    pub display_name: String,
    pub unique_id:    String,
    /// Empty means "do not read group membership from the person's entry".
    pub member_of:    String,
}

impl AttributeMap {
    /// A standard LDAPv3 directory: OpenLDAP, 389 Directory Server, ApacheDS -
    /// anything speaking `inetOrgPerson`.
    pub fn standard() -> Self {
        Self {
            username:     "uid".into(),
            email:        "mail".into(),
            display_name: "cn".into(),
            unique_id:    "entryUUID".into(),
            member_of:    String::new(),
        }
    }

    /// Active Directory, where every one of these names differs.
    ///
    /// `sAMAccountName` rather than `uid` (which AD does not populate),
    /// `objectGUID` rather than `entryUUID`, and `memberOf` on the person's own
    /// entry - AD maintains it, so a second search over the groups is wasted
    /// work on a forest of any size.
    pub fn active_directory() -> Self {
        Self {
            username:     "sAMAccountName".into(),
            email:        "mail".into(),
            display_name: "displayName".into(),
            unique_id:    "objectGUID".into(),
            member_of:    "memberOf".into(),
        }
    }

    /// Attributes to request from the server. Asking for exactly these rather
    /// than `*` keeps a directory with fat entries (photos, certificates) from
    /// putting megabytes on the wire per person.
    pub fn requested(&self) -> Vec<String> {
        let mut attrs = vec![
            self.username.clone(),
            self.email.clone(),
            self.display_name.clone(),
            self.unique_id.clone(),
        ];
        if !self.member_of.is_empty() {
            attrs.push(self.member_of.clone());
        }
        attrs.retain(|a| !a.is_empty());
        attrs.sort();
        attrs.dedup();
        attrs
    }
}

// ── The row ──────────────────────────────────────────────────────────────────

/// A configured directory, exactly as stored. `bind_password_enc` holds the
/// AES-256-GCM blob and must never reach a serialiser.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LdapDirectory {
    pub id:           Uuid,
    pub slug:         String,
    pub display_name: String,
    pub enabled:      bool,

    pub host:               String,
    pub port:               i32,
    pub security:           String,
    pub verify_certificate: bool,
    pub ca_certificate:     String,
    pub connect_timeout_s:  i32,

    pub bind_dn:           String,
    pub bind_password_enc: String,

    pub base_dn:     String,
    pub user_filter: String,
    pub user_scope:  String,

    pub attr_username:     String,
    pub attr_email:        String,
    pub attr_display_name: String,
    pub attr_unique_id:    String,
    pub attr_member_of:    String,

    pub sync_groups:       bool,
    pub group_base_dn:     String,
    pub group_filter:      String,
    pub attr_group_name:   String,
    pub attr_group_member: String,

    pub sync_enabled:      bool,
    pub sync_interval_min: i32,
    pub on_missing:        String,
    pub allow_signup:      bool,

    pub last_sync_at:     Option<DateTime<Utc>>,
    pub last_sync_status: Option<String>,
    pub last_sync_detail: Option<String>,

    /// Unit imported accounts are placed in. `None` leaves them unplaced, and
    /// they then follow the instance authentication policy.
    pub default_org_unit_id: Option<Uuid>,

    pub position:   i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl LdapDirectory {
    pub fn security(&self) -> Security {
        Security::parse(&self.security)
    }

    pub fn scope(&self) -> Scope {
        Scope::parse(&self.user_scope)
    }

    pub fn on_missing(&self) -> OnMissing {
        OnMissing::parse(&self.on_missing)
    }

    pub fn attributes(&self) -> AttributeMap {
        AttributeMap {
            username:     self.attr_username.clone(),
            email:        self.attr_email.clone(),
            display_name: self.attr_display_name.clone(),
            unique_id:    self.attr_unique_id.clone(),
            member_of:    self.attr_member_of.clone(),
        }
    }

    /// `ldap://host:port` - what `ldap3` connects to. StartTLS keeps the plain
    /// scheme; the upgrade is a connection setting, not a URL.
    pub fn url(&self) -> String {
        let port = self.port.clamp(1, 65_535);
        format!("{}://{}:{}", self.security().url_scheme(), self.host, port)
    }

    /// True when a sign-in attempt has any chance of reaching this directory.
    /// Checked before every attempt, so a half-filled row never costs anybody a
    /// connection timeout on the sign-in path.
    pub fn is_usable(&self) -> bool {
        self.enabled
            && !self.host.trim().is_empty()
            && !self.base_dn.trim().is_empty()
            && !self.user_filter.trim().is_empty()
    }
}

// ── Admin-facing view ────────────────────────────────────────────────────────

/// Everything an administrator may read. The service password is reported as a
/// boolean and by nothing else - not masked, not by its length, both of which
/// leak. The private certificate authority *is* returned: it is public material
/// by construction, and an operator has to be able to see what they pasted.
#[derive(Debug, Clone, Serialize)]
pub struct AdminLdapDirectory {
    pub id:           Uuid,
    pub slug:         String,
    pub display_name: String,
    pub enabled:      bool,

    pub host:               String,
    pub port:               i32,
    pub security:           String,
    pub verify_certificate: bool,
    pub ca_certificate:     String,
    pub connect_timeout_s:  i32,

    pub bind_dn:          String,
    pub has_bind_password: bool,

    pub base_dn:     String,
    pub user_filter: String,
    pub user_scope:  String,

    pub attr_username:     String,
    pub attr_email:        String,
    pub attr_display_name: String,
    pub attr_unique_id:    String,
    pub attr_member_of:    String,

    pub sync_groups:       bool,
    pub group_base_dn:     String,
    pub group_filter:      String,
    pub attr_group_name:   String,
    pub attr_group_member: String,

    pub sync_enabled:      bool,
    pub sync_interval_min: i32,
    pub on_missing:        String,
    pub allow_signup:      bool,

    pub last_sync_at:     Option<DateTime<Utc>>,
    pub last_sync_status: Option<String>,
    pub last_sync_detail: Option<String>,
    pub default_org_unit_id: Option<Uuid>,

    pub position: i32,
    pub usable:   bool,
}

impl From<LdapDirectory> for AdminLdapDirectory {
    fn from(d: LdapDirectory) -> Self {
        Self {
            usable:             d.is_usable(),
            has_bind_password:  !d.bind_password_enc.is_empty(),
            id:                 d.id,
            slug:               d.slug,
            display_name:       d.display_name,
            enabled:            d.enabled,
            host:               d.host,
            port:               d.port,
            security:           d.security,
            verify_certificate: d.verify_certificate,
            ca_certificate:     d.ca_certificate,
            connect_timeout_s:  d.connect_timeout_s,
            bind_dn:            d.bind_dn,
            base_dn:            d.base_dn,
            user_filter:        d.user_filter,
            user_scope:         d.user_scope,
            attr_username:      d.attr_username,
            attr_email:         d.attr_email,
            attr_display_name:  d.attr_display_name,
            attr_unique_id:     d.attr_unique_id,
            attr_member_of:     d.attr_member_of,
            sync_groups:        d.sync_groups,
            group_base_dn:      d.group_base_dn,
            group_filter:       d.group_filter,
            attr_group_name:    d.attr_group_name,
            attr_group_member:  d.attr_group_member,
            sync_enabled:       d.sync_enabled,
            sync_interval_min:  d.sync_interval_min,
            on_missing:         d.on_missing,
            allow_signup:       d.allow_signup,
            last_sync_at:       d.last_sync_at,
            last_sync_status:   d.last_sync_status,
            last_sync_detail:   d.last_sync_detail,
            default_org_unit_id: d.default_org_unit_id,
            position:           d.position,
        }
    }
}

// ── Write DTOs ───────────────────────────────────────────────────────────────

fn default_true() -> bool {
    true
}

/// Creation payload. `bind_password` is write-only: it goes in once and the
/// row's encrypted form is the only thing that survives the request.
#[derive(Deserialize)]
pub struct CreateDirectoryDto {
    pub slug:         String,
    pub display_name: String,
    pub host:         String,
    pub port:         Option<i32>,
    pub security:     Option<String>,
    #[serde(default = "default_true")]
    pub verify_certificate: bool,
    #[serde(default)]
    pub ca_certificate:     String,
    pub connect_timeout_s:  Option<i32>,

    #[serde(default)]
    pub bind_dn:       String,
    #[serde(default)]
    pub bind_password: String,

    pub base_dn:     String,
    pub user_filter: Option<String>,
    pub user_scope:  Option<String>,

    pub attr_username:     Option<String>,
    pub attr_email:        Option<String>,
    pub attr_display_name: Option<String>,
    pub attr_unique_id:    Option<String>,
    pub attr_member_of:    Option<String>,

    #[serde(default)]
    pub sync_groups:       bool,
    pub group_base_dn:     Option<String>,
    pub group_filter:      Option<String>,
    pub attr_group_name:   Option<String>,
    pub attr_group_member: Option<String>,

    #[serde(default)]
    pub sync_enabled:      bool,
    pub sync_interval_min: Option<i32>,
    pub on_missing:        Option<String>,
    #[serde(default = "default_true")]
    pub allow_signup:      bool,
    pub default_org_unit_id: Option<Uuid>,
    #[serde(default)]
    pub enabled:           bool,
    #[serde(default)]
    pub position:          i32,
}

/// Hand-written on purpose. `#[derive(Debug)]` on a struct holding a service
/// password is how that password reaches the first log line somebody adds while
/// debugging this handler.
impl std::fmt::Debug for CreateDirectoryDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateDirectoryDto")
            .field("slug", &self.slug)
            .field("host", &self.host)
            .field("bind_dn", &self.bind_dn)
            .field("bind_password", &crate::audit::redact::REDACTED)
            .finish_non_exhaustive()
    }
}

/// Update payload. Every field is optional and absent means "unchanged"; the
/// password additionally distinguishes absent (keep) from empty (clear).
#[derive(Default, Deserialize)]
pub struct UpdateDirectoryDto {
    pub display_name: Option<String>,
    pub host:         Option<String>,
    pub port:         Option<i32>,
    pub security:     Option<String>,
    pub verify_certificate: Option<bool>,
    pub ca_certificate:     Option<String>,
    pub connect_timeout_s:  Option<i32>,

    pub bind_dn:       Option<String>,
    /// Absent = keep the stored password. Empty string = clear it (a directory
    /// that accepts anonymous searches). Anything else replaces it.
    pub bind_password: Option<String>,

    pub base_dn:     Option<String>,
    pub user_filter: Option<String>,
    pub user_scope:  Option<String>,

    pub attr_username:     Option<String>,
    pub attr_email:        Option<String>,
    pub attr_display_name: Option<String>,
    pub attr_unique_id:    Option<String>,
    pub attr_member_of:    Option<String>,

    pub sync_groups:       Option<bool>,
    pub group_base_dn:     Option<String>,
    pub group_filter:      Option<String>,
    pub attr_group_name:   Option<String>,
    pub attr_group_member: Option<String>,

    pub sync_enabled:      Option<bool>,
    pub sync_interval_min: Option<i32>,
    pub on_missing:        Option<String>,
    pub allow_signup:      Option<bool>,
    pub default_org_unit_id: Option<Uuid>,
    /// `Option<Uuid>` cannot say "set this back to nothing" - absent and null
    /// are the same JSON. This flag is how "no unit" is expressed on an update;
    /// without it, an operator could choose a unit and never un-choose it.
    #[serde(default)]
    pub clear_default_org_unit: bool,
    pub enabled:           Option<bool>,
    pub position:          Option<i32>,
}

impl std::fmt::Debug for UpdateDirectoryDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdateDirectoryDto")
            .field("host", &self.host)
            .field("bind_dn", &self.bind_dn)
            .field(
                "bind_password",
                &self.bind_password.as_ref().map(|_| crate::audit::redact::REDACTED),
            )
            .finish_non_exhaustive()
    }
}

/// A fully-formed directory row, for the tests of every sibling module.
#[cfg(test)]
pub mod tests_support {
    use super::*;

    pub fn sample() -> LdapDirectory {
        LdapDirectory {
            id: Uuid::nil(),
            slug: "test".into(),
            display_name: "Annuaire de test".into(),
            enabled: true,
            host: "dc.exemple.test".into(),
            port: 389,
            security: "starttls".into(),
            verify_certificate: true,
            ca_certificate: String::new(),
            connect_timeout_s: 10,
            bind_dn: "cn=service,dc=exemple,dc=test".into(),
            bind_password_enc: String::new(),
            base_dn: "dc=exemple,dc=test".into(),
            user_filter: "(uid={login})".into(),
            user_scope: "subtree".into(),
            attr_username: "uid".into(),
            attr_email: "mail".into(),
            attr_display_name: "cn".into(),
            attr_unique_id: "entryUUID".into(),
            attr_member_of: String::new(),
            sync_groups: false,
            group_base_dn: String::new(),
            group_filter: "(objectClass=groupOfNames)".into(),
            attr_group_name: "cn".into(),
            attr_group_member: "member".into(),
            sync_enabled: false,
            sync_interval_min: 60,
            on_missing: "disable".into(),
            allow_signup: true,
            last_sync_at: None,
            last_sync_status: None,
            last_sync_detail: None,
            default_org_unit_id: None,
            position: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::sample;
    use super::*;

    #[test]
    fn an_unreadable_security_never_downgrades_to_plaintext() {
        assert_eq!(Security::parse("none"), Security::None);
        assert_eq!(Security::parse("ldaps"), Security::Ldaps);
        assert_eq!(Security::parse("starttls"), Security::Starttls);
        // Garbage, empty, or written by a version that does not exist yet.
        assert_eq!(Security::parse(""), Security::Starttls);
        assert_eq!(Security::parse("plaintext-please"), Security::Starttls);
    }

    #[test]
    fn an_unreadable_missing_policy_never_deactivates_anybody() {
        assert_eq!(OnMissing::parse("disable"), OnMissing::Disable);
        assert_eq!(OnMissing::parse("ignore"), OnMissing::Ignore);
        // The point of the fallback: a value nobody can interpret must not be
        // read as permission to switch accounts off.
        assert_eq!(OnMissing::parse(""), OnMissing::Ignore);
        assert_eq!(OnMissing::parse("delete"), OnMissing::Ignore);
    }

    #[test]
    fn the_two_presets_differ_on_every_line_that_matters() {
        let std = AttributeMap::standard();
        let ad = AttributeMap::active_directory();
        assert_ne!(std.username, ad.username);
        assert_ne!(std.display_name, ad.display_name);
        assert_ne!(std.unique_id, ad.unique_id);
        assert_eq!(std.email, ad.email); // `mail` is the one both agree on
        assert_eq!(ad.member_of, "memberOf");
        assert!(std.member_of.is_empty());
    }

    #[test]
    fn requested_attributes_are_deduplicated_and_skip_the_empty_ones() {
        let map = AttributeMap {
            username: "uid".into(),
            email: "mail".into(),
            display_name: "uid".into(), // an operator may well map two to one
            unique_id: "entryUUID".into(),
            member_of: String::new(),
        };
        assert_eq!(map.requested(), vec!["entryUUID", "mail", "uid"]);

        let ad = AttributeMap::active_directory();
        assert!(ad.requested().contains(&"memberOf".to_string()));
    }

    #[test]
    fn the_url_carries_the_scheme_the_mode_implies() {
        let mut d = sample();
        d.security = "starttls".into();
        assert_eq!(d.url(), "ldap://dc.exemple.test:389");
        d.security = "ldaps".into();
        d.port = 636;
        assert_eq!(d.url(), "ldaps://dc.exemple.test:636");
    }

    #[test]
    fn a_half_filled_directory_is_never_reached_for() {
        let mut d = sample();
        assert!(d.is_usable());
        d.enabled = false;
        assert!(!d.is_usable());
        d.enabled = true;
        d.base_dn = "   ".into();
        assert!(!d.is_usable());
    }

    #[test]
    fn the_admin_view_carries_no_password() {
        let mut d = sample();
        d.bind_password_enc = "un-blob-chiffré".into();
        let view = AdminLdapDirectory::from(d);
        assert!(view.has_bind_password);
        let json = serde_json::to_string(&view).expect("sérialisation");
        assert!(!json.contains("un-blob-chiffré"));
        assert!(!json.contains("bind_password_enc"));
    }
}
