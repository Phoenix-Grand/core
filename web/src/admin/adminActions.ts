import {
  AtSign, BarChart3, BellRing, Building2, Cloud, Contact, KeyRound, LayoutGrid, Mail,
  Package, ScrollText, Send, Shield, ShieldAlert, ShieldPlus, SlidersHorizontal,
  Timer, UserCog, UserPlus, Users, type LucideIcon,
} from 'lucide-react'
import { NAV_INDEX, canSeeTab } from './adminNav'
import { adminUrl, type AdminActionTarget } from './adminAction'
import { PRIV, type CanFn } from '../core/authz/types'

/**
 * ── The action registry ──────────────────────────────────────────────────────
 *
 * An experienced administrator does not walk the tree: they type what they want
 * to *do*. This registry is the catalogue of those verbs — the first category
 * the search offers, ahead of every place and every record.
 *
 * Each entry is a task, not a page. Most carry an `action` verb that opens the
 * surface performing it (see `adminAction.ts` for the URL convention); the few
 * that do not are tasks whose surface *is* the page (installing a module is
 * browsing the marketplace).
 *
 * ── Why the keywords live in the catalogues ──────────────────────────────────
 *
 * They used to be a French string array in this file, which meant the search
 * only ever worked in French: an English operator typing "add user" matched
 * nothing, because the synonyms said "ajouter". `keysKey` now points at a
 * COMMA-SEPARATED i18n entry, translated like any other string, so each locale
 * carries the words its administrators actually type. Diacritics do not matter —
 * matching folds both sides (see `adminSearchIndex.ts`).
 *
 * ── Visibility ───────────────────────────────────────────────────────────────
 *
 * An action is offered only when the caller may both reach its section AND hold
 * every privilege it needs. The search must never enumerate what the console
 * refuses to show: naming an action is already telling someone it exists.
 */
export interface AdminAction {
  id:         string
  labelKey:   string
  /** i18n key of the comma-separated synonym list. */
  keysKey:    string
  Icon:       LucideIcon
  target:     AdminActionTarget
  /** ALL of these are required. Empty = any administrator who can see the tab. */
  privs?:     string[]
  /** Super-user only (defining a role is guard-1 server-side, not a privilege). */
  superuser?: boolean
}

