//! Whitelist-based snapshotting of audited objects.
//!
//! The rule is deliberately inverted compared to the usual "strip these fields"
//! reflex: a deny-list is a promise you break the day someone adds a column. A
//! `password_reset_token` added to `core.users` next month would flow straight
//! into the trail - and the trail is readable by every administrator, exported
//! to CSV and kept for over a year.
//!
//! So: **nothing is recorded unless a field is explicitly named** for its target
//! type. An unknown field is dropped, not redacted, because its very name can
//! leak (`recovery_answer`). A field that is on the list but whose value must
//! not be shown (an opaque setting value, a stored secret) is replaced by
//! [`REDACTED`], which keeps the diff honest - the reader sees *that* something
//! changed without seeing *what*.

use serde_json::{json, Map, Value};

/// Marker substituted for any value that must not appear in the trail.
pub const REDACTED: &str = "«rédigé»";

/// Target type constants, shared by the writers and by the UI filters.
pub mod target {
    pub const USER: &str = "user";
    pub const SETTING: &str = "setting";
    pub const MODULE: &str = "module";
    /// A database of the platform - the core's own, or a module's - as the
    /// subject of a maintenance operation (engine switch, schema-prefix change,
    /// restore, connection change/sync).
    pub const DATABASE: &str = "database";
    pub const GROUP: &str = "group";
    pub const GROUP_MEMBER: &str = "group_member";
    /// A target audience (`core.target_audiences`).
    pub const AUDIENCE: &str = "audience";
    /// One binding of audience × module × organisational unit, i.e. the decision
    /// that made an audience visible to people rather than merely defined.
    pub const AUDIENCE_POLICY: &str = "audience_policy";
    /// A building of the directory (`core.buildings`), floors included - the
    /// ordered floor list is part of the building, not a separate object, so a
    /// reordering shows up as one entry rather than as N silent writes.
    pub const BUILDING: &str = "building";
    /// One bookable resource (`core.resources`). Labelled by its COMPOSED name,
    /// because that is the string people recognise it by everywhere else.
    pub const RESOURCE: &str = "resource";
    /// A named piece of equipment (`core.resource_features`) attachable to any
    /// number of resources.
    pub const RESOURCE_FEATURE: &str = "resource_feature";
    pub const OAUTH_PROVIDER: &str = "oauth_provider";
    pub const THEME: &str = "theme";
    pub const SESSION: &str = "session";
    pub const MARKETPLACE: &str = "marketplace_module";
    pub const ORG_UNIT: &str = "org_unit";
    pub const ROUTE: &str = "route";
    /// A printable administration report (`/admin/reports/<panel>`). Recorded
    /// when its RECORDS were consulted - the rows name people, and reading them
    /// is an act of its own, like exporting the trail.
    pub const REPORT: &str = "report";
    /// A role definition (`core.roles`) and its privilege set.
    pub const ROLE: &str = "role";
    /// One binding of subject × role × scope (`core.role_assignments`).
    pub const ROLE_ASSIGNMENT: &str = "role_assignment";
    /// A personal API token (`core.api_tokens`). Identified by row id and name
    /// only - never the token, never its hash.
    pub const API_TOKEN: &str = "api_token";
    /// One row of the alert centre (`core.alerts`). Identified by id and title;
    /// the payload never travels into the trail - it belongs to the alert.
    pub const ALERT: &str = "alert";
    /// One row of the device inventory (`core.devices`). Identified by its
    /// PUBLIC id; `correlation_hash` is not on the whitelist below and must
    /// never be added - a trail that can name a device must not be able to
    /// claim it.
    pub const DEVICE: &str = "device";
    /// One declared special day (`core.holidays`). Labelled by its name, since
    /// that is what an administrator recognises it by; the rule travels in the
    /// diff, which is what makes "who moved this date, and to what" answerable.
    pub const HOLIDAY: &str = "holiday";
    /// A territory's holiday calendar (`core.holiday_calendars`).
    pub const HOLIDAY_CALENDAR: &str = "holiday_calendar";
    /// A domain this instance answers for (`core.domains`). Labelled by the
    /// name itself - the whole point of the object.
    pub const DOMAIN: &str = "domain";
    /// One connected LDAP / Active Directory (`core.ldap_directories`).
    /// Identified by row id and display name; the encrypted service password is
    /// not on the whitelist below and must never be added - the trail records
    /// that a directory was reconfigured, never how to bind to it.
    pub const LDAP_DIRECTORY: &str = "ldap_directory";
    /// The instance's support contract (`core.support_contract`). Identified by
    /// the party it is with; the pasted key is not on the whitelist below and
    /// must never be added - it is the bearer proof of the contract, and a trail
    /// readable by every administrator and exported to CSV must not carry it.
    pub const SUPPORT_CONTRACT: &str = "support_contract";
    /// One data-migration campaign (`core.migration_campaigns`). Identified by
    /// id and name. The source credentials of its accounts are not on the
    /// whitelist below and must never be added - a campaign holds one password
    /// per migrated mailbox, and a trail readable by every administrator and
    /// exported to CSV would turn an import into a credential dump.
    pub const MIGRATION_CAMPAIGN: &str = "migration_campaign";
}

