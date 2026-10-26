//! Writing scoped values: set, revert to inherited, lock.
//!
//! Every path here goes through the same two gates before touching a row:
//! the value must match the declaration ([`super::schema::SettingSchema::validate`]),
//! and no level above the target may hold a lock. The second gate is what makes
//! locking an enforceable rule rather than a hint in the interface.

use kubuno_db::dialect::{Assign, SqlType};
use kubuno_db::{params, Backend, DbPool, DbQueryBuilder, DbTx};
use serde_json::Value;
use uuid::Uuid;

use super::chain::{self, Resolution};
use super::schema::{self, SettingSchema};
use super::scope::{ScopeKind, SettingScope};
use crate::errors::AppError;

/// What a write did, for the audit entry and the change event.
#[derive(Debug, Clone)]
pub struct WriteOutcome {
    pub schema: SettingSchema,
    /// State before the write, as the target scope saw it.
    pub before: Resolution,
    /// The value that now applies at the target scope.
    pub effective: Option<Value>,
    pub locked: bool,
}

/// Refuses the write when a strictly more general level has locked the key.
fn ensure_writable(resolution: &Resolution, key: &str, scope: &SettingScope) -> Result<(), AppError> {
    if !resolution.locked_above {
        return Ok(());
    }
    let by = resolution
        .lock_source
        .as_ref()
        .and_then(|o| o.scope_name.clone())
        .unwrap_or_else(|| "l'organisation".into());
    tracing::warn!(
        key = %key,
        scope = %scope.kind.as_str(),
        scope_id = ?scope.id,
        "settings: écriture refusée, réglage verrouillé par un niveau supérieur"
    );
    Err(AppError::SettingLocked(format!(
        "'{key}' is locked by {by}; its value cannot be overridden here"
    )))
}

// ── The scope's subject must exist ───────────────────────────────────────────

/// Where a scope's subject lives, and how it is named in a refusal.
///
/// `Instance` has no subject at all - its `scope_id` is the sentinel uuid of
/// migration `000060` - and `Default` is the factory value rather than a
/// storable scope. Neither is checkable, and that is a property of the model,
/// not a gap in this function.
///
/// The table names are literals from this match and never come from a request:
/// the query built below interpolates only what is returned here.
fn subject_relation(kind: ScopeKind) -> Option<(&'static str, &'static str)> {
    match kind {
        ScopeKind::OrgUnit => Some(("core.org_units", "Organizational unit")),
        ScopeKind::Group => Some(("core.user_groups", "Groupe")),
        ScopeKind::User => Some(("core.users", "Compte")),
        ScopeKind::Instance | ScopeKind::Default => None,
    }
}

/// Refuses a scope whose subject does not exist.
///
/// `core.setting_values.scope_id` is polymorphic and therefore carries no
/// foreign key (`000060:77`), so nothing in the schema was checking this. The
/// consequences were not merely untidy:
///
///   * `GET /admin/settings/resolved?scope_type=org_unit&scope_id=<any uuid>`
///     answered `200` with `can_override: true` on every declared key - a full
///     settings page for a unit that does not exist;
///   * the matching `PUT` stored a row keyed on that uuid. The purge trigger of
///     `000060:89` fires on the DELETE of a real subject, so it can never reach a
///     row whose subject never existed;
///   * and that row is UNREACHABLE afterwards. `core.setting_chain` walks
///     `core.org_unit_ancestors`, which returns nothing for a unit that is not
///     there, so the resolver reports "no own value at this scope" and
///     `DELETE /admin/settings/scoped/:key` refuses to remove it. It surfaces
///     only in the instance-level override warning, as a scope named « ? ».
///
/// Checked at the entry of every read and every write. Migration `000107`
/// deletes the rows created before this existed.
pub async fn ensure_subject_exists(db: &DbPool, scope: &SettingScope) -> Result<(), AppError> {
    let Some((table, label)) = subject_relation(scope.kind) else {
        return Ok(());
    };
    // `SettingScope::from_parts` already refuses a subject-less unit/group/user
    // scope, so this is unreachable through the API; treated as "nothing to
    // check" rather than as an error, because inventing a second refusal for a
    // case the constructor owns would just make the two disagree one day.
    let Some(id) = scope.id else {
        return Ok(());
    };

    // Safe: `table` is a `&'static str` returned by `subject_relation`, an
    // exhaustive `match` over the `ScopeKind` enum. The caller's scope is parsed
    // into that enum before reaching here, so no request text is spliced in; the
    // subject id travels as a bind parameter.
    let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = $1)");
    let exists: bool = db
        .fetch_scalar::<bool>(&sql, params![id])
        .await
        .map_err(|e| {
        tracing::error!(
            error = %e,
            scope = %scope.kind.as_str(),
            scope_id = %id,
            "settings: vérification de l'existence du sujet de portée impossible"
        );
        AppError::Database(e)
    })?;

    if !exists {
        tracing::warn!(
            scope = %scope.kind.as_str(),
            scope_id = %id,
            "settings: portée refusée, le sujet n'existe pas"
        );
        return Err(AppError::NotFound(format!("{label} {id}")));
    }
    Ok(())
}

