/**
 * Code-behind of `RoomStatsTab.kbcontrol` (converted from `RoomStatsTab.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { CalendarCheck2, Clock, Gauge, ThumbsUp } from "lucide-react"
import { useChartSeries } from "../../DashboardCharts"
import { useRoomStats, errorMessage } from "./api"

import { ViewBase } from './RoomStatsTab.kbcontrol'
import * as __parts from './RoomStatsTab.parts'

const PERIODS: Record<string, number> = {
  last_7_days:  7,
  last_30_days: 30,
  last_90_days: 90,
}

const WORKDAY_HOURS = 8

export class RoomStatsTab extends ViewBase {
  @bind accessor period = 'last_30_days'
  tr!: RoomStatsTabStores['t']
  i18n!: RoomStatsTabStores['i18n']
  series!: readonly string[]
  from!: string
  data!: RoomStatsTabHooks['data']
  isLoading!: boolean
  isError!: boolean
  error!: Error | null
  periodOptions!: { value: string; label: string; }[]
  nf!: RoomStatsTabStores['nf']
  nf1!: RoomStatsTabStores['nf1']
  dayFm!: RoomStatsTabStores['dayFm']
  perDay!: { label: string; value: number; }[]
  perHour!: { label: string; value: number; }[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const series = useChartSeries()
    const periodOptions = useMemo(
      () => Object.keys(PERIODS).map(id => ({ value: id, label: t(`admin.sec_period_${id}`) })),
      [t],
    )
    const nf    = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language])
    const nf1   = useMemo(
      () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }),
      [i18n.language],
    )
    const dayFm = useMemo(
      () => new Intl.DateTimeFormat(i18n.language, { day: '2-digit', month: '2-digit' }),
      [i18n.language],
    )
    return { t, i18n, series, periodOptions, nf, nf1, dayFm }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const dayFm = this.dayFm
    const { from, to } = useMemo(() => {
      const end   = new Date()
      const start = new Date(end.getTime() - (PERIODS[this.period] ?? 30) * 86_400_000)
      return { from: start.toISOString(), to: end.toISOString() }
    }, [this.period])
    this.publish({ from })
    const { data, isLoading, isError, error } = useRoomStats(from, to, true)
    this.publish({ data, isLoading, isError, error })
    const perDay = useMemo(
      () => (data?.per_day ?? []).map(d => ({
        // Day and month only: a date axis reaching back three months cannot carry
        // a year on every tick, and the window is named right above it.
        label: dayFm.format(new Date(`${d.date}T00:00:00`)),
        value: Math.round(d.hours * 10) / 10,
      })),
      [data?.per_day, dayFm],
    )
    this.publish({ perDay })
    const perHour = useMemo(
      () => Array.from({ length: 13 }, (_, i) => i + 7).map(h => ({
        label: t('admin.rs_hour_tick', { hour: String(h).padStart(2, '0') }),
        value: Math.round(((data?.per_hour ?? []).find(x => x.hour === h)?.hours ?? 0) * 10) / 10,
      })),
      [data?.per_hour, t],
    )
    this.publish({ perHour })
    return { from, to, data, isLoading, isError, error, perDay, perHour }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, series: s.series, periodOptions: s.periodOptions, nf: s.nf, nf1: s.nf1, dayFm: s.dayFm })
    const h = this.useHooks()
    this.publish({ from: h.from, data: h.data, isLoading: h.isLoading, isError: h.isError, error: h.error, perDay: h.perDay, perHour: h.perHour })
  }

  get rooms(): { resource_id: string; name: string; capacity: number; hours: number; bookings: number; declined: number; }[] {
    return this.memo('rooms', [this.data], () => this.data?.per_room ?? [])
  }

  get topHours(): number {
    return Math.max(...this.rooms.map(r => r.hours), 1)
  }

  get answered(): number {
    return (this.data?.bookings ?? 0) + (this.data?.declined ?? 0)
  }

  get acceptance(): number | null {
    return this.answered > 0 ? (this.data?.bookings ?? 0) / this.answered : null
  }

  get absent(): boolean {
    if (!(!(this.isLoading)) || !(!!(this.data && !this.data.available))) return undefined as never
    return this.data.reason === 'module_absent'
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.data && !this.data.available)
  }

  get variant() {
    if (!(!(this.isLoading)) || !(this.data && !this.data.available)) return undefined as never
    return this.absent ? 'unavailable' : 'error'
  }

  get title() {
    if (!(!(this.isLoading)) || !(this.data && !this.data.available)) return undefined as never
    return this.tr(this.absent ? 'admin.rs_no_module' : 'admin.rs_unreachable')
  }

  get description() {
    if (!(!(this.isLoading)) || !(this.data && !this.data.available)) return undefined as never
    return this.tr(this.absent ? 'admin.rs_no_module_desc' : 'admin.rs_unreachable_desc')
  }

  get show_main() {
    return !(this.isLoading) && !(this.data && !this.data.available)
  }

  get part1_props() {
    return this.memo('part1_props', [this.period, this.memo, this.periodOptions, this.isLoading, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.data && !this.data.available))) return undefined as never
      return ({ period: this.period, setPeriod: this.memo("setPeriod:bound", [], () => this.setPeriod.bind(this)), periodOptions: this.periodOptions })
    })
  }

  /** A part of the screen still written in React (<Dropdown> width, focusable: no .kbview property). */
  get Part1() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available))) return undefined as never
    return __parts.Part1
  }

  get show_data() {
    return this.memo('show_data', [this.data, this.isLoading], () => {
      if (!(!(this.isLoading)) || !(!(this.data && !this.data.available))) return undefined as never
      return !!(this.data)
    })
  }

  get rs_scope_count() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available)) || !(this.data)) return undefined as never
    return this.data.rooms
  }

  get rs_scope_hours() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available)) || !(this.data)) return undefined as never
    return WORKDAY_HOURS
  }

  get callout_text() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available)) || !(this.isError)) return undefined as never
    return errorMessage(this.error, this.tr('admin.rs_load_failed'))
  }

  /** `<StatCard>`, rendered by a ReactHost. */
  get StatCard() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available))) return undefined as never
    return __parts.StatCard
  }

  get stat_card_props() {
    return this.memo('stat_card_props', [this.tr, this.nf, this.data, this.isLoading], () => {
      if (!(!(this.isLoading)) || !(!(this.data && !this.data.available))) return undefined as never
      return ({ label: this.tr('admin.rs_bookings'), icon: CalendarCheck2, value: this.nf.format(this.data?.bookings ?? 0), accent: this.tr('admin.rs_bookings_sub', { count: this.data?.declined ?? 0 }) })
    })
  }

  get stat_card_props2() {
    return this.memo('stat_card_props2', [this.tr, this.nf1, this.data, this.isLoading], () => {
      if (!(!(this.isLoading)) || !(!(this.data && !this.data.available))) return undefined as never
      return ({ label: this.tr('admin.rs_booked_hours'), icon: Clock, value: this.hours(this.data?.booked_hours ?? 0) })
    })
  }

  get stat_card_props3() {
    return this.memo('stat_card_props3', [this.tr, this.i18n, this.data, this.nf, this.isLoading], () => {
      if (!(!(this.isLoading)) || !(!(this.data && !this.data.available))) return undefined as never
      return ({ label: this.tr('admin.rs_rate'), icon: Gauge, value: this.pct(this.data?.booking_rate), accent: this.tr('admin.rs_rate_sub', { hours: this.nf.format(Math.round(this.data?.available_hours ?? 0)) }) })
    })
  }

  get stat_card_props4() {
    return this.memo('stat_card_props4', [this.tr, this.i18n, this.acceptance, this.isLoading, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.data && !this.data.available))) return undefined as never
      return ({ label: this.tr('admin.rs_acceptance'), icon: ThumbsUp, value: this.pct(this.acceptance), accent: this.tr('admin.rs_acceptance_sub') })
    })
  }

  get show_answered() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available))) return undefined as never
    return this.answered === 0
  }

  get show_not_answered() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available))) return undefined as never
    return !(this.answered === 0)
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.perDay, this.series, this.isLoading, this.data, this.answered], () => {
      if (!(!(this.isLoading)) || !(!(this.data && !this.data.available)) || !(!(this.answered === 0))) return undefined as never
      return ({ t: this.tr, perDay: this.perDay, series: this.series })
    })
  }

  /** A part of the screen still written in React (<ChartCard> is no .kbview element (a local or dynamic component)). */
  get Part2() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available)) || !(!(this.answered === 0))) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.perHour, this.series, this.isLoading, this.data, this.answered], () => {
      if (!(!(this.isLoading)) || !(!(this.data && !this.data.available)) || !(!(this.answered === 0))) return undefined as never
      return ({ t: this.tr, perHour: this.perHour, series: this.series })
    })
  }

  /** A part of the screen still written in React (<ChartCard> is no .kbview element (a local or dynamic component)). */
  get Part3() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available)) || !(!(this.answered === 0))) return undefined as never
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.tr, this.rooms, this.series, this.topHours, this.nf1, this.isLoading, this.data, this.answered], () => {
      if (!(!(this.isLoading)) || !(!(this.data && !this.data.available)) || !(!(this.answered === 0))) return undefined as never
      return ({ t: this.tr, rooms: this.rooms, series: this.series, topHours: this.topHours, nf1: this.nf1 })
    })
  }

  /** A part of the screen still written in React (<ChartCard> is no .kbview element (a local or dynamic component)). */
  get Part4() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available)) || !(!(this.answered === 0))) return undefined as never
    return __parts.Part4
  }

  get p_text() {
    if (!(!(this.isLoading)) || !(!(this.data && !this.data.available)) || !(!(this.answered === 0))) return undefined as never
    return this.hours(this.data?.released_hours ?? 0)
  }

  hours(n: number) {
    return this.tr('admin.rs_h', { value: this.nf1.format(n) })
  }

  pct(n: number | null | undefined) {
    return n === null || n === undefined
      ? '—'
      : new Intl.NumberFormat(this.i18n.language, { style: 'percent', maximumFractionDigits: 1 }).format(n)
  }

  /** `setPeriod` of the TSX: a value, or an update of the previous one. */
  setPeriod(value: RoomStatsTab['period'] | ((prev: RoomStatsTab['period']) => RoomStatsTab['period'])) {
    this.period = typeof value === 'function' ? (value as (prev: RoomStatsTab['period']) => RoomStatsTab['period'])(this.period) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type RoomStatsTabStores = ReturnType<RoomStatsTab['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type RoomStatsTabHooks = ReturnType<RoomStatsTab['useHooks']>

export default RoomStatsTab.component()
