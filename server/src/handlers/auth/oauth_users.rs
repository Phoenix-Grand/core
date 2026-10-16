//! User provisioning for OAuth / OIDC sign-ins: lookup, local-account linking,
//! account creation and username uniqueness.

use kubuno_db::dialect::SqlType;
use kubuno_db::{new_id, params, DbPool};

use crate::errors::AppError;

/// Find a user by (provider, sub), or link a local account sharing the verified
/// email. Returns `None` if neither matches (caller decides whether to create).
pub(super) async fn find_oauth_user(
    db:       &DbPool,
    provider: &str,
    sub:      &str,
    email:    &str,
) -> Result<Option<crate::models::user::User>, AppError> {
    // 1. By (provider, oauth_id)
    if let Some(user) = db
        .fetch_optional_as::<crate::models::user::User>(
            "SELECT * FROM core.users WHERE oauth_provider = $1 AND oauth_id = $2 AND is_active = TRUE",
            params![provider, sub],
        )
        .await?
    {
        return Ok(Some(user));
    }

    // 2. Link a pre-existing local account with the same email. MySQL has no
    // UPDATE ... RETURNING, so the link is done in a transaction - find the row,
    // stamp it, then read it back by id.
    let mut tx = db.begin().await?;
    let uid: Option<uuid::Uuid> = tx
        .fetch_optional_scalar(
            "SELECT id FROM core.users WHERE email = $1 AND is_active = TRUE",
            params![email],
        )
        .await?;
    if let Some(uid) = uid {
        tx.execute(
            "UPDATE core.users SET oauth_provider = $1, oauth_id = $2, email_verified = TRUE
             WHERE id = $3",
            params![provider, sub, uid],
        )
        .await?;
        tx.commit().await?;
        let user = db
            .fetch_one_as::<crate::models::user::User>(
                "SELECT * FROM core.users WHERE id = $1",
                params![uid],
            )
            .await?;
        tracing::info!(user_id = %user.id, provider = %provider, "Local account linked to SSO");
        return Ok(Some(user));
    }
    tx.rollback().await?;

    Ok(None)
}

pub(super) async fn create_oauth_user(
    db:                 &DbPool,
    provider:           &str,
    sub:                &str,
    email:              &str,
    preferred_username: Option<&str>,
    display_name:       Option<&str>,
) -> Result<crate::models::user::User, AppError> {
    let base_username = preferred_username
        .filter(|u| !u.is_empty())
        .unwrap_or(email.split('@').next().unwrap_or("user"));
    let username = unique_username(db, base_username).await?;

    // The identity provider does not place people in the tree, so this account
    // goes to the root - which is a place, unlike the NULL it used to get. An
    // account outside the tree is invisible to every DELEGATED administrator and
    // resolves `auth.methods` at INSTANCE level, skipping every unit-level value:
    // a policy that does not list `sso` there would lock out, the next day,
    // somebody the provider had just authenticated. Migration 000091:17-21
    // described that trap for the LDAP path; 000107 closes it for all of them.
    let root_unit = crate::database::seed::root_org_unit(db).await;

    // An account provisioned by a first SSO sign-in is an account like any other:
    // it receives the configured default rather than a constant, resolved from
    // the unit it is created in.
    let quota = crate::models::user::default_quota_for(db, root_unit).await;

    // The id is minted here instead of relying on a DEFAULT / RETURNING, so the
    // row can be read back on the three engines.
    let id = new_id();
    db.execute(
        r#"INSERT INTO core.users
               (id, email, username, display_name, oauth_provider, oauth_id, email_verified,
                quota_bytes, org_unit_id)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8)"#,
        params![id, email, &username, display_name, provider, sub, quota, root_unit],
    )
    .await?;
    let user = db
        .fetch_one_as::<crate::models::user::User>(
            "SELECT * FROM core.users WHERE id = $1",
            params![id],
        )
        .await?;

    tracing::info!(user_id = %user.id, username = %username, provider = %provider, "New account created via SSO");
    Ok(user)
}

