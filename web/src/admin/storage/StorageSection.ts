/**
 * Code-behind of `StorageSection.kbview` (converted from `StorageSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { adminUrl } from "../adminAction"
import { formatBytes } from "../sections/format"
import type { AdminSectionProps } from "../sections/registry"
import { type Segment } from "./charts"
import { errorMessage, useSetWarnPercent, useStorageOverview } from "./api"
import { TrendChart } from "./TrendChart"

import { ViewBase } from './StorageSection.kbview'
import * as __parts from './StorageSection.parts'

export type { AdminSectionProps }

export class StorageSection extends ViewBase {
  @bind accessor warnDraft: number | null = null
  @bind accessor error: string | null = null
  tr!: StorageSectionStores['t']
  can!: StorageSectionStores['can']
  data!: StorageSectionStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: StorageSectionStores['refetch']
  setWarn!: StorageSectionStores['setWarn']
  trendData!: { day: string; value: number; }[]
  projection!: { perDay: number; daysLeft: number | null; } | null

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { can } = usePrivileges()
    const { data, isLoading, isError, refetch } = useStorageOverview()
    const setWarn = useSetWarnPercent()
    const trendData = useMemo(
      () => (data?.trend ?? []).map(p => ({ day: p.day, value: p.used_bytes })),
      [data],
    )
    const projection = useMemo(() => {
      const pts = data?.trend ?? []
      if (pts.length < 7 || !data?.volume) return null
      const first = pts[0], last = pts[pts.length - 1]
      const days = Math.max(
        (new Date(last.day).getTime() - new Date(first.day).getTime()) / 86_400_000,
        1,
      )
      const perDay = (last.used_bytes - first.used_bytes) / days
      if (perDay <= 0) return { perDay, daysLeft: null as number | null }
      return { perDay, daysLeft: Math.round(data.volume.available_bytes / perDay) }
    }, [data])
    return { t, can, data, isLoading, isError, refetch, setWarn, trendData, projection }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, setWarn: s.setWarn, trendData: s.trendData, projection: s.projection })
  }

  get canManageSettings(): boolean {
    return this.can(PRIV.SETTINGS_MANAGE)
  }

  get volume() {
    return this.memo('volume', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return (this.data).volume
    })
  }

  get states() {
    return this.memo('states', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return (this.data).quota_states
    })
  }

  get volumeFreeRatio(): number | null {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.volume && this.volume.total_bytes > 0
    ? this.volume.available_bytes / this.volume.total_bytes
    : null
  }

  get otherOnVolume(): number {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.volume ? Math.max(this.volume.used_bytes - this.data.used_bytes, 0) : 0
  }

  get volumeSegments(): Segment[] {
    return this.memo('volumeSegments', [this.volume, this.tr, this.data, this.otherOnVolume, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return this.volume ? [
    { id: 'accounts', label: this.tr('admin.sto_seg_accounts'), value: Math.min(this.data.used_bytes, this.volume.used_bytes), color: 'var(--color-primary)' },
    { id: 'other',    label: this.tr('admin.sto_seg_other'),    value: this.otherOnVolume,            color: 'var(--color-border-strong)' },
    { id: 'free',     label: this.tr('admin.sto_seg_free'),     value: this.volume.available_bytes,   color: 'var(--color-surface-2)', track: true },
  ] : []
    })
  }

  get stateSegments(): Segment[] {
    return this.memo('stateSegments', [this.tr, this.states, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return [
    { id: 'ok',   label: this.tr('admin.sto_state_ok'),   value: this.states.ok,   color: 'var(--color-success)' },
    { id: 'near', label: this.tr('admin.sto_state_near'), value: this.states.near, color: 'var(--color-warning)' },
    { id: 'full', label: this.tr('admin.sto_state_full'), value: this.states.full, color: 'var(--color-danger)' },
  ]
    })
  }

  get overCommitted(): boolean {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data.allocated_bytes > 0 && this.volume
    ? this.data.allocated_bytes > this.volume.total_bytes
    : false
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.isError || !this.data)
  }

  get show_main() {
    return !(this.isLoading) && !(this.isError || !this.data)
  }

  get show_volume_free_ratio_volume_free_ratio() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.volumeFreeRatio != null && this.volumeFreeRatio < 0.15
  }

  get variant() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.volumeFreeRatio != null && this.volumeFreeRatio < 0.15)) return undefined as never
    return this.volumeFreeRatio < 0.07 ? 'danger' : 'warning'
  }

  get sto_banner_volume_title_percent() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.volumeFreeRatio != null && this.volumeFreeRatio < 0.15)) return undefined as never
    return Math.round(this.volumeFreeRatio * 100)
  }

  get span_text() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return formatBytes(this.data.used_bytes)
  }

  get show_volume() {
    return this.memo('show_volume', [this.volume, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return !!(this.volume)
    })
  }

  get sto_of_volume_total() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.volume)) return undefined as never
    return formatBytes(this.volume.total_bytes)
  }

  get show_not_volume() {
    return this.memo('show_not_volume', [this.volume, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return !(this.volume)
    })
  }

  /** `<CompositionBar Total>`: the volume's size, the bar's denominator. */
  get sto_volume_total() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.volume)) return undefined as never
    return this.volume.total_bytes
  }

  get p_text() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.volume)) return undefined as never
    return this.volume.path
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ t: this.tr, data: this.data })
    })
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part1() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Part1
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part2() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Part2
  }

  get sto_overcommit_allocated() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.overCommitted)) return undefined as never
    return formatBytes(this.data.allocated_bytes)
  }

  get sto_overcommit_total() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.overCommitted)) return undefined as never
    return formatBytes(this.volume?.total_bytes ?? 0)
  }

  get sto_states_sub_percent() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data.warn_percent
  }

  /** `<CompositionBar Total>` for the states bar: the account count (the bar's denominator). */
  get sto_states_total() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return Math.max(this.data.accounts, 1)
  }

  /** `<CompositionBar Format>` for the states bar: a value-transforming prop (WV-7 blocker E) - the segments are
   * account counts, not bytes, so they are shown as plain numbers instead of the control's default `formatBytes`. */
  get sto_states_format() {
    return (n: number) => String(n)
  }

  get show_states_full_states() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.states.full === 0 && this.states.near === 0
  }

  get show_not_states_full_states() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return !(this.states.full === 0 && this.states.near === 0)
  }

  get show_trend_data() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.trendData.length >= 2
  }

  get show_not_trend_data() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return !(this.trendData.length >= 2)
  }

  /** `<TrendChart>`, rendered by a ReactHost. */
  get TrendChart() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.trendData.length >= 2)) return undefined as never
    return TrendChart
  }

  get trend_chart_props() {
    return this.memo('trend_chart_props', [this.trendData, this.tr, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.trendData.length >= 2)) return undefined as never
      return ({ data: this.trendData, label: this.tr('admin.sto_trend_aria') })
    })
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.trendData, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.trendData.length >= 2)) return undefined as never
      return ({ t: this.tr, trendData: this.trendData })
    })
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part3() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.trendData.length >= 2)) return undefined as never
    return __parts.Part3
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part4() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.trendData.length >= 2)) return undefined as never
    return __parts.Part4
  }

  get show_projection() {
    return this.memo('show_projection', [this.projection, this.isLoading, this.isError, this.data, this.trendData], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.trendData.length >= 2)) return undefined as never
      return !!(this.projection)
    })
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr, this.projection, this.isLoading, this.isError, this.data, this.trendData], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.trendData.length >= 2) || !(this.projection)) return undefined as never
      return ({ t: this.tr, projection: this.projection, projection_daysLeft: this.projection?.daysLeft })
    })
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part5() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.trendData.length >= 2) || !(this.projection)) return undefined as never
    return __parts.Part5
  }

  get show_projection_days_left() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.trendData.length >= 2)) return undefined as never
    return this.projection?.daysLeft != null
  }

  get visible() {
    return this.memo('visible', [this.show_projection_days_left, this.show_trend_data, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return this.show_projection_days_left && this.show_trend_data
    })
  }

  get sto_trend_empty_desc_count() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.trendData.length >= 2))) return undefined as never
    return this.data.sampled_days
  }

  get show_data_by_module() {
    return this.memo('show_data_by_module', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return !!(this.data.by_module)
    })
  }

  /** `<ModuleBreakdownCard Data>`: the per-module breakdown, present only within `show_data_by_module`. */
  get moduleBreakdownData() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.data.by_module)) return undefined as never
    return this.data.by_module
  }

  get show_data_reconciliation() {
    return this.memo('show_data_reconciliation', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return !!(this.data.reconciliation)
    })
  }

  /** `<ReconciliationCard Data>`: the reconciliation state, present only within `show_data_reconciliation`. */
  get reconciliationData() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.data.reconciliation)) return undefined as never
    return this.data.reconciliation
  }

  /** `<ReconciliationCard Modules>`: module list, only to name a blocking module id. */
  get reconciliationModules() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.data.reconciliation)) return undefined as never
    return this.data.by_module?.modules ?? []
  }

  /** `<ReconciliationCard StaleHours>`: the staleness threshold used in blocker messages. */
  get reconciliationStaleHours() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.data.reconciliation)) return undefined as never
    return this.data.by_module?.stale_hours ?? 0
  }

  /** `<ConsumersCard WarnPercent>`: the instance warn threshold, drives the fill colouring. */
  get consumersWarnPercent() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data.warn_percent
  }

  /** `<ConsumersCard InitialFilter>`: the saturated-accounts filter read from the URL, if any. */
  get consumersInitialFilter() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.props.params.get('filter') === 'full' ? 'full'
      : this.props.params.get('filter') === 'near' ? 'near' : 'all'
  }

  get show_data_by_unit() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data.by_unit.length === 0
  }

  get show_not_data_by_unit() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return !(this.data.by_unit.length === 0)
  }

  /** A part of the screen still written in React (<ProgressBar> label: an object value for a text property). */
  get Part6() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.by_unit.length === 0))) return undefined as never
    return __parts.Part6
  }

  /** The rows of the Repeater over `data.by_unit`. */
  get rows_by_unit() {
    return this.memo('rows_by_unit', [this.data, this.isLoading, this.isError, this.tr], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.by_unit.length === 0))) return undefined as never
      return this.data.by_unit.map((u) => {
      return { u, part6_props: ((!(this.isLoading)) && (!(this.isError || !this.data)) && (!(this.data.by_unit.length === 0))) ? ({ u: u, data: this.data, t: this.tr }) : undefined, key: u.unit_id ?? 'none' }
    })
    })
  }

  /** `<QuotaPolicyCard Overview>`: the whole storage overview the policy editor reads. */
  get quotaOverview() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data
  }

  get part7_props() {
    return this.memo('part7_props', [this.canManageSettings, this.warnDraft, this.data, this.memo, this.tr, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ canManageSettings: this.canManageSettings, warnDraft: this.warnDraft, data: this.data, setWarnDraft: this.memo("setWarnDraft:bound", [], () => this.setWarnDraft.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<input> has no .kbview element yet). */
  get Part7() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Part7
  }

  get span_text2() {
    return this.memo('span_text2', [this.warnDraft, this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return String(this.warnDraft ?? this.data.warn_percent) + " %"
    })
  }

  get show_can_manage_settings_warn_draft_warn_draft() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.canManageSettings && this.warnDraft != null && this.warnDraft !== this.data.warn_percent
  }

  get enabled_unless_set_warn_is_pending() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManageSettings && this.warnDraft != null && this.warnDraft !== this.data.warn_percent)) return undefined as never
    return !(this.setWarn.isPending)
  }

  get show_error() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return !!(this.error)
  }

  async saveWarn(percent: number) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    this.error = null
    try {
      await this.setWarn.mutateAsync(percent)
      this.warnDraft = null
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.sto_threshold_failed'))
    }
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(this.isError || !this.data)) return undefined as never
    void this.refetch()
  }

  callout_action(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.volumeFreeRatio != null && this.volumeFreeRatio < 0.15)) return undefined as never
    this.props.navigate(adminUrl({ tab: 'alerts' }))
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManageSettings && this.warnDraft != null && this.warnDraft !== this.data.warn_percent)) return undefined as never
    this.warnDraft = null
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManageSettings && this.warnDraft != null && this.warnDraft !== this.data.warn_percent)) return undefined as never
    void this.saveWarn(this.warnDraft)
  }

  /** `setWarnDraft` of the TSX: a value, or an update of the previous one. */
  setWarnDraft(value: number | null | ((prev: number | null) => number | null)) {
    this.warnDraft = typeof value === 'function' ? (value as (prev: number | null) => number | null)(this.warnDraft) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type StorageSectionStores = ReturnType<StorageSection['useStores']>

export default StorageSection.component()
