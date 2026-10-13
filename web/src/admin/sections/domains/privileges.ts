// The two privilege keys of the domain registry, mirroring `authz::keys::DOMAINS_*`
// server-side. A module of its own, with no imports, because the navigation tree
// needs them too and `adminNav.ts` must stay a declarative list.
export const DOMAINS_READ   = 'core.domains.read'
export const DOMAINS_MANAGE = 'core.domains.manage'
