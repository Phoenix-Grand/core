//! Turning a directory entry into an account, and keeping it in step.
//!
//! ## Linking never disarms a local password
//!
//! When a directory entry matches an account that already exists locally, the
//! account is *linked* - it records which directory governs it - and its
//! `password_hash` is left exactly as it was. That single decision is what makes
//! a directory outage survivable: the account keeps signing in the way it
//! always did (see [`super::auth::authority_for`]), and no synchronisation can
//! turn the local administrator into somebody who needs a reachable directory to
//! get in.
//!
//! Handing an account over to the directory is a deliberate act with its own
//! endpoint, not a side effect of a sync.
//!
//! ## Identity survives a rename
//!
//! Re-identification goes through the immutable identifier first
//! (`entryUUID`/`objectGUID`), then the DN, then the address. Matching on the DN
//! alone loses somebody the day they move to another organisational unit, and
//! the next synchronisation creates them a second account.

use chrono::Utc;
use kubuno_db::{new_id, params, DbPool};
use uuid::Uuid;

use crate::{errors::AppError, models::user::User};

use super::mapping::MappedUser;
use super::model::LdapDirectory;

/// How an account came to be linked to this run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provisioned {
    /// The account already carried this directory's mark.
    Matched,
    /// A local account was found by address and now records the directory. Its
    /// password hash, if it had one, is untouched.
    Linked,
    /// A new account.
    Created,
}

impl Provisioned {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Matched => "matched",
            Self::Linked => "linked",
            Self::Created => "created",
        }
    }
}

pub struct Outcome {
    pub user: User,
    pub how: Provisioned,
}

/// Cleans a directory handle into something `core.users.username` accepts.
fn sanitise_username(base: &str) -> String {
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
        .take(40)
        .collect();
    let cleaned = cleaned.trim_matches(['.', '-', '_']).to_lowercase();
    if cleaned.chars().count() < 3 {
        format!("{cleaned}usr").chars().take(40).collect()
    } else {
        cleaned
    }
}

/// A username nobody else holds. Same shape as the OIDC path, deliberately: two
/// external identity sources must not disagree about what a free handle is.
async fn unique_username(db: &DbPool, base: &str) -> Result<String, AppError> {
    let base = sanitise_username(base);
    let taken = |name: String| async move {
        db.fetch_scalar::<bool>(
            "SELECT EXISTS(SELECT 1 FROM core.users WHERE username = $1)",
            params![name],
        )
        .await
    };

    if !taken(base.clone()).await.map_err(|e| {
        tracing::error!(error = %e, "annuaire : test d'unicité du nom d'utilisateur");
        AppError::Database(e)
    })? {
        return Ok(base);
    }

    for i in 2u32..=999 {
        let candidate = format!("{base}{i}");
        if !taken(candidate.clone()).await.map_err(|e| {
            tracing::error!(error = %e, "annuaire : test d'unicité du nom d'utilisateur");
            AppError::Database(e)
        })? {
            return Ok(candidate);
        }
    }

    Ok(format!(
        "{base}_{}",
        Uuid::new_v4().simple().to_string().chars().take(6).collect::<String>()
    ))
}

/// Finds the account this entry already corresponds to, without creating one.
///
/// Order matters: immutable identifier, then DN, then address. Each step is
/// narrower than the next, and the address is last because it is the only one a
/// directory administrator can reassign to somebody else.
pub async fn find_existing(
    db: &DbPool,
    dir: &LdapDirectory,
    mapped: &MappedUser,
) -> Result<Option<User>, AppError> {
    if let Some(uid) = mapped.uid.as_deref() {
        if let Some(u) = db
            .fetch_optional_as::<User>(
                "SELECT * FROM core.users WHERE ldap_directory_id = $1 AND ldap_uid = $2",
                params![dir.id, uid],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "annuaire : recherche par identifiant immuable");
                AppError::Database(e)
            })?
        {
            return Ok(Some(u));
        }
    }

    if let Some(u) = db
        .fetch_optional_as::<User>(
            "SELECT * FROM core.users WHERE ldap_directory_id = $1 AND ldap_dn = $2",
            params![dir.id, &mapped.dn],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "annuaire : recherche par DN");
            AppError::Database(e)
        })?
    {
        return Ok(Some(u));
    }

    let Some(email) = mapped.email.as_deref() else {
        return Ok(None);
    };
    db.fetch_optional_as::<User>(
        "SELECT * FROM core.users WHERE email = $1",
        params![email],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "annuaire : recherche par adresse");
        AppError::Database(e)
    })
}

