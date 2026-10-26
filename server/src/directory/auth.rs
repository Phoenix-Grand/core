//! Which authenticator governs an account, and how a directory authenticates.
//!
//! ## The order of authentication methods
//!
//! An account can exist locally *and* in the directory, so something has to say
//! which credential decides. **An administrator decides**, per organisational
//! unit - see [`crate::auth::methods`], which owns the policy, its inheritance
//! and its anti-lockout guard. This module only *applies* it:
//!
//! > For the account in front of us, resolve the accepted methods. If `local` is
//! > accepted (or the administrative fallback applies) and the account holds a
//! > hash, the local password decides and nothing else is consulted. Otherwise,
//! > if `directory` is accepted, the directory that governs the account decides -
//! > or, when none does yet, each enabled directory gets a turn. If neither
//! > applies, the password route admits nobody.
//!
//! Three consequences, all of them intentional:
//!
//! 1. **The instance cannot lock itself out.** `auth.local_admin_fallback` is on
//!    by default, so an administrator holding a hash is routed to `Local`
//!    whatever the unit's policy says - see
//!    [`a_local_administrator_is_never_routed_to_a_directory`] below. Turning
//!    that fallback off, or narrowing a unit's methods, is refused outright when
//!    it would strand an administrator
//!    ([`crate::auth::methods::ensure_no_administrator_is_stranded`]), and the
//!    console recovery path (`kubuno auth:recover --local-access`) remains open
//!    regardless.
//!
//! 2. **A directory-provisioned account has no local fallback.** It carries no
//!    hash - there is nothing to fall back to - so revoking somebody in the
//!    directory revokes them here, which is the whole point of connecting one.
//!
//! 3. **Linking does not seize an account.** A local account matched by a
//!    synchronisation records the directory but keeps its hash. Handing it over
//!    is an explicit administrative action
//!    (`POST /admin/ldap/directories/:id/govern`) that clears the hash, never a
//!    side effect of a sync. Otherwise the first synchronisation of a directory
//!    containing the administrator's address would make the instance's own
//!    console depend on that directory being up.
//!
//! ## What the person signing in is told
//!
//! Nothing that distinguishes the cases. Whether the address is unknown, the
//! password is wrong, the directory refused the bind or the directory is down,
//! the sign-in route answers the same "Invalid credentials" it has always
//! answered. The diagnosis lives in the log and in the administration console's
//! test button, both of which require an operator.

use kubuno_db::DbPool;
use uuid::Uuid;

use crate::auth::methods::MethodSet;
use crate::{errors::AppError, models::user::User};

use super::client::{Connection, DirectoryError};
use super::mapping::{map_user, MappedUser};
use super::model::LdapDirectory;
use super::{config, filter, provision};

/// The credential that decides whether a given account may sign in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authority {
    /// A local password hash exists: it is checked, and the directory is not
    /// consulted. Applies even when the account is *also* linked to one.
    LocalPassword,
    /// No local hash, and a directory governs the account.
    Directory(Uuid),
    /// No local hash and no directory - an OIDC-only account, or one whose
    /// directory row was deleted. The password route cannot admit it.
    External,
}

/// The rule, as a pure function of the account. Deliberately takes the whole
/// user so the reason is readable at the call site.
pub fn authority_for(user: &User) -> Authority {
    if user.password_hash.is_some() {
        return Authority::LocalPassword;
    }
    match user.ldap_directory_id {
        Some(id) => Authority::Directory(id),
        None => Authority::External,
    }
}

/// Where the password typed at the sign-in form has to be checked.
///
/// The sign-in handler asks this once and follows the answer; it does not
/// re-derive the rule. Keeping the decision in one function is what makes the
/// anti-lockout property checkable rather than merely intended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordRoute {
    /// Against the stored hash, and nowhere else.
    Local,
    /// Against this directory, and no other.
    Directory(Uuid),
    /// Against every enabled directory, in the operator's order. Reached only
    /// when the instance has no account for this login at all.
    AnyDirectory,
    /// Nothing to check: the account authenticates through an external
    /// identity provider that is not a directory.
    Nowhere,
}

impl PasswordRoute {
    pub const fn uses_directory(self) -> bool {
        matches!(self, Self::Directory(_) | Self::AnyDirectory)
    }

    /// The single directory to try, when the route names one.
    pub const fn only(self) -> Option<Uuid> {
        match self {
            Self::Directory(id) => Some(id),
            _ => None,
        }
    }
}