/// Fields recorded for each target type. Everything absent is dropped.
///
/// Explicitly NOT listed, and worth stating so nobody "fixes" the omission:
/// `password_hash`, `totp_secret`, `totp_pending_secret` (users); `gender` and
/// `birthday` (users, migration `000114`) - personal data, and this trail is
/// readable by every administrator and exported to CSV, so a diff must be able
/// to say *that* a profile changed without saying to what;
/// `client_secret`, `client_secret_enc` (SSO providers); `token_hash`
/// (sessions and API tokens); every `*_secret` of the server configuration.
fn allowed(target_type: &str) -> &'static [&'static str] {
    match target_type {
        target::USER => &[
            "id",
            "email",
            "username",
            "display_name",
            "role",
            "quota_bytes",
            "is_active",
            "email_verified",
            "org_unit_id",
            "must_change_password",
            "totp_enabled",
            "oauth_provider",
        ],
        // `scope_type` / `scope_id` / `locked` say *where* the value was written
        // and whether it now binds the levels below. Without them the trail
        // cannot tell "the whole instance was reconfigured" from "one unit was",
        // which is the first question asked of a per-unit change. They are
        // identifiers and a flag, never content, so nothing is disclosed by
        // listing them.
        target::SETTING => &[
            "key",
            "value",
            "category",
            "is_public",
            "scope_type",
            "scope_id",
            "locked",
        ],
        target::MODULE => &["id", "display_name", "version", "is_enabled"],
        target::GROUP => &["id", "name", "description", "permissions", "is_default", "is_system"],
        target::GROUP_MEMBER => &["group_id", "group_name", "user_id", "username"],
        target::OAUTH_PROVIDER => &[
            "id",
            "slug",
            "display_name",
            "issuer_url",
            "client_id",
            "scopes",
            "button_color",
            "enabled",
            "allow_signup",
            "position",
        ],
        target::THEME => &["id", "name", "trusted", "source"],
        target::SESSION => &[
            "id",
            "user_id",
            "device_name",
            "device_type",
            "client_type",
            "ip_address",
            "created_at",
            "last_used_at",
            "revoke_reason",
        ],
        // `correlation_hash` is deliberately absent, exactly like `token_hash`
        // on a session: the trail names the device, it does not hold the secret
        // that identifies it. `approval` and its reason are the point of the
        // entry - "who blocked this laptop, and why" is what gets asked later.
        target::DEVICE => &[
            "id",
            "user_id",
            "label",
            "device_type",
            "client_kind",
            "platform",
            "platform_version",
            "browser",
            "signal_level",
            "approval",
            "approval_reason",
            "last_ip",
            "last_country",
            "first_seen_at",
            "last_seen_at",
        ],
        target::MARKETPLACE => &["id", "name", "version", "author", "official"],
        // `token_hash` is deliberately absent, as is the token itself: the trail
        // must be able to name a credential without being able to replay it. The
        // scope list is the point of the entry - "what was this key allowed to
        // do" is the first question asked after an incident.
        target::API_TOKEN => &[
            "id",
            "user_id",
            "name",
            "scopes",
            "expires_at",
            "is_legacy",
            "created_at",
            "last_used_at",
            "revoked_at",
        ],
        // `bind_password_enc` is deliberately absent, like every other credential
        // above. `bind_dn`, the filters and the attribute mapping are the point
        // of the entry: "who repointed the directory, and at what" is the
        // question asked after everybody's account changes at once.
        // `ca_certificate` is absent too - not because it is secret (it is
        // public material by construction) but because a PEM block turns every
        // trail row into a wall of base64.
        target::LDAP_DIRECTORY => &[
            "id",
            "slug",
            "display_name",
            "enabled",
            "host",
            "port",
            "security",
            "verify_certificate",
            "bind_dn",
            "base_dn",
            "user_filter",
            "user_scope",
            "attr_username",
            "attr_email",
            "attr_display_name",
            "attr_unique_id",
            "attr_member_of",
            "sync_groups",
            "group_base_dn",
            "group_filter",
            "attr_group_name",
            "attr_group_member",
            "sync_enabled",
            "sync_interval_min",
            "on_missing",
            "allow_signup",
            "position",
        ],
        target::ORG_UNIT => &["id", "name", "parent_id", "description"],
        // The floor list is on the whitelist because it is the field a resource
        // depends on: "who removed the 3rd floor" is the question asked the day
        // a room stops being bookable. Coordinates too - they place a building
        // on a map, and a wrong pin is a room nobody finds.
        target::BUILDING => &[
            "id",
            "building_key",
            "name",
            "address",
            "description",
            "latitude",
            "longitude",
            "floors",
        ],
        // `generated_name` is recorded alongside the fields it is composed from:
        // it is what everybody else reads, so a diff that only showed the parts
        // would not show what actually changed on people's screens.
        target::RESOURCE => &[
            "id",
            "name",
            "generated_name",
            "category",
            "resource_type",
            "floor_name",
            "floor_section",
            "capacity",
            "user_description",
            "description",
            // The nested building object, as `building_of` composes it.
            "building",
            "feature_ids",
            "feature_names",
            "renamed_resources",
        ],
        target::RESOURCE_FEATURE => &["id", "name", "description", "renamed_resources"],
        // The rule is the point of the entry: "somebody moved the national day"
        // is only answerable a year later if the before/after carry the rule
        // itself, not just the fact that the row changed.
        target::HOLIDAY => &[
            "id",
            "key",
            "name",
            "calendar",
            "category",
            "kind",
            "rule",
            "observance",
            "from_year",
            "to_year",
            "enabled",
            "is_overridden",
            "calendar_id",
            "holiday_id",
        ],
        // The verification token is NOT on this list and must never be added:
        // it is the secret that proves ownership, and the trail is readable by
        // every administrator and exported to CSV.
        target::DOMAIN => &["id", "name", "kind", "parent_id", "verified", "primary"],
        target::HOLIDAY_CALENDAR => &[
            "id",
            "code",
            "name",
            "country_code",
            "subdivision",
            "enabled",
            "exclusions",
        ],
        target::ROUTE => &["method", "path"],
        // Privileges are the whole point of the entry: recording the set is what
        // makes "who widened this role, and by how much" answerable a year later.
        target::ROLE => &[
            "id",
            "slug",
            "name",
            "description",
            "is_system",
            "is_superuser",
            "privileges",
        ],
        target::ROLE_ASSIGNMENT => &[
            "id",
            "role_id",
            "role_slug",
            "subject_user_id",
            "subject_group_id",
            "subject_label",
            "scope",
            "scope_org_unit_id",
            "scope_org_unit_name",
            "expires_at",
        ],
        // Everything the console displays, and nothing else. `key_text` is
        // absent on purpose (see the target's own comment): registering a
        // contract must be traceable without the trail becoming a place to
        // recover the key from.
        target::SUPPORT_CONTRACT => &[
            "subject",
            "plan",
            "perimeter",
            "contact",
            "expires_at",
            "verified",
            "key_id",
        ],
        // The server being read, the size of the operation and the state
        // changes. No `password`, no `secret_enc`, no `source_login`: naming
        // the campaign and the host is what makes the entry useful, and listing
        // every migrated address would turn one line of the trail into the
        // organisation's address book.
        target::MIGRATION_CAMPAIGN => &[
            "id",
            "name",
            "service",
            "source_host",
            "source_port",
            "accounts",
            "status",
            "retried_account",
        ],
        _ => &[],
    }
}

