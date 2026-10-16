//! The four scopes a setting value can be attached to, and their ordering.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::errors::AppError;

/// Sentinel used as `scope_id` for the instance scope. A nullable component in a
/// primary key is not a key (NULL never equals NULL), so the database stores
/// this value instead - see migration `000060`.
pub const INSTANCE_SCOPE_ID: Uuid = Uuid::nil();

/// Where a value lives, from the most general to the most specific.
///
/// `Default` is not a storable scope: it is the factory value carried by
/// `core.settings.default_value` and only ever appears as the last resort of a
/// resolution chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    Default,
    Instance,
    OrgUnit,
    Group,
    User,
}

impl ScopeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScopeKind::Default => "default",
            ScopeKind::Instance => "instance",
            ScopeKind::OrgUnit => "org_unit",
            ScopeKind::Group => "group",
            ScopeKind::User => "user",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "default" => ScopeKind::Default,
            "instance" => ScopeKind::Instance,
            "org_unit" => ScopeKind::OrgUnit,
            "group" => ScopeKind::Group,
            "user" => ScopeKind::User,
            _ => return None,
        })
    }

    /// True when a value may be written at this scope.
    pub fn is_writable(self) -> bool {
        self != ScopeKind::Default
    }
}

/// A concrete target scope: a kind plus, for everything below the instance, the
/// subject it applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettingScope {
    pub kind: ScopeKind,
    /// `None` for the instance scope, `Some(subject)` otherwise.
    pub id: Option<Uuid>,
}

impl SettingScope {
    pub const INSTANCE: SettingScope = SettingScope {
        kind: ScopeKind::Instance,
        id: None,
    };

    pub fn org_unit(id: Uuid) -> Self {
        Self { kind: ScopeKind::OrgUnit, id: Some(id) }
    }

    pub fn group(id: Uuid) -> Self {
        Self { kind: ScopeKind::Group, id: Some(id) }
    }

    pub fn user(id: Uuid) -> Self {
        Self { kind: ScopeKind::User, id: Some(id) }
    }

    /// Validates the pair received from an HTTP request.
    ///
    /// The two failure modes are symmetric and both refused: a subject-less
    /// per-unit scope (it would resolve for every unit at once) and an instance
    /// scope carrying a subject (it would be silently ignored).
    pub fn from_parts(scope_type: &str, scope_id: Option<Uuid>) -> Result<Self, AppError> {
        let kind = ScopeKind::parse(scope_type).ok_or_else(|| {
            AppError::Validation(format!(
                "Portée '{scope_type}' inconnue (instance, org_unit, group, user)"
            ))
        })?;
        if !kind.is_writable() {
            return Err(AppError::Validation(
                "La valeur d'usine n'est pas une portée".into(),
            ));
        }
        match (kind, scope_id) {
            (ScopeKind::Instance, None) => Ok(SettingScope::INSTANCE),
            (ScopeKind::Instance, Some(_)) => Err(AppError::Validation(
                "La portée instance ne prend pas d'identifiant".into(),
            )),
            (_, Some(id)) if id != INSTANCE_SCOPE_ID => Ok(SettingScope { kind, id: Some(id) }),
            _ => Err(AppError::Validation(format!(
                "La portée '{scope_type}' exige un identifiant de sujet"
            ))),
        }
    }

    /// The value stored in `core.setting_values.scope_id`.
    pub fn storage_id(&self) -> Uuid {
        self.id.unwrap_or(INSTANCE_SCOPE_ID)
    }

    /// The uuid handed to `core.setting_chain`, which takes `NULL` for the
    /// instance scope because it has no subject to walk from.
    pub fn chain_id(&self) -> Option<Uuid> {
        self.id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_refuses_a_subject_and_units_demand_one() {
        assert_eq!(
            SettingScope::from_parts("instance", None).expect("instance"),
            SettingScope::INSTANCE
        );
        assert!(SettingScope::from_parts("instance", Some(Uuid::from_u128(7))).is_err());
        assert!(SettingScope::from_parts("org_unit", None).is_err());
        // The sentinel is not a legal subject either.
        assert!(SettingScope::from_parts("org_unit", Some(INSTANCE_SCOPE_ID)).is_err());
    }

    #[test]
    fn factory_default_is_not_a_writable_scope() {
        assert!(SettingScope::from_parts("default", None).is_err());
        assert!(SettingScope::from_parts("nowhere", None).is_err());
    }
}
