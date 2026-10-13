/**
 * Code-behind of `DashboardSection.kbview` (converted from `DashboardSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Package, Users, Wifi } from "lucide-react"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { Slot } from "../../core/slots/SlotRegistry"
import { useAdminModules } from "../adminModules"
import { reportUrl } from "../panels/report"
import { applyLayout, usePanelLayout } from "../panels/usePanelLayout"
import type { DashboardPanel } from "../panels/types"
import { useAdminStats } from "./adminStats"
import { errorMessage, useDashboard } from "./dashboard/api"
import { DEFAULT_ORDER, panelDef } from "./dashboard/panels"
import type { AdminSectionProps } from "./registry"

import { ViewBase } from './DashboardSection.kbview'
import * as __parts from './DashboardSection.parts'

const LAYOUT_KEYS = {
  pref:         'dashboard_panels',
  cache:        'kubuno-admin-dashboard',
  defaultOrder: DEFAULT_ORDER,
}

export type { AdminSectionProps }

export class DashboardSection extends ViewBase {
  @bind accessor period = 'last_30_days'
  @bind accessor editing = false
  tr!: DashboardSectionStores['t']
  i18n!: DashboardSectionStores['i18n']
  can!: DashboardSectionStores['can']
  stats!: DashboardSectionStores['stats']
  statsLoading!: boolean
  data!: DashboardSectionHooks['data']
  isLoading!: boolean
  isError!: boolean
  error!: Error | null
  layout!: DashboardSectionStores['layout']
  hide!: (id: string, visible: string[]) => void
  show!: (id: string, visible: string[]) => void
  move!: (id: string, delta: -1 | 1, visible: string[]) => void
  reset!: () => void
  moduleName!: (id: string) => string
  received!: Map<string, DashboardPanel>
  visible!: string[]
  hiddenAvailable!: string[]
  periodOptions!: { value: string; label: string; }[]
  openReport!: (id: string) => void

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { can } = usePrivileges()
    const { data: stats, isLoading: statsLoading } = useAdminStats()
    const { layout, hide, show, move, reset } = usePanelLayout(LAYOUT_KEYS)
    return { t, i18n, can, stats, statsLoading, layout, hide, show, move, reset }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const layout = this.layout
    const { data, isLoading, isError, error } = useDashboard(this.period)
    this.publish({ data, isLoading, isError, error })
    const { data: modules } = useAdminModules()
    const moduleName = useCallback(
      (id: string) => modules?.find(m => m.id === id)?.display_name ?? id,
      [modules],
    )
    this.publish({ moduleName })
    const received = useMemo(() => {
      const map = new Map<string, DashboardPanel>()
      for (const p of data?.panels ?? []) if (panelDef(p.id)) map.set(p.id, p)
      return map
    }, [data])
    this.publish({ received })
    const visible = useMemo(
      () => applyLayout([...received.keys()], layout),
      [received, layout],
    )
    this.publish({ visible })
    const hiddenAvailable = useMemo(
      () => [...received.keys()].filter(id => !visible.includes(id)),
      [received, visible],
    )
    this.publish({ hiddenAvailable })
    const periodOptions = useMemo(
      () => (data?.periods ?? [this.period]).map(id => ({
        value: id, label: t(`admin.sec_period_${id}`, { defaultValue: id }),
      })),
      [data?.periods, this.period, t],
    )
    this.publish({ periodOptions })
    const openReport = useCallback((id: string) => {
      if (!panelDef(id)) return
      this.props.navigate(reportUrl('dashboard', id, this.period))
    }, [this.props.navigate, this.period])
    this.publish({ openReport })
    return { data, isLoading, isError, error, modules, moduleName, received, visible, hiddenAvailable, periodOptions, openReport }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, can: s.can, stats: s.stats, statsLoading: s.statsLoading, layout: s.layout, hide: s.hide, show: s.show, move: s.move, reset: s.reset })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, error: h.error, moduleName: h.moduleName, received: h.received, visible: h.visible, hiddenAvailable: h.hiddenAvailable, periodOptions: h.periodOptions, openReport: h.openReport })
  }

  get total(): number {
    return this.stats?.users_total ?? 0
  }

  get activePct(): number {
    return this.total > 0 ? Math.round(((this.stats?.users_active ?? 0) / this.total) * 100) : 0
  }

  get healthy(): number {
    return this.stats?.modules_by_status?.find(s => s.key === 'healthy')?.count ?? this.stats?.modules_active ?? 0
  }

  get modTotal(): number {
    return (this.stats?.modules_by_status ?? []).reduce((s, x) => s + x.count, 0) || (this.stats?.modules_active ?? 0)
  }

  get bucket() {
    if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
    return this.data?.period.bucket ?? 'day'
  }

  get withheldCount(): number {
    if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
    return this.data?.withheld.length ?? 0
  }

  get show_case_1() {
    return !!(!this.can(PRIV.STATS_READ))
  }

  get show_main() {
    return !(!this.can(PRIV.STATS_READ))
  }

  /** `<StatCard>`, rendered by a ReactHost. */
  get StatCard() {
    if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
    return __parts.StatCard
  }

  get stat_card_props() {
    return this.memo('stat_card_props', [this.tr, this.statsLoading, this.i18n, this.stats, this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
      return ({ label: this.tr('admin.card_users_total'), value: this.n(this.stats?.users_total), icon: Users, tone: "var(--kb-chart-1)", accent: this.tr('admin.sub_new_week', { count: this.stats?.new_users_7d ?? 0 }) })
    })
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.memo, this.statsLoading, this.i18n, this.stats, this.activePct, this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
      return ({ t: this.tr, n: this.memo("n:bound", [], () => this.n.bind(this)), stats: this.stats, activePct: this.activePct })
    })
  }

  /** A part of the screen still written in React (<StatCard> is no .kbview element (a local or dynamic component)). */
  get Part1() {
    if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
    return __parts.Part1
  }

  get stat_card_props2() {
    return this.memo('stat_card_props2', [this.tr, this.statsLoading, this.i18n, this.stats, this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
      return ({ label: this.tr('admin.card_users_online'), value: this.n(this.stats?.users_online), icon: Wifi, tone: "var(--kb-chart-6)", accent: this.tr('admin.sub_n_sessions', { count: this.stats?.sessions_active ?? 0 }) })
    })
  }

  get stat_card_props3() {
    return this.memo('stat_card_props3', [this.tr, this.statsLoading, this.i18n, this.healthy, this.modTotal, this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
      return ({ label: this.tr('admin.card_modules_active'), value: this.n(this.healthy), icon: Package, tone: "var(--kb-chart-5)", accent: this.tr('admin.sub_healthy_total', { healthy: this.healthy, total: this.modTotal }) })
    })
  }

  get part2_props() {
    return this.memo('part2_props', [this.period, this.memo, this.periodOptions, this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
      return ({ period: this.period, setPeriod: this.memo("setPeriod:bound", [], () => this.setPeriod.bind(this)), periodOptions: this.periodOptions })
    })
  }

  /** A part of the screen still written in React (<Dropdown> width, focusable: no .kbview property). */
  get Part2() {
    if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.editing, this.memo, this.tr, this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
      return ({ editing: this.editing, setEditing: this.memo("setEditing:bound", [], () => this.setEditing.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button Icon>: an icon that is not a Lucide icon). */
  get Part3() {
    if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
    return __parts.Part3
  }

  get callout_text() {
    if (!(!(!this.can(PRIV.STATS_READ))) || !(this.isError)) return undefined as never
    return errorMessage(this.error, this.tr('admin.stats_error'))
  }

  get show_data() {
    return this.memo('show_data', [this.data, this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
      return !!(this.data)
    })
  }

  /** `<ReachNotice>`, rendered by a ReactHost. */
  get ReachNotice() {
    if (!(!(!this.can(PRIV.STATS_READ))) || !(this.data)) return undefined as never
    return __parts.ReachNotice
  }

  get reach_notice_props() {
    return this.memo('reach_notice_props', [this.data, this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ))) || !(this.data)) return undefined as never
      return ({ periodId: this.data.period.id, retention: this.data.retention })
    })
  }

  get show_data_visible() {
    if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
    return !!(this.data && this.visible.length > 0)
  }

  get part4_props() {
    return this.memo('part4_props', [this.visible, this.received, this.bucket, this.editing, this.hide, this.move, this.openReport, this.moduleName, this.can, this.data], () => {
      if (!(!(!this.can(PRIV.STATS_READ))) || !(this.data && this.visible.length > 0)) return undefined as never
      return ({ visible: this.visible, received: this.received, bucket: this.bucket, editing: this.editing, hide: this.hide, move: this.move, openReport: this.openReport, moduleName: this.moduleName })
    })
  }

  /** A part of the screen still written in React (a list whose item is not a single element). */
  get Part4() {
    if (!(!(!this.can(PRIV.STATS_READ))) || !(this.data && this.visible.length > 0)) return undefined as never
    return __parts.Part4
  }

  get show_data_visible2() {
    if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
    return !!(this.data && this.visible.length === 0)
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr, this.reset, this.can, this.data, this.visible], () => {
      if (!(!(!this.can(PRIV.STATS_READ))) || !(this.data && this.visible.length === 0)) return undefined as never
      return ({ t: this.tr, reset: this.reset })
    })
  }

  /** A part of the screen still written in React (<EmptyState> action.variant: no .kbview property). */
  get Part5() {
    if (!(!(!this.can(PRIV.STATS_READ))) || !(this.data && this.visible.length === 0)) return undefined as never
    return __parts.Part5
  }

  get show_editing_data() {
    return this.memo('show_editing_data', [this.editing, this.data, this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
      return !!(this.editing && this.data)
    })
  }

  get show_hidden_available() {
    if (!(!(!this.can(PRIV.STATS_READ))) || !(this.editing && this.data)) return undefined as never
    return this.hiddenAvailable.length === 0
  }

  get show_not_hidden_available() {
    if (!(!(!this.can(PRIV.STATS_READ))) || !(this.editing && this.data)) return undefined as never
    return !(this.hiddenAvailable.length === 0)
  }

  get part6_props() {
    return this.memo('part6_props', [this.hiddenAvailable, this.show, this.visible, this.tr, this.can, this.editing, this.data], () => {
      if (!(!(!this.can(PRIV.STATS_READ))) || !(this.editing && this.data) || !(!(this.hiddenAvailable.length === 0))) return undefined as never
      return ({ hiddenAvailable: this.hiddenAvailable, show: this.show, visible: this.visible, t: this.tr })
    })
  }

  /** A part of the screen still written in React (a list whose item is not a single element). */
  get Part6() {
    if (!(!(!this.can(PRIV.STATS_READ))) || !(this.editing && this.data) || !(!(this.hiddenAvailable.length === 0))) return undefined as never
    return __parts.Part6
  }

  get show_data_withheld_count() {
    if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
    return !!(this.data && this.withheldCount > 0)
  }

  /** `<Slot>`, rendered by a ReactHost. */
  get Slot() {
    if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
    return Slot
  }

  get slot_props() {
    return this.memo('slot_props', [this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
      return ({ name: "dashboard-stats-cards" })
    })
  }

  get slot_props2() {
    return this.memo('slot_props2', [this.can], () => {
      if (!(!(!this.can(PRIV.STATS_READ)))) return undefined as never
      return ({ name: "dashboard-widgets" })
    })
  }

  n(v?: number) {
    return (this.statsLoading ? '…' : (v ?? 0).toLocaleString(this.i18n.language))
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(!this.can(PRIV.STATS_READ))) || !(this.editing && this.data)) return undefined as never
    this.reset()
  }

  /** `setPeriod` of the TSX: a value, or an update of the previous one. */
  setPeriod(value: DashboardSection['period'] | ((prev: DashboardSection['period']) => DashboardSection['period'])) {
    this.period = typeof value === 'function' ? (value as (prev: DashboardSection['period']) => DashboardSection['period'])(this.period) : value
  }

  /** `setEditing` of the TSX: a value, or an update of the previous one. */
  setEditing(value: DashboardSection['editing'] | ((prev: DashboardSection['editing']) => DashboardSection['editing'])) {
    this.editing = typeof value === 'function' ? (value as (prev: DashboardSection['editing']) => DashboardSection['editing'])(this.editing) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DashboardSectionStores = ReturnType<DashboardSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type DashboardSectionHooks = ReturnType<DashboardSection['useHooks']>

export default DashboardSection.component()
