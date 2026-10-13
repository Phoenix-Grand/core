/**
 * Code-behind of `PanelCard.kbcontrol` (converted from `PanelCard.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"
import { fmtBytes, useChartSeries } from "../DashboardCharts"
import { bucketLabel } from "./bucketLabel"
import type { DashboardPanel, PanelBucket, PanelDef } from "./types"
import { AreaChart } from "../pages/AreaChart"
import { BarChart } from "../controls/BarChart"
import DonutChart from "../controls/DonutChart"
import HBarList from "../controls/HBarList"
import ProgressRing from "../controls/ProgressRing"

import { ViewBase } from './PanelCard.kbcontrol'
import * as __parts from './PanelCard.parts'

interface Props {
  def:       PanelDef
  panel:     DashboardPanel
  bucket:    PanelBucket
  /** Only rendered while the page is in edit mode. */
  editing:   boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onHide:    () => void
  onMove:    (delta: -1 | 1) => void
  onReport:  () => void
  /**
   * Spells one breakdown key, when the wording is not a translation key but a
   * fact this build has to look up — a module's display name, say. Takes
   * precedence over `def.legendKey`.
   */
  labelSlice?: (key: string) => string
}

export type { Props }

export class PanelCard extends ViewBase {
  tr!: PanelCardStores['t']
  i18n!: PanelCardStores['i18n']
  series!: readonly string[]
  fmt!: (v: number) => string
  points!: { label: string; value: number; }[]
  donut!: { label: string; value: number; color: string; }[]
  ranking!: { label: string; value: number; max: number; sub: string; }[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const series = useChartSeries()
    return { t, i18n, series }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const i18n = this.i18n
    const series = this.series
    const fmt = useCallback(
      (v: number) => (this.bytes ? fmtBytes(v) : v.toLocaleString(i18n.language)),
      [this.bytes, i18n.language],
    )
    this.publish({ fmt })
    const points = useMemo(
      () => this.props.panel.series.map(p => ({ label: bucketLabel(p.bucket, this.props.bucket, i18n.language), value: p.value })),
      [this.props.panel.series, this.props.bucket, i18n.language],
    )
    this.publish({ points })
    const labelSlice = this.props.labelSlice
    const sliceLabel = useCallback(
      (key: string) => {
        if (labelSlice) return labelSlice(key)
        return this.props.def.legendKey ? t(this.props.def.legendKey(key), { defaultValue: key }) : key
      },
      [this.props.def, t, labelSlice],
    )
    const donut = useMemo(
      () => this.props.panel.breakdown.map((s, i) => ({
        label: sliceLabel(s.key),
        value: s.value,
        // A meaningful state keeps its own colour; everything else is ranked by
        // the palette (see `sliceTone` in PanelDef).
        color: this.props.def.sliceTone?.(s.key) ?? series[i % series.length],
      })),
      [this.props.panel.breakdown, series, sliceLabel, this.props.def],
    )
    this.publish({ donut })
    const ranking = useMemo(() => {
      // A slice with its OWN ceiling is drawn against it — "80 % of what that
      // account was promised" is the fact somebody acts on, and it is invisible on
      // a bar scaled to the biggest holder. Slices without one share the largest
      // value, which is what makes a top-N readable.
      const largest = Math.max(1, ...this.props.panel.breakdown.map(s => s.value))
      return this.props.panel.breakdown.map(s => ({
        label: sliceLabel(s.key),
        value: s.value,
        max:   s.capacity && s.capacity > 0 ? s.capacity : largest,
        sub:   s.capacity && s.capacity > 0 ? `${fmt(s.value)} / ${fmt(s.capacity)}` : fmt(s.value),
      }))
    }, [this.props.panel.breakdown, sliceLabel, fmt])
    this.publish({ ranking })
    return { fmt, points, sliceLabel, donut, ranking }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, series: s.series })
    const h = this.useHooks()
    this.publish({ fmt: h.fmt, points: h.points, donut: h.donut, ranking: h.ranking })
  }

  get Icon() {
    return this.memo('Icon', [this.props], () => (this.props.def).Icon)
  }

  get bytes(): boolean {
    return this.props.panel.unit === 'bytes'
  }

  get previous(): number | null {
    return this.props.panel.previous_total
  }

  get snapshot(): boolean {
    return this.previous === null || this.previous === undefined
  }

  get delta(): number | null {
    const previous = this.previous
    const snapshot = previous === null || previous === undefined
    return !snapshot && previous > 0
    ? Math.round(((this.props.panel.total - previous) / previous) * 100)
    : null
  }

  get rising(): boolean {
    return this.delta !== null && this.delta > 0
  }

  get falling(): boolean {
    return this.delta !== null && this.delta < 0
  }

  get worse(): boolean {
    return this.props.def.polarity === 'bad-up' ? this.rising : false
  }

  get better(): boolean {
    return this.props.def.polarity === 'bad-up' ? this.falling : false
  }

  get DeltaIcon() {
    return this.memo('DeltaIcon', [this.rising, this.falling], () => this.rising ? ArrowUpRight : this.falling ? ArrowDownRight : Minus)
  }

  get deltaColor(): "text-text-secondary" | "text-danger" | "text-success" {
    return this.worse ? 'text-danger' : this.better ? 'text-success' : 'text-text-secondary'
  }

  get capacity(): number {
    return this.props.panel.capacity ?? 0
  }

  get pct(): number {
    return this.capacity > 0 ? (this.props.panel.total / this.capacity) * 100 : 0
  }

  get empty(): boolean {
    return this.props.def.shape === 'donut' || this.props.def.shape === 'ranking'
    ? this.props.panel.breakdown.length === 0
    : this.props.def.shape === 'gauge'
      ? this.capacity <= 0
      : this.props.panel.total === 0 && (this.previous ?? 0) === 0
  }

  get caveatKey(): (id: string) => string {
    return this.memo('caveatKey', [this.props], () => this.props.def.caveatKey ?? ((id: string) => `admin.sec_caveat_${id}`))
  }

  get caveat(): string {
    return this.props.panel.caveat
    ? this.tr(this.caveatKey(this.props.panel.caveat), { defaultValue: '' })
    : ''
  }

  get part1_props() {
    return this.memo('part1_props', [this.Icon], () => ({ Icon: this.Icon }))
  }

  /** A part of the screen still written in React (<Icon> is no .kbview element (a local or dynamic component)). */
  get Part1() {
    return __parts.Part1
  }

  get h3_text() {
    return this.tr(this.props.def.titleKey)
  }

  get p_text() {
    return this.tr(this.props.def.aboutKey)
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.props], () => {
      if (!(this.props.editing)) return undefined as never
      return ({ t: this.tr, onMove: this.props.onMove, canMoveUp: this.props.canMoveUp })
    })
  }

  /** A part of the screen still written in React (<ToolTip> label: no .kbview property). */
  get Part2() {
    if (!(this.props.editing)) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.props], () => {
      if (!(this.props.editing)) return undefined as never
      return ({ t: this.tr, onMove: this.props.onMove, canMoveDown: this.props.canMoveDown })
    })
  }

  /** A part of the screen still written in React (<ToolTip> label: no .kbview property). */
  get Part3() {
    if (!(this.props.editing)) return undefined as never
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.tr, this.props], () => {
      if (!(this.props.editing)) return undefined as never
      return ({ t: this.tr, onHide: this.props.onHide })
    })
  }

  /** A part of the screen still written in React (<ToolTip> label: no .kbview property). */
  get Part4() {
    if (!(this.props.editing)) return undefined as never
    return __parts.Part4
  }

  get span_text() {
    return this.fmt(this.props.panel.total)
  }

  get show_not_snapshot() {
    return !(this.snapshot)
  }

  get show_delta() {
    if (!(!(this.snapshot))) return undefined as never
    return this.delta === null
  }

  get show_not_delta() {
    if (!(!(this.snapshot))) return undefined as never
    return !(this.delta === null)
  }

  get span_class() {
    if (!(!(this.snapshot)) || !(!(this.delta === null))) return undefined as never
    return `inline-flex items-center gap-1 tabular-nums ${this.deltaColor}`
  }

  get part5_props() {
    return this.memo('part5_props', [this.DeltaIcon, this.snapshot, this.delta], () => {
      if (!(!(this.snapshot)) || !(!(this.delta === null))) return undefined as never
      return ({ DeltaIcon: this.DeltaIcon })
    })
  }

  /** A part of the screen still written in React (<DeltaIcon> is no .kbview element (a local or dynamic component)). */
  get Part5() {
    if (!(!(this.snapshot)) || !(!(this.delta === null))) return undefined as never
    return __parts.Part5
  }

  get text() {
    if (!(!(this.snapshot)) || !(!(this.delta === null))) return undefined as never
    return this.delta > 0 ? '+' : ''
  }

  get visible() {
    return this.memo('visible', [this.show_delta, this.show_not_snapshot], () => this.show_delta && this.show_not_snapshot)
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_delta, this.show_not_snapshot], () => this.show_not_delta && this.show_not_snapshot)
  }

  get show_not_empty() {
    return !(this.empty)
  }

  get show_def_shape_gauge() {
    if (!(!(this.empty))) return undefined as never
    return this.props.def.shape === 'gauge'
  }

  get show_not_def_shape_gauge() {
    if (!(!(this.empty))) return undefined as never
    return !(this.props.def.shape === 'gauge')
  }

  /** `<ProgressRing>`, rendered by a ReactHost. */
  get ProgressRing() {
    if (!(!(this.empty)) || !(this.props.def.shape === 'gauge')) return undefined as never
    return ProgressRing
  }

  get progress_ring_props() {
    return this.memo('progress_ring_props', [this.pct, this.tr, this.props, this.series, this.fmt, this.capacity, this.empty], () => {
      if (!(!(this.empty)) || !(this.props.def.shape === 'gauge')) return undefined as never
      return ({ pct: this.pct, value: `${Math.round(this.pct)} %`, label: this.tr(this.props.def.titleKey), color: this.pct >= 90 ? 'var(--color-danger)' : this.series[0], sub: `${this.fmt(this.props.panel.total)} / ${this.fmt(this.capacity)}` })
    })
  }

  get show_def_shape_donut() {
    if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge'))) return undefined as never
    return this.props.def.shape === 'donut'
  }

  get show_not_def_shape_donut() {
    if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge'))) return undefined as never
    return !(this.props.def.shape === 'donut')
  }

  /** `<DonutChart>`, rendered by a ReactHost. */
  get DonutChart() {
    if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(this.props.def.shape === 'donut')) return undefined as never
    return DonutChart
  }

  get donut_chart_props() {
    return this.memo('donut_chart_props', [this.donut, this.fmt, this.props, this.empty], () => {
      if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(this.props.def.shape === 'donut')) return undefined as never
      return ({ data: this.donut, size: 128, centerValue: this.fmt(this.props.panel.total) })
    })
  }

  get show_def_shape_ranking() {
    if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut'))) return undefined as never
    return this.props.def.shape === 'ranking'
  }

  get show_not_def_shape_ranking() {
    if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut'))) return undefined as never
    return !(this.props.def.shape === 'ranking')
  }

  /** `<HBarList>`, rendered by a ReactHost. */
  get HBarList() {
    if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut')) || !(this.props.def.shape === 'ranking')) return undefined as never
    return HBarList
  }

  get hbar_list_props() {
    return this.memo('hbar_list_props', [this.ranking, this.series, this.empty, this.props], () => {
      if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut')) || !(this.props.def.shape === 'ranking')) return undefined as never
      return ({ items: this.ranking, color: this.series[0] })
    })
  }

  get show_def_shape_area() {
    if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut')) || !(!(this.props.def.shape === 'ranking'))) return undefined as never
    return this.props.def.shape === 'area'
  }

  get show_not_def_shape_area() {
    if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut')) || !(!(this.props.def.shape === 'ranking'))) return undefined as never
    return !(this.props.def.shape === 'area')
  }

  /** `<AreaChart>`, rendered by a ReactHost. */
  get AreaChart() {
    if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut')) || !(!(this.props.def.shape === 'ranking')) || !(this.props.def.shape === 'area')) return undefined as never
    return AreaChart
  }

  get area_chart_props() {
    return this.memo('area_chart_props', [this.points, this.series, this.empty, this.props], () => {
      if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut')) || !(!(this.props.def.shape === 'ranking')) || !(this.props.def.shape === 'area')) return undefined as never
      return ({ data: this.points, color: this.series[0], height: 132 })
    })
  }

  /** `<BarChart>`, rendered by a ReactHost. */
  get BarChart() {
    if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut')) || !(!(this.props.def.shape === 'ranking')) || !(!(this.props.def.shape === 'area'))) return undefined as never
    return BarChart
  }

  get bar_chart_props() {
    return this.memo('bar_chart_props', [this.points, this.series, this.empty, this.props], () => {
      if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut')) || !(!(this.props.def.shape === 'ranking')) || !(!(this.props.def.shape === 'area'))) return undefined as never
      return ({ data: this.points, color: this.series[0], height: 132 })
    })
  }

  get visible3() {
    return this.memo('visible3', [this.show_def_shape_area, this.show_not_def_shape_ranking, this.empty, this.props], () => {
      if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut'))) return undefined as never
      return this.show_def_shape_area && this.show_not_def_shape_ranking
    })
  }

  get visible4() {
    return this.memo('visible4', [this.show_not_def_shape_area, this.show_not_def_shape_ranking, this.empty, this.props], () => {
      if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge')) || !(!(this.props.def.shape === 'donut'))) return undefined as never
      return this.show_not_def_shape_area && this.show_not_def_shape_ranking
    })
  }

  get visible5() {
    return this.memo('visible5', [this.show_def_shape_ranking, this.show_not_def_shape_donut, this.empty, this.props], () => {
      if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge'))) return undefined as never
      return this.show_def_shape_ranking && this.show_not_def_shape_donut
    })
  }

  get visible6() {
    return this.memo('visible6', [this.visible3, this.show_not_def_shape_donut, this.empty, this.props], () => {
      if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge'))) return undefined as never
      return this.visible3 && this.show_not_def_shape_donut
    })
  }

  get visible7() {
    return this.memo('visible7', [this.visible4, this.show_not_def_shape_donut, this.empty, this.props], () => {
      if (!(!(this.empty)) || !(!(this.props.def.shape === 'gauge'))) return undefined as never
      return this.visible4 && this.show_not_def_shape_donut
    })
  }

  get visible8() {
    return this.memo('visible8', [this.show_def_shape_donut, this.show_not_def_shape_gauge, this.empty], () => {
      if (!(!(this.empty))) return undefined as never
      return this.show_def_shape_donut && this.show_not_def_shape_gauge
    })
  }

  get visible9() {
    return this.memo('visible9', [this.visible5, this.show_not_def_shape_gauge, this.empty], () => {
      if (!(!(this.empty))) return undefined as never
      return this.visible5 && this.show_not_def_shape_gauge
    })
  }

  get visible10() {
    return this.memo('visible10', [this.visible6, this.show_not_def_shape_gauge, this.empty], () => {
      if (!(!(this.empty))) return undefined as never
      return this.visible6 && this.show_not_def_shape_gauge
    })
  }

  get visible11() {
    return this.memo('visible11', [this.visible7, this.show_not_def_shape_gauge, this.empty], () => {
      if (!(!(this.empty))) return undefined as never
      return this.visible7 && this.show_not_def_shape_gauge
    })
  }

  get visible12() {
    return this.memo('visible12', [this.show_def_shape_gauge, this.show_not_empty], () => this.show_def_shape_gauge && this.show_not_empty)
  }

  get visible13() {
    return this.memo('visible13', [this.visible8, this.show_not_empty], () => this.visible8 && this.show_not_empty)
  }

  get visible14() {
    return this.memo('visible14', [this.visible9, this.show_not_empty], () => this.visible9 && this.show_not_empty)
  }

  get visible15() {
    return this.memo('visible15', [this.visible10, this.show_not_empty], () => this.visible10 && this.show_not_empty)
  }

  get visible16() {
    return this.memo('visible16', [this.visible11, this.show_not_empty], () => this.visible11 && this.show_not_empty)
  }

  get show_caveat() {
    return !!(this.caveat)
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    this.props.onReport?.()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type PanelCardStores = ReturnType<PanelCard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type PanelCardHooks = ReturnType<PanelCard['useHooks']>

export default PanelCard.component()