/// Setting keys whose *value* is recorded verbatim.
///
/// Same inversion as above, applied one level down: setting keys are open-ended
/// (modules register their own), so an unknown key's value is redacted. A module
/// shipping `mail.smtp_password` tomorrow therefore cannot leak by default; the
/// entry still names the key and records that it changed.
const SETTING_VALUES_IN_CLEAR: &[&str] = &[
    "instance.name",
    "instance.description",
    "instance.logo_url",
    "instance.color_primary",
    "appearance.login_animation",
    "navigation.default_module",
    "auth.registration_open",
    "auth.email_verification",
    "auth.oauth_google_enabled",
    "auth.oauth_github_enabled",
    "auth.oauth_keycloak_enabled",
    "auth.keycloak_display_name",
    "auth.api_token_allowed_roles",
    "storage.default_quota_bytes",
    "storage.max_upload_bytes",
    "security.jwt_access_ttl_s",
    "security.jwt_refresh_ttl_d",
    "security.max_sessions",
    "security.session_idle_timeout_min",
    "security.rate_user_per_min",
    "security.ddos_enabled",
    "security.ddos_rate_per_min",
    "security.ddos_max_concurrent",
    "security.audit_retention_days",
    // The password policy (migration `000115`). Its values are the policy
    // itself, never a credential: "the minimum went from 12 to 8" is exactly
    // what an audit of a weakening must be able to show, and an entry that only
    // said "the minimum changed" would make the trail useless for the one
    // question anybody asks of it.
    "security.password_min_length",
    "security.password_strong",
    "security.password_reuse_allowed",
    "security.password_history_depth",
    "security.password_expiry_days",
    "security.password_enforce_at_login",
    "auth.self_service_recovery",
    // Outgoing mail relay. Everything about it is operational configuration an
    // operator must be able to read back from the trail - the host they pointed
    // at, the port, whether they turned encryption off - EXCEPT
    // `mail.smtp_password`, whose deliberate absence from this list is what
    // makes its rotation appear as «rédigé». Do not "fix" that omission.
    "mail.smtp_enabled",
    "mail.smtp_host",
    "mail.smtp_port",
    "mail.smtp_security",
    "mail.smtp_username",
    "mail.from_address",
    "mail.from_name",
    "mail.public_url",
    "agenda.default_event_duration_min",
    "agenda.default_timezone",
    "agenda.time_format",
    "agenda.week_starts_on",
    "notes.autosave_interval_s",
    "notes.default_editor",
    "notes.default_reminder_before_min",
    "notes.enable_bidirectional_links",
    "notes.enable_spell_check",
    "office.autosave_interval_s",
    "office.default_format",
    "office.default_margins",
    "office.track_changes_default",
    "photos.allow_public_sharing",
    "photos.jpeg_quality",
    "photos.share_link_max_days",
    "photos.thumbnail_size",
    "photos.trash_auto_delete_days",
];

