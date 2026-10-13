import { useQuery } from '@tanstack/react-query'
import { api } from '../../core/api/client'
import { PRIV } from '../../core/authz/types'
import { usePrivileges } from '../../core/authz/usePrivileges'
import type { DashboardPanel, PanelBucket, PanelPeriod, PanelPoint, PanelSlice } from '../panels/types'

/**
 * The security dashboard's data layer — one read, no writes.
 *
 * The page performs no action of its own: every panel links to the report that
 * owns the records behind it (the audit trail, the alert queue, the rule log,
 * the device inventory), and those screens already carry their verbs and their
 * audit entries. A second write path here would be a second place to forget one.
 *
 * ## Nothing on this page is estimated
 *
 * Every figure the endpoint returns is a `COUNT(*)` over a table the core itself
 * writes. Families the reference console also charts — message authentication,
 * transport encryption, spam filtering, external file shares — are absent rather
 * than approximated: they live in module schemas the core never reads, and a
 * plausible-looking curve over data nobody measured is the one thing a security
 * overview must never draw.
 */

// The wire shape is the one every panelled page of the console shares
// (`../panels/types`). Named again here so the page's own imports read in its
// own vocabulary, but never REDEFINED: a second declaration of the same payload
// is a second thing to keep in step with the server.

/** One bucket of a series. `bucket` is a local wall-clock instant. */
export type SecurityPoint = PanelPoint

export type SecuritySlice = PanelSlice

/**
 * One panel, as the server computed it.
 *
 * `previous_total` covers the window of identical length immediately before the
 * reading — including for a period still running, which is read up to now on
 * both sides so three days of a month are never compared against a whole one.
 * This endpoint always states it: every security panel counts events, and events
 * have a past.
 */
export type SecurityPanel = DashboardPanel

export type SecurityBucket = PanelBucket

export type SecurityPeriod = PanelPeriod

/** How far back each source can still answer, in days. */
export interface SecurityRetention {
  audit_days:           number
  alerts_days:          number
  rule_executions_days: number
  event_log_days:       number
}

export interface SecurityDashboard {
  period:    SecurityPeriod
  /** The closed list of selectable windows, in display order. */
  periods:   string[]
  panels:    SecurityPanel[]
  /** Panels the caller does not hold the privilege for, at instance scope. */
  withheld:  string[]
  retention: SecurityRetention
}

export const SECURITY_DASHBOARD_KEY = ['admin-security-dashboard'] as const

/**
 * The whole page, for one period.
 *
 * Skipped without `core.audit.read`: the endpoint gates on it, and polling a 403
 * would be the only thing the page did.
 */
export function useSecurityDashboard(period: string) {
  const { can } = usePrivileges()
  const allowed = can(PRIV.AUDIT_READ)
  return useQuery({
    queryKey:  [...SECURITY_DASHBOARD_KEY, period],
    enabled:   allowed,
    queryFn:   () => api
      .get<SecurityDashboard>('/admin/security/dashboard', { params: { period } })
      .then(r => r.data),
    staleTime: 60_000,
  })
}

/** One implementation, shared: reading the failure of a request is the same
 *  problem everywhere. Re-exported under the name this section's callers
 *  already use. */
export { apiErrorMessage as errorMessage } from '../../core/api/errorMessage'
