// The three privilege keys of the target-audiences section, mirroring
// `authz::keys::AUDIENCES_*` server-side.
//
// A module of its own, with no imports, because the navigation tree needs them
// too: pulling them from the section's `api.ts` would drag React Query into
// `adminNav.ts`, which is a declarative list and should stay one.
//
// `AUDIENCES_APPLY` is named on its domain rather than its verb
// (`audience_policy.execute`) because `core.privileges` enforces
// `key = namespace.domain.verb` against a closed verb vocabulary with no
// "apply". The constant is what the UI checks; the string is what the server
// grants.
export const AUDIENCES_READ   = 'core.audiences.read'
export const AUDIENCES_MANAGE = 'core.audiences.manage'
export const AUDIENCES_APPLY  = 'core.audience_policy.execute'
