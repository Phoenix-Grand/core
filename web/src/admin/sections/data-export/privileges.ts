// The two privilege keys of the data export, mirroring `authz::keys::DATA_EXPORT_*`
// server-side. A module of its own, with no imports, because the navigation tree
// needs them too and `adminNav.ts` must stay a declarative list — same shape as
// `data-migration/privileges.ts`.
//
// `EXECUTE` is held by no seeded role, on purpose: producing an archive of every
// account is a power that has to be granted deliberately. The console reads it
// only to decide what to *offer*; the server refuses regardless.
export const DATA_EXPORT_READ    = 'core.data_export.read'
export const DATA_EXPORT_EXECUTE = 'core.data_export.execute'