/// Links (or refreshes) an existing account, or creates one.
///
/// `allow_create` is the caller's decision - the sign-in path resolves the
/// instance switch and the directory's own flag before calling, and the
/// synchroniser answers the same question from the same two places.
pub async fn upsert(
    db: &DbPool,
    dir: &LdapDirectory,
    mapped: &MappedUser,
    allow_create: bool,
) -> Result<Option<Outcome>, AppError> {
    if !mapped.is_provisionable() {
        tracing::debug!(
            directory = %dir.slug,
            dn = %mapped.dn,
            "annuaire : entrée sans adresse exploitable, ignorée"
        );
        return Ok(None);
    }
    let email = mapped.email.clone().unwrap_or_default();

    if let Some(existing) = find_existing(db, dir, mapped).await? {
        let was_linked = existing.ldap_directory_id == Some(dir.id);

        // Everything the directory owns is refreshed. `password_hash` is
        // conspicuously absent from this list, and so is `is_active`: a
        // synchronisation reactivating somebody an operator suspended locally
        // would silently undo a deliberate decision.
        //
        // The old `RETURNING *` (which MySQL lacks) becomes an update-then-reselect
        // by the known id. Placeholders are numbered ascending - SET first, the
        // WHERE key last - and `NOW()` is bound from Rust.
        db.execute(
            r#"UPDATE core.users SET
                   ldap_directory_id = $1,
                   ldap_dn           = $2,
                   ldap_uid          = COALESCE($3, ldap_uid),
                   ldap_synced_at    = $4,
                   email             = $5,
                   display_name      = COALESCE($6, display_name),
                   email_verified    = TRUE
               WHERE id = $7"#,
            params![
                dir.id,
                &mapped.dn,
                mapped.uid.as_deref(),
                Utc::now(),
                &email,
                mapped.display_name.as_deref(),
                existing.id
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, user_id = %existing.id, "annuaire : mise à jour du compte lié");
            AppError::Database(e)
        })?;

        let updated = db
            .fetch_one_as::<User>(
                "SELECT * FROM core.users WHERE id = $1",
                params![existing.id],
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, user_id = %existing.id, "annuaire : relecture du compte lié");
                AppError::Database(e)
            })?;

        let how = if was_linked { Provisioned::Matched } else { Provisioned::Linked };
        if how == Provisioned::Linked {
            tracing::info!(
                user_id = %updated.id,
                directory = %dir.slug,
                keeps_local_password = updated.password_hash.is_some(),
                "annuaire : compte existant lié"
            );
        }
        return Ok(Some(Outcome { user: updated, how }));
    }

    if !allow_create {
        return Ok(None);
    }

    let username = unique_username(db, mapped.username_seed()).await?;
    // The unit the operator named for this directory, when they named one. It
    // matters beyond tidiness now: `auth.methods` is resolved per unit, and an
    // account placed nowhere follows the INSTANCE policy - which may well not
    // include `directory`, leaving somebody the directory just authenticated
    // unable to sign in tomorrow.
    // No unit named for the directory means the root: MySQL/MariaDB and SQLite
    // have no trigger to coerce the NULL the column refuses.
    let unit = crate::database::seed::unit_for_new_account(db, dir.default_org_unit_id).await;
    // Quota resolved through the same chain every other account creation uses,
    // from that unit when there is one.
    let quota = crate::models::user::default_quota_for(db, unit).await;

    // The old `RETURNING *` becomes generate-id-in-Rust + reselect. `NOW()` is
    // bound from Rust and `email_verified` stays the literal TRUE.
    let new_user_id = new_id();
    db.execute(
        r#"INSERT INTO core.users
               (id, email, username, display_name, quota_bytes, email_verified,
                ldap_directory_id, ldap_dn, ldap_uid, ldap_synced_at, org_unit_id)
           VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9, $10)"#,
        params![
            new_user_id,
            &email,
            &username,
            mapped.display_name.as_deref(),
            quota,
            dir.id,
            &mapped.dn,
            mapped.uid.as_deref(),
            Utc::now(),
            unit
        ],
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, directory = %dir.slug, "annuaire : création du compte");
        AppError::Database(e)
    })?;

    let created = db
        .fetch_one_as::<User>(
            "SELECT * FROM core.users WHERE id = $1",
            params![new_user_id],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, directory = %dir.slug, "annuaire : relecture du compte créé");
            AppError::Database(e)
        })?;

    tracing::info!(
        user_id = %created.id,
        username = %username,
        directory = %dir.slug,
        "annuaire : compte créé"
    );

    // A new account joins the default groups like any other, so a directory
    // account is not silently less capable than one created by hand. The bare
    // `ON CONFLICT DO NOTHING` is expressed through the backend so MySQL uses
    // `INSERT IGNORE`; the conflict key is the (group_id, user_id) membership PK.
    let backend = db.backend();
    let group_sql = format!(
        "INSERT {}INTO core.user_group_members (group_id, user_id, source)
         SELECT id, $1, 'directory' FROM core.user_groups WHERE is_default = TRUE{}",
        backend.insert_ignore_prefix(),
        backend.on_conflict_do_nothing(&["group_id", "user_id"]),
    );
    if let Err(e) = db.execute(&group_sql, params![created.id]).await {
        tracing::error!(error = %e, user_id = %created.id, "annuaire : ajout aux groupes par défaut");
    }

    Ok(Some(Outcome { user: created, how: Provisioned::Created }))
}

/// Records that this account was seen in the directory during this run.
pub async fn touch_seen(db: &DbPool, user_id: Uuid) {
    if let Err(e) = db
        .execute(
            "UPDATE core.users SET ldap_synced_at = $1 WHERE id = $2",
            params![Utc::now(), user_id],
        )
        .await
    {
        tracing::error!(error = %e, user_id = %user_id, "annuaire : horodatage de synchronisation");
    }
}

/// Timestamp used as the cut-off for "not seen during this run".
pub fn run_started_at() -> chrono::DateTime<Utc> {
    Utc::now()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directory_handle_becomes_an_acceptable_username() {
        assert_eq!(sanitise_username("Alice.Martin"), "alice.martin");
        assert_eq!(sanitise_username("ALICE"), "alice");
        // Directory handles carry things a username column will not.
        assert_eq!(sanitise_username("EXEMPLE\\amartin"), "exempleamartin");
        assert_eq!(sanitise_username("a mar tin"), "amartin");
        // Too short after cleaning: padded rather than rejected, because the
        // person exists in the directory and has to end up with an account.
        assert_eq!(sanitise_username("ab"), "abusr");
        assert_eq!(sanitise_username("--"), "usr");
        // Bounded.
        assert!(sanitise_username(&"x".repeat(120)).chars().count() <= 40);
    }
}
