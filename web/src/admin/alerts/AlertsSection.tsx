/**
 * Code-behind of `AlertsSection.kbview` (converted from `AlertsSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Ban, Check, Hand, Search, SlidersHorizontal, X } from "lucide-react"
import { Button, Input, useToast, type DataTableBulkAction, type DataTableColumn, type DataTableRowAction } from "@ui"
import { formatAgo, formatWhen } from "../sections/format"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { adminUrl, useAdminAction } from "../adminAction"
import type { AdminSectionProps } from "../sections/registry"
import { useAlertFacets, useAlerts, useAlertSummary, useAlertVerb, useAlertViews, useBulkAlerts, useDeleteAlertView, useSaveAlertView, useScanNow } from "./useAlerts"
import { alertSummary, alertTitle, severityLabel, skinOf, statusLabel } from "./labels"
import { EMPTY_FILTERS, type Alert, type AlertFilters, type AlertStatus } from "./types"

import { ViewBase } from './AlertsSection.kbview'
import * as __parts from './AlertsSection.parts'
import { FilterControls } from './AlertsSection.parts'

export type { AdminSectionProps }

export class AlertsSection extends ViewBase {
  @bind accessor selected: string[] = []
  @bind accessor sheet = false
  @bind accessor saving = false
  @bind accessor viewName = ''
  tr!: AlertsSectionStores['t']
  i18n!: AlertsSectionStores['i18n']
  can!: AlertsSectionStores['can']
  toast!: AlertsSectionStores['toast']
  filters!: AlertFilters
  setFilters!: AlertsSectionHooks['setFilters']
  draft!: AlertsSectionHooks['draft']
  setDraft!: AlertsSectionHooks['setDraft']
  summary!: AlertsSectionStores['summary']
  facets!: AlertsSectionStores['facets']
  views!: AlertsSectionStores['views']
  fetchNextPage!: AlertsSectionHooks['fetchNextPage']
  hasNextPage!: boolean
  isFetching!: boolean
  isLoading!: boolean
  isError!: boolean
  refetch!: AlertsSectionHooks['refetch']
  bulk!: AlertsSectionStores['bulk']
  verb!: AlertsSectionStores['verb']
  scan!: AlertsSectionStores['scan']
  saveView!: AlertsSectionStores['saveView']
  deleteView!: AlertsSectionStores['deleteView']
  rows!: Alert[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { can } = usePrivileges()
    const toast = useToast()
    const { data: summary }  = useAlertSummary()
    const { data: facets }   = useAlertFacets()
    const { data: views }    = useAlertViews()
    const bulk    = useBulkAlerts()
    const verb    = useAlertVerb()
    const scan    = useScanNow()
    const saveView   = useSaveAlertView()
    const deleteView = useDeleteAlertView()
    return { t, i18n, can, toast, summary, facets, views, bulk, verb, scan, saveView, deleteView }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [filters, setFilters] = useState<AlertFilters>(() => ({
      ...EMPTY_FILTERS,
      status:   this.props.params.get('status') ?? '',
      severity: this.props.params.get('severity') ?? '',
      kind:     this.props.params.get('kind') ?? '',
      assignee: this.props.params.get('assignee') ?? '',
      q:        this.props.params.get('q') ?? '',
    }))
    this.publish({ filters, setFilters })
    const [draft, setDraft]     = useState<string>(() => this.props.params.get('q') ?? '')
    this.publish({ draft, setDraft })
    const { data, fetchNextPage, hasNextPage, isFetching, isLoading, isError, refetch } =
      useAlerts(filters, !this.openId)
    this.publish({ fetchNextPage, hasNextPage, isFetching, isLoading, isError, refetch })
    useAdminAction('retry-jobs',   id => this.runVerb(id, 'retry-jobs'))
    useAdminAction('discard-jobs', id => this.runVerb(id, 'discard-jobs'))
    const rows = useMemo(() => (data?.pages ?? []).flatMap(p => p.alerts), [data])
    this.publish({ rows })
    return { filters, setFilters, draft, setDraft, data, fetchNextPage, hasNextPage, isFetching, isLoading, isError, refetch, rows }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, can: s.can, toast: s.toast, summary: s.summary, facets: s.facets, views: s.views, bulk: s.bulk, verb: s.verb, scan: s.scan, saveView: s.saveView, deleteView: s.deleteView })
    const h = this.useHooks()
    this.publish({ filters: h.filters, setFilters: h.setFilters, draft: h.draft, setDraft: h.setDraft, fetchNextPage: h.fetchNextPage, hasNextPage: h.hasNextPage, isFetching: h.isFetching, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch, rows: h.rows })
  }

  get canManage(): boolean {
    return this.can(PRIV.ALERTS_MANAGE)
  }

  get openId(): string | null {
    return this.props.params.get('alert')
  }

  get anyFilter(): boolean {
    return Object.values(this.filters).some(Boolean)
  }

  get columns(): DataTableColumn<Alert>[] {
    return this.memo('columns', [this.tr, this.i18n, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return [
    {
      id: 'title',
      header: this.tr('admin.al_col_alert'),
      primary: true,
      required: true,
      minWidth: 240,
      cell: (a) => {
        const skin = skinOf(a)
        return (
          <div className="flex min-w-0 items-start gap-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${skin.dot}`} aria-hidden />
            {/* Two lines rather than an ellipsis: on a phone the card title IS
                the row, and "Échecs de connexion répé…" identifies nothing.
                `whitespace-normal` is load-bearing - the card layout wraps the
                primary cell in `truncate`, whose `white-space: nowrap` would
                otherwise keep this on one line however it is clamped. */}
            <div className="min-w-0">
              <div className="line-clamp-2 whitespace-normal break-words text-text-primary">
                {alertTitle(this.tr, a)}
              </div>
              <div className="line-clamp-2 whitespace-normal break-words text-text-tertiary"
                style={{ fontSize: 'var(--kb-text-meta)' }}>
                {alertSummary(this.tr, a)}
              </div>
            </div>
          </div>
        )
      },
      sortValue: (a) => a.title,
    },
    {
      id: 'severity',
      header: this.tr('admin.al_col_severity'),
      width: 110,
      cell: (a) => (
        <span className={`inline-block rounded-full px-1.5 py-0.5 ${skinOf(a).chip}`}
          style={{ fontSize: 'var(--kb-text-micro)' }}>
          {severityLabel(this.tr, a.severity)}
        </span>
      ),
      sortValue: (a) => ({ critical: 0, warning: 1, info: 2 })[a.severity],
    },
    {
      id: 'status',
      header: this.tr('admin.al_col_status'),
      width: 110,
      cell: (a) => (
        <span className="text-text-secondary">{statusLabel(this.tr, a.status)}</span>
      ),
      sortValue: (a) => a.status,
    },
    {
      id: 'occurrences',
      header: this.tr('admin.al_col_occurrences'),
      width: 70,
      align: 'right',
      // The counter is the visible proof that the queue deduplicates: one row
      // saying "×212" instead of two hundred and twelve rows.
      cell: (a) => <span className="tabular-nums text-text-secondary">{a.occurrences}</span>,
      sortValue: (a) => a.occurrences,
    },
    {
      id: 'assignee',
      header: this.tr('admin.al_col_assignee'),
      width: 150,
      cell: (a) => <span className="truncate text-text-secondary">{a.assignee_label ?? '-'}</span>,
      sortValue: (a) => a.assignee_label ?? '',
    },
    {
      id: 'last_seen',
      header: this.tr('admin.al_col_last_seen'),
      width: 150,
      cell: (a) => (
        <span className="whitespace-nowrap text-text-secondary" title={formatWhen(a.last_seen_at, this.i18n.language)}>
          {formatAgo(a.last_seen_at)}
        </span>
      ),
      sortValue: (a) => new Date(a.last_seen_at),
    },
  ]
    })
  }

  get bulkActions(): DataTableBulkAction<Alert>[] {
    return this.memo('bulkActions', [this.canManage, this.tr, this.openId, this.bulk, this.selected, this.toast], () => {
      if (!(!(this.openId))) return undefined as never
      return this.canManage ? [
    { id: 'ack',     label: this.tr('admin.al_take'),    icon: <Hand size={15} />,  onClick: rs => this.move(rs.map(r => r.id), 'acknowledged') },
    { id: 'resolve', label: this.tr('admin.al_resolve'), icon: <Check size={15} />, onClick: rs => this.move(rs.map(r => r.id), 'resolved') },
    { id: 'ignore',  label: this.tr('admin.al_ignore'),  icon: <Ban size={15} />,   onClick: rs => this.move(rs.map(r => r.id), 'ignored') },
  ] : []
    })
  }

  get rowActions(): DataTableRowAction<Alert>[] {
    return this.memo('rowActions', [this.canManage, this.tr, this.openId, this.bulk, this.selected, this.toast], () => {
      if (!(!(this.openId))) return undefined as never
      return this.canManage ? [
    { id: 'ack',     label: this.tr('admin.al_take'),    icon: <Hand size={15} />,  onClick: r => this.move([r.id], 'acknowledged'), hidden: r => r.status === 'acknowledged' },
    { id: 'resolve', label: this.tr('admin.al_resolve'), icon: <Check size={15} />, onClick: r => this.move([r.id], 'resolved'),     hidden: r => r.status === 'resolved' },
    { id: 'ignore',  label: this.tr('admin.al_ignore'),  icon: <Ban size={15} />,   onClick: r => this.move([r.id], 'ignored'),      hidden: r => r.status === 'ignored' },
  ] : []
    })
  }

  get toolbar() {
    return this.memo('toolbar', [this.setFilters, this.draft, this.setDraft, this.tr, this.memo, this.facets, this.sheet, this.openId, this.filters], () => {
      if (!(!(this.openId))) return undefined as never
      const filters = this.filters
      const anyFilter = Object.values(filters).some(Boolean)
      return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <form className="flex items-center" onSubmit={e => { e.preventDefault(); this.set('q', this.draft) }}>
        <Input value={this.draft} onChange={e => this.setDraft(e.target.value)}
          placeholder={this.tr('admin.al_search_ph')} leftIcon={<Search size={15} />} className="w-52 pl-9" />
      </form>
      {/* The six selects would wrap into a four-line toolbar on a phone; below
          `sm` they live in a sheet behind one button instead. */}
      <div className="hidden flex-wrap items-center gap-2 sm:flex">
        <FilterControls filters={filters} set={this.memo("set:bound", [], () => this.set.bind(this))} facets={this.facets} stacked={false} />
      </div>
      <Button variant="secondary" size="sm" className="sm:hidden"
        icon={<SlidersHorizontal size={14} />} onClick={() => this.sheet = true}>
        {this.tr('admin.al_filters')}
      </Button>
      {anyFilter && (
        <Button variant="ghost" size="sm" icon={<X size={14} />}
          onClick={() => { this.setFilters(EMPTY_FILTERS); this.setDraft('') }}>
          {this.tr('admin.al_reset_filters')}
        </Button>
      )}
    </div>
  )
    })
  }

  get show_case_1() {
    return !!(this.openId)
  }

  /** `<AlertDetail Id>`: the id of the alert to open. */
  get alertDetailId() {
    if (!(this.openId)) return undefined as never
    return this.openId
  }

  /** `<AlertDetail OnBack>`: go back to the alerts list. */
  alert_detail_back(_sender: unknown, _e: EventArgs) {
    this.props.navigate(adminUrl({ tab: 'alerts' }))
  }

  get show_main() {
    return !(this.openId)
  }

  get show_summary() {
    return this.memo('show_summary', [this.summary, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return !!(this.summary)
    })
  }

  get al_counts_open() {
    if (!(!(this.openId)) || !(this.summary)) return undefined as never
    return this.summary.open
  }

  get al_counts_critical() {
    if (!(!(this.openId)) || !(this.summary)) return undefined as never
    return this.summary.critical
  }

  get al_counts_mine() {
    if (!(!(this.openId)) || !(this.summary)) return undefined as never
    return this.summary.mine
  }

  /** The rows of the Repeater over `(views ?? [])`. */
  get rows_items() {
    return this.memo('rows_items', [this.views, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return (this.views ?? []).map((v) => {
      return { v, key: v.id }
    })
    })
  }

  get show_not_saving() {
    if (!(!(this.openId))) return undefined as never
    return !(this.saving)
  }

  get enabled_unless_view_name_trim() {
    if (!(!(this.openId)) || !(this.saving)) return undefined as never
    return !(!this.viewName.trim())
  }

  get part1_props() {
    return this.memo('part1_props', [this.rows, this.columns, this.isLoading, this.isError, this.tr, this.refetch, this.anyFilter, this.setFilters, this.setDraft, this.toolbar, this.canManage, this.selected, this.memo, this.bulkActions, this.rowActions, this.props, this.summary, this.i18n, this.scan, this.toast, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return ({ rows: this.rows, columns: this.columns, isLoading: this.isLoading, isError: this.isError, t: this.tr, refetch: this.refetch, anyFilter: this.anyFilter, setFilters: this.setFilters, setDraft: this.setDraft, toolbar: this.toolbar, canManage: this.canManage, selected: this.selected, setSelected: this.memo("setSelected:bound", [], () => this.setSelected.bind(this)), bulkActions: this.bulkActions, rowActions: this.rowActions, navigate: this.props.navigate, summary: this.summary, summary_last_scan_at: this.summary?.last_scan_at, i18n: this.i18n, scan: this.scan, toast: this.toast })
    })
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, onRetry, filtered, onClearFilters, toolbar, selectedIds, onSelectionChange, bulkActions, rowActions, onRowClick, configurableColumns, t, emptyState: no .kbview property). */
  get Part1() {
    if (!(!(this.openId))) return undefined as never
    return __parts.Part1
  }

  get enabled_unless_is_fetching() {
    if (!(!(this.openId)) || !(this.hasNextPage)) return undefined as never
    return !(this.isFetching)
  }

  get button_text() {
    if (!(!(this.openId)) || !(this.hasNextPage)) return undefined as never
    return this.isFetching ? this.tr('common.loading') : this.tr('admin.al_load_more')
  }

  get part2_props() {
    return this.memo('part2_props', [this.sheet, this.memo, this.tr, this.filters, this.setFilters, this.facets, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return ({ sheet: this.sheet, setSheet: this.memo("setSheet:bound", [], () => this.setSheet.bind(this)), t: this.tr, filters: this.filters, set: this.memo("set:bound", [], () => this.set.bind(this)), facets: this.facets })
    })
  }

  /** A part of the screen still written in React (<MobileSheet> is no .kbview element (@ui#MobileSheet)). */
  get Part2() {
    if (!(!(this.openId))) return undefined as never
    return __parts.Part2
  }

  runVerb(id: string | null, v: 'retry-jobs' | 'discard-jobs') {
    if (!id) return
    this.verb.mutate({ id, verb: v }, {
      onSuccess: () => this.toast.success(this.tr(v === 'retry-jobs' ? 'admin.al_toast_retried' : 'admin.al_toast_discarded')),
      onError:   () => this.toast.error(this.tr('admin.al_toast_failed')),
    })
  }

  set<K extends keyof AlertFilters>(key: K, value: AlertFilters[K]) {
    return this.setFilters(f => ({ ...f, [key]: value }))
  }

  move(ids: string[], status: AlertStatus) {
    if (!(!(this.openId))) return undefined as never
    return this.bulk.mutate(
    { ids, status },
    {
      onSuccess: () => { this.selected = []; this.toast.success(this.tr('admin.al_toast_bulk', { count: ids.length })) },
      onError:   () => this.toast.error(this.tr('admin.al_toast_failed')),
    },
  )
  }

  applyView(name: string) {
    if (!(!(this.openId))) return undefined as never
    const view = (this.views ?? []).find(v => v.name === name)
    if (!view) return
    this.setFilters({ ...EMPTY_FILTERS, ...view.filters })
    this.setDraft(view.filters.q ?? '')
  }

  doSaveView() {
    if (!(!(this.openId))) return undefined as never
    const name = this.viewName.trim()
    if (!name) return
    this.saveView.mutate({ name, filters: this.filters as unknown as Record<string, string> }, {
      onSuccess: () => { this.saving = false; this.viewName = ''; this.toast.success(this.tr('admin.al_toast_view_saved')) },
      onError:   () => this.toast.error(this.tr('admin.al_toast_failed')),
    })
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.openId)) || !(this.canManage)) return undefined as never
    this.scan.mutate(undefined, {
                onSuccess: () => this.toast.success(this.tr('admin.al_toast_scanned')),
                onError:   () => this.toast.error(this.tr('admin.al_toast_failed')),
              })
  }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { v } = args.row as RowOf_rows_items
    if (!(!(this.openId))) return undefined as never
    this.applyView(v.name)
  }

  panel_click2(_sender: unknown, args: MouseEventArgs) {
    const { v } = args.row as RowOf_rows_items
    if (!(!(this.openId))) return undefined as never
    this.deleteView.mutate(v.id)
  }

  text_field_key_down(_sender: unknown, args: EventArgs) {
    if (!(!(this.openId)) || !(this.saving)) return undefined as never
    const e = args.native as React.KeyboardEvent<HTMLInputElement>
 if (e.key === 'Enter') this.doSaveView() }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.openId)) || !(this.saving)) return undefined as never
    this.saving = false
  }

  button_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.openId)) || !(!(this.saving))) return undefined as never
    this.saving = true
  }

  button_click4(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.openId)) || !(this.hasNextPage)) return undefined as never
    void this.fetchNextPage()
  }

  /** `setSelected` of the TSX: a value, or an update of the previous one. */
  setSelected(value: string[] | ((prev: string[]) => string[])) {
    this.selected = typeof value === 'function' ? (value as (prev: string[]) => string[])(this.selected) : value
  }

  /** `setSheet` of the TSX: a value, or an update of the previous one. */
  setSheet(value: AlertsSection['sheet'] | ((prev: AlertsSection['sheet']) => AlertsSection['sheet'])) {
    this.sheet = typeof value === 'function' ? (value as (prev: AlertsSection['sheet']) => AlertsSection['sheet'])(this.sheet) : value
  }

}

type RowOf_rows_items = AlertsSection['rows_items'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type AlertsSectionStores = ReturnType<AlertsSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AlertsSectionHooks = ReturnType<AlertsSection['useHooks']>

export default AlertsSection.component()