/// Where the password goes, given the account **and the policy that governs it**.
///
/// `methods` is the administrator's decision for this account's scope
/// ([`crate::auth::methods`]), resolved by the caller: for a known account,
/// through its own chain (account → groups → unit and ancestors → instance);
/// for a login the instance has never seen, at the instance scope, because
/// there is no unit to resolve from and no account whose existence may be
/// revealed.
///
/// `admin_fallback` is the one exception to the policy and the reason an
/// instance cannot be locked out: an administrator may always use their local
/// password while it is on, even where `local` is not accepted.
pub fn route_for(user: Option<&User>, methods: MethodSet, admin_fallback: bool) -> PasswordRoute {
    let Some(u) = user else {
        // Nothing is known - not even whether this login exists. The answer must
        // therefore depend on the instance policy alone.
        return if methods.directory {
            PasswordRoute::AnyDirectory
        } else {
            PasswordRoute::Nowhere
        };
    };

    if crate::auth::methods::local_allowed(methods, admin_fallback, &u.role, u.password_hash.is_some()) {
        return PasswordRoute::Local;
    }

    if methods.directory {
        // An account already governed by a directory is offered to that one and
        // to no other: replaying an unknown password against every directory in
        // the instance would be a credential-stuffing amplifier.
        return match u.ldap_directory_id {
            Some(id) => PasswordRoute::Directory(id),
            // A local account in a directory-governed branch that nobody has
            // linked yet. The directories get a turn, which is how the link is
            // made on the first successful bind.
            None => PasswordRoute::AnyDirectory,
        };
    }

    PasswordRoute::Nowhere
}

/// How a directory sign-in ended, for the caller's log and audit.
pub struct DirectoryLogin {
    pub user: User,
    pub directory_slug: String,
    pub how: provision::Provisioned,
}

/// Resolves an entry and binds as it. The password never leaves this function.
///
/// Returns the mapped entry on success - the caller decides what to do with it
/// (provision, refresh, or nothing).
pub async fn search_then_bind(
    dir: &LdapDirectory,
    service_password: &str,
    login: &str,
    password: &str,
) -> Result<MappedUser, DirectoryError> {
    if !dir.is_usable() {
        return Err(DirectoryError::Misconfigured(
            "Directory disabled or incompletely configured".into(),
        ));
    }
    let search_filter = filter::build_user_filter(&dir.user_filter, login)
        .map_err(|e| DirectoryError::Misconfigured(e.message().to_string()))?;

    let attrs = dir.attributes();
    let mut conn = Connection::open(dir, service_password).await?;

    let entries = match conn
        .search(&dir.base_dn, dir.scope(), &search_filter, &attrs.requested())
        .await
    {
        Ok(e) => e,
        Err(e) => {
            conn.close().await;
            return Err(e);
        }
    };

    let entry = match entries.len() {
        0 => {
            conn.close().await;
            return Err(DirectoryError::NoSuchUser);
        }
        1 => entries.into_iter().next().unwrap_or_else(|| {
            // Unreachable: the length was just checked. Written without an
            // `unwrap` because the rule is the rule.
            ldap3::SearchEntry {
                dn: String::new(),
                attrs: Default::default(),
                bin_attrs: Default::default(),
            }
        }),
        n => {
            // Binding against "the first match" would authenticate an arbitrary
            // person whenever the filter is too loose. Refuse instead.
            conn.close().await;
            return Err(DirectoryError::Ambiguous(n));
        }
    };

    let mapped = map_user(&entry, &attrs);
    if mapped.dn.is_empty() {
        conn.close().await;
        return Err(DirectoryError::SearchFailed("Entry has no DN".into()));
    }

    // The bind is the authentication. It runs on the same connection, which
    // re-binds it as the person - hence nothing else is done with it afterwards.
    let result = conn.bind_as(&mapped.dn, password).await;
    conn.close().await;
    result?;

    Ok(mapped)
}