/// Keeps the legacy `core.settings.value` mirror in lockstep with the instance
/// scope, the way migration `000060`'s `setting_values_mirror` trigger does on
/// PostgreSQL. About twenty call sites (mailer, health report, job runner, rate
/// limiter, auth) still read `core.settings.value` with plain SQL, so an
/// instance-level write made through this module must reach them.
///
/// `settings.value` becomes the instance override when one exists, and the
/// factory default once it is cleared. A no-op on PostgreSQL, where the trigger
/// already fired.
async fn mirror_instance_to_settings(tx: &mut DbTx, key: &str) -> Result<(), sqlx::Error> {
    if tx.backend() == Backend::Postgres {
        return Ok(());
    }
    tx.execute(
        "UPDATE core.settings s \
            SET value = COALESCE( \
                    (SELECT v.value FROM core.setting_values v \
                      WHERE v.\"key\" = $1 AND v.scope_type = 'instance'), \
                    s.default_value, s.value), \
                updated_at = COALESCE( \
                    (SELECT v.updated_at FROM core.setting_values v \
                      WHERE v.\"key\" = $2 AND v.scope_type = 'instance'), \
                    s.updated_at) \
          WHERE s.\"key\" = $3",
        params![key, key, key],
    )
    .await?;
    Ok(())
}

/// Removes the scoped setting values whose subject is being deleted, the way
/// migration `000060`'s `setting_values_purge_scope` trigger does on PostgreSQL.
/// `scope_type` is one of `'org_unit'`, `'group'`, `'user'` - a literal from the
/// caller, never request text. A no-op on PostgreSQL, where the trigger fires.
///
/// The polymorphic `scope_id` carries no foreign key, so a recycled uuid could
/// otherwise resurrect an override nobody remembers.
pub async fn purge_setting_values_for_scope(
    tx: &mut DbTx,
    scope_type: &'static str,
    subject_id: Uuid,
) -> Result<(), sqlx::Error> {
    debug_assert!(matches!(scope_type, "org_unit" | "group" | "user"));
    if tx.backend() == Backend::Postgres {
        return Ok(());
    }
    tx.execute(
        "DELETE FROM core.setting_values WHERE scope_type = $1 AND scope_id = $2",
        params![scope_type, subject_id],
    )
    .await?;
    Ok(())
}

/// Sets `key` at `scope`.
///
/// Runs on a connection rather than the pool so the caller can enclose it in the
/// audited transaction.
pub async fn set_value(
    db: &DbPool,
    tx: &mut DbTx,
    key: &str,
    scope: &SettingScope,
    value: &Value,
    actor: Option<Uuid>,
) -> Result<WriteOutcome, AppError> {
    ensure_subject_exists(db, scope).await?;
    let schema = schema::load(db, key).await?;
    schema.validate(value)?;

    let before = chain::resolve_for(db, key, scope).await?;
    ensure_writable(&before, key, scope)?;

    // The lock flag is a property of the level, not of the value: re-setting a
    // value at a level that locks must not silently unlock it.
    let now = chrono::Utc::now();
    let upsert = tx.backend().upsert(
        "core.setting_values",
        &["key", "scope_type", "scope_id"],
        &[
            Assign::Incoming("value"),
            Assign::Incoming("updated_at"),
            Assign::Incoming("updated_by"),
        ],
    );
    let sql = format!(
        "INSERT INTO core.setting_values (\"key\", scope_type, scope_id, value, updated_at, updated_by) \
         VALUES ($1, $2, $3, $4, $5, $6){upsert}"
    );
    tx.execute(
        &sql,
        params![
            key,
            scope.kind.as_str(),
            scope.storage_id(),
            value.clone(),
            now,
            actor
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, key = %key, "settings: écriture de la valeur impossible");
        AppError::Database(e)
    })?;

    if scope.kind == ScopeKind::Instance {
        mirror_instance_to_settings(tx, key).await.map_err(|e| {
            tracing::error!(error = %e, key = %key, "settings: miroir instance impossible");
            AppError::Database(e)
        })?;
    }

    Ok(WriteOutcome {
        schema,
        locked: before.locked_here,
        before,
        effective: Some(value.clone()),
    })
}

