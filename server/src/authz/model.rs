//! Value types of the delegated-administration model, and the grammar of a
//! privilege key.

use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::errors::AppError;

/// The closed set of verbs. A privilege key ends in one of these and nothing
/// else: an open verb space turns the catalogue into free text, and free text
/// cannot be reasoned about by a reviewer reading a role.
pub const VERBS: &[&str] = &["read", "create", "update", "delete", "manage", "execute"];

/// Namespace the core owns. A module may never declare under it.
pub const CORE_NAMESPACE: &str = "core";

/// The two scopes an assignment can carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentScope {
    /// The whole instance.
    Instance,
    /// One organisational unit **and its whole subtree**.
    OrgUnit,
}

impl AssignmentScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Instance => "instance",
            Self::OrgUnit => "org_unit",
        }
    }

    pub fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "instance" => Ok(Self::Instance),
            "org_unit" => Ok(Self::OrgUnit),
            other => Err(AppError::Validation(format!(
                "Unknown scope '{other}': expected 'instance' or 'org_unit'"
            ))),
        }
    }
}

/// One row of `core.privileges`.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Privilege {
    pub key: String,
    pub namespace: String,
    pub domain: String,
    pub verb: String,
    pub label: String,
    pub description: Option<String>,
    pub is_ou_scopable: bool,
    pub is_orphan: bool,
}

/// One row of `core.roles`.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Role {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub is_system: bool,
    pub is_superuser: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// One row of `core.role_assignments`, joined with the labels a reader needs.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AssignmentRow {
    pub id: Uuid,
    pub role_id: Uuid,
    pub role_slug: String,
    pub role_name: String,
    pub subject_user_id: Option<Uuid>,
    pub subject_group_id: Option<Uuid>,
    pub subject_label: Option<String>,
    pub scope: String,
    pub scope_org_unit_id: Option<Uuid>,
    pub scope_org_unit_name: Option<String>,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub created_by: Option<Uuid>,
}

/// A privilege key split into its three segments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedKey<'a> {
    pub namespace: &'a str,
    pub domain: &'a str,
    pub verb: &'a str,
}

/// Validates `<space>.<domain>.<verb>` and splits it.
///
/// Exactly three segments: a dotted key with a fourth segment would make
/// `namespace` ambiguous, and the whole enforcement of "a module writes only
/// under its own identifier" rests on the first segment being unambiguous.
pub fn parse_key(key: &str) -> Result<ParsedKey<'_>, AppError> {
    let invalid = |reason: &str| {
        AppError::Validation(format!(
            "Invalid privilege '{key}': {reason}. Expected '<namespace>.<domain>.<verb>'"
        ))
    };

    let mut segments = key.split('.');
    let (Some(namespace), Some(domain), Some(verb), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return Err(invalid("trois segments exactement sont attendus"));
    };

    if namespace.is_empty() || domain.is_empty() || verb.is_empty() {
        return Err(invalid("No segment can be empty"));
    }
    let segment_ok = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    };
    if !segment_ok(namespace) || !segment_ok(domain) {
        return Err(invalid(
            "les segments n'acceptent que minuscules, chiffres, tirets et underscores",
        ));
    }
    if !VERBS.contains(&verb) {
        return Err(invalid(&format!(
            "verbe « {verb} » inconnu (attendus : {})",
            VERBS.join(", ")
        )));
    }

    Ok(ParsedKey { namespace, domain, verb })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_well_formed_key_splits_into_three() {
        let k = parse_key("core.users.read").expect("clé valide");
        assert_eq!(k.namespace, "core");
        assert_eq!(k.domain, "users");
        assert_eq!(k.verb, "read");
    }

    #[test]
    fn the_grammar_refuses_anything_else() {
        for bad in [
            "core.users",             // two segments
            "core.users.read.extra",  // four
            "core..read",             // empty segment
            "core.users.list",        // unknown verb
            "Core.Users.read",        // uppercase namespace
            "",
            "*",
        ] {
            assert!(parse_key(bad).is_err(), "aurait dû être refusé : {bad}");
        }
    }

    #[test]
    fn the_superuser_marker_is_not_a_valid_key() {
        // `*` (the superuser sentinel used by the resolver) is not a valid
        // privilege key: a key has three segments, so the two can never collide.
        assert!(parse_key("*").is_err());
    }

    #[test]
    fn scopes_round_trip() {
        assert_eq!(AssignmentScope::parse("instance").expect("ok"), AssignmentScope::Instance);
        assert_eq!(AssignmentScope::parse("org_unit").expect("ok"), AssignmentScope::OrgUnit);
        assert!(AssignmentScope::parse("global").is_err());
        assert_eq!(AssignmentScope::Instance.as_str(), "instance");
    }
}
