/**
 * Code-behind of `NetworksSection.kbview` (converted from `NetworksSection.tsx` by @kubuno/views-migrate).
 */
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Search, X } from "lucide-react"
import { Button, Combobox, Input, useToast, type ComboboxOption, type DataTableColumn } from "@ui"
import { formatAgo, formatWhen } from "../sections/format"
import type { AdminSectionProps } from "../sections/registry"
import { useAdminSessions } from "../../core/devices/useDevices"
import { authStrengthLabel, clientKindLabel, sessionName } from "../../core/devices/labels"
import { EMPTY_SESSION_FILTERS, type DeviceSession, type SessionFilters } from "../../core/devices/types"

import { ViewBase } from './NetworksSection.kbview'
import * as __parts from './NetworksSection.parts'

export type { AdminSectionProps }

export class NetworksSection extends ViewBase {
  tr!: NetworksSectionStores['t']
  i18n!: NetworksSectionStores['i18n']
  toast!: NetworksSectionStores['toast']
  filters!: SessionFilters
  setFilters!: NetworksSectionHooks['setFilters']
  draft!: NetworksSectionHooks['draft']
  setDraft!: NetworksSectionHooks['setDraft']
  data!: NetworksSectionHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: NetworksSectionHooks['refetch']
  origins!: [string, number][]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const toast = useToast()
    return { t, i18n, toast }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [filters, setFilters] = useState<SessionFilters>(() => ({
      ...EMPTY_SESSION_FILTERS,
      q: this.props.params.get('q') ?? '',
    }))
    this.publish({ filters, setFilters })
    const [draft, setDraft] = useState<string>(() => this.props.params.get('q') ?? '')
    this.publish({ draft, setDraft })
    const { data, isLoading, isError, refetch } = useAdminSessions(filters)
    this.publish({ data, isLoading, isError, refetch })
    const origins = useMemo(() => {
      const counts = new Map<string, number>()
      for (const session of this.rows) {
        const key = session.country ?? ''
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])
    }, [this.rows])
    this.publish({ origins })
    return { filters, setFilters, draft, setDraft, data, isLoading, isError, refetch, origins }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, toast: s.toast })
    const h = this.useHooks()
    this.publish({ filters: h.filters, setFilters: h.setFilters, draft: h.draft, setDraft: h.setDraft, data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch, origins: h.origins })
  }

  get rows(): DeviceSession[] {
    return this.memo('rows', [this.data], () => this.data?.sessions ?? [])
  }

  get anyFilter(): boolean {
    return Object.values(this.filters).some(Boolean)
  }

  get clients(): ComboboxOption[] {
    return this.memo('clients', [this.tr], () => [
    { value: '', label: this.tr('devices.filter_all_clients') },
    { value: 'web', label: clientKindLabel(this.tr, 'web') },
    { value: 'native', label: clientKindLabel(this.tr, 'native') },
    { value: 'desktop', label: clientKindLabel(this.tr, 'desktop') },
    { value: 'api', label: clientKindLabel(this.tr, 'api') },
  ])
  }

  get twoFactor(): ComboboxOption[] {
    return this.memo('twoFactor', [this.tr], () => [
    { value: '', label: this.tr('devices.filter_all_sessions') },
    { value: 'true', label: this.tr('devices.filter_without_2fa') },
  ])
  }

  get columns(): DataTableColumn<DeviceSession>[] {
    return this.memo('columns', [this.tr, this.i18n], () => [
    {
      id: 'account',
      header: this.tr('devices.col_account'),
      primary: true,
      required: true,
      minWidth: 180,
      cell: (s) => (
        <div className="min-w-0">
          <div className="truncate text-text-primary">{s.user_label ?? '—'}</div>
          <div className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {sessionName(this.tr, s)}
          </div>
        </div>
      ),
      sortValue: (s) => s.user_label ?? '',
    },
    {
      id: 'ip',
      header: this.tr('devices.field_last_ip'),
      width: 160,
      cell: (s) => <span className="truncate text-text-secondary">{s.ip_address ?? '—'}</span>,
      sortValue: (s) => s.ip_address ?? '',
    },
    {
      id: 'country',
      header: this.tr('devices.col_country'),
      width: 90,
      cell: (s) => <span className="text-text-secondary">{s.country ?? '—'}</span>,
      sortValue: (s) => s.country ?? '',
    },
    {
      id: 'client',
      header: this.tr('devices.field_client'),
      width: 120,
      cell: (s) => <span className="text-text-secondary">{clientKindLabel(this.tr, s.client_type)}</span>,
      sortValue: (s) => s.client_type ?? '',
    },
    {
      id: 'auth',
      header: this.tr('devices.col_auth'),
      width: 150,
      cell: (s) => <span className="text-text-secondary">{authStrengthLabel(this.tr, s.auth_strength)}</span>,
      sortValue: (s) => s.auth_strength ?? '',
    },
    {
      id: 'last_used',
      header: this.tr('devices.col_last_seen'),
      width: 150,
      cell: (s) => (
        <span className="whitespace-nowrap text-text-secondary" title={formatWhen(s.last_used_at, this.i18n.language)}>
          {formatAgo(s.last_used_at)}
        </span>
      ),
      sortValue: (s) => new Date(s.last_used_at),
    },
  ])
  }

  get toolbar() {
    return this.memo('toolbar', [this.setFilters, this.draft, this.setDraft, this.tr, this.clients, this.twoFactor, this.filters], () => {
      const filters = this.filters
      const anyFilter = Object.values(filters).some(Boolean)
      return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <form className="flex items-center" onSubmit={e => { e.preventDefault(); this.set('q', this.draft) }}>
        <Input value={this.draft} onChange={e => this.setDraft(e.target.value)}
          placeholder={this.tr('devices.sessions_search_ph')} leftIcon={<Search size={15} />} className="w-52 pl-9" />
      </form>
      <Combobox value={filters.client_type} onChange={v => this.set('client_type', v)} options={this.clients}
        width={150} aria-label={this.tr('devices.field_client')} />
      <Combobox value={filters.without_2fa} onChange={v => this.set('without_2fa', v)} options={this.twoFactor}
        width={220} aria-label={this.tr('devices.col_auth')} />
      {anyFilter && (
        <Button variant="ghost" size="sm" icon={<X size={14} />}
          onClick={() => { this.setFilters(EMPTY_SESSION_FILTERS); this.setDraft('') }}>
          {this.tr('devices.reset_filters')}
        </Button>
      )}
    </div>
  )
    })
  }

  get show_data() {
    return this.memo('show_data', [this.data], () => !!(this.data))
  }

  get sessions_count_count() {
    if (!(this.data)) return undefined as never
    return this.data.total
  }

  get show_origins() {
    return this.origins.length > 0
  }

  get part1_props() {
    return this.memo('part1_props', [this.origins, this.memo, this.setFilters, this.tr], () => {
      if (!(this.origins.length > 0)) return undefined as never
      return ({ origins: this.origins, set: this.memo("set:bound", [], () => this.set.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (a list callback destructuring its item). */
  get Part1() {
    if (!(this.origins.length > 0)) return undefined as never
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.rows, this.columns, this.isLoading, this.isError, this.tr, this.refetch, this.anyFilter, this.setFilters, this.setDraft, this.toolbar, this.toast], () => ({ rows: this.rows, columns: this.columns, isLoading: this.isLoading, isError: this.isError, t: this.tr, refetch: this.refetch, anyFilter: this.anyFilter, setFilters: this.setFilters, setDraft: this.setDraft, toolbar: this.toolbar, toast: this.toast }))
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, onRetry, filtered, onClearFilters, toolbar, configurableColumns, t, emptyState: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  set<K extends keyof SessionFilters>(key: K, value: SessionFilters[K]) {
    return this.setFilters(f => ({ ...f, [key]: value }))
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type NetworksSectionStores = ReturnType<NetworksSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type NetworksSectionHooks = ReturnType<NetworksSection['useHooks']>

export default NetworksSection.component()
