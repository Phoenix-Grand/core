// Data access of the rules console.
//
// One cache entry per question. The catalogue in particular is read by the list,
// the editor, the summary panel and the run log at once: four components asking
// the same thing four times per navigation is how a "free" lookup becomes a
// request per keystroke.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../core/api/client'
import type {
  BacktestRow, Catalog, ExecutionRow, Mode, Rule, RuleInput, RulesListResponse, VersionRow,
} from './types'

export const RULES_KEY   = ['admin-rules'] as const
export const CATALOG_KEY = ['admin-rules-catalog'] as const
export const EXEC_KEY    = ['admin-rules-executions'] as const

/**
 * The catalogue: every trigger, every action, the closed operator vocabulary,
 * the settable modes and the ceilings. Everything the editor offers is derived
 * from this — nothing is hard-coded in the frontend.
 */
export function useRuleCatalog(enabled = true) {
  return useQuery({
    queryKey: CATALOG_KEY,
    enabled,
    queryFn: () => api.get<Catalog>('/admin/rules/catalog').then(r => r.data),
    // A module registering adds entries; it does not do so mid-session often
    // enough to justify refetching on every mount.
    staleTime: 5 * 60_000,
  })
}

export function useRules(enabled = true) {
  return useQuery({
    queryKey: RULES_KEY,
    enabled,
    queryFn: () => api.get<RulesListResponse>('/admin/rules').then(r => r.data),
  })
}

export interface RuleDetail { rule: Rule; versions: VersionRow[]; backtests: BacktestRow[] }

export function useRule(id: string | null) {
  return useQuery({
    queryKey: [...RULES_KEY, 'detail', id],
    enabled: !!id,
    queryFn: () => api.get<RuleDetail>(`/admin/rules/${id}`).then(r => r.data),
  })
}

function useRuleMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: RULES_KEY })
      void qc.invalidateQueries({ queryKey: EXEC_KEY })
    },
  })
}

export function useCreateRule() {
  return useRuleMutation((input: RuleInput) =>
    api.post<{ rule: Rule }>('/admin/rules', input).then(r => r.data.rule))
}

export function useUpdateRule() {
  return useRuleMutation(({ id, input }: { id: string; input: RuleInput }) =>
    api.patch<{ rule: Rule }>(`/admin/rules/${id}`, input).then(r => r.data.rule))
}

/**
 * The one-click arm/disarm. Server-side it goes through the same validation and
 * the same versioning as a full edit, because "which version acted" must stay
 * answerable and the mode is part of what a version means.
 */
export function useSetRuleMode() {
  return useRuleMutation(({ id, mode, change_note }: { id: string; mode: Mode; change_note?: string }) =>
    api.post<{ rule: Rule }>(`/admin/rules/${id}/mode`, { mode, change_note }).then(r => r.data.rule))
}

export function useDeleteRule() {
  return useRuleMutation((id: string) => api.delete(`/admin/rules/${id}`))
}

// ── Run log ──────────────────────────────────────────────────────────────────

export interface ExecutionFilters {
  rule_id?: string
  mode?:    string
  outcome?: string
  limit?:   number
}

export function useExecutions(filters: ExecutionFilters, enabled = true) {
  return useQuery({
    queryKey: [...EXEC_KEY, filters],
    enabled,
    queryFn: () => api
      .get<{ executions: ExecutionRow[] }>('/admin/rules/executions', {
        params: {
          ...(filters.rule_id ? { rule_id: filters.rule_id } : {}),
          ...(filters.mode ? { mode: filters.mode } : {}),
          ...(filters.outcome ? { outcome: filters.outcome } : {}),
          limit: filters.limit ?? 100,
        },
      })
      .then(r => r.data.executions),
    // The engine writes rows continuously; a stale log reads as a broken engine.
    staleTime: 15_000,
  })
}

// ── Backtest ─────────────────────────────────────────────────────────────────

export function useStartBacktest() {
  return useMutation({
    mutationFn: ({ id, from, to }: { id: string; from?: string; to?: string }) =>
      api.post<{ backtest: BacktestRow }>(`/admin/rules/${id}/backtest`, { from, to })
        .then(r => r.data.backtest),
  })
}

/**
 * Polls one replay until it settles.
 *
 * The replay runs in the job queue, not in the request: a month of events cannot
 * hold an HTTP call open — or die with it. So the console asks again until the
 * row says `done` or `failed`, and stops.
 */
export function useBacktest(ruleId: string | null, backtestId: string | null) {
  return useQuery({
    queryKey: [...RULES_KEY, 'backtest', ruleId, backtestId],
    enabled: !!ruleId && !!backtestId,
    queryFn: () => api
      .get<{ backtest: BacktestRow }>(`/admin/rules/${ruleId}/backtest/${backtestId}`)
      .then(r => r.data.backtest),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'done' || status === 'failed' ? false : 1500
    },
  })
}

// ── Directory lookups, for the scope editor ──────────────────────────────────

export interface OrgUnitRow { id: string; name: string; parent_id: string | null }
export interface GroupRow   { id: string; name: string; member_count: number }
export interface UserRow    { id: string; username: string; email: string; display_name: string | null; org_unit_id: string | null }

/**
 * The directory the scope editor names things from.
 *
 * `retry: false` on purpose: an operator holding `core.rules.read` but not
 * `core.users.read` legitimately gets a 403 here, and the editor degrades to
 * showing raw identifiers rather than retrying a refusal three times.
 */
export function useOrgUnits(enabled = true) {
  return useQuery({
    queryKey: ['admin-org-units-lite'],
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () => api.get<{ org_units: OrgUnitRow[] }>('/admin/org-units').then(r => r.data.org_units),
  })
}

export function useGroupsLite(enabled = true) {
  return useQuery({
    queryKey: ['admin-groups-lite'],
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () => api.get<{ groups: GroupRow[] }>('/admin/groups').then(r => r.data.groups),
  })
}

/**
 * A page of accounts, used for the scope preview.
 *
 * Deliberately capped: the server offers no "count the accounts this scope
 * covers" endpoint, so the console computes over what it loaded and SAYS so
 * rather than presenting a partial count as a measurement.
 */
export function useUsersLite(enabled = true, limit = 200) {
  return useQuery({
    queryKey: ['admin-users-lite', limit],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: () => api
      .get<{ users: UserRow[]; total: number }>('/admin/users', { params: { limit } })
      .then(r => r.data),
  })
}

export function useGroupMembers(ids: string[], enabled = true) {
  const key = [...ids].sort().join(',')
  return useQuery({
    queryKey: ['admin-group-members', key],
    enabled: enabled && ids.length > 0,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const out: Record<string, string[]> = {}
      for (const id of ids) {
        const res = await api.get<{ members: { id: string }[] }>(`/admin/groups/${id}`)
        out[id] = (res.data.members ?? []).map(m => m.id)
      }
      return out
    },
  })
}
