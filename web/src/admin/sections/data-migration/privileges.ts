// The two privilege keys of data migration, mirroring `authz::keys::DATA_MIGRATION_*`
// server-side. A module of its own, with no imports, because the navigation tree
// needs them too and `adminNav.ts` must stay a declarative list.
export const DATA_MIGRATION_READ   = 'core.data_migration.read'
export const DATA_MIGRATION_MANAGE = 'core.data_migration.manage'
