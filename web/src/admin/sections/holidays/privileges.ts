// The two privilege keys of the holiday referential, mirroring
// `authz::keys::HOLIDAYS_*` server-side.
//
// A module of its own, with no imports, because the navigation tree needs them
// too: pulling them from the section's `api.ts` would drag React Query into
// `adminNav.ts`, which is a declarative list and should stay one.
export const HOLIDAYS_READ   = 'core.holidays.read'
export const HOLIDAYS_MANAGE = 'core.holidays.manage'
