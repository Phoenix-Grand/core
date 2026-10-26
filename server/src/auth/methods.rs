//! **Which authentication methods an account may use** - an administrator's
//! decision, resolved per organisational unit.
//!
//! ## The decision is configuration, not a heuristic
//!
//! There is no "try the directory, fall back to local". An administrator states
//! which methods an instance - or a branch of the organisation - accepts, and
//! the sign-in path enforces exactly that. `auth.methods` is a
//! [`crate::settings`] key like any other, so it inherits down the
//! organisational tree (`instance → unit → sub-unit → group → account`), the
//! nearest unit wins, a level above can lock it, and "revert" removes the row so
//! the branch follows its parent again.
//!
//! Five real shapes, all expressible:
//!
//! | organisation | value |
//! |---|---|
//! | local accounts only | `["local"]` |
//! | directory only | `["directory"]` |
//! | one or several identity providers only | `["sso"]` |
//! | directory **plus** a local way in for administrators | `["directory"]` + `auth.local_admin_fallback = true` |
//! | mixed, per branch | `["directory"]` on one unit, `["local","sso"]` on another |
//!
//! ## The inverted order at the sign-in screen, and how it is resolved
//!
//! The method depends on the account's unit, and at the sign-in screen there is
//! no account yet - that is the whole difficulty. Three ways out were available:
//!
//! 1. **Resolve after the login field is typed.** Rejected. The screen would
//!    become a function of the account: whether it exists, and which unit it is
//!    in. That is a directory-enumeration oracle on a public page, and the
//!    project rule is explicit - nothing observable may distinguish "no such
//!    account" from "wrong password".
//! 2. **Derive the unit from the address domain.** Rejected. There is no
//!    domain → unit mapping in the model, and inventing one would be a guess
//!    that silently misroutes everybody whose address does not fit it.
//! 3. **Offer every method active *somewhere* in the instance, and enforce the
//!    unit's own rule after identification.** Chosen.
//!
//! What an anonymous visitor sees therefore depends on instance-wide
//! configuration only ([`active_anywhere`]) - never on whether a login exists,
//! never on which unit it belongs to. The per-unit rule is applied once the
//! account is known, and a refusal at that point returns the same
//! "Invalid credentials" as every other failure, so it leaks nothing either.
//! The cost is a slightly less guided sign-in page. That is the right trade
//! against an enumeration oracle.
//!
//! ## Accounts with no unit
//!
//! They exist - an account created before the tree, or one an operator never
//! placed. `core.setting_chain` anchors on `core.users.org_unit_id`, which is
//! `NULL` for them, so their chain is `default → instance` and nothing else.
//! They obey the instance value, which is the only sensible answer and needs no
//! special case anywhere.

use kubuno_db::{params, DbPool};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::errors::AppError;
use crate::settings::{chain, SettingScope};

/// Which methods this scope accepts. A JSON array of [`Method`] identifiers.
pub const KEY_METHODS: &str = "auth.methods";
/// May an administrator always use their local password, even where `local` is
/// not among the accepted methods?
///
/// The one lever that keeps a wrong policy from being a locked door. Default
/// **true**, and the guard below refuses any change that would leave an
/// administrator with nothing.
pub const KEY_ADMIN_FALLBACK: &str = "auth.local_admin_fallback";

// ── The methods themselves ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    /// The password stored in `core.users.password_hash`.
    Local,
    /// An LDAP / Active Directory bind (`crate::directory`).
    Directory,
    /// An OpenID Connect provider (`core.oauth_providers`).
    Sso,
}

impl Method {
    pub const ALL: [Method; 3] = [Method::Local, Method::Directory, Method::Sso];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Directory => "directory",
            Self::Sso => "sso",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "local" | "password" => Some(Self::Local),
            "directory" | "ldap" => Some(Self::Directory),
            "sso" | "oidc" | "oauth" => Some(Self::Sso),
            _ => None,
        }
    }
}

/// A resolved set of accepted methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MethodSet {
    pub local: bool,
    pub directory: bool,
    pub sso: bool,
}

impl MethodSet {
    pub const fn all() -> Self {
        Self { local: true, directory: true, sso: true }
    }

    pub const fn none() -> Self {
        Self { local: false, directory: false, sso: false }
    }

    pub const fn has(self, m: Method) -> bool {
        match m {
            Method::Local => self.local,
            Method::Directory => self.directory,
            Method::Sso => self.sso,
        }
    }

    pub const fn is_empty(self) -> bool {
        !self.local && !self.directory && !self.sso
    }

    pub fn union(self, other: Self) -> Self {
        Self {
            local: self.local || other.local,
            directory: self.directory || other.directory,
            sso: self.sso || other.sso,
        }
    }