export const ADMIN_ACTIONS: AdminAction[] = [
  // ── Directory ─────────────────────────────────────────────────────────────
  {
    id: 'create-user', labelKey: 'admin.act_create_user', keysKey: 'admin.act_create_user_kw',
    Icon: UserPlus, target: { tab: 'users', action: 'create' }, privs: [PRIV.USERS_CREATE],
  },
  {
    id: 'reset-password', labelKey: 'admin.act_reset_password', keysKey: 'admin.act_reset_password_kw',
    Icon: KeyRound, target: { tab: 'users', action: 'reset-password' }, privs: [PRIV.USER_PASSWORD],
  },
  {
    id: 'edit-user', labelKey: 'admin.feat_edit_user', keysKey: 'admin.act_edit_user_kw',
    Icon: Users, target: { tab: 'users' }, privs: [PRIV.USERS_UPDATE],
  },
  {
    id: 'delete-user', labelKey: 'admin.feat_delete_user', keysKey: 'admin.act_delete_user_kw',
    Icon: Users, target: { tab: 'users' }, privs: [PRIV.USERS_DELETE],
  },
  {
    id: 'create-group', labelKey: 'admin.feat_create_group', keysKey: 'admin.act_create_group_kw',
    Icon: Contact, target: { tab: 'groups', action: 'create' }, privs: [PRIV.GROUPS_MANAGE],
  },
  {
    id: 'create-org-unit', labelKey: 'admin.act_create_org_unit', keysKey: 'admin.act_create_org_unit_kw',
    Icon: Building2, target: { tab: 'org-units', action: 'create' }, privs: [PRIV.ORG_UNITS_MANAGE],
  },

  // ── Delegated administration ──────────────────────────────────────────────
  {
    id: 'create-role', labelKey: 'admin.roles_create', keysKey: 'admin.act_create_role_kw',
    Icon: UserCog, target: { tab: 'admin-roles', action: 'create' },
    privs: [PRIV.ROLES_READ], superuser: true,
  },
  {
    id: 'assign-role', labelKey: 'admin.act_assign_role', keysKey: 'admin.act_assign_role_kw',
    Icon: ShieldPlus, target: { tab: 'admin-roles' }, privs: [PRIV.ROLES_MANAGE],
  },

  // ── Applications ──────────────────────────────────────────────────────────
  {
    id: 'install-module', labelKey: 'admin.feat_install_module', keysKey: 'admin.act_install_module_kw',
    Icon: LayoutGrid, target: { tab: 'marketplace' }, privs: [PRIV.MARKETPLACE_MANAGE],
  },
  {
    id: 'module-settings', labelKey: 'admin.act_module_settings', keysKey: 'admin.act_module_settings_kw',
    Icon: Package, target: { tab: 'modules' }, privs: [PRIV.MODULES_READ],
  },

  // ── Security & authentication ─────────────────────────────────────────────
  {
    id: 'add-sso', labelKey: 'admin.act_add_sso', keysKey: 'admin.act_add_sso_kw',
    Icon: Shield, target: { tab: 'sso', action: 'add' }, privs: [PRIV.AUTH_PROVIDERS_MANAGE],
  },
  {
    id: 'config-sso', labelKey: 'admin.feat_config_sso', keysKey: 'admin.act_config_sso_kw',
    Icon: Shield, target: { tab: 'sso' }, privs: [PRIV.AUTH_PROVIDERS_READ],
  },

  {
    id: 'session-policy', labelKey: 'admin.act_session_policy', keysKey: 'admin.act_session_policy_kw',
    Icon: Timer, target: { tab: 'session-policy' }, privs: [PRIV.SETTINGS_READ],
  },
  {
    id: 'api-access', labelKey: 'admin.act_api_access', keysKey: 'admin.act_api_access_kw',
    Icon: KeyRound, target: { tab: 'access-data' }, privs: [PRIV.SETTINGS_READ],
  },
  {
    id: 'service-protection', labelKey: 'admin.act_service_protection', keysKey: 'admin.act_service_protection_kw',
    Icon: ShieldAlert, target: { tab: 'service-protection' }, privs: [PRIV.SETTINGS_READ],
  },

  // ── Instance ──────────────────────────────────────────────────────────────
  {
    id: 'config-mail', labelKey: 'admin.act_config_mail', keysKey: 'admin.act_config_mail_kw',
    Icon: Mail, target: { tab: 'email' }, privs: [PRIV.MAIL_READ],
  },
  {
    id: 'test-mail', labelKey: 'admin.act_test_mail', keysKey: 'admin.act_test_mail_kw',
    Icon: Send, target: { tab: 'email', action: 'test' }, privs: [PRIV.MAIL_MANAGE],
  },
  {
    id: 'instance-profile', labelKey: 'admin.act_instance_profile', keysKey: 'admin.act_instance_profile_kw',
    Icon: SlidersHorizontal, target: { tab: 'settings' }, privs: [PRIV.SETTINGS_READ],
  },
  {
    id: 'customize', labelKey: 'admin.feat_customize', keysKey: 'admin.act_customize_kw',
    Icon: AtSign, target: { tab: 'apparence' }, privs: [PRIV.THEMES_READ],
  },

  // ── Reporting ─────────────────────────────────────────────────────────────
  {
    id: 'view-reports', labelKey: 'admin.feat_view_reports', keysKey: 'admin.act_view_reports_kw',
    Icon: BarChart3, target: { tab: 'event-log' }, privs: [PRIV.AUDIT_READ],
  },
  {
    id: 'view-audit', labelKey: 'admin.act_view_audit', keysKey: 'admin.act_view_audit_kw',
    Icon: ScrollText, target: { tab: 'audit' }, privs: [PRIV.AUDIT_READ],
  },

  // ── Alert centre ──────────────────────────────────────────────────────────
  {
    id: 'view-alerts', labelKey: 'admin.act_view_alerts', keysKey: 'admin.act_view_alerts_kw',
    Icon: BellRing, target: { tab: 'alerts' }, privs: [PRIV.ALERTS_READ],
  },
  {
    id: 'my-alerts', labelKey: 'admin.act_my_alerts', keysKey: 'admin.act_my_alerts_kw',
    Icon: BellRing, target: { tab: 'alerts', params: { assignee: 'me' } }, privs: [PRIV.ALERTS_READ],
  },

  // ── Storage ───────────────────────────────────────────────────────────────
  {
    id: 'manage-storage', labelKey: 'admin.feat_manage_storage', keysKey: 'admin.act_manage_storage_kw',
    Icon: Cloud, target: { tab: 'storage' }, privs: [PRIV.STORAGE_READ],
  },
  {
    id: 'storage-full-accounts', labelKey: 'admin.act_storage_full', keysKey: 'admin.act_storage_full_kw',
    Icon: Cloud, target: { tab: 'storage', params: { filter: 'full' } }, privs: [PRIV.STORAGE_READ],
  },
]

/** URL of an action — the same convention every other producer uses. */
export const actionUrl = (a: AdminAction): string => adminUrl(a.target)

/**
 * Is this target a declared placeholder? Read from the nav tree rather than
 * repeated here, so a section that ships stops being flagged on its own.
 */
export const isSoonTarget = (tab: string): boolean => !!NAV_INDEX.get(tab)?.item.soon

/** The actions this caller may actually perform. */
export function visibleActions(can: CanFn, isSuperuser: boolean): AdminAction[] {
  return ADMIN_ACTIONS.filter(a => {
    if (a.superuser && !isSuperuser) return false
    if (!canSeeTab(a.target.tab, can)) return false
    return (a.privs ?? []).every(p => can(p))
  })
}
