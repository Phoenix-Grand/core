import { useQuery } from '@tanstack/react-query'
import { api } from '../../../core/api/client'
import { PRIV } from '../../../core/authz/types'
import { usePrivileges } from '../../../core/authz/usePrivileges'
import type { DashboardPanel, PanelPeriod } from '../../panels/types'

/**
 * The dashboard's data layer - one read, no writes.
 *
 * The page performs no action of its own: every panel links to the report that
 * owns the records behind it (the account list, the session inventory, the
 * storage page, the module list), and those screens already carry their verbs
 * and their audit entries. A second write path here would be a second place to
 * forget one.
 *
 * ## Nothing on this page is estimated
 *
 * Every figure the endpoint returns is read from a table the core itself writes.
 * The one family the reference console panels and this page does not - **file
 * sharing exposure**, internal and external - lives in module schemas the core
 * never reads, and is therefore ABSENT rather than drawn as a zero. The note at
 * the foot of the page says so out loud; see `handlers/admin/dashboard.rs` for
 * the channel that would carry it.
 */

/** How far back each source can answer, and since when it has been answering. */
export interface DashboardRetention {
  /** Retention of the attendance counters, in days (`usage.retention_days`). */
  module_usage_days:  number
  /**
   * First day the attendance counters hold anything, `YYYY-MM-DD`, or null when
   * nothing has been counted yet. Without it, a window opening before the
   * counter existed reads as "nobody used the applications".
   */
  module_usage_since: string | null
  event_log_days:     number
}

export interface DashboardData {
  period:    PanelPeriod
  /** The closed list of selectable windows, in display order. */
  periods:   string[]
  panels:    DashboardPanel[]
  /** Panels the caller does not hold the privilege for, at instance scope. */
  withheld:  string[]
  retention: DashboardRetention
}

export const DASHBOARD_KEY = ['admin-dashboard'] as const

/**
 * The whole page, for one period.
 *
 * Skipped without `core.stats.read`: the endpoint gates on it, and polling a 403
 * would be the only thing the page did.
 */
export function useDashboard(period: string) {
  const { can } = usePrivileges()
  const allowed = can(PRIV.STATS_READ)
  return useQuery({
    queryKey:  [...DASHBOARD_KEY, period],
    enabled:   allowed,
    queryFn:   () => api
      .get<DashboardData>('/admin/dashboard', { params: { period } })
      .then(r => r.data),
    staleTime: 60_000,
  })
}

export function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { message?: string; error?: string } } })?.response?.data
  return detail?.message ?? detail?.error ?? fallback
}
