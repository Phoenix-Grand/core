/**
 * Code-behind of `EventLogSection.kbview` (converted from `EventLogSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useInfiniteQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight } from "lucide-react"
import { type ComboboxOption, type DataTableColumn } from "@ui"
import { api } from "../../core/api/client"
import { formatWhen } from "./format"

import { ViewBase } from './EventLogSection.kbview'
import * as __parts from './EventLogSection.parts'

const PAGE = 50

interface EventRow {
  id:            number
  event_type:    string
  source_module: string | null
  payload:       Record<string, unknown>
  created_at:    string
}

interface EventPage { events: EventRow[]; limit: number; offset: number }

function inner(e: EventRow): Record<string, unknown> | null {
  const p = e.payload?.payload
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
}

function subType(e: EventRow): string | null {
  const v = inner(e)?.event_type
  return typeof v === 'string' && v !== e.event_type ? v : null
}

function sourceModule(e: EventRow): string | null {
  if (e.source_module) return e.source_module
  const v = inner(e)?.module_id
  return typeof v === 'string' && v ? v : null
}

function preview(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
  return json.length > 120 ? `${json.slice(0, 120)}…` : json
}

export class EventLogSection extends ViewBase {
  @bind accessor type = ''
  @bind accessor open: number | null = null
  tr!: EventLogSectionStores['t']
  i18n!: EventLogSectionStores['i18n']
  fetchNextPage!: EventLogSectionHooks['fetchNextPage']
  hasNextPage!: boolean
  isFetching!: boolean
  isLoading!: boolean
  isError!: boolean
  refetch!: EventLogSectionHooks['refetch']
  rows!: EventRow[]
  typeOptions!: ComboboxOption[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    return { t, i18n }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const { data, fetchNextPage, hasNextPage, isFetching, isLoading, isError, refetch } = useInfiniteQuery({
      queryKey: ['admin-event-log', this.type],
      initialPageParam: 0,
      queryFn: ({ pageParam }) => api
        .get<EventPage>('/admin/event-log', {
          params: { limit: PAGE, offset: pageParam, ...(this.type ? { event_type: this.type } : {}) },
        })
        .then(r => r.data),
      // No total and no cursor: a short page is the only end-of-list signal.
      getNextPageParam: (last, all) =>
        last.events.length < PAGE ? undefined : all.length * PAGE,
    })
    this.publish({ fetchNextPage, hasNextPage, isFetching, isLoading, isError, refetch })
    const rows = useMemo(() => (data?.pages ?? []).flatMap(p => p.events), [data])
    this.publish({ rows })
    const typeOptions: ComboboxOption[] = useMemo(() => {
      const seen = new Map<string, number>()
      for (const e of rows) seen.set(e.event_type, (seen.get(e.event_type) ?? 0) + 1)
      const options: ComboboxOption[] = [...seen.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, label: value, description: t('admin.el_type_count', { total: count }) }))
      // Keep the active filter selectable even once its rows scrolled out.
      if (this.type && !seen.has(this.type)) options.unshift({ value: this.type, label: this.type })
      return [{ value: '', label: t('admin.el_filter_all_types') }, ...options]
    }, [rows, this.type, t])
    this.publish({ typeOptions })
    return { data, fetchNextPage, hasNextPage, isFetching, isLoading, isError, refetch, rows, typeOptions }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n })
    const h = this.useHooks()
    this.publish({ fetchNextPage: h.fetchNextPage, hasNextPage: h.hasNextPage, isFetching: h.isFetching, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch, rows: h.rows, typeOptions: h.typeOptions })
  }

  get columns(): DataTableColumn<EventRow>[] {
    return this.memo('columns', [this.tr, this.i18n, this.open], () => {
      const open = this.open
      return [
    {
      id: 'when',
      header: this.tr('admin.audit_col_when'),
      headerText: this.tr('admin.audit_col_when'),
      minWidth: 170,
      sortValue: e => new Date(e.created_at),
      cell: e => (
        <span className="whitespace-nowrap tabular-nums text-text-secondary">
          {formatWhen(e.created_at, this.i18n.language)}
        </span>
      ),
    },
    {
      id: 'type',
      header: this.tr('admin.el_col_type'),
      headerText: this.tr('admin.el_col_type'),
      primary: true,
      minWidth: 200,
      sortValue: e => e.event_type,
      cell: (e) => {
        const sub = subType(e)
        return (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-text-primary">{e.event_type}</span>
            {sub && (
              <span className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {sub}
              </span>
            )}
          </span>
        )
      },
    },
    {
      id: 'module',
      header: this.tr('admin.el_col_module'),
      headerText: this.tr('admin.el_col_module'),
      minWidth: 130,
      sortValue: e => sourceModule(e) ?? '',
      cell: (e) => {
        const mod = sourceModule(e)
        if (!mod) return <span className="text-text-tertiary">—</span>
        return (
          <span className="flex items-center gap-1.5">
            <span className="truncate text-text-primary">{mod}</span>
            {e.source_module == null && (
              // The column is NULL in the database for every row the core
              // writes; the module is then read back out of the payload.
              <span
                className="rounded-full bg-surface-2 px-1.5 py-0.5 text-text-tertiary"
                style={{ fontSize: 'var(--kb-text-micro)' }}
                title={this.tr('admin.el_module_derived')}
              >
                {this.tr('admin.el_module_derived_short')}
              </span>
            )}
          </span>
        )
      },
    },
    {
      id: 'payload',
      header: this.tr('admin.el_col_payload'),
      headerText: this.tr('admin.el_col_payload'),
      minWidth: 280,
      cell: (e) => {
        const expanded = open === e.id
        const json = JSON.stringify(e.payload, null, 2)
        return (
          // Hard width cap: a table cell is sized by its content, so an
          // unbounded <pre> would widen the whole table and make expanding a
          // payload scroll the columns out of view.
          <div className="min-w-0" style={{ maxWidth: 420 }}>
            <button
              type="button"
              onClick={() => this.open = expanded ? null : e.id}
              aria-expanded={expanded}
              className="flex w-full min-w-0 items-center gap-1 rounded-sm text-left text-text-secondary
                         transition-colors hover:text-text-primary
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              style={{ fontSize: 'var(--kb-text-meta)' }}
            >
              {expanded ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
              <span className="min-w-0 truncate font-mono">
                {expanded ? this.tr('admin.el_collapse') : preview(e.payload)}
              </span>
            </button>
            {expanded && (
              <pre className="mt-1.5 max-h-72 overflow-auto rounded-md border border-border bg-surface-1 p-2
                              font-mono text-text-primary"
                   style={{ fontSize: 'var(--kb-text-meta)' }}>
                {json}
              </pre>
            )}
          </div>
        )
      },
    },
  ]
    })
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.type, this.memo, this.typeOptions], () => ({ t: this.tr, type: this.type, setType: this.memo("setType:bound", [], () => this.setType.bind(this)), typeOptions: this.typeOptions }))
  }

  /** A part of the screen still written in React (<ComboBox> width, searchPlaceholder: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.rows, this.columns, this.isLoading, this.isError, this.refetch, this.type, this.memo], () => ({ t: this.tr, rows: this.rows, columns: this.columns, isLoading: this.isLoading, isError: this.isError, refetch: this.refetch, type: this.type, setType: this.memo("setType:bound", [], () => this.setType.bind(this)) }))
  }

  /** A part of the screen still written in React (<DataTable> t, columns, rowKey, skeletonRows, onRetry, filtered, onClearFilters, manualSort, configurableColumns, minTableWidth, emptyState: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  get enabled_unless_is_fetching() {
    if (!(this.hasNextPage)) return undefined as never
    return !(this.isFetching)
  }

  get button_text() {
    if (!(this.hasNextPage)) return undefined as never
    return this.isFetching ? this.tr('common.loading') : this.tr('admin.el_load_more')
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.hasNextPage)) return undefined as never
    void this.fetchNextPage()
  }

  /** `setType` of the TSX: a value, or an update of the previous one. */
  setType(value: EventLogSection['type'] | ((prev: EventLogSection['type']) => EventLogSection['type'])) {
    this.type = typeof value === 'function' ? (value as (prev: EventLogSection['type']) => EventLogSection['type'])(this.type) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type EventLogSectionStores = ReturnType<EventLogSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type EventLogSectionHooks = ReturnType<EventLogSection['useHooks']>

export default EventLogSection.component()
