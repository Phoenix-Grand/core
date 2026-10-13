/**
 * Code-behind of `AuditSection.kbview` (converted from `AuditSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { type DropdownOption } from "@ui"
import { api } from "../../core/api/client"
import { type AuditEntry } from "./auditTypes"
import type { AdminSectionProps } from "./registry"

import { ViewBase } from './AuditSection.kbview'
import * as __parts from './AuditSection.parts'

interface Facets {
  actions:      string[]
  target_types: string[]
  actors:       { id: string; label: string }[]
  outcomes:     string[]
}

interface Filters {
  q: string; action: string; target_type: string; outcome: string; actor_id: string
  from: string; to: string
}

const EMPTY_FILTERS: Filters = { q: '', action: '', target_type: '', outcome: '', actor_id: '', from: '', to: '' }

function toParams(f: Filters): Record<string, string> {
  const out: Record<string, string> = {}
  if (f.q)           out.q = f.q
  if (f.action)      out.action = f.action
  if (f.target_type) out.target_type = f.target_type
  if (f.outcome)     out.outcome = f.outcome
  if (f.actor_id)    out.actor_id = f.actor_id
  // <input type="date"> yields YYYY-MM-DD; the backend expects RFC 3339.
  if (f.from)        out.from = `${f.from}T00:00:00Z`
  if (f.to)          out.to = `${f.to}T23:59:59Z`
  return out
}

function filtersFromUrl(params: URLSearchParams): Filters {
  return {
    ...EMPTY_FILTERS,
    q:           params.get('q') ?? '',
    action:      params.get('audit_action') ?? '',
    actor_id:    params.get('audit_actor') ?? '',
    target_type: params.get('audit_target') ?? '',
  }
}

export type { AdminSectionProps }

export class AuditSection extends ViewBase {
  @bind accessor open: number | null = null
  tr!: AuditSectionStores['t']
  i18n!: AuditSectionStores['i18n']
  filters!: Filters
  setFilters!: AuditSectionHooks['setFilters']
  draft!: AuditSectionHooks['draft']
  setDraft!: AuditSectionHooks['setDraft']
  facets!: AuditSectionStores['facets']
  retention!: AuditSectionStores['retention']
  data!: AuditSectionHooks['data']
  fetchNextPage!: AuditSectionHooks['fetchNextPage']
  hasNextPage!: boolean
  isFetching!: boolean
  isLoading!: boolean
  rows!: AuditEntry[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { data: facets } = useQuery({
      queryKey: ['admin-audit-facets'],
      queryFn:  () => api.get<Facets>('/admin/audit/facets').then(r => r.data),
      staleTime: 60_000,
    })
    const { data: retention } = useQuery({
      queryKey: ['admin-audit-retention'],
      queryFn:  () => api.get<{ retention_days: number; min_days: number; entries: number }>('/admin/audit/retention').then(r => r.data),
      staleTime: 60_000,
    })
    return { t, i18n, facets, retention }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [filters, setFilters] = useState<Filters>(() => filtersFromUrl(this.props.params))
    this.publish({ filters, setFilters })
    const [draft, setDraft]     = useState<string>(() => this.props.params.get('q') ?? '')
    this.publish({ draft, setDraft })
    const { data, fetchNextPage, hasNextPage, isFetching, isLoading } = useInfiniteQuery({
      queryKey: ['admin-audit', filters],
      initialPageParam: '' as string,
      queryFn: ({ pageParam }) => api
        .get<{ entries: AuditEntry[]; next_cursor: string | null }>('/admin/audit', {
          params: { ...toParams(filters), limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
        })
        .then(r => r.data),
      getNextPageParam: (last) => last.next_cursor ?? undefined,
    })
    this.publish({ data, fetchNextPage, hasNextPage, isFetching, isLoading })
    const rows = useMemo(() => (data?.pages ?? []).flatMap(p => p.entries), [data])
    this.publish({ rows })
    return { filters, setFilters, draft, setDraft, data, fetchNextPage, hasNextPage, isFetching, isLoading, rows }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, facets: s.facets, retention: s.retention })
    const h = this.useHooks()
    this.publish({ filters: h.filters, setFilters: h.setFilters, draft: h.draft, setDraft: h.setDraft, data: h.data, fetchNextPage: h.fetchNextPage, hasNextPage: h.hasNextPage, isFetching: h.isFetching, isLoading: h.isLoading, rows: h.rows })
  }

  get anyFilter(): boolean {
    return Object.values(this.filters).some(Boolean)
  }

  get show_retention() {
    return this.memo('show_retention', [this.retention], () => !!(this.retention))
  }

  get span_text() {
    return this.memo('span_text', [this.tr, this.retention], () => {
      if (!(this.retention)) return undefined as never
      return "| " + this.tr('admin.audit_retention', { days: this.retention.retention_days, min: this.retention.min_days }) + String(' · ') + this.tr('admin.audit_entries_count', { count: this.retention.entries })
    })
  }

  get part1_props() {
    return this.memo('part1_props', [this.memo, this.filters, this.tr], () => ({ exportCsv: this.memo("exportCsv:bound", [], () => this.exportCsv.bind(this)), t: this.tr }))
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.draft, this.setDraft, this.tr], () => ({ draft: this.draft, setDraft: this.setDraft, t: this.tr }))
  }

  /** A part of the screen still written in React (<TextField LeftIcon>: an icon size the element cannot take). */
  get Part2() {
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.filters, this.memo, this.setFilters, this.facets, this.tr], () => ({ filters: this.filters, set: this.memo("set:bound", [], () => this.set.bind(this)), opt: this.memo("opt:bound", [], () => this.opt.bind(this)), facets: this.facets, t: this.tr }))
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part3() {
    return __parts.Part3
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part4() {
    return __parts.Part4
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part5() {
    return __parts.Part5
  }

  get part6_props() {
    return this.memo('part6_props', [this.filters, this.memo, this.setFilters, this.tr, this.facets], () => ({ filters: this.filters, set: this.memo("set:bound", [], () => this.set.bind(this)), t: this.tr, facets: this.facets }))
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part6() {
    return __parts.Part6
  }

  get part7_props() {
    return this.memo('part7_props', [this.tr, this.filters, this.memo, this.setFilters], () => ({ t: this.tr, filters: this.filters, set: this.memo("set:bound", [], () => this.set.bind(this)) }))
  }

  /** A part of the screen still written in React (<input> has no .kbview element yet). */
  get Part7() {
    return __parts.Part7
  }

  /** A part of the screen still written in React (<input> has no .kbview element yet). */
  get Part8() {
    return __parts.Part8
  }

  get part9_props() {
    return this.memo('part9_props', [this.tr, this.rows, this.isLoading, this.open, this.memo, this.i18n], () => ({ t: this.tr, rows: this.rows, isLoading: this.isLoading, open: this.open, setOpen: this.memo("setOpen:bound", [], () => this.setOpen.bind(this)), i18n: this.i18n }))
  }

  /** A part of the screen still written in React (<table> has no .kbview element yet). */
  get Part9() {
    return __parts.Part9
  }

  get enabled_unless_is_fetching() {
    if (!(this.hasNextPage)) return undefined as never
    return !(this.isFetching)
  }

  get button_text() {
    if (!(this.hasNextPage)) return undefined as never
    return this.isFetching ? this.tr('common.loading') : this.tr('admin.audit_load_more')
  }

  set<K extends keyof Filters>(key: K, value: Filters[K]) {
    return this.setFilters(f => ({ ...f, [key]: value }))
  }

  opt(values: string[], allLabel: string, label?: (v: string) => string): DropdownOption[] {
    return [
    { value: '', label: allLabel },
    ...values.map(v => ({ value: v, label: label ? label(v) : v })),
  ]
  }

  exportHref() {
    const params = new URLSearchParams(toParams(this.filters))
    return `/api/v1/admin/audit/export${params.toString() ? `?${params}` : ''}`
  }

  async exportCsv() {
    const res = await api.get(this.exportHref().replace('/api/v1', ''), { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kubuno-audit-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  panel_submit(_sender: unknown, args: EventArgs) {
    const e = args.native as SubmitEvent
 e.preventDefault(); this.set('q', this.draft) }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.anyFilter)) return undefined as never
 this.setFilters(EMPTY_FILTERS); this.setDraft('') }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.hasNextPage)) return undefined as never
    void this.fetchNextPage()
  }

  /** `setOpen` of the TSX: a value, or an update of the previous one. */
  setOpen(value: number | null | ((prev: number | null) => number | null)) {
    this.open = typeof value === 'function' ? (value as (prev: number | null) => number | null)(this.open) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AuditSectionStores = ReturnType<AuditSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AuditSectionHooks = ReturnType<AuditSection['useHooks']>

export default AuditSection.component()
