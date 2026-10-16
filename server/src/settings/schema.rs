//! The setting *schema* - what `core.settings` still owns after `000060`.
//!
//! A row of `core.settings` no longer holds "the" value; it declares what the
//! key is: its type, its enum domain, its owning module, its factory default,
//! its label and whether it is exposed publicly. Values live in
//! `core.setting_values`, one per scope.

use kubuno_db::{params, DbPool};
use serde::Serialize;
use serde_json::Value;

use crate::errors::AppError;

/// One declared setting, without any value attached.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct SettingSchema {
    pub key: String,
    pub category: String,
    pub label: Option<String>,
    pub description: Option<String>,
    pub is_public: bool,
    /// `global` | `user` | `overridable` - the *declared* editability, kept from
    /// the module manifest. Orthogonal to the four storage scopes: it says who
    /// may edit, not where the value lives.
    pub scope: String,
    /// `bool` | `int` | `string` | `enum`, or `None` for the legacy core keys
    /// that predate the declarative schema.
    pub value_type: Option<String>,
    pub allowed_values: Option<Value>,
    pub module_id: Option<String>,
    pub default_value: Option<Value>,
}

impl SettingSchema {
    /// Refuses a value that does not match the declaration.
    ///
    /// Legacy keys carry no `value_type`; for those the shape of the factory
    /// default is the only declaration available, and changing a boolean into a
    /// string is refused on that basis alone. Numbers are the one deliberate
    /// exception: JSON has a single number type and an admin typing `10` for a
    /// float setting must not be rejected.
    pub fn validate(&self, value: &Value) -> Result<(), AppError> {
        let mismatch = |expected: &str| {
            Err(AppError::Validation(format!(
                "'{}' attend une valeur de type {expected}",
                self.key
            )))
        };

        match self.value_type.as_deref() {
            Some("bool") if !value.is_boolean() => return mismatch("booléen"),
            Some("int") if !value.is_number() => return mismatch("entier"),
            Some("string") if !value.is_string() => return mismatch("texte"),
            Some("enum") => {
                if let Some(Value::Array(domain)) = self.allowed_values.as_ref() {
                    // Two shapes are in the wild, and both are legitimate: a bare
                    // list of values (`["month","week"]`) and the labelled form a
                    // module ships to drive a picker
                    // (`[{"value":"month","label":"Mois"}, …]`). Comparing the raw
                    // array only would reject every labelled enum - silently, and
                    // only for the modules that took the trouble to translate
                    // their options.
                    let accepted = domain.iter().any(|candidate| match candidate {
                        Value::Object(o) => o.get("value") == Some(value),
                        other => other == value,
                    });
                    if !accepted {
                        return Err(AppError::Validation(format!(
                            "'{}' n'accepte pas cette valeur",
                            self.key
                        )));
                    }
                }
            }
            None => {
                if let Some(default) = self.default_value.as_ref() {
                    let comparable = |v: &Value| match v {
                        Value::Bool(_) => "bool",
                        Value::Number(_) => "number",
                        Value::String(_) => "string",
                        Value::Array(_) => "array",
                        Value::Object(_) => "object",
                        Value::Null => "null",
                    };
                    // A null default declares nothing (an optional URL, a logo):
                    // any shape is legitimate there.
                    if !default.is_null()
                        && !value.is_null()
                        && comparable(default) != comparable(value)
                    {
                        return mismatch(comparable(default));
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// Loads one declaration, or `NotFound`.
pub async fn load(db: &DbPool, key: &str) -> Result<SettingSchema, AppError> {
    db.fetch_optional_as::<SettingSchema>(
        "SELECT \"key\", category, label, description, is_public, scope, value_type, \
                allowed_values, module_id, default_value \
         FROM core.settings WHERE \"key\" = $1",
        params![key],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, key = %key, "settings: lecture du schéma impossible");
        AppError::Database(e)
    })?
    .ok_or_else(|| AppError::NotFound(format!("Réglage '{key}' inexistant")))
}

/// Loads every declaration matching an optional module filter.
///
/// `module_id = Some("")` selects the core's own settings (`module_id IS NULL`),
/// which is what the general Settings tab shows.
pub async fn load_all(
    db: &DbPool,
    module_id: Option<&str>,
) -> Result<Vec<SettingSchema>, AppError> {
    // `module_id` is bound twice (a typed NULL carries its own type across all
    // three engines, so the former `$1::text` cast is no longer needed).
    db.fetch_all_as::<SettingSchema>(
        "SELECT \"key\", category, label, description, is_public, scope, value_type, \
                allowed_values, module_id, default_value \
         FROM core.settings \
         WHERE ($1 IS NULL AND module_id IS NULL) OR module_id = $2 \
         ORDER BY category, \"key\"",
        params![module_id, module_id],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "settings: lecture des schémas impossible");
        AppError::Database(e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema(value_type: Option<&str>, default: Option<Value>) -> SettingSchema {
        SettingSchema {
            key: "test.key".into(),
            category: "general".into(),
            label: None,
            description: None,
            is_public: false,
            scope: "global".into(),
            value_type: value_type.map(Into::into),
            allowed_values: None,
            module_id: None,
            default_value: default,
        }
    }

    #[test]
    fn declared_types_are_enforced() {
        assert!(schema(Some("bool"), None).validate(&json!(true)).is_ok());
        assert!(schema(Some("bool"), None).validate(&json!("oui")).is_err());
        assert!(schema(Some("int"), None).validate(&json!(12)).is_ok());
        assert!(schema(Some("int"), None).validate(&json!("12")).is_err());
        assert!(schema(Some("string"), None).validate(&json!("a")).is_ok());
    }

    #[test]
    fn enum_domain_is_closed() {
        let mut s = schema(Some("enum"), None);
        s.allowed_values = Some(json!(["month", "week"]));
        assert!(s.validate(&json!("week")).is_ok());
        assert!(s.validate(&json!("decade")).is_err());
    }

    #[test]
    fn a_labelled_enum_domain_is_understood_too() {
        // The shape `calendar.default_view` actually ships. Reading only the raw
        // array would reject every value of every translated picker.
        let mut s = schema(Some("enum"), None);
        s.allowed_values = Some(json!([
            { "value": "day",   "label": "Jour" },
            { "value": "month", "label": "Mois" },
        ]));
        assert!(s.validate(&json!("month")).is_ok());
        assert!(s.validate(&json!("decade")).is_err());
        // The label is not a value.
        assert!(s.validate(&json!("Mois")).is_err());
    }

    #[test]
    fn legacy_keys_fall_back_to_the_shape_of_their_default() {
        let s = schema(None, Some(json!(10)));
        assert!(s.validate(&json!(42)).is_ok());
        assert!(s.validate(&json!("42")).is_err());
        // A null default declares nothing.
        assert!(schema(None, Some(json!(null))).validate(&json!("n'importe")).is_ok());
        assert!(schema(None, None).validate(&json!("n'importe")).is_ok());
    }
}