/// Places the account in the groups the identity provider claimed, and removes
/// it from the ones this provider granted and no longer claims.
///
/// Same discipline as the LDAP synchroniser, and for the same reason: rows the
/// import created carry `source = 'directory'` and are the only ones it may
/// take back. A membership an operator granted by hand survives every sign-in,
/// and survives the provider being detached.
///
/// Best-effort: a group that cannot be created must not cost somebody their
/// session. The failure is logged and the sign-in continues.
pub(super) async fn apply_claimed_groups(
    db:       &DbPool,
    provider: &str,
    user_id:  uuid::Uuid,
    claimed:  &[String],
) {
    let backend = db.backend();
    let mut ids: Vec<uuid::Uuid> = Vec::new();

    // Existence probe rendered the portable way: `SELECT 1 ... LIMIT 1` decoded
    // as a nullable bigint, present ⇔ the row exists.
    let name_taken_sql = format!(
        "SELECT {} FROM core.user_groups WHERE name = $1 LIMIT 1",
        backend.cast("1", SqlType::BigInt)
    );

    for name in claimed {
        // A claim value can be anything the provider felt like sending -
        // `/ventes`, a URN, a UUID. Trimmed and bounded; not otherwise
        // interpreted, because guessing at somebody else's naming scheme is how
        // two different groups end up merged.
        // `core.user_groups.name` is VARCHAR(100), and a colliding claim gets a
        // « (provider) » suffix below - so the base is cut short enough for that
        // suffix to still fit.
        let budget = 100usize.saturating_sub(provider.chars().count() + 12).max(8);
        let name: String = name.trim().trim_start_matches('/').chars().take(budget).collect();
        if name.is_empty() {
            continue;
        }

        // ⚠️ Matched on (provider, name) and NEVER on the name alone. Adopting a
        // group by name would let an identity provider claim `Administrateurs`
        // and drop whoever signed in into the seeded administrators group - a
        // privilege escalation with a one-line claim. A group this provider does
        // not already own is created fresh, under a name that is free.
        let existing = db
            .fetch_optional_scalar::<uuid::Uuid>(
                "SELECT id FROM core.user_groups WHERE oauth_provider_slug = $1 AND name = $2",
                params![provider, &name],
            )
            .await;

        let existing = match existing {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(error = %e, group = %name, "SSO: lookup of claimed group");
                continue;
            }
        };
        if let Some(id) = existing {
            ids.push(id);
            continue;
        }

        // The instance-wide name is unique, so a collision with a group somebody
        // else owns is disambiguated rather than merged into.
        let mut candidate = name.clone();
        for attempt in 0..3 {
            let taken = db
                .fetch_optional_scalar::<i64>(&name_taken_sql, params![&candidate])
                .await
                .map(|row| row.is_some());
            match taken {
                Ok(false) => break,
                Ok(true) if attempt == 0 => candidate = format!("{name} ({provider})"),
                Ok(true) => {
                    candidate = format!(
                        "{name} ({provider}-{})",
                        uuid::Uuid::new_v4().simple().to_string().chars().take(6).collect::<String>()
                    )
                }
                Err(e) => {
                    tracing::error!(error = %e, group = %name, "SSO: group name uniqueness check");
                    candidate.clear();
                    break;
                }
            }
        }
        if candidate.is_empty() {
            continue;
        }

        // The id is minted in Rust: an insert that actually landed reports one
        // row affected and hands us that id; a lost race reports zero and we
        // re-select the winner's row. This replaces `ON CONFLICT ... RETURNING`,
        // which MySQL cannot express.
        let new_gid = new_id();
        let insert_sql = format!(
            "INSERT {}INTO core.user_groups (id, name, description, oauth_provider_slug) \
             VALUES ($1, $2, $3, $4){}",
            backend.insert_ignore_prefix(),
            backend.on_conflict_do_nothing(&["name"]),
        );
        let created = db
            .execute(
                &insert_sql,
                params![
                    new_gid,
                    &candidate,
                    format!("Importé du fournisseur SSO « {provider} »"),
                    provider
                ],
            )
            .await;

        match created {
            Ok(1) => ids.push(new_gid),
            // Lost a race with a concurrent sign-in: the other one created it.
            Ok(_) => {
                if let Ok(Some(id)) = db
                    .fetch_optional_scalar::<uuid::Uuid>(
                        "SELECT id FROM core.user_groups WHERE oauth_provider_slug = $1 AND name = $2",
                        params![provider, &candidate],
                    )
                    .await
                {
                    ids.push(id);
                }
            }
            Err(e) => {
                tracing::error!(error = %e, group = %candidate, "SSO: import of claimed group");
            }
        }
    }

    // Claimed memberships, inserted one by one so no PostgreSQL `UNNEST` is
    // needed. Best-effort: a failed row is logged, the rest continue.
    let member_insert_sql = format!(
        "INSERT {}INTO core.user_group_members (group_id, user_id, source) \
         VALUES ($1, $2, 'directory'){}",
        backend.insert_ignore_prefix(),
        backend.on_conflict_do_nothing(&["group_id", "user_id"]),
    );
    for gid in &ids {
        if let Err(e) = db.execute(&member_insert_sql, params![gid, user_id]).await {
            tracing::error!(error = %e, user_id = %user_id, "SSO: claimed memberships");
        }
    }

    // Only what this provider granted, and only for this person. The DELETE ...
    // USING form is PostgreSQL-only, so the join becomes a portable subquery;
    // when nothing is claimed (`ids` empty) every directory membership for this
    // provider is removed - the `NOT IN` clause is simply omitted, matching the
    // old `NOT (... = ANY('{}'))` which was true for every row.
    let mut delete_sql = String::from(
        "DELETE FROM core.user_group_members \
         WHERE user_id = $1 AND source = 'directory' \
         AND group_id IN (SELECT id FROM core.user_groups WHERE oauth_provider_slug = $2)",
    );
    let mut delete_binds = params![user_id, provider];
    if !ids.is_empty() {
        let list = backend.in_list(3, ids.len());
        delete_sql.push_str(&format!(" AND group_id NOT IN ({list})"));
        for id in &ids {
            delete_binds.push((*id).into());
        }
    }
    if let Err(e) = db.execute(&delete_sql, delete_binds).await {
        tracing::error!(error = %e, user_id = %user_id, "SSO: removal of unclaimed memberships");
    }
}

async fn unique_username(db: &DbPool, base: &str) -> Result<String, AppError> {
    // Clean up: lowercase, alphanumerics + dashes/underscores only.
    let base: String = base
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .take(40)
        .collect();
    let base = if base.is_empty() { "user".to_string() } else { base.to_lowercase() };

    // Existence probe rendered as a nullable bigint (`SELECT 1 ... LIMIT 1`).
    let probe_sql = format!(
        "SELECT {} FROM core.users WHERE username = $1 LIMIT 1",
        db.backend().cast("1", SqlType::BigInt)
    );

    let exists = db
        .fetch_optional_scalar::<i64>(&probe_sql, params![&base])
        .await?
        .is_some();

    if !exists {
        return Ok(base);
    }

    // Add a numeric suffix.
    for i in 2u32..=999 {
        let candidate = format!("{base}{i}");
        let exists = db
            .fetch_optional_scalar::<i64>(&probe_sql, params![&candidate])
            .await?
            .is_some();
        if !exists {
            return Ok(candidate);
        }
    }

    // Extremely rare case - short UUID suffix.
    Ok(format!("{base}_{}", uuid::Uuid::new_v4().simple().to_string().get(..6).unwrap_or("xxx")))
}
