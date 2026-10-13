// The two privilege keys of the buildings-and-resources section, mirroring
// `authz::keys::RESOURCES_*` server-side.
//
// A module of its own, with no imports, because the navigation tree needs them
// too: pulling them from the section's `api.ts` would drag React Query into
// `adminNav.ts`, which is a declarative list and should stay one.
export const RESOURCES_READ   = 'core.resources.read'
export const RESOURCES_MANAGE = 'core.resources.manage'
