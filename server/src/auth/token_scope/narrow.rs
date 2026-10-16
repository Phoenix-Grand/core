//! Intersecting the owner's privileges with the token's scopes.
//!
//! This is the whole of property 1 and property 2 (see the module header): a
//! token never grants more than its owner, and the answer is recomputed at every
//! call rather than frozen when the token was minted.

use std::collections::HashSet;

use super::{policy, TokenGrant};
use crate::authz::{AdminContext, PrivilegeScope};

/// Narrows a freshly resolved administrative context to what the presented
/// credential may exercise.
///
/// `grant` is `None` for a browser session, and the context comes back
/// untouched - this function is a no-op on the interactive path.
///
/// For a token there are two cases, and the difference between them *is* the
/// migration policy:
///
/// * **scoped token** - the effective privilege set is the intersection. A
///   superuser owner is not special-cased into "everything": their token holds
///   exactly its listed scopes, at instance scope, because that is what
///   intersecting "all privileges, instance-wide" with a list produces.
///   Crucially the intersection *preserves the owner's scope*: if the owner holds
///   `core.users.update` over one organisational unit only, so does the token -
///   listing the key cannot widen it to the instance.
///
/// * **legacy token** - issued before scopes existed. It runs on the owner's
///   privileges during the grace window, minus the ones no bearer may ever
///   exercise. Administrative *writes* are refused separately and immediately,
///   with no grace at all (see [`super::deny_legacy_admin_write`]).
///
/// In both cases the forbidden keys land in [`AdminContext::denied`] rather than
/// being removed from the map: a superuser holds privileges implicitly, so there
/// is nothing to remove, and an explicit deny-list is the only representation
/// that survives that.
pub fn apply(mut ctx: AdminContext, grant: Option<&TokenGrant>) -> AdminContext {
    let Some(grant) = grant else {
        return ctx;
    };

    if grant.is_legacy {
        // Keep what the owner holds - including the superuser flag - but never
        // the scopes reserved to a person.
        ctx.denied = forbidden_keys(&ctx);
        return ctx;
    }

    let listed: HashSet<&str> = grant.scopes.iter().map(String::as_str).collect();

    if ctx.is_superuser {
        // "Everything, instance-wide" ∩ "these keys" = these keys, instance-wide.
        // Dropping the flag is what stops the token inheriting privileges that do
        // not exist yet, which is the trap a superuser's token would otherwise be.
        ctx.is_superuser = false;
        ctx.privileges = grant
            .scopes
            .iter()
            .filter(|k| !policy::forbids_scope(k))
            .map(|k| {
                (
                    k.clone(),
                    PrivilegeScope { instance: true, units: HashSet::new() },
                )
            })
            .collect();
    } else {
        // Retain preserves each privilege's own scope: a token cannot widen an
        // org-unit-scoped privilege into an instance-wide one by naming it.
        ctx.privileges.retain(|key, _| listed.contains(key.as_str()));
    }

    ctx.denied = forbidden_keys(&ctx);
    ctx
}

/// The keys this credential may never exercise, whatever it lists and whatever
/// its owner holds.
///
/// Two sources, and both are needed: the catalogue flag (`is_token_grantable`,
/// consulted at creation) cannot be read here without a query on the hot path,
/// so the keys the core knows by name are hard-coded, and the namespace rule
/// covers whatever is added later.
fn forbidden_keys(ctx: &AdminContext) -> HashSet<String> {
    let mut denied: HashSet<String> = NEVER_BY_TOKEN.iter().map(|k| (*k).to_string()).collect();
    // Anything the owner holds in a forbidden namespace is denied too, so a key
    // promoted into the catalogue tomorrow is closed today.
    denied.extend(
        ctx.privileges
            .keys()
            .filter(|k| policy::forbids_scope(k))
            .cloned(),
    );
    denied
}

