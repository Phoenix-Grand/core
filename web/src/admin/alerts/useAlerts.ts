import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../core/api/client'
import type {
  Alert, AlertEvent, AlertFacets, AlertFilters, AlertStatus, AlertSummary, AlertView,
} from './types'
import { toParams } from './types'

/**
 * Data access of the alert centre.
 *
 * One shared cache entry per question: the queue, the summary, the facets and a
 * detail. The summary in particular is read by three surfaces at once (the
 * bell, the landing card, the queue header) — three components asking the same
 * thing three times per navigation is how a "free" badge becomes a request per
 * page.
 */

export const ALERTS_KEY  = ['admin-alerts'] as const
export const SUMMARY_KEY = ['admin-alerts-summary'] as const
export const FACETS_KEY  = ['admin-alerts-facets'] as const
export const VIEWS_KEY   = ['admin-alerts-views'] as const

export interface AlertPage { alerts: Alert[]; next_cursor: string | null }

/** One page of the queue, cursor-paginated (never offset: the queue moves). */
export function useAlerts(filters: AlertFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...ALERTS_KEY, filters],
    initialPageParam: '' as string,
    enabled,
    queryFn: ({ pageParam }) => api
      .get<AlertPage>('/admin/alerts', {
        params: { ...toParams(filters), limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
      })
      .then(r => r.data),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })
}

/**
 * The counters behind every badge.
 *
 * `enabled` exists because the bell is rendered for every signed-in user, and
 * only an operator holding `core.alerts.read` may ask: firing a 403 per page
 * load for everybody else is exactly the pattern this codebase already removed
 * once from the privileges resolution.
 */
export function useAlertSummary(enabled = true) {
  return useQuery({
    queryKey: SUMMARY_KEY,
    enabled,
    queryFn: () => api.get<AlertSummary>('/admin/alerts/summary').then(r => r.data),
    // The producers run every few minutes; polling faster only costs round
    // trips. Refetching on focus is what catches "somebody else took it".
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  })
}

export function useAlertFacets(enabled = true) {
  return useQuery({
    queryKey: FACETS_KEY,
    enabled,
    queryFn: () => api.get<AlertFacets>('/admin/alerts/facets').then(r => r.data),
    staleTime: 5 * 60_000,
  })
}

export interface AlertDetail { alert: Alert; timeline: AlertEvent[]; related: Alert[] }

export function useAlert(id: string | null) {
  return useQuery({
    queryKey: [...ALERTS_KEY, 'detail', id],
    enabled: !!id,
    queryFn: () => api.get<AlertDetail>(`/admin/alerts/${id}`).then(r => r.data),
  })
}

/** Everything that changes an alert invalidates the queue AND the counters. */
function useAlertMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ALERTS_KEY })
      void qc.invalidateQueries({ queryKey: SUMMARY_KEY })
    },
  })
}

export function useSetAlertStatus() {
  return useAlertMutation(({ id, status, comment }: { id: string; status: AlertStatus; comment?: string }) =>
    api.post(`/admin/alerts/${id}/status`, { status, comment }))
}

export function useAssignAlert() {
  return useAlertMutation(({ id, assignee_id }: { id: string; assignee_id: string | null }) =>
    api.post(`/admin/alerts/${id}/assign`, { assignee_id }))
}

export function useCommentAlert() {
  return useAlertMutation(({ id, comment }: { id: string; comment: string }) =>
    api.post(`/admin/alerts/${id}/comment`, { comment }))
}

export function useBulkAlerts() {
  return useAlertMutation((body: { ids: string[]; status?: AlertStatus; assign?: boolean; assignee_id?: string | null }) =>
    api.post('/admin/alerts/bulk', body))
}

/** The two verbs the alert centre performs itself (dead-lettered jobs). */
export function useAlertVerb() {
  return useAlertMutation(({ id, verb }: { id: string; verb: 'retry-jobs' | 'discard-jobs' }) =>
    api.post(`/admin/alerts/${id}/${verb}`))
}

/** "I just fixed it, check again" — the same code path as the scheduled scan. */
export function useScanNow() {
  return useAlertMutation(() => api.post('/admin/alerts/scan'))
}

// ── Saved filter sets ────────────────────────────────────────────────────────

export function useAlertViews(enabled = true) {
  return useQuery({
    queryKey: VIEWS_KEY,
    enabled,
    queryFn: () => api.get<{ views: AlertView[] }>('/admin/alerts/views').then(r => r.data.views),
    staleTime: 5 * 60_000,
  })
}

export function useSaveAlertView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; filters: Record<string, string> }) =>
      api.post<AlertView>('/admin/alerts/views', body).then(r => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: VIEWS_KEY }),
  })
}

export function useDeleteAlertView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/alerts/views/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: VIEWS_KEY }),
  })
}
