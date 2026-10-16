// Wire types of the delegated-administration model, mirroring `crate::authz`.
// Kept in one place so the roles panel, the navigation filter and the shell all
// read the same shapes.

/** One row of the privilege catalogue (`GET /admin/privileges`). */
export interface Privilege {
  key:         string
  namespace:   string
  domain:      string
  verb:        string
  label:       string
  description: string | null
  /** Can this privilege be confined to an organisational subtree? */
  is_ou_scopable: boolean
  /** The declaring module is gone. Kept and flagged, never hidden. */
  is_orphan:      boolean
}

/** One role, as `GET /admin/roles` returns it (definition + derived facts). */
export interface Role {
  id:           string
  slug:         string
  name:         string
  description:  string | null
  is_system:    boolean
  is_superuser: boolean
  privileges:   string[]
  assignment_count: number
  /**
   * False when the role holds at least one non-scopable privilege (or is a
   * superuser role): an org-unit-scoped assignment of it would be refused, so
   * the console disables that option instead of letting the operator discover
   * it on a 422.
   */
  ou_delegable: boolean
  created_at:   string
  updated_at:   string
}

export type AssignmentScope = 'instance' | 'org_unit'

/** One row of `GET /admin/role-assignments`, joined with its labels. */
export interface RoleAssignment {
  id:        string
  role_id:   string
  role_slug: string
  role_name: string
  subject_user_id:  string | null
  subject_group_id: string | null
  subject_label:    string | null
  scope:                AssignmentScope
  scope_org_unit_id:    string | null
  scope_org_unit_name:  string | null
  expires_at: string | null
  created_at: string
  created_by: string | null
}

/** One privilege and the scope it is held over - scopes already resolved. */
export interface EffectivePrivilege {
  key:       string
  instance:  boolean
  /** Organisational units, subtrees already expanded server-side. */
  org_units: string[]
}

/**
 * What an account effectively holds.
 *
 * Returned by `GET /api/v1/me` (the `privileges` block - the caller looking at
 * themselves, no privilege required) and by `GET /admin/users/:id/privileges`
 * (an operator looking at someone else). Same shape from both, deliberately.
 */
export interface EffectivePrivileges {
  user_id:      string
  is_superuser: boolean
  /** May enter the administration surface at all. */
  is_admin:     boolean
  org_unit_id:  string | null
  privileges:   EffectivePrivilege[]
  /**
   * Keys this credential may never exercise, whatever the rest says. Non-empty
   * only for an API token: a legacy one keeps its owner's super-user flag while
   * it may still read, and this list is the only thing that says "not that one".
   */
  denied:       string[]
}

/**
 * The single privilege predicate used everywhere in the console.
 *
 * `can(key)` answers "does the caller hold this anywhere?" - the question the
 * navigation asks. `can(key, unitId)` narrows it to one organisational unit,
 * and `can(key, null)` to a target that sits in no unit (covered by instance
 * scope only, exactly like `AdminContext::has_for_unit` server-side).
 */
export type CanFn = (key: string, unit?: string | null) => boolean

/** Privilege keys the console checks by name (mirrors `authz::keys`). */
export const PRIV = {
  USERS_READ:            'core.users.read',
  USERS_CREATE:          'core.users.create',
  USERS_UPDATE:          'core.users.update',
  USERS_DELETE:          'core.users.delete',
  /** Resetting someone else's password - its own key, not `users.update`. */
  USER_PASSWORD:         'core.user_password.execute',
  SESSIONS_READ:         'core.sessions.read',
  /**
   * Revoking sessions - and, in the device inventory, every mutation that ends
   * in revoking them: blocking, signing out, forgetting an entry.
   */
  SESSIONS_DELETE:       'core.sessions.delete',
  ORG_UNITS_READ:        'core.org_units.read',
  ORG_UNITS_MANAGE:      'core.org_units.manage',
  GROUPS_READ:           'core.groups.read',
  GROUPS_MANAGE:         'core.groups.manage',
  ROLES_READ:            'core.roles.read',
  ROLES_MANAGE:          'core.roles.manage',
  SETTINGS_READ:         'core.settings.read',
  SETTINGS_MANAGE:       'core.settings.manage',
  STATS_READ:            'core.stats.read',
  MODULES_READ:          'core.modules.read',
  MODULES_MANAGE:        'core.modules.manage',
  MARKETPLACE_MANAGE:    'core.marketplace.manage',
  AUTH_PROVIDERS_READ:   'core.auth_providers.read',
  AUTH_PROVIDERS_MANAGE: 'core.auth_providers.manage',
  THEMES_READ:           'core.themes.read',
  THEMES_MANAGE:         'core.themes.manage',
  MAIL_READ:             'core.mail.read',
  MAIL_MANAGE:           'core.mail.manage',
  AUDIT_READ:            'core.audit.read',
  /**
   * Opening the storage page. Its own key rather than `stats.read`: the page
   * names accounts and how much each one holds. There is no `storage.manage`
   * counterpart - the page writes through `users.update` (one account's quota)
   * and `settings.manage` (the default policy).
   */
  STORAGE_READ:          'core.storage.read',
  BACKUP_READ:           'core.backup.read',
  BACKUP_MANAGE:         'core.backup.manage',
  /** Opening the alert centre. */
  ALERTS_READ:           'core.alerts.read',
  /** Taking, assigning, closing or ignoring an alert, and running its actions. */
  ALERTS_MANAGE:         'core.alerts.manage',
  /** Reading the administration rules, their catalogue and their run log. */
  RULES_READ:            'core.rules.read',
  /**
   * Writing an administration rule.
   *
   * Held apart from every other administrative key, and by no seeded role: a
   * rule can suspend accounts and revoke sessions, at machine speed, over a
   * population its author describes rather than names. "Can administer" must
   * not imply "can arm that".
   */
  RULES_MANAGE:          'core.rules.manage',
} as const