/// Removes the row held at `scope`, which is what makes the setting inherit
/// again - and keep following its parent afterwards. Deliberately **not** a
/// write of the inherited value.
pub async fn clear_value(
    db: &DbPool,
    tx: &mut DbTx,
    key: &str,
    scope: &SettingScope,
    _actor: Option<Uuid>,
) -> Result<WriteOutcome, AppError> {
    ensure_subject_exists(db, scope).await?;
    let schema = schema::load(db, key).await?;
    let before = chain::resolve_for(db, key, scope).await?;
    ensure_writable(&before, key, scope)?;

    if !before.has_own_value {
        return Err(AppError::Validation(format!(
            "'{key}' has no value at this scope; there is nothing to reset"
        )));
    }

    tx.execute(
        "DELETE FROM core.setting_values WHERE \"key\" = $1 AND scope_type = $2 AND scope_id = $3",
        params![key, scope.kind.as_str(), scope.storage_id()],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, key = %key, "settings: suppression de la valeur impossible");
        AppError::Database(e)
    })?;

    if scope.kind == ScopeKind::Instance {
        mirror_instance_to_settings(tx, key).await.map_err(|e| {
            tracing::error!(error = %e, key = %key, "settings: miroir instance impossible");
            AppError::Database(e)
        })?;
    }

    Ok(WriteOutcome {
        schema,
        effective: before.inherited_value.clone(),
        locked: false,
        before,
    })
}

/// Locks or unlocks `key` at `scope` for every level below it.
///
/// Locking requires a value at that level: a lock with nothing to enforce would
/// pin whatever the level happens to inherit today and silently change meaning
/// when the parent moves.
pub async fn set_lock(
    db: &DbPool,
    tx: &mut DbTx,
    key: &str,
    scope: &SettingScope,
    locked: bool,
    actor: Option<Uuid>,
) -> Result<WriteOutcome, AppError> {
    ensure_subject_exists(db, scope).await?;
    let schema = schema::load(db, key).await?;
    let before = chain::resolve_for(db, key, scope).await?;
    ensure_writable(&before, key, scope)?;

    if locked && !before.has_own_value {
        return Err(AppError::Validation(format!(
            "'{key}' must first have a value at this scope before it can be locked"
        )));
    }
    if !locked && !before.has_own_value {
        return Err(AppError::Validation(format!(
            "'{key}' is not locked at this scope"
        )));
    }

    // Placeholders reordered to appear strictly increasing in the text (the
    // engine-agnostic layer numbers them positionally); `NOW()` is bound from Rust.
    let now = chrono::Utc::now();
    tx.execute(
        "UPDATE core.setting_values SET locked = $1, updated_at = $2, updated_by = $3 \
         WHERE \"key\" = $4 AND scope_type = $5 AND scope_id = $6",
        params![
            locked,
            now,
            actor,
            key,
            scope.kind.as_str(),
            scope.storage_id()
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, key = %key, "settings: verrouillage impossible");
        AppError::Database(e)
    })?;

    Ok(WriteOutcome {
        schema,
        effective: before.value.clone(),
        locked,
        before,
    })
}

