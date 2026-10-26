//! The privilege catalogue: what a module may declare, and what happens to a
//! privilege whose module is gone.
//!
//! ## A module can only write under its own name
//!
//! A module declares a privilege by its **domain and verb** - `documents.read`,
//! not `office.documents.read` - and the core prefixes it with the module
//! identifier at registration. This is the same shape as `settings_schema` in
//! `handlers/modules.rs`, and for the same reason: a namespace a module can
//! choose is a namespace a module can *claim*, and the first thing a hostile (or
//! merely careless) module would claim is `core`.
//!
//! ## Orphans are kept
//!
//! Uninstalling a module does not delete its privileges. A deleted privilege
//! would either cascade through `core.role_privileges` - silently changing what
//! a role means, which is worse than leaving a dangling row - or break the audit
//! trail, which references keys by name for a year. Instead the row survives,
//! flagged `is_orphan`, and the console can show it greyed out with its history
//! intact. Reinstalling the module clears the flag.

use kubuno_db::dialect::Assign;
use kubuno_db::{params, DbPool, DbTx};
use serde::{Deserialize, Serialize};

use super::model::{parse_key, CORE_NAMESPACE};
use crate::errors::AppError;

/// A privilege as declared by a module in its registration payload.
///
/// `key` is **relative to the module**: `<domain>.<verb>`. The full key is
/// `<module_id>.<domain>.<verb>`, built here and nowhere else.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PrivilegeDef {
    /// `<domain>.<verb>`, without the module prefix.
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    /// May an assignment carrying this privilege be confined to an
    /// organisational subtree? Defaults to `false`: a module that has not
    /// thought about it gets the safe answer, since a wrongly-scopable privilege
    /// is what turns a delegation into an escalation.
    #[serde(default)]
    pub ou_scopable: bool,
}

/// Builds the full key for a module-declared privilege, refusing anything that
/// tries to escape the module's namespace.
pub fn qualify(module_id: &str, relative_key: &str) -> Result<String, AppError> {
    if module_id == CORE_NAMESPACE {
        return Err(AppError::Validation(
            "The 'core' namespace is reserved for the core".into(),
        ));
    }
    let relative = relative_key.trim();
    // A relative key carrying its own prefix is a module trying to choose its
    // namespace. Refuse instead of silently double-prefixing.
    if relative.split('.').count() != 2 {
        return Err(AppError::Validation(format!(
            "Invalid privilege '{relative}': a module declares '<domain>.<verb>'; the core adds the prefix"
        )));
    }
    let full = format!("{module_id}.{relative}");
    let parsed = parse_key(&full)?;
    if parsed.namespace != module_id {
        // Unreachable given the check above; kept as the assertion that the
        // invariant is enforced rather than assumed.
        return Err(AppError::Validation(format!(
            "Privilege '{full}' is outside module '{module_id}'s namespace"
        )));
    }
    Ok(full)
}

/// Upserts a module's declared privileges and clears their orphan flag.
///
/// Runs inside the registration transaction. Ignoring a malformed declaration
/// (with a loud log) rather than failing the whole registration is deliberate:
/// a typo in one privilege must not keep a module offline.
pub async fn register_module_privileges(
    tx: &mut DbTx,
    module_id: &str,
    defs: &[PrivilegeDef],
) -> Result<(), AppError> {
    let backend = tx.backend();
    for def in defs {
        let full = match qualify(module_id, &def.key) {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(
                    module_id = %module_id,
                    key = %def.key,
                    error = %e,
                    "Privilège ignoré : déclaration invalide"
                );
                continue;
            }
        };
        let parsed = match parse_key(&full) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(module_id = %module_id, key = %full, error = %e, "Privilège ignoré");
                continue;
            }
        };

        let sql = format!(
            r#"INSERT INTO core.privileges
                   ("key", namespace, domain, verb, label, description, is_ou_scopable, is_orphan)
               VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE){}"#,
            backend.upsert(
                "core.privileges",
                &["key"],
                &[
                    Assign::Incoming("label"),
                    Assign::Incoming("description"),
                    Assign::Incoming("is_ou_scopable"),
                    Assign::Expr {
                        col: "is_orphan",
                        expr: "FALSE",
                    },
                ],
            )
        );
        tx.execute(
            &sql,
            params![
                &full,
                parsed.namespace,
                parsed.domain,
                parsed.verb,
                &def.label,
                def.description.as_deref(),
                def.ou_scopable,
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, key = %full, "authz: registering a module privilege");
            AppError::Database(e)
        })?;
    }
    Ok(())
}

/// Flags as orphan every non-core privilege whose module is no longer installed,
/// and clears the flag on those whose module came back.
///
/// Cheap enough to run at startup and after an uninstall; never deletes a row.
pub async fn refresh_orphans(db: &DbPool) -> Result<u64, AppError> {
    let affected = db
        .execute(
            // Portable: no alias on the UPDATE target (SQLite refuses one) and each
            // `NOT EXISTS` parenthesised (MySQL does not parse `x <> NOT EXISTS`).
            r#"UPDATE core.privileges
              SET is_orphan = (NOT EXISTS (SELECT 1 FROM core.modules m WHERE m.id = privileges.namespace))
            WHERE namespace <> 'core'
              AND is_orphan <> (NOT EXISTS (SELECT 1 FROM core.modules m WHERE m.id = privileges.namespace))"#,
            params![],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "authz: updating orphan privileges");
            AppError::Database(e)
        })?;

    if affected > 0 {
        tracing::info!(count = affected, "Privilèges orphelins réévalués");
    }
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_module_prefix_is_added_by_the_core() {
        assert_eq!(
            qualify("office", "documents.read").expect("valide"),
            "office.documents.read"
        );
    }

    #[test]
    fn a_module_cannot_claim_the_core_namespace() {
        // Neither by being called "core"…
        assert!(qualify("core", "users.delete").is_err());
        // …nor by smuggling a prefix into its relative key.
        assert!(qualify("office", "core.users.delete").is_err());
        // …nor by declaring a bare verb and hoping for the best.
        assert!(qualify("office", "read").is_err());
    }

    #[test]
    fn the_verb_grammar_still_applies_after_prefixing() {
        assert!(qualify("office", "documents.list").is_err());
        assert!(qualify("office", "documents.execute").is_ok());
    }
}