    pub fn to_value(self) -> Value {
        let mut list = Vec::new();
        if self.local { list.push(Method::Local.as_str()); }
        if self.directory { list.push(Method::Directory.as_str()); }
        if self.sso { list.push(Method::Sso.as_str()); }
        json!(list)
    }

    pub fn to_json(self) -> Value {
        json!({ "local": self.local, "directory": self.directory, "sso": self.sso })
    }

    /// Parses a stored value.
    ///
    /// A value nobody can read resolves to **every** method rather than to none:
    /// an unreadable policy must not be interpreted as "nobody may sign in".
    /// That failure direction is deliberate and is the opposite of the one
    /// [`crate::directory::model::OnMissing`] takes, for the same reason in
    /// mirror - there, the unreadable case must not deactivate people; here, it
    /// must not lock them out.
    pub fn parse(value: Option<&Value>) -> Self {
        let Some(Value::Array(items)) = value else {
            return Self::all();
        };
        let mut set = Self::none();
        for item in items {
            match item.as_str().and_then(Method::parse) {
                Some(Method::Local) => set.local = true,
                Some(Method::Directory) => set.directory = true,
                Some(Method::Sso) => set.sso = true,
                None => {}
            }
        }
        // An array that named nothing we understand is a policy we cannot apply.
        // Same reasoning: fail open rather than lock the instance on a typo.
        if set.is_empty() {
            return Self::all();
        }
        set
    }

    /// Validates an administrator's input. An empty list is refused here rather
    /// than silently widened: writing "no method at all" is a mistake worth
    /// naming, whereas *reading* an unreadable one must not lock anybody out.
    pub fn validate(value: &Value) -> Result<Self, AppError> {
        let Value::Array(items) = value else {
            return Err(AppError::Validation(
                "auth.methods expects a list, for example [\"local\",\"directory\"]".into(),
            ));
        };
        let mut set = Self::none();
        for item in items {
            let name = item.as_str().ok_or_else(|| {
                AppError::Validation("auth.methods: each item must be a string".into())
            })?;
            match Method::parse(name) {
                Some(Method::Local) => set.local = true,
                Some(Method::Directory) => set.directory = true,
                Some(Method::Sso) => set.sso = true,
                None => {
                    return Err(AppError::Validation(format!(
                        "auth.methods: unknown method '{name}' (expected: local, directory, sso)"
                    )))
                }
            }
        }
        if set.is_empty() {
            return Err(AppError::Validation(
                "auth.methods: at least one method must remain enabled; an empty list would lock everyone out".into(),
            ));
        }
        Ok(set)
    }
}

// ── Resolution ───────────────────────────────────────────────────────────────

/// Methods accepted for one account, resolved through the full chain
/// (account → its groups → its unit and every ancestor → instance → factory).
pub async fn for_user(db: &DbPool, user_id: Uuid) -> MethodSet {
    resolve(db, &SettingScope::user(user_id)).await
}

/// Methods accepted at a scope. Used for the account-less case (somebody the
/// instance has never seen) with [`SettingScope::INSTANCE`].
pub async fn resolve(db: &DbPool, scope: &SettingScope) -> MethodSet {
    match chain::resolve_for(db, KEY_METHODS, scope).await {
        Ok(r) => MethodSet::parse(r.value.as_ref()),
        Err(_) => {
            // Already logged by the resolver. Fail open - see `parse`.
            MethodSet::all()
        }
    }
}

/// Is the administrative local-password fallback active at this scope?
pub async fn admin_fallback(db: &DbPool, scope: &SettingScope) -> bool {
    match chain::resolve_for(db, KEY_ADMIN_FALLBACK, scope).await {
        Ok(r) => r.value.as_ref().and_then(Value::as_bool).unwrap_or(true),
        Err(_) => true,
    }
}

/// May this account sign in with the password stored on it?
///
/// `local` accepted for its scope, **or** the administrative fallback. Either
/// way the account must actually hold a hash.
pub fn local_allowed(methods: MethodSet, fallback: bool, role: &str, has_hash: bool) -> bool {
    has_hash && (methods.local || (fallback && role == "admin"))
}

