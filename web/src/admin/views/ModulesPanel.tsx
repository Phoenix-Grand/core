/**
 * Code-behind of `ModulesPanel.kbview` (converted from `ModulesPanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import { Package, Settings } from "lucide-react"
import { Badge, type DataTableColumn, type DataTableRowAction } from "@ui"
import MarketplacePanel from "./MarketplacePanel"
import { adminUrl, useAdminAction } from "../adminAction"
import type { AdminSectionProps } from "../sections/registry"
import { moduleGlyph } from "../nav/moduleGlyph"
import { useAdminModules, useModuleLiveState, useToggleModule, type AdminModule, type ModuleLiveState } from "../adminModules"
import { getPublicConfig } from "../../core/api/publicConfig"

import { ViewBase } from './ModulesPanel.kbview'
import * as __parts from './ModulesPanel.parts.tsx'
import { ServiceStatus } from './ModulesPanel.parts.tsx'

function useDefaultModule() {
  return useQuery({
    queryKey: ['public-config'],
    queryFn: getPublicConfig,
    staleTime: 60_000,
    select: (config) => {
      const v = config['navigation.default_module']
      return typeof v === 'string' && v.length > 0 ? v : null
    },
  })
}

const STATUS_RANK: Record<ModuleLiveState, number> = {
  unreachable: 0, disabled: 1, running: 2, unknown: 3,
}

export type { AdminSectionProps }

export class ModulesPanel extends ViewBase {
  @bind accessor errorMsg: string | null = null
  @bind accessor infoMsg: string | null = null
  @bind accessor showMarketplace = false
  @bind accessor query = ''
  tr!: ModulesPanelStores['t']
  queryClient!: ModulesPanelStores['queryClient']
  data!: ModulesPanelStores['data']
  isLoading!: boolean
  liveState!: (module: AdminModule) => ModuleLiveState
  defaultModulePath!: string | null | undefined
  setDefault!: ModulesPanelHooks['setDefault']
  toggle!: ModulesPanelStores['toggle']
  rows!: AdminModule[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { data, isLoading } = useAdminModules()
    const liveState = useModuleLiveState()
    const { data: defaultModulePath } = useDefaultModule()
    const toggle = useToggleModule()
    return { t, queryClient, data, isLoading, liveState, defaultModulePath, toggle }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const queryClient = this.queryClient
    const data = this.data
    useAdminAction('settings', (id) => {
      if (id) this.props.navigate(adminUrl({ tab: 'modules', params: { module: id } }), { replace: true })
    })
    const setDefault = useMutation({
      mutationFn: (path: string | null) =>
        api.patch('/admin/settings', { 'navigation.default_module': path }),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['public-config'] })
      },
      onError: (err) => {
        const msg = (err as { message?: string })?.message ?? String(err)
        this.errorMsg = msg
      },
    })
    this.publish({ setDefault })
    const rows = useMemo(() => {
      const all = [...(data ?? [])].sort((a, b) => a.display_name.localeCompare(b.display_name))
      const q = this.query.trim().toLowerCase()
      if (!q) return all
      return all.filter(m =>
        m.display_name.toLowerCase().includes(q)
        || (m.description ?? '').toLowerCase().includes(q)
        || m.id.toLowerCase().includes(q))
    }, [data, this.query])
    this.publish({ rows })
    return { setDefault, rows }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, queryClient: s.queryClient, data: s.data, isLoading: s.isLoading, liveState: s.liveState, defaultModulePath: s.defaultModulePath, toggle: s.toggle })
    const h = this.useHooks()
    this.publish({ setDefault: h.setDefault, rows: h.rows })
  }

  get columns(): DataTableColumn<AdminModule>[] {
    return this.memo('columns', [this.tr, this.defaultModulePath, this.liveState], () => [
    {
      id:         'app',
      header:     this.tr('admin.m_col_app'),
      headerText: this.tr('admin.m_col_app'),
      required:   true,
      primary:    true,
      minWidth:   260,
      sortValue:  m => m.display_name,
      cell: (m) => {
        const Glyph = moduleGlyph(m)
        const off   = !m.is_enabled
        return (
          <div className="flex min-w-0 items-center gap-3">
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg
                              bg-surface-2 ${off ? 'opacity-50' : ''}`}>
              {Glyph
                ? <Glyph size={18} className="text-text-secondary" />
                : <Package size={18} className="text-text-secondary" />}
            </span>
            {/* max-width caps the cell's min-content contribution: without it the
                no-wrap name and description widen the column past the card. */}
            <span className="min-w-0 max-w-[560px]">
              <span className="flex items-center gap-2">
                <span className={`truncate text-sm ${off ? 'text-text-tertiary' : 'text-text-primary'}`}>
                  {m.display_name}
                </span>
                <span className="shrink-0 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                  v{m.version}
                </span>
                {this.isDefault(m) && <Badge size="sm">{this.tr('admin.m_default')}</Badge>}
              </span>
              {m.description && (
                <span className="block truncate text-text-tertiary"
                      style={{ fontSize: 'var(--kb-text-meta)' }}>
                  {m.description}
                </span>
              )}
            </span>
          </div>
        )
      },
    },
    // Two columns, like the list this one is modelled on: what the service is,
    // and whether it is on. The version is not a column of its own — it is a
    // detail OF the service, and a third column would have pushed the one fact
    // the page exists for off to the side.
    {
      id:         'status',
      header:     this.tr('admin.m_col_status'),
      headerText: this.tr('admin.m_col_status'),
      // Narrow enough that the status text is never clipped by the card edge:
      // the app column absorbs the remaining width and truncates instead.
      minWidth:   150,
      width:      190,
      sortValue:  m => STATUS_RANK[this.liveState(m)],
      cell:       m => <ServiceStatus state={this.liveState(m)} />,
    },
  ])
  }

  get rowActions(): DataTableRowAction<AdminModule>[] {
    return this.memo('rowActions', [this.tr, this.memo, this.props, this.errorMsg, this.toggle, this.infoMsg, this.defaultModulePath, this.setDefault], () => [
    {
      id: 'manage', label: this.tr('admin.card_manage'), icon: <Settings size={15} />,
      onClick: this.memo("open:bound", [], () => this.open.bind(this)),
    },
    {
      id: 'enable', label: this.tr('admin.m_turn_on'),
      hidden:  m => m.is_enabled,
      onClick: m => this.flip(m.id, true),
    },
    {
      id: 'disable', label: this.tr('admin.m_turn_off'),
      hidden:  m => !m.is_enabled,
      onClick: m => this.flip(m.id, false),
    },
    {
      id: 'default', label: this.tr('admin.m_default_set'),
      // A switched-off service cannot be what the product opens on, and a
      // service that already is offers the opposite action instead.
      hidden:  m => !m.is_enabled || this.isDefault(m),
      onClick: m => this.setDefault.mutate(`/${m.id}`),
    },
    {
      id: 'undefault', label: this.tr('admin.m_default_unset'),
      hidden:  m => !this.isDefault(m),
      onClick: () => this.setDefault.mutate(null),
    },
  ])
  }

  get show_case_1() {
    return !!(this.showMarketplace)
  }

  /** `<MarketplacePanel>`, rendered by a ReactHost. */
  get MarketplacePanel() {
    if (!(this.showMarketplace)) return undefined as never
    return MarketplacePanel
  }

  get marketplace_panel_props() {
    return this.memo('marketplace_panel_props', [this.showMarketplace], () => {
      if (!(this.showMarketplace)) return undefined as never
      return ({ onBack: () => this.showMarketplace = false } as React.ComponentProps<typeof MarketplacePanel>)
    })
  }

  get show_main() {
    return !(this.showMarketplace)
  }

  get show_data() {
    return this.memo('show_data', [this.data, this.showMarketplace], () => {
      if (!(!(this.showMarketplace))) return undefined as never
      return !!(this.data)
    })
  }

  get m_count_count() {
    if (!(!(this.showMarketplace)) || !(this.data)) return undefined as never
    return this.data.length
  }

  get show_info_msg() {
    if (!(!(this.showMarketplace))) return undefined as never
    return !!(this.infoMsg)
  }

  get show_error_msg() {
    if (!(!(this.showMarketplace))) return undefined as never
    return !!(this.errorMsg)
  }

  get part1_props() {
    return this.memo('part1_props', [this.rows, this.columns, this.isLoading, this.query, this.memo, this.rowActions, this.props, this.tr, this.showMarketplace], () => {
      if (!(!(this.showMarketplace))) return undefined as never
      return ({ rows: this.rows, columns: this.columns, isLoading: this.isLoading, query: this.query, setQuery: this.memo("setQuery:bound", [], () => this.setQuery.bind(this)), rowActions: this.rowActions, open: this.memo("open:bound", [], () => this.open.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, filtered, onClearFilters, rowActions, onRowClick, defaultSort, t, toolbar: no .kbview property). */
  get Part1() {
    if (!(!(this.showMarketplace))) return undefined as never
    return __parts.Part1
  }

  flip(id: string, is_enabled: boolean) {
    this.errorMsg = null
    this.toggle.mutate({ id, is_enabled }, {
      onSuccess: (result) => {
        if (!result.is_enabled && result.also_disabled.length > 0) {
          this.infoMsg = this.tr('admin.m_cascade', { list: result.also_disabled.join(', ') })
        }
      },
      onError: (err) => {
        const msg = (err as { message?: string })?.message ?? String(err)
        this.errorMsg = msg
        console.error('[ModulesPanel] toggle failed:', err)
      },
    })
  }

  open(mod: AdminModule) {
    return this.props.navigate(adminUrl({ tab: 'modules', params: { module: mod.id } }))
  }

  isDefault(mod: AdminModule) {
    return this.defaultModulePath === `/${mod.id}`
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.showMarketplace))) return undefined as never
    this.showMarketplace = true
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.showMarketplace)) || !(this.infoMsg)) return undefined as never
    this.infoMsg = null
  }

  panel_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.showMarketplace)) || !(this.errorMsg)) return undefined as never
    this.errorMsg = null
  }

  /** `setQuery` of the TSX: a value, or an update of the previous one. */
  setQuery(value: ModulesPanel['query'] | ((prev: ModulesPanel['query']) => ModulesPanel['query'])) {
    this.query = typeof value === 'function' ? (value as (prev: ModulesPanel['query']) => ModulesPanel['query'])(this.query) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ModulesPanelStores = ReturnType<ModulesPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ModulesPanelHooks = ReturnType<ModulesPanel['useHooks']>

export default ModulesPanel.component()
