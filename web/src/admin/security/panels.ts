import {
  AlertTriangle, BadgeCheck, FileWarning, Fingerprint, Gavel, Globe2, KeyRound,
  LogIn, ShieldAlert, ShieldX, Siren, Smartphone, UserCog,
} from 'lucide-react'
import { PRIV } from '../../core/authz/types'
import type { PanelDef } from '../panels/types'

/**
 * What each security panel IS - the half of a panel the server does not send.
 *
 * The server sends counts; this table says what those counts are called, which
 * report answers them in full, how they should be read, and which privilege
 * governs them. Keeping it here rather than in the payload is deliberate: the
 * wording is translated, the report link is an address this build knows how to
 * spell, and neither belongs in an API another client may consume.
 *
 * A panel the server returns that is NOT in this table is dropped rather than
 * rendered with its raw id - an older console must not invent a title for a
 * newer server's panel. A panel in this table the server does not return is
 * simply absent, which is what happens for a withheld privilege.
 *
 * The SHAPE of an entry is shared with every other panelled page
 * (`../panels/types`), so a field added for one dashboard is available to all of
 * them instead of being invented twice.
 */

export type { PanelDef, PanelPolarity, PanelShape } from '../panels/types'

export const PANELS: PanelDef[] = [
  // ── Sign-in activity ───────────────────────────────────────────────────────
  {
    id: 'signins',
    Icon: LogIn,
    titleKey: 'admin.sec_signins',
    aboutKey: 'admin.sec_signins_about',
    shape: 'area',
    polarity: 'neutral',
    privilege: PRIV.SESSIONS_READ,
    reportTab: 'device-sessions',
  },
  {
    id: 'signin_methods',
    Icon: KeyRound,
    titleKey: 'admin.sec_signin_methods',
    aboutKey: 'admin.sec_signin_methods_about',
    shape: 'donut',
    polarity: 'neutral',
    privilege: PRIV.SESSIONS_READ,
    reportTab: 'device-sessions',
    legendKey: k => `devices.auth_${k}`,
  },
  {
    id: 'login_failures',
    Icon: ShieldX,
    titleKey: 'admin.sec_login_failures',
    aboutKey: 'admin.sec_login_failures_about',
    shape: 'bars',
    polarity: 'bad-up',
    privilege: PRIV.AUDIT_READ,
    reportTab: 'audit',
    reportParams: { action: 'core.auth.login_failed' },
  },
  {
    id: 'admin_denied',
    Icon: Gavel,
    titleKey: 'admin.sec_admin_denied',
    aboutKey: 'admin.sec_admin_denied_about',
    shape: 'bars',
    polarity: 'bad-up',
    privilege: PRIV.AUDIT_READ,
    reportTab: 'audit',
    reportParams: { outcome: 'denied' },
    legendKey: k => `admin.audit_outcome_${k}`,
  },
  {
    id: 'sensitive_actions',
    Icon: UserCog,
    titleKey: 'admin.sec_sensitive_actions',
    aboutKey: 'admin.sec_sensitive_actions_about',
    shape: 'ranking',
    polarity: 'neutral',
    privilege: PRIV.AUDIT_READ,
    reportTab: 'audit',
  },
  {
    id: 'signin_countries',
    Icon: Globe2,
    titleKey: 'admin.sec_signin_countries',
    aboutKey: 'admin.sec_signin_countries_about',
    shape: 'ranking',
    polarity: 'neutral',
    privilege: PRIV.SESSIONS_READ,
    reportTab: 'device-sessions',
  },

  // ── Devices ────────────────────────────────────────────────────────────────
  {
    id: 'new_devices',
    Icon: Smartphone,
    titleKey: 'admin.sec_new_devices',
    aboutKey: 'admin.sec_new_devices_about',
    shape: 'bars',
    polarity: 'neutral',
    privilege: PRIV.SESSIONS_READ,
    reportTab: 'device-sessions',
  },
  {
    id: 'device_incidents',
    Icon: ShieldAlert,
    titleKey: 'admin.sec_device_incidents',
    aboutKey: 'admin.sec_device_incidents_about',
    shape: 'bars',
    polarity: 'bad-up',
    privilege: PRIV.SESSIONS_READ,
    reportTab: 'device-sessions',
    legendKey: k => `devices.event_${k}`,
  },

  // ── Alerts ─────────────────────────────────────────────────────────────────
  {
    id: 'alerts_opened',
    Icon: Siren,
    titleKey: 'admin.sec_alerts_opened',
    aboutKey: 'admin.sec_alerts_opened_about',
    shape: 'bars',
    polarity: 'bad-up',
    privilege: PRIV.ALERTS_READ,
    reportTab: 'alerts',
  },
  {
    id: 'alerts_severity',
    Icon: AlertTriangle,
    titleKey: 'admin.sec_alerts_severity',
    aboutKey: 'admin.sec_alerts_severity_about',
    shape: 'donut',
    polarity: 'bad-up',
    privilege: PRIV.ALERTS_READ,
    reportTab: 'alerts',
    legendKey: k => `admin.al_sev_${k}`,
  },
  {
    id: 'alerts_kinds',
    Icon: BadgeCheck,
    titleKey: 'admin.sec_alerts_kinds',
    aboutKey: 'admin.sec_alerts_kinds_about',
    shape: 'ranking',
    polarity: 'neutral',
    privilege: PRIV.ALERTS_READ,
    reportTab: 'alerts',
    // `security.login_burst` → `admin.al_security_login_burst_name`.
    legendKey: k => `admin.al_${k.replace(/\./g, '_')}_name`,
  },

  // ── Rules and content detectors ────────────────────────────────────────────
  {
    id: 'rule_matches',
    Icon: Fingerprint,
    titleKey: 'admin.sec_rule_matches',
    aboutKey: 'admin.sec_rule_matches_about',
    shape: 'bars',
    polarity: 'neutral',
    privilege: PRIV.RULES_READ,
    reportTab: 'rules-log',
  },
  {
    id: 'top_rules',
    Icon: Gavel,
    titleKey: 'admin.sec_top_rules',
    aboutKey: 'admin.sec_top_rules_about',
    shape: 'ranking',
    polarity: 'neutral',
    privilege: PRIV.RULES_READ,
    reportTab: 'rules',
  },
  {
    id: 'gate_blocks',
    Icon: FileWarning,
    titleKey: 'admin.sec_gate_blocks',
    aboutKey: 'admin.sec_gate_blocks_about',
    shape: 'bars',
    polarity: 'bad-up',
    privilege: PRIV.RULES_READ,
    reportTab: 'detectors',
  },
]

/** The default order - the order they are declared in. */
export const DEFAULT_ORDER = PANELS.map(p => p.id)

const BY_ID = new Map(PANELS.map(p => [p.id, p]))

export function panelDef(id: string): PanelDef | undefined {
  return BY_ID.get(id)
}
