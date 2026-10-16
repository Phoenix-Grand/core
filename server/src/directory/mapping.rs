//! Turning a directory entry into the fields an account is made of.
//!
//! Everything here is pure: an entry in, a [`MappedUser`] out. That is what
//! makes the mapping testable without a directory, and the mapping is the part
//! operators get wrong - an Active Directory forest and an OpenLDAP tree agree
//! on almost none of the attribute names.
//!
//! ## Two things the wire format forces
//!
//! **Attribute names are case-insensitive** (RFC 4512 §2.5). A server may answer
//! `sAMAccountName`, `samaccountname` or `SAMAccountName` for the same request,
//! so every lookup here folds case. Matching exactly is a bug that only shows up
//! against one vendor.
//!
//! **Some attributes are not text.** `objectGUID` is sixteen raw bytes and
//! `ldap3` therefore files it under `bin_attrs`, not `attrs`. A mapping that
//! only reads `attrs` finds nothing, decides the person has no stable
//! identifier, and re-creates their account on every synchronisation.

use std::collections::HashMap;

use ldap3::{ResultEntry, SearchEntry};

use super::model::AttributeMap;

/// What one directory entry contributes to an account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedUser {
    /// Distinguished name - what the bind is attempted against.
    pub dn: String,
    /// Stable identifier read through `attr_unique_id`, when the entry has one.
    pub uid: Option<String>,
    /// The handle, as the directory spells it.
    pub username: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    /// Group DNs read from the person's own entry (`memberOf`). Empty when the
    /// mapping does not read membership from that side.
    pub member_of: Vec<String>,
}

impl MappedUser {
    /// Can this entry become an account?
    ///
    /// An address is required and nothing else is: `core.users.email` is
    /// `NOT NULL UNIQUE`, so an entry without one has no account to become. A
    /// missing username is recoverable (the local part of the address stands
    /// in); a missing address is not.
    pub fn is_provisionable(&self) -> bool {
        self.email.as_deref().is_some_and(|e| e.contains('@'))
    }

    /// The handle to derive a local username from, before uniqueness is applied.
    pub fn username_seed(&self) -> &str {
        self.username
            .as_deref()
            .filter(|u| !u.trim().is_empty())
            .or_else(|| self.email.as_deref().and_then(|e| e.split('@').next()))
            .unwrap_or("user")
    }
}

/// A group as the directory describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedGroup {
    pub dn: String,
    pub name: String,
    /// DNs of the members, when membership is read from the group side.
    pub members: Vec<String>,
}

// ── Case-insensitive attribute access ────────────────────────────────────────

/// First value of an attribute, matched without regard to case.
///
/// Returns `None` for an attribute that is present but empty: a directory
/// answering `mail: ` has not given us an address, and storing the empty string
/// would trip the account's own validation two layers down.
pub fn attr_first(attrs: &HashMap<String, Vec<String>>, name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    attrs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .and_then(|(_, v)| v.iter().find(|s| !s.trim().is_empty()))
        .map(|s| s.trim().to_string())
}