/// Full sign-in against the directories, for somebody the instance has no local
/// password for.
///
/// `only` narrows the attempt to a single directory - used when the account is
/// already governed by one, so an unknown password is not replayed against every
/// other directory in the instance.
pub async fn authenticate(
    db: &DbPool,
    jwt_secret: &str,
    login: &str,
    password: &str,
    only: Option<Uuid>,
) -> Result<Option<DirectoryLogin>, AppError> {
    if !config::login_enabled(db).await {
        tracing::debug!("annuaire : authentification désactivée sur l'instance");
        return Ok(None);
    }
    if password.is_empty() {
        return Ok(None);
    }

    let directories = config::enabled_directories(db).await?;
    let instance_allows_signup = config::provision_on_login(db).await;

    for dir in directories {
        if let Some(id) = only {
            if dir.id != id {
                continue;
            }
        }
        if !dir.is_usable() {
            continue;
        }

        let service_password = config::decrypt_password(jwt_secret, &dir.bind_password_enc);
        let mapped = match search_then_bind(&dir, &service_password, login, password).await {
            Ok(m) => m,
            Err(e) => {
                // An operational failure is the instance's problem and deserves
                // to be visible; a wrong password is routine and is not.
                if e.is_operational() {
                    tracing::error!(
                        directory = %dir.slug,
                        error = %e,
                        "annuaire : tentative d'authentification impossible"
                    );
                } else {
                    tracing::debug!(directory = %dir.slug, reason = %e.message(), "annuaire : liaison refusée");
                }
                continue;
            }
        };

        let allow_create = instance_allows_signup && dir.allow_signup;
        let Some(outcome) = provision::upsert(db, &dir, &mapped, allow_create).await? else {
            tracing::info!(
                directory = %dir.slug,
                "annuaire : liaison réussie mais aucun compte local (création désactivée ou entrée sans adresse)"
            );
            continue;
        };

        if !outcome.user.is_active {
            tracing::info!(
                user_id = %outcome.user.id,
                "annuaire : liaison réussie mais compte local désactivé"
            );
            continue;
        }

        return Ok(Some(DirectoryLogin {
            user: outcome.user,
            directory_slug: dir.slug.clone(),
            how: outcome.how,
        }));
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn user() -> User {
        User {
            id: Uuid::new_v4(),
            email: "admin@kubuno.local".into(),
            username: "admin".into(),
            password_hash: Some("$argon2id$…".into()),
            display_name: None,
            avatar_url: None,
            first_name: None,
            last_name: None,
            role: "admin".into(),
            quota_bytes: 0,
            used_bytes: 0,
            is_active: true,
            email_verified: true,
            oauth_provider: None,
            oauth_id: None,
            preferences: serde_json::json!({}),
            org_unit_id: None,
            name_pronunciation: None,
            pronouns: None,
            work_location: None,
            introduction: None,
            gender: None,
            birthday: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            last_login_at: None,
            password_changed_at: None,
            totp_enabled: false,
            must_change_password: false,
            admin_2fa_grace_until: None,
            totp_secret: None,
            totp_pending_secret: None,
            ldap_directory_id: None,
            ldap_dn: None,
            ldap_uid: None,
            ldap_synced_at: None,
        }
    }

    #[test]
    fn a_local_administrator_is_never_routed_to_a_directory() {
        // The anti-lockout proof, at the level of the rule itself. The unit says
        // "directory only" and the account has even been linked to one - the
        // administrator is still routed to their local password, because
        // `auth.local_admin_fallback` is on.
        let mut u = user();
        u.ldap_directory_id = Some(Uuid::new_v4());
        u.ldap_dn = Some("cn=admin,dc=exemple,dc=test".into());

        let directory_only = MethodSet::parse(Some(&serde_json::json!(["directory"])));
        assert_eq!(
            route_for(Some(&u), directory_only, true),
            PasswordRoute::Local,
            "le secours local des administrateurs l'emporte sur la politique de l'unité"
        );

        // And the same account without the fallback IS routed to its directory -
        // which is what makes the fallback meaningful rather than decorative.
        assert!(matches!(
            route_for(Some(&u), directory_only, false),
            PasswordRoute::Directory(_)
        ));
    }

    #[test]
    fn an_ordinary_account_obeys_its_units_policy() {
        let mut u = user();
        u.role = "user".into();
        let directory_only = MethodSet::parse(Some(&serde_json::json!(["directory"])));
        let local_only = MethodSet::parse(Some(&serde_json::json!(["local"])));

        // Directory-only unit, local hash still present: the hash is ignored and
        // the directories get the attempt. This is how a per-unit policy becomes
        // real rather than advisory.
        assert_eq!(route_for(Some(&u), directory_only, true), PasswordRoute::AnyDirectory);
        // Local-only unit: the local hash decides, no directory is contacted.
        assert_eq!(route_for(Some(&u), local_only, true), PasswordRoute::Local);
    }

    #[test]
    fn an_sso_only_unit_admits_nobody_through_the_password_form() {
        let mut u = user();
        u.role = "user".into();
        u.password_hash = None;
        u.oauth_provider = Some("keycloak".into());
        let sso_only = MethodSet::parse(Some(&serde_json::json!(["sso"])));
        assert_eq!(route_for(Some(&u), sso_only, true), PasswordRoute::Nowhere);
    }

    #[test]
    fn an_unknown_login_never_reveals_whether_it_exists() {
        // Two different instance policies, two different behaviours - but the
        // behaviour depends on the POLICY, never on the login. Nothing here can
        // be used to probe for an account.
        let with_dir = MethodSet::parse(Some(&serde_json::json!(["local", "directory"])));
        let without = MethodSet::parse(Some(&serde_json::json!(["local"])));
        assert_eq!(route_for(None, with_dir, true), PasswordRoute::AnyDirectory);
        assert_eq!(route_for(None, without, true), PasswordRoute::Nowhere);
    }

    #[test]
    fn an_account_provisioned_by_a_directory_has_no_local_fallback() {
        let mut u = user();
        let dir = Uuid::new_v4();
        u.password_hash = None;
        u.ldap_directory_id = Some(dir);
        assert_eq!(authority_for(&u), Authority::Directory(dir));
    }

    #[test]
    fn an_account_with_neither_is_refused_by_the_password_route() {
        let mut u = user();
        u.password_hash = None;
        u.oauth_provider = Some("keycloak".into());
        assert_eq!(authority_for(&u), Authority::External);
    }
}
