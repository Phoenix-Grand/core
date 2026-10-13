import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../core/api/client'
import type { HealthCheck, HealthReport } from './types'
import { isFailing, SEVERITY_RANK } from './types'

/**
 * The instance health report.
 *
 * One shared cache entry: the landing card, the health page and the global
 * banner all read it, and three components asking the same question three times
 * per navigation is how a "free" banner becomes a request per page.
 *
 * Open to any administrator — the server narrows the report to what the caller
 * may read, so a delegate gets a shorter list rather than a 403 and a blank
 * page. Nothing here is gated client-side for the same reason.
 */
export const HEALTH_KEY = ['admin-health-checks'] as const

/**
 * `enabled` exists for the one caller that lives OUTSIDE the administration:
 * the top-bar indicator is mounted by the shell, which every signed-in account
 * renders. Without it, a regular user would fire an administration request on
 * every page load just to be told no.
 */
export function useHealthChecks(enabled = true) {
  return useQuery({
    enabled,
    queryKey: HEALTH_KEY,
    queryFn: () => api.get<HealthReport>('/admin/health-checks').then(r => r.data),
    // The server caches its evaluation for a minute; polling faster only costs
    // round trips. Refetching on focus is what catches "I fixed it in another
    // tab" without a poll at all.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  })
}

/** "Check everything again" — bypasses the server-side cache. */
export function useRefreshHealthChecks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.get<HealthReport>('/admin/health-checks', { params: { refresh: true } })
        .then(r => r.data),
    onSuccess: (report) => {
      // Seed the cache with the answer we already have rather than firing a
      // second request for it.
      qc.setQueryData(HEALTH_KEY, report)
    },
  })
}

/** Silence a finding, or put it back. Both are audited server-side. */
export function useMuteCheck() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, muted, reason }: { id: string; muted: boolean; reason?: string }) =>
      muted
        ? api.post(`/admin/health-checks/${encodeURIComponent(id)}/ignore`, { reason })
        : api.delete(`/admin/health-checks/${encodeURIComponent(id)}/ignore`),
    onSuccess: () => qc.invalidateQueries({ queryKey: HEALTH_KEY }),
  })
}

/**
 * The checks still to settle, worst first.
 *
 * Ignored and inapplicable checks are gone by construction: `isFailing` only
 * admits `todo` and `blocked`. That is what makes "ignore" actually remove a
 * line from the landing card instead of merely greying it.
 */
export function openTasks(checks: HealthCheck[] | undefined): HealthCheck[] {
  return (checks ?? [])
    .filter(c => isFailing(c.status))
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}