/// Every value of an attribute, matched without regard to case.
pub fn attr_all(attrs: &HashMap<String, Vec<String>>, name: &str) -> Vec<String> {
    if name.is_empty() {
        return Vec::new();
    }
    attrs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| {
            v.iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// First value of a **binary** attribute, rendered as lowercase hexadecimal.
///
/// Hexadecimal rather than Active Directory's braced GUID rendering: the value
/// is only ever compared to itself, and a lossless encoding of the raw bytes
/// cannot disagree with a vendor about byte order the way a formatted GUID can.
pub fn attr_first_binary(attrs: &HashMap<String, Vec<Vec<u8>>>, name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    attrs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .and_then(|(_, v)| v.iter().find(|b| !b.is_empty()))
        .map(|bytes| bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ── Mapping ──────────────────────────────────────────────────────────────────

/// Maps one entry through the configured attribute names.
pub fn map_user(entry: &SearchEntry, map: &AttributeMap) -> MappedUser {
    let uid = attr_first(&entry.attrs, &map.unique_id)
        // `objectGUID` never lands in `attrs`: it is not valid UTF-8.
        .or_else(|| attr_first_binary(&entry.bin_attrs, &map.unique_id));

    MappedUser {
        dn: entry.dn.clone(),
        uid,
        username: attr_first(&entry.attrs, &map.username),
        email: attr_first(&entry.attrs, &map.email).map(|e| e.to_lowercase()),
        display_name: attr_first(&entry.attrs, &map.display_name),
        member_of: attr_all(&entry.attrs, &map.member_of),
    }
}

/// Maps a group entry. An entry whose name attribute is missing falls back to
/// its DN's first component, so a group is never imported nameless.
pub fn map_group(entry: &SearchEntry, name_attr: &str, member_attr: &str) -> MappedGroup {
    let name = attr_first(&entry.attrs, name_attr)
        .or_else(|| rdn_value(&entry.dn))
        .unwrap_or_else(|| entry.dn.clone());
    MappedGroup {
        dn: entry.dn.clone(),
        name,
        members: attr_all(&entry.attrs, member_attr),
    }
}

/// Value of the first component of a DN: `cn=Ventes,ou=g,dc=x` → `Ventes`.
pub fn rdn_value(dn: &str) -> Option<String> {
    let first = dn.split(',').next()?;
    let (_, value) = first.split_once('=')?;
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Parses a raw result entry without letting a malformed one take the process
/// down.
///
/// `SearchEntry::construct` panics on anything it cannot parse - its own
/// documentation says so. On the sign-in path the peer is a directory an
/// operator configured, but "configured by an operator" is not "trusted to be
/// well-formed", and a panic in a request task is a 500 with no explanation at
/// best. The entry is skipped and named in the log instead.
pub fn safe_entry(raw: ResultEntry) -> Option<SearchEntry> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| SearchEntry::construct(raw)))
        .map_err(|_| {
            tracing::warn!("Entrée LDAP illisible ignorée (BER malformé)");
        })
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(dn: &str, pairs: &[(&str, &[&str])]) -> SearchEntry {
        SearchEntry {
            dn: dn.to_string(),
            attrs: pairs
                .iter()
                .map(|(k, v)| {
                    (
                        (*k).to_string(),
                        v.iter().map(|s| (*s).to_string()).collect(),
                    )
                })
                .collect(),
            bin_attrs: HashMap::new(),
        }
    }

    #[test]
    fn a_standard_directory_entry_maps_to_an_account() {
        let e = entry(
            "uid=alice,ou=gens,dc=exemple,dc=test",
            &[
                ("uid", &["alice"]),
                ("mail", &["Alice@Exemple.Test"]),
                ("cn", &["Alice Martin"]),
                ("entryUUID", &["8f0c1b52-1f2e-103a-9c1a-cf3a1b2c3d4e"]),
            ],
        );
        let m = map_user(&e, &AttributeMap::standard());
        assert_eq!(m.username.as_deref(), Some("alice"));
        // Addresses are folded: the column is CITEXT and the directory's own
        // casing must not decide whether a link matches.
        assert_eq!(m.email.as_deref(), Some("alice@exemple.test"));
        assert_eq!(m.display_name.as_deref(), Some("Alice Martin"));
        assert_eq!(m.uid.as_deref(), Some("8f0c1b52-1f2e-103a-9c1a-cf3a1b2c3d4e"));
        assert!(m.member_of.is_empty());
        assert!(m.is_provisionable());
    }

    #[test]
    fn the_same_entry_under_the_active_directory_map_yields_nothing() {
        // The failure operators actually hit: the right directory, the wrong
        // preset. Nothing maps, and the mapping says so rather than inventing.
        let e = entry(
            "uid=alice,ou=gens,dc=exemple,dc=test",
            &[("uid", &["alice"]), ("cn", &["Alice Martin"])],
        );
        let m = map_user(&e, &AttributeMap::active_directory());
        assert_eq!(m.username, None);
        assert_eq!(m.email, None);
        assert!(!m.is_provisionable());
    }

    #[test]
    fn an_active_directory_entry_maps_through_its_own_names() {
        let mut e = entry(
            "CN=Alice Martin,OU=Gens,DC=exemple,DC=test",
            &[
                ("sAMAccountName", &["amartin"]),
                ("mail", &["amartin@exemple.test"]),
                ("displayName", &["Alice Martin"]),
                ("memberOf", &["CN=Ventes,OU=Groupes,DC=exemple,DC=test",
                               "CN=Tous,OU=Groupes,DC=exemple,DC=test"]),
            ],
        );
        // objectGUID is binary and never appears in `attrs`.
        e.bin_attrs.insert(
            "objectGUID".into(),
            vec![vec![0x01, 0x23, 0xab, 0xff]],
        );
        let m = map_user(&e, &AttributeMap::active_directory());
        assert_eq!(m.username.as_deref(), Some("amartin"));
        assert_eq!(m.uid.as_deref(), Some("0123abff"));
        assert_eq!(m.member_of.len(), 2);
    }

    #[test]
    fn attribute_names_are_matched_without_regard_to_case() {
        // Same request, three vendors, three spellings.
        let e = entry("cn=x", &[("SAMACCOUNTNAME", &["amartin"])]);
        assert_eq!(attr_first(&e.attrs, "sAMAccountName").as_deref(), Some("amartin"));
        assert_eq!(attr_first(&e.attrs, "samaccountname").as_deref(), Some("amartin"));
    }

    #[test]
    fn an_attribute_present_but_empty_counts_as_absent() {
        let e = entry("cn=x", &[("mail", &["   "]), ("uid", &[])]);
        assert_eq!(attr_first(&e.attrs, "mail"), None);
        assert_eq!(attr_first(&e.attrs, "uid"), None);
        assert!(attr_all(&e.attrs, "mail").is_empty());
    }

    #[test]
    fn an_empty_mapping_never_matches_an_attribute_by_accident() {
        // `attr_member_of` is empty by default. Looking up "" must not match the
        // first attribute whose name happens to be empty on some server.
        let mut e = entry("cn=x", &[("uid", &["a"])]);
        e.attrs.insert(String::new(), vec!["surprise".into()]);
        assert_eq!(attr_first(&e.attrs, ""), None);
        assert!(attr_all(&e.attrs, "").is_empty());
    }

    #[test]
    fn an_entry_without_an_address_cannot_become_an_account() {
        let e = entry("uid=svc,ou=comptes,dc=x", &[("uid", &["svc"])]);
        let m = map_user(&e, &AttributeMap::standard());
        assert!(!m.is_provisionable());
        // …and one whose address is not one either.
        let e = entry("uid=svc,dc=x", &[("uid", &["svc"]), ("mail", &["pas-une-adresse"])]);
        assert!(!map_user(&e, &AttributeMap::standard()).is_provisionable());
    }

    #[test]
    fn the_username_seed_falls_back_to_the_local_part() {
        let e = entry("uid=x,dc=x", &[("mail", &["alice.martin@exemple.test"])]);
        let m = map_user(&e, &AttributeMap::standard());
        assert_eq!(m.username_seed(), "alice.martin");
    }

    #[test]
    fn a_group_without_its_name_attribute_still_gets_a_name() {
        let e = entry("cn=Ventes,ou=Groupes,dc=exemple,dc=test", &[("member", &["uid=a,dc=x"])]);
        let g = map_group(&e, "cn", "member");
        assert_eq!(g.name, "Ventes");
        assert_eq!(g.members, vec!["uid=a,dc=x".to_string()]);
    }

    #[test]
    fn a_named_group_uses_its_attribute_rather_than_its_dn() {
        let e = entry(
            "cn=ventes-2024,ou=Groupes,dc=x",
            &[("cn", &["Ventes"]), ("member", &[])],
        );
        assert_eq!(map_group(&e, "cn", "member").name, "Ventes");
    }
}