/// Every method active **somewhere** in the instance.
///
/// This is what the sign-in page is drawn from, and it is deliberately a
/// property of the configuration alone: it does not depend on any account, so
/// nothing about it can be used to probe for one.
pub async fn active_anywhere(db: &DbPool) -> MethodSet {
    // The instance value, plus every scope that overrides it. A method offered
    // to one unit has to be offered on the page, or that unit cannot sign in.
    let mut set = resolve(db, &SettingScope::INSTANCE).await;

    let overrides: Vec<Value> = db
        .fetch_all_as::<ValueRow>(
            "SELECT value FROM core.setting_values WHERE \"key\" = $1",
            params![KEY_METHODS],
        )
        .await
        .map(|rows| rows.into_iter().map(|r| r.value).collect())
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "auth: reading the per-scope methods");
            Vec::new()
        });
    for value in &overrides {
        set = set.union(MethodSet::parse(Some(value)));
    }

    // A method with nothing behind it is not offered: a directory button with no
    // directory, or an identity-provider row that is disabled, is an invitation
    // to an error the person cannot diagnose.
    if set.directory {
        let usable: bool = db
            .fetch_scalar::<bool>(
                "SELECT EXISTS(SELECT 1 FROM core.ldap_directories
                            WHERE enabled = TRUE AND host <> '' AND base_dn <> '')",
                params![],
            )
            .await
            .unwrap_or(false);
        let master = crate::directory::config::login_enabled(db).await;
        set.directory = usable && master;
    }
    if set.sso {
        let any: bool = db
            .fetch_scalar::<bool>(
                "SELECT EXISTS(SELECT 1 FROM core.oauth_providers WHERE enabled = TRUE)",
                params![],
            )
            .await
            .unwrap_or(false);
        set.sso = any;
    }

    set
}

/// A single JSON `value` column, wrapped so `DbPool` can fetch a list of them.
#[derive(sqlx::FromRow)]
struct ValueRow {
    value: Value,
}

// ── The anti-lockout guard ───────────────────────────────────────────────────

/// One row of the administrator scan: id, username, unit name, role, whether a
/// local hash exists, the governing directory, the OIDC provider slug.
///
/// A named alias rather than the bare tuple: seven positional fields read the
/// same at the call site whether or not two of them are swapped.
type AdminRow = (
    Uuid,
    String,
    Option<String>,
    Option<String>,
    bool,
    Option<Uuid>,
    Option<String>,
);

/// One administrator who would be shut out.
#[derive(Debug, Clone, Serialize)]
pub struct StrandedAdmin {
    pub id: Uuid,
    pub username: String,
    pub org_unit: Option<String>,
}