/// Operations that hand over durable control and therefore demand a person.
///
/// Mirrors `is_token_grantable = FALSE` in the catalogue (migration `000053`).
/// The duplication is deliberate: the flag stops such a scope being *granted*,
/// this list stops it being *exercised* - including by a legacy token, which was
/// never granted anything and would otherwise inherit them all from its owner.
pub const NEVER_BY_TOKEN: &[&str] = &[
    crate::authz::keys::ROLES_MANAGE,
    crate::authz::keys::MARKETPLACE_MANAGE,
    crate::authz::keys::THEMES_MANAGE,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::ActorOrigin;
    use uuid::Uuid;

    fn grant(scopes: &[&str], is_legacy: bool) -> TokenGrant {
        TokenGrant {
            token_id: Uuid::nil(),
            user_id: Uuid::nil(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            is_legacy,
            grace_until: None,
        }
    }

    fn owner_with(keys: &[(&str, PrivilegeScope)]) -> AdminContext {
        let mut ctx = AdminContext::empty(Uuid::nil(), ActorOrigin::ApiToken, Some(Uuid::nil()));
        for (k, s) in keys {
            ctx.privileges.insert((*k).to_string(), s.clone());
        }
        ctx
    }

    fn instance() -> PrivilegeScope {
        PrivilegeScope { instance: true, units: HashSet::new() }
    }

    #[test]
    fn a_session_is_left_alone() {
        let ctx = owner_with(&[("core.users.read", instance())]);
        let out = apply(ctx.clone(), None);
        assert!(out.has("core.users.read"));
        assert!(out.denied.is_empty());
    }

    #[test]
    fn the_effective_privilege_is_the_intersection() {
        let ctx = owner_with(&[
            ("core.users.read", instance()),
            ("core.settings.manage", instance()),
        ]);
        // The token lists one of the two, plus one its owner does not hold.
        let out = apply(ctx, Some(&grant(&["core.users.read", "core.audit.read"], false)));
        assert!(out.has("core.users.read"));
        assert!(!out.has("core.settings.manage"), "portée non listée par le jeton");
        assert!(!out.has("core.audit.read"), "le jeton ne peut pas dépasser son propriétaire");
    }

    #[test]
    fn a_token_cannot_widen_an_org_unit_scope_by_naming_the_key() {
        let unit = Uuid::new_v4();
        let ctx = owner_with(&[(
            "core.users.update",
            PrivilegeScope { instance: false, units: HashSet::from([unit]) },
        )]);
        let out = apply(ctx, Some(&grant(&["core.users.update"], false)));
        assert!(out.has_for_unit("core.users.update", Some(unit)));
        assert!(!out.has_at_instance("core.users.update"));
        assert!(!out.has_for_unit("core.users.update", Some(Uuid::new_v4())));
    }

    #[test]
    fn a_superuser_token_holds_its_list_and_nothing_more() {
        let mut ctx = AdminContext::empty(Uuid::nil(), ActorOrigin::ApiToken, Some(Uuid::nil()));
        ctx.is_superuser = true;
        let out = apply(ctx, Some(&grant(&["core.users.read"], false)));
        assert!(!out.is_superuser, "le drapeau ne doit pas survivre à l'intersection");
        assert!(out.has("core.users.read"));
        // Not held, and - the real point - not implicitly held either.
        assert!(!out.has("core.settings.manage"));
        assert!(!out.has("un.module.execute"));
    }

    #[test]
    fn sensitive_keys_are_refused_even_to_a_superuser_token() {
        let mut ctx = AdminContext::empty(Uuid::nil(), ActorOrigin::ApiToken, Some(Uuid::nil()));
        ctx.is_superuser = true;
        // Even if the list somehow contains one (creation refuses it, but the
        // exercise path must not depend on that).
        let out = apply(ctx, Some(&grant(&["core.roles.manage", "core.users.read"], false)));
        assert!(!out.has("core.roles.manage"));
        assert!(out.has("core.users.read"));
    }

    #[test]
    fn a_legacy_token_keeps_the_owner_privileges_minus_the_sensitive_ones() {
        let mut ctx = AdminContext::empty(Uuid::nil(), ActorOrigin::ApiToken, Some(Uuid::nil()));
        ctx.is_superuser = true;
        let out = apply(ctx, Some(&grant(&[], true)));
        // Grace: still a superuser for ordinary reads…
        assert!(out.has("core.users.read"));
        assert!(out.has("core.settings.read"));
        // …but never for the operations reserved to a person.
        assert!(!out.has("core.roles.manage"));
        assert!(!out.has("core.marketplace.manage"));
        assert!(!out.has("core.themes.manage"));
    }

    #[test]
    fn losing_a_privilege_loses_it_for_the_token_too() {
        // Property 2, expressed as the two resolutions a withdrawal produces.
        let before = owner_with(&[("core.users.read", instance())]);
        let after = owner_with(&[]);
        let g = grant(&["core.users.read"], false);
        assert!(apply(before, Some(&g)).has("core.users.read"));
        assert!(
            !apply(after, Some(&g)).has("core.users.read"),
            "l'intersection est recalculée, jamais copiée"
        );
    }
}