/// True when a setting's value may appear in the trail.
pub fn setting_value_visible(key: &str) -> bool {
    SETTING_VALUES_IN_CLEAR.contains(&key)
}

/// Longest string kept for a single field. Beyond that the value is truncated:
/// the trail is a log, not a copy of the object, and an unbounded blob in a
/// JSONB column is a denial-of-service vector on the admin screen.
const MAX_STRING: usize = 512;

fn cap(value: Value) -> Value {
    match value {
        Value::String(s) if s.chars().count() > MAX_STRING => {
            let truncated: String = s.chars().take(MAX_STRING).collect();
            Value::String(format!("{truncated}…"))
        }
        other => other,
    }
}

/// Filters `value` down to the fields allowed for `target_type`.
///
/// `value` is normally the `serde_json` rendering of a model. A non-object input
/// is returned as `null`: there is no field to whitelist, so there is nothing
/// safe to keep.
pub fn snapshot(target_type: &str, value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return Value::Null;
    };
    let fields = allowed(target_type);
    let mut out = Map::new();
    for field in fields {
        if let Some(found) = object.get(*field) {
            out.insert((*field).to_string(), cap(found.clone()));
        }
    }
    // Setting values obey their own, key-scoped whitelist.
    if target_type == target::SETTING && out.contains_key("value") {
        let key = out.get("key").and_then(Value::as_str).unwrap_or("");
        if !setting_value_visible(key) {
            out.insert("value".into(), Value::String(REDACTED.into()));
        }
    }
    Value::Object(out)
}

/// Snapshot of a single setting, ready for `before`/`after`.
pub fn setting(key: &str, value: &Value) -> Value {
    snapshot(target::SETTING, &json!({ "key": key, "value": value }))
}