/// Refuses a policy under which some active administrator could no longer sign
/// in.
///
/// Called **after** the write, inside the audited transaction that performed it,
/// so what is checked is the policy as it would really be - chain, inheritance,
/// locks and all - rather than a simulation that could drift from the resolver.
/// Returning `Err` rolls the transaction back and nothing was ever written.
///
/// The rule is per administrator, not "at least one somewhere": the whole point
/// of a per-unit policy is that it can strand the operator of *one branch* while
/// the rest of the instance still works, and that is precisely the change nobody
/// notices until they need it.
///
/// "Administrator" here means `role = 'admin'` **and** anybody holding a live
/// role assignment, directly or through a group. A delegated administrator is
/// `role = 'user'` by construction (see `crate::authz`), so checking the column
/// alone would leave exactly the population the delegation model exists for
/// unprotected - and they are the ones confined to one unit, which is the unit a
/// per-unit policy can close.
pub async fn ensure_no_administrator_is_stranded(db: &DbPool) -> Result<(), AppError> {
    // `NOW()` is bound from Rust so the comparison is engine-agnostic; the two
    // occurrences take one placeholder each.
    let now = chrono::Utc::now();
    let admins: Vec<AdminRow> = db
        .fetch_all_as::<AdminRow>(
            r#"SELECT u.id, u.username, o.name, u.role,
                      (u.password_hash IS NOT NULL) AS has_hash,
                      u.ldap_directory_id, u.oauth_provider
                 FROM core.users u
            LEFT JOIN core.org_units o ON o.id = u.org_unit_id
                WHERE u.is_active = TRUE
                  AND (u.role = 'admin'
                    OR EXISTS (SELECT 1 FROM core.role_assignments a
                                WHERE a.subject_user_id = u.id
                                  AND (a.expires_at IS NULL OR a.expires_at > $1))
                    OR EXISTS (SELECT 1 FROM core.role_assignments a
                                 JOIN core.user_group_members m ON m.group_id = a.subject_group_id
                                WHERE m.user_id = u.id
                                  AND (a.expires_at IS NULL OR a.expires_at > $2)))"#,
            params![now, now],
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "auth: reading the active administrators");
            AppError::Database(e)
        })?;

    if admins.is_empty() {
        // An instance with no active administrator is already broken, and it is
        // not this guard's business to say so.
        return Ok(());
    }

    let mut stranded: Vec<StrandedAdmin> = Vec::new();

    for (id, username, unit, role, has_hash, ldap_dir, oauth) in admins {
        let scope = SettingScope::user(id);
        let methods = resolve(db, &scope).await;
        let fallback = admin_fallback(db, &scope).await;
        let role = role.unwrap_or_default();

        if local_allowed(methods, fallback, &role, has_hash) {
            continue;
        }

        // A directory only counts when there is a reachable configuration behind
        // it: pointing an administrator at a disabled directory is the same as
        // pointing them at nothing.
        if methods.directory {
            if let Some(dir_id) = ldap_dir {
                let usable: bool = db
                    .fetch_scalar::<bool>(
                        "SELECT EXISTS(SELECT 1 FROM core.ldap_directories
                                    WHERE id = $1 AND enabled = TRUE AND host <> '' AND base_dn <> '')",
                        params![dir_id],
                    )
                    .await
                    .unwrap_or(false);
                if usable {
                    continue;
                }
            }
        }

        if methods.sso {
            if let Some(slug) = oauth.as_deref() {
                let usable: bool = db
                    .fetch_scalar::<bool>(
                        "SELECT EXISTS(SELECT 1 FROM core.oauth_providers WHERE slug = $1 AND enabled = TRUE)",
                        params![slug],
                    )
                    .await
                    .unwrap_or(false);
                if usable {
                    continue;
                }
            }
        }

        stranded.push(StrandedAdmin { id, username, org_unit: unit });
    }

    if stranded.is_empty() {
        return Ok(());
    }

    let names: Vec<String> = stranded
        .iter()
        .take(5)
        .map(|a| match &a.org_unit {
            Some(u) => format!("{} ({u})", a.username),
            None => format!("{} (no unit)", a.username),
        })
        .collect();

    Err(AppError::Validation(format!(
        "Refused: {} administrator(s), including delegated administrators, would be unable to sign in: {}. Keep a usable method for their unit, or keep administrator local recovery enabled. As a last resort, run on the server: kubuno auth:recover <account> --local-access",
        stranded.len(),
        names.join(", ")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreadable_policy_never_locks_anybody_out() {
        // The failure direction that matters here: a value nobody can parse must
        // not be read as "no method is accepted".
        assert_eq!(MethodSet::parse(None), MethodSet::all());
        assert_eq!(MethodSet::parse(Some(&json!("local"))), MethodSet::all());
        assert_eq!(MethodSet::parse(Some(&json!([]))), MethodSet::all());
        assert_eq!(MethodSet::parse(Some(&json!(["telepathie"]))), MethodSet::all());
    }

    #[test]
    fn a_written_policy_is_read_back_exactly() {
        let set = MethodSet::parse(Some(&json!(["directory"])));
        assert!(set.directory && !set.local && !set.sso);
        let set = MethodSet::parse(Some(&json!(["local", "sso"])));
        assert!(set.local && set.sso && !set.directory);
        // Aliases an operator may reasonably type.
        assert!(MethodSet::parse(Some(&json!(["ldap"]))).directory);
        assert!(MethodSet::parse(Some(&json!(["oidc"]))).sso);
    }

    #[test]
    fn an_empty_list_is_refused_on_the_way_in() {
        // Reading is permissive, writing is not: "no method at all" is a mistake
        // worth naming at the moment somebody makes it.
        assert!(MethodSet::validate(&json!([])).is_err());
        assert!(MethodSet::validate(&json!(["local", "inconnue"])).is_err());
        assert!(MethodSet::validate(&json!("local")).is_err());
        assert!(MethodSet::validate(&json!(["local"])).is_ok());
    }

    #[test]
    fn the_administrative_fallback_is_what_keeps_a_door_open() {
        let directory_only = MethodSet::parse(Some(&json!(["directory"])));

        // An ordinary account in a directory-only unit cannot use its old hash.
        assert!(!local_allowed(directory_only, true, "user", true));
        // An administrator can, while the fallback is on.
        assert!(local_allowed(directory_only, true, "admin", true));
        // …and cannot once it is off.
        assert!(!local_allowed(directory_only, false, "admin", true));
        // Having no hash at all is not rescued by anything.
        assert!(!local_allowed(MethodSet::all(), true, "admin", false));
        // Where `local` is accepted, no fallback is needed.
        assert!(local_allowed(MethodSet::all(), false, "user", true));
    }

    #[test]
    fn a_union_is_what_the_sign_in_page_is_drawn_from() {
        let a = MethodSet::parse(Some(&json!(["local"])));
        let b = MethodSet::parse(Some(&json!(["directory"])));
        let u = a.union(b);
        assert!(u.local && u.directory && !u.sso);
    }

    #[test]
    fn the_stored_shape_round_trips() {
        for value in [json!(["local"]), json!(["directory", "sso"]), json!(["local", "directory", "sso"])] {
            let set = MethodSet::validate(&value).expect("valide");
            assert_eq!(MethodSet::parse(Some(&set.to_value())), set);
        }
    }
}