/// Mirrors a `PATCH /me` preferences payload into the user scope.
///
/// Personal module settings are still written by the client as
/// `preferences[<module>][<key>]`, and `core.users.preferences` remains the
/// store for everything in there that is *not* a declared setting (widget
/// layout, language, sidebar widths). This keeps the two in step for the subset
/// that is one: the resolver reads `core.setting_values`, so a personal override
/// that never made it there would simply stop applying.
///
/// Driven by the patch rather than by the whole preferences document on purpose:
/// `preferences || patch` replaces a module subtree wholesale, so the patch is
/// the complete new state of every module it names - which is what lets a key
/// dropped from the subtree be deleted here rather than lingering.
///
/// Best effort by design. A key locked by a higher scope is skipped, not
/// refused: the rest of the payload is unrelated preference data, and failing it
/// all would turn "you may not change this one setting" into "your preferences
/// cannot be saved".
pub async fn sync_user_preferences(
    db: &DbPool,
    tx: &mut DbTx,
    user_id: Uuid,
    patch: &Value,
) -> Result<(), AppError> {
    let Some(modules) = patch.as_object() else {
        return Ok(());
    };
    let scope = SettingScope::user(user_id);

    for (module_id, subtree) in modules {
        let Some(entries) = subtree.as_object() else {
            continue;
        };
        for (sub_key, value) in entries {
            let key = format!("{module_id}.{sub_key}");
            // Not a declared setting (widget layout and friends): nothing to
            // mirror, and `schema::load` is the cheapest way to find out.
            let Ok(declared) = schema::load(db, &key).await else {
                continue;
            };
            if declared.module_id.as_deref() != Some(module_id.as_str()) {
                continue;
            }

            let resolution = chain::resolve_for(db, &key, &scope).await?;
            if resolution.locked_above {
                tracing::info!(
                    %user_id, key = %key,
                    "settings: préférence ignorée, réglage verrouillé par l'organisation"
                );
                continue;
            }

            // A stored JSON null has always meant "reverted to the inherited
            // value" on this route; here that is a deletion, which is what keeps
            // the account following its unit afterwards.
            if value.is_null() {
                tx.execute(
                    "DELETE FROM core.setting_values \
                     WHERE \"key\" = $1 AND scope_type = 'user' AND scope_id = $2",
                    params![&key, user_id],
                )
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, key = %key, "settings: retrait de la préférence impossible");
                    AppError::Database(e)
                })?;
                continue;
            }

            if declared.validate(value).is_err() {
                tracing::warn!(%user_id, key = %key, "settings: préférence ignorée, valeur hors schéma");
                continue;
            }

            // `user_id` feeds both `scope_id` and `updated_by`; placeholders are
            // numbered positionally and never reused, so it is bound twice and
            // `NOW()` is bound from Rust.
            let now = chrono::Utc::now();
            let upsert = tx.backend().upsert(
                "core.setting_values",
                &["key", "scope_type", "scope_id"],
                &[Assign::Incoming("value"), Assign::Incoming("updated_at")],
            );
            let sql = format!(
                "INSERT INTO core.setting_values (\"key\", scope_type, scope_id, value, updated_at, updated_by) \
                 VALUES ($1, 'user', $2, $3, $4, $5){upsert}"
            );
            tx.execute(&sql, params![&key, user_id, value.clone(), now, user_id])
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, key = %key, "settings: écriture de la préférence impossible");
                    AppError::Database(e)
                })?;
        }
    }
    Ok(())
}

/// Scopes that override `key` below the instance - the "these will not be
/// affected" warning shown when editing at instance level.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OverrideRef {
    pub scope_type: String,
    pub scope_id: Uuid,
    pub scope_name: String,
    pub locked: bool,
}

pub async fn list_overrides(db: &DbPool, key: &str) -> Result<Vec<OverrideRef>, AppError> {
    // Inlined portable equivalent of the PostgreSQL-only `core.setting_overrides`
    // set-returning function: no recursion, only left joins to name each scope.
    // `::text` casts are dropped (the columns are already text) and `key` is
    // spelled as the quoted reserved word.
    let rows: Vec<(String, Uuid, String, bool)> = db
        .fetch_all_as::<(String, Uuid, String, bool)>(
            "SELECT v.scope_type, v.scope_id, \
                    COALESCE(o.name, g.name, u.display_name, u.username, '?') AS scope_name, \
                    v.locked \
               FROM core.setting_values v \
               LEFT JOIN core.org_units   o ON v.scope_type = 'org_unit' AND o.id = v.scope_id \
               LEFT JOIN core.user_groups g ON v.scope_type = 'group'    AND g.id = v.scope_id \
               LEFT JOIN core.users       u ON v.scope_type = 'user'     AND u.id = v.scope_id \
              WHERE v.\"key\" = $1 AND v.scope_type <> 'instance' \
              ORDER BY v.scope_type, 3",
            params![key],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, key = %key, "settings: lecture des surcharges impossible");
            AppError::Database(e)
        })?;

    Ok(rows
        .into_iter()
        .map(|(scope_type, scope_id, scope_name, locked)| OverrideRef {
            scope_type,
            scope_id,
            scope_name,
            locked,
        })
        .collect())
}