/// Same, for a write at a given scope.
///
/// Routed through [`snapshot`] like every other snapshot, so the value obeys
/// exactly the same key-scoped whitelist: a credential written per unit is
/// `«rédigé»` for the same reason it is at instance level. The scope only
/// changes *where* the value applies, never whether it may be read back.
pub fn setting_scoped(
    key: &str,
    value: &Value,
    scope_type: &str,
    scope_id: Option<uuid::Uuid>,
    locked: bool,
) -> Value {
    snapshot(
        target::SETTING,
        &json!({
            "key":        key,
            "value":      value,
            "scope_type": scope_type,
            "scope_id":   scope_id,
            "locked":     locked,
        }),
    )
}

/// Field-by-field difference of two snapshots, as served on the detail route.
///
/// Both sides are already whitelisted, so this only has to pair them up. Fields
/// present on one side only are reported with a `null` on the other.
pub fn diff(before: Option<&Value>, after: Option<&Value>) -> Vec<Value> {
    let empty = Map::new();
    let b = before.and_then(Value::as_object).unwrap_or(&empty);
    let a = after.and_then(Value::as_object).unwrap_or(&empty);

    let mut keys: Vec<&String> = b.keys().chain(a.keys()).collect();
    keys.sort_unstable();
    keys.dedup();

    keys.into_iter()
        .filter_map(|k| {
            let bv = b.get(k);
            let av = a.get(k);
            if bv == av {
                return None;
            }
            Some(json!({
                "field":  k,
                "before": bv.cloned().unwrap_or(Value::Null),
                "after":  av.cloned().unwrap_or(Value::Null),
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_snapshot_drops_every_secret() {
        let raw = json!({
            "id": "11111111-1111-1111-1111-111111111111",
            "email": "a@b.c",
            "username": "alice",
            "role": "admin",
            "password_hash": "$argon2id$v=19$m=19456,t=2,p=1$abc$def",
            "totp_secret": "JBSWY3DPEHPK3PXP",
            "totp_pending_secret": "JBSWY3DPEHPK3PXP",
            "preferences": { "theme": "dark" },
        });
        let out = snapshot(target::USER, &raw);
        let rendered = out.to_string();
        assert!(!rendered.contains("argon2"), "empreinte de mot de passe fuitée");
        assert!(!rendered.contains("JBSWY3DPEHPK3PXP"), "secret TOTP fuité");
        assert!(!rendered.contains("password_hash"));
        assert!(!rendered.contains("totp_secret"));
        // Whitelisted fields survive.
        assert_eq!(out["username"], json!("alice"));
        assert_eq!(out["role"], json!("admin"));
        // Non-whitelisted, non-secret field is dropped too (default deny).
        assert!(out.get("preferences").is_none());
    }

    #[test]
    fn unknown_field_added_tomorrow_is_dropped() {
        // The property a deny-list cannot offer.
        let raw = json!({ "username": "bob", "recovery_answer": "ma première voiture" });
        let out = snapshot(target::USER, &raw);
        assert_eq!(out, json!({ "username": "bob" }));
    }

    #[test]
    fn oauth_provider_secret_never_recorded() {
        let raw = json!({
            "id": "22222222-2222-2222-2222-222222222222",
            "slug": "keycloak",
            "client_id": "kubuno",
            "client_secret": "s3cr3t-plain",
            "client_secret_enc": "AAAA.BBBB.CCCC",
            "enabled": true,
        });
        let out = snapshot(target::OAUTH_PROVIDER, &raw);
        let rendered = out.to_string();
        assert!(!rendered.contains("s3cr3t-plain"));
        assert!(!rendered.contains("AAAA.BBBB.CCCC"));
        assert_eq!(out["slug"], json!("keycloak"));
    }

    #[test]
    fn session_token_hash_never_recorded() {
        let raw = json!({
            "id": "33333333-3333-3333-3333-333333333333",
            "token_hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "device_name": "Chrome",
        });
        let out = snapshot(target::SESSION, &raw);
        assert!(!out.to_string().contains("9f86d081"));
        assert_eq!(out["device_name"], json!("Chrome"));
    }

    #[test]
    fn scoped_setting_obeys_the_same_value_whitelist() {
        let unit = uuid::Uuid::from_u128(0x2a);
        // A credential written per unit is redacted exactly like at instance
        // level: the scope changes where it applies, not whether it may be read.
        let secret = setting_scoped(
            "mail.smtp_password",
            &json!("hunter2"),
            "org_unit",
            Some(unit),
            true,
        );
        assert_eq!(secret["value"], json!(REDACTED));
        assert!(!secret.to_string().contains("hunter2"));
        // …and the scope itself is recorded, so the trail can tell "one unit"
        // from "the whole instance".
        assert_eq!(secret["scope_type"], json!("org_unit"));
        assert_eq!(secret["scope_id"], json!(unit.to_string()));
        assert_eq!(secret["locked"], json!(true));

        let known = setting_scoped("security.max_sessions", &json!(3), "user", Some(unit), false);
        assert_eq!(known["value"], json!(3));
        assert_eq!(known["scope_type"], json!("user"));
    }

    #[test]
    fn known_setting_value_kept_unknown_one_redacted() {
        let known = setting("security.max_sessions", &json!(10));
        assert_eq!(known["value"], json!(10));

        // A module shipping this key tomorrow must not leak it.
        let unknown = setting("mail.smtp_password", &json!("hunter2"));
        assert_eq!(unknown["value"], json!(REDACTED));
        assert!(!unknown.to_string().contains("hunter2"));
        // The key itself is still recorded: the reader learns *that* it changed.
        assert_eq!(unknown["key"], json!("mail.smtp_password"));
    }

    #[test]
    fn the_smtp_password_is_redacted_but_the_rest_of_the_relay_is_readable() {
        // The credential: the key is recorded, the value never is - on both
        // sides of the diff, so "it rotated" is visible and "to what" is not.
        let secret = setting("mail.smtp_password", &json!("Zm9vYmFy…blob-chiffré"));
        assert_eq!(secret["value"], json!(REDACTED));
        assert!(!secret.to_string().contains("blob-chiffré"));
        assert_eq!(secret["key"], json!("mail.smtp_password"));

        // The rest is operational configuration and must stay readable: an
        // operator reading the trail has to see that someone pointed the relay
        // at another host or turned encryption off.
        assert_eq!(setting("mail.smtp_host", &json!("smtp.exemple.com"))["value"], json!("smtp.exemple.com"));
        assert_eq!(setting("mail.smtp_port", &json!(465))["value"], json!(465));
        assert_eq!(setting("mail.smtp_security", &json!("none"))["value"], json!("none"));
        assert_eq!(setting("mail.smtp_enabled", &json!(true))["value"], json!(true));
        assert_eq!(setting("mail.from_address", &json!("a@b.co"))["value"], json!("a@b.co"));
    }

    #[test]
    fn retention_setting_is_visible_so_its_change_is_readable() {
        let s = setting("security.audit_retention_days", &json!(400));
        assert_eq!(s["value"], json!(400));
    }

    #[test]
    fn unknown_target_type_records_nothing() {
        let raw = json!({ "anything": "at all", "secret": "leak" });
        assert_eq!(snapshot("not_a_target", &raw), json!({}));
    }

    #[test]
    fn non_object_snapshot_is_null() {
        assert_eq!(snapshot(target::USER, &json!("plain string")), Value::Null);
    }

    #[test]
    fn long_values_are_truncated() {
        let long = "x".repeat(MAX_STRING + 50);
        let out = snapshot(target::USER, &json!({ "display_name": long }));
        let got = out["display_name"].as_str().unwrap_or_default();
        assert_eq!(got.chars().count(), MAX_STRING + 1); // + the ellipsis
    }

    #[test]
    fn diff_reports_only_changed_fields() {
        let before = json!({ "role": "user", "quota_bytes": 10, "username": "alice" });
        let after = json!({ "role": "admin", "quota_bytes": 10, "username": "alice" });
        let d = diff(Some(&before), Some(&after));
        assert_eq!(d.len(), 1);
        assert_eq!(d[0]["field"], json!("role"));
        assert_eq!(d[0]["before"], json!("user"));
        assert_eq!(d[0]["after"], json!("admin"));
    }

    #[test]
    fn diff_handles_creation_and_deletion() {
        let after = json!({ "username": "new" });
        let created = diff(None, Some(&after));
        assert_eq!(created.len(), 1);
        assert_eq!(created[0]["before"], Value::Null);

        let deleted = diff(Some(&after), None);
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0]["after"], Value::Null);
    }
}
