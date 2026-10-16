import {
  Activity, HardDrive, LayoutGrid, LogIn, MonitorSmartphone, Package,
  ShieldCheck, UserCheck, UserPlus, Users,
} from 'lucide-react'
import { PRIV } from '../../../core/authz/types'
import type { PanelDef } from '../../panels/types'

/**
 * What each panel of the general dashboard IS - the half the server does not
 * send.
 *
 * Same contract as the security overview's own table: a panel the server returns
 * that is NOT here is dropped rather than rendered with its raw id, and a panel
 * here that the server does not return is simply absent (which is what a
 * withheld privilege looks like).
 *
 * ## Polarity
 *
 * Everything on this page is `neutral`. Unlike the security overview, none of
 * these movements is bad in itself: more accounts, more sessions, more storage
 * used are facts an operator interprets, not incidents. Painting a rise in
 * consumption red would be the console having an opinion about a disk.
 */

export const PANELS: PanelDef[] = [
  // ── The people ─────────────────────────────────────────────────────────────
  {
    id: 'new_users',
    Icon: UserPlus,
    titleKey: 'admin.dash_new_users',
    aboutKey: 'admin.dash_new_users_about',
    shape: 'bars',
    polarity: 'neutral',
    privilege: PRIV.STATS_READ,
    reportTab: 'users',
  },
  {
    id: 'account_status',
    Icon: UserCheck,
    titleKey: 'admin.dash_account_status',
    aboutKey: 'admin.dash_account_status_about',
    shape: 'donut',
    polarity: 'neutral',
    privilege: PRIV.USERS_READ,
    reportTab: 'users',
    legendKey: k => `admin.acct_state_${k}`,
    caveatKey: id => `admin.dash_caveat_${id}`,
    // These three shares are not a ranking, they are a state of health: green
    // for the accounts that work, amber for those held back, red for those on
    // their way out. Ranked palette colours said the opposite here.
    sliceTone: k => ({
      active:           'var(--color-success)',
      suspended:        'var(--color-warning)',
      pending_deletion: 'var(--color-danger)',
    } as Record<string, string>)[k],
  },
  {
    id: 'user_roles',
    Icon: ShieldCheck,
    titleKey: 'admin.dash_user_roles',
    aboutKey: 'admin.dash_user_roles_about',
    shape: 'donut',
    polarity: 'neutral',
    privilege: PRIV.USERS_READ,
    reportTab: 'users',
    // The vocabulary the account list already uses - one name per role, on both
    // screens.
    legendKey: k => `admin.role_${k}`,
  },

  // ── Getting in ─────────────────────────────────────────────────────────────
  {
    id: 'signins',
    Icon: LogIn,
    titleKey: 'admin.dash_signins',
    aboutKey: 'admin.dash_signins_about',
    shape: 'area',
    polarity: 'neutral',
    privilege: PRIV.SESSIONS_READ,
    reportTab: 'device-sessions',
  },
  {
    id: 'unique_signins',
    Icon: Users,
    titleKey: 'admin.dash_unique_signins',
    aboutKey: 'admin.dash_unique_signins_about',
    shape: 'area',
    polarity: 'neutral',
    privilege: PRIV.SESSIONS_READ,
    reportTab: 'device-sessions',
    caveatKey: id => `admin.dash_caveat_${id}`,
  },
  {
    id: 'device_sessions',
    Icon: MonitorSmartphone,
    titleKey: 'admin.dash_device_sessions',
    aboutKey: 'admin.dash_device_sessions_about',
    shape: 'donut',
    polarity: 'neutral',
    privilege: PRIV.SESSIONS_READ,
    reportTab: 'device-sessions',
    legendKey: k => `admin.device_${k}`,
  },

  // ── What the instance is used for ──────────────────────────────────────────
  {
    id: 'app_usage',
    Icon: LayoutGrid,
    titleKey: 'admin.dash_app_usage',
    aboutKey: 'admin.dash_app_usage_about',
    shape: 'ranking',
    polarity: 'neutral',
    privilege: PRIV.STATS_READ,
    reportTab: 'modules',
    caveatKey: id => `admin.dash_caveat_${id}`,
  },

  // ── What it costs ──────────────────────────────────────────────────────────
  {
    id: 'storage',
    Icon: HardDrive,
    titleKey: 'admin.dash_storage',
    aboutKey: 'admin.dash_storage_about',
    shape: 'gauge',
    polarity: 'neutral',
    privilege: PRIV.STORAGE_READ,
    reportTab: 'storage',
  },
  {
    id: 'top_storage',
    Icon: HardDrive,
    titleKey: 'admin.dash_top_storage',
    aboutKey: 'admin.dash_top_storage_about',
    shape: 'ranking',
    polarity: 'neutral',
    privilege: PRIV.STORAGE_READ,
    reportTab: 'storage',
  },

  // ── The machinery ──────────────────────────────────────────────────────────
  {
    id: 'module_status',
    Icon: Package,
    titleKey: 'admin.dash_module_status',
    aboutKey: 'admin.dash_module_status_about',
    shape: 'donut',
    polarity: 'neutral',
    privilege: PRIV.MODULES_READ,
    reportTab: 'modules',
    legendKey: k => `admin.status_${k}`,
  },
  {
    id: 'events',
    Icon: Activity,
    titleKey: 'admin.dash_events',
    aboutKey: 'admin.dash_events_about',
    shape: 'bars',
    polarity: 'neutral',
    privilege: PRIV.AUDIT_READ,
    reportTab: 'event-log',
    caveatKey: id => `admin.dash_caveat_${id}`,
  },
]

/** The default order - the order they are declared in. */
export const DEFAULT_ORDER = PANELS.map(p => p.id)

const BY_ID = new Map(PANELS.map(p => [p.id, p]))

export function panelDef(id: string): PanelDef | undefined {
  return BY_ID.get(id)
}