/// Every override of every key at once, keyed by setting key. One query instead
/// of one per row when the console lists a whole category.
pub async fn overrides_by_key(
    db: &DbPool,
    keys: &[String],
) -> Result<std::collections::HashMap<String, Vec<OverrideRef>>, AppError> {
    // `= ANY($1)` becomes a variadic `IN (...)` list via the query builder, and
    // the PostgreSQL `::TEXT` casts (over the `scope_type` enum and the COALESCE)
    // are spelled per engine by `Backend::cast`.
    let backend = db.backend();
    let scope_type_text = backend.cast("v.scope_type", SqlType::Text);
    let name_text = backend.cast(
        "COALESCE(o.name, g.name, u.display_name, u.username, '?')",
        SqlType::Text,
    );
    let mut qb = DbQueryBuilder::new(
        backend,
        format!(
            "SELECT v.\"key\", {scope_type_text}, v.scope_id, {name_text}, v.locked \
               FROM core.setting_values v \
               LEFT JOIN core.org_units   o ON v.scope_type = 'org_unit' AND o.id = v.scope_id \
               LEFT JOIN core.user_groups g ON v.scope_type = 'group'    AND g.id = v.scope_id \
               LEFT JOIN core.users       u ON v.scope_type = 'user'     AND u.id = v.scope_id \
              WHERE v.\"key\""
        ),
    );
    qb.push_in(keys.iter().cloned());
    qb.push(" AND v.scope_type <> 'instance'");
    qb.push_order_by("v.\"key\", v.scope_type");

    let rows: Vec<(String, String, Uuid, String, bool)> =
        qb.fetch_all_as(db).await.map_err(|e| {
            tracing::error!(error = %e, "settings: lecture groupée des surcharges impossible");
            AppError::Database(e)
        })?;

    let mut out: std::collections::HashMap<String, Vec<OverrideRef>> =
        std::collections::HashMap::new();
    for (key, scope_type, scope_id, scope_name, locked) in rows {
        out.entry(key).or_default().push(OverrideRef {
            scope_type,
            scope_id,
            scope_name,
            locked,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three scopes with a subject each name the table that holds it, and the
    /// two without one name nothing. A scope added later without a branch here
    /// would be silently unchecked, which is exactly what this asserts against.
    #[test]
    fn every_scope_with_a_subject_names_its_table() {
        assert_eq!(
            subject_relation(ScopeKind::OrgUnit).map(|(t, _)| t),
            Some("core.org_units")
        );
        assert_eq!(
            subject_relation(ScopeKind::Group).map(|(t, _)| t),
            Some("core.user_groups")
        );
        assert_eq!(
            subject_relation(ScopeKind::User).map(|(t, _)| t),
            Some("core.users")
        );
        // No subject to check: the instance scope carries the sentinel uuid, and
        // the factory default is not a storable scope at all.
        assert!(subject_relation(ScopeKind::Instance).is_none());
        assert!(subject_relation(ScopeKind::Default).is_none());
    }

    /// Every table named is in the `core` schema and is a bare identifier - the
    /// string is interpolated into the existence query, so it must never be able
    /// to carry anything else. The values are literals, so this guards the *next*
    /// branch somebody adds.
    #[test]
    fn subject_tables_are_plain_core_identifiers() {
        for kind in [ScopeKind::OrgUnit, ScopeKind::Group, ScopeKind::User] {
            let (table, label) = subject_relation(kind).expect("a subject");
            assert!(table.starts_with("core."), "{table} is outside the core schema");
            assert!(
                table
                    .strip_prefix("core.")
                    .is_some_and(|t| !t.is_empty()
                        && t.chars().all(|c| c.is_ascii_lowercase() || c == '_')),
                "{table} is not a bare identifier"
            );
            assert!(!label.is_empty(), "{table} has no name for the refusal");
        }
    }
}
