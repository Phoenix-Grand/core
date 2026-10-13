/**
 * Code-behind of `ImpactPanel.kbcontrol` (converted from `ImpactPanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useBacktest, useStartBacktest } from "./api"
import { formatWhen } from "../sections/format"
import { BACKTEST_MAX_WINDOW_DAYS, type BacktestRow } from "./types"
import { apiErrorDetail } from "../../core/api/errorMessage"

import { ViewBase } from './ImpactPanel.kbcontrol'
import * as __parts from './ImpactPanel.parts'

interface Props {
  ruleId:   string | null
  /** The last replays already stored for this rule, newest first. */
  previous: BacktestRow[]
  /** No rule id yet (the wizard): the panel explains instead of offering. */
  hint?:    string
}

const WINDOWS = [1, 7, 14, 30]

export type { Props }

export class ImpactPanel extends ViewBase {
  @bind accessor days = 7
  @bind accessor runId: string | null = null
  tr!: ImpactPanelStores['t']
  i18n!: ImpactPanelStores['i18n']
  start!: ImpactPanelStores['start']
  poll!: ImpactPanelHooks['poll']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const start = useStartBacktest()
    return { t, i18n, start }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const poll  = useBacktest(this.props.ruleId, this.runId)
    this.publish({ poll })
    const runId = this.runId
    useEffect(() => {
      if (!runId && this.props.previous.length > 0) this.runId = this.props.previous[0].id
    }, [this.props.previous, runId])
    return { poll }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, start: s.start })
    const h = this.useHooks()
    this.publish({ poll: h.poll })
  }

  get row(): BacktestRow | null {
    return this.memo('row', [this.poll, this.props, this.runId], () => {
      const runId = this.runId
      return this.poll.data ?? this.props.previous.find(b => b.id === runId) ?? null
    })
  }

  get report() {
    return this.memo('report', [this.row], () => this.row?.report ?? {})
  }

  get running(): boolean {
    return this.row?.status === 'pending' || this.row?.status === 'running' || this.start.isPending
  }

  get scanned(): number {
    if (!(!(!this.props.ruleId))) return undefined as never
    return this.report.events_scanned ?? 0
  }

  get matched(): number {
    if (!(!(!this.props.ruleId))) return undefined as never
    return this.report.matched ?? 0
  }

  get ratio(): number {
    if (!(!(!this.props.ruleId))) return undefined as never
    return this.scanned > 0 ? (this.matched / this.scanned) * 100 : 0
  }

  get show_case_1() {
    return !!(!this.props.ruleId)
  }

  get callout_text() {
    if (!(!this.props.ruleId)) return undefined as never
    return this.props.hint ?? this.tr('admin.rl_impact_needs_save')
  }

  get show_main() {
    return !(!this.props.ruleId)
  }

  /** The rows of the Repeater over `WINDOWS`. */
  get rows_windows() {
    return this.memo('rows_windows', [this.props, this.days], () => {
      if (!(!(!this.props.ruleId))) return undefined as never
      return WINDOWS.map((d) => {
      return { d, variant: ((!(!this.props.ruleId))) ? (this.days === d ? 'secondary' : 'ghost') : undefined, key: d }
    })
    })
  }

  get rl_impact_retention_days() {
    if (!(!(!this.props.ruleId))) return undefined as never
    return BACKTEST_MAX_WINDOW_DAYS
  }

  get callout_text2() {
    if (!(!(!this.props.ruleId)) || !(this.start.isError)) return undefined as never
    return apiErrorDetail(this.start.error) ?? ''
  }

  get show_row_running() {
    if (!(!(!this.props.ruleId))) return undefined as never
    return !!(this.row && this.running)
  }

  get show_row_status_failed() {
    if (!(!(!this.props.ruleId))) return undefined as never
    return this.row?.status === 'failed'
  }

  get callout_text3() {
    if (!(!(!this.props.ruleId)) || !(this.row?.status === 'failed')) return undefined as never
    return this.row.error ?? '—'
  }

  get show_row_status_done() {
    if (!(!(!this.props.ruleId))) return undefined as never
    return this.row?.status === 'done'
  }

  get rl_impact_window_from() {
    if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
    return formatWhen(this.row.window_from, this.i18n.language)
  }

  get rl_impact_window_to() {
    if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
    return formatWhen(this.row.window_to, this.i18n.language)
  }

  /** `<Figure>`, rendered by a ReactHost. */
  get Figure() {
    if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
    return __parts.Figure
  }

  get figure_props() {
    return this.memo('figure_props', [this.tr, this.scanned, this.props, this.row], () => {
      if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
      return ({ label: this.tr('admin.rl_impact_scanned'), value: this.scanned })
    })
  }

  get figure_props2() {
    return this.memo('figure_props2', [this.tr, this.matched, this.props, this.row], () => {
      if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
      return ({ label: this.tr('admin.rl_impact_matched'), value: this.matched })
    })
  }

  get figure_props3() {
    return this.memo('figure_props3', [this.tr, this.report, this.props, this.row], () => {
      if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
      return ({ label: this.tr('admin.rl_impact_would_act'), value: this.report.would_act ?? 0, hint: this.tr('admin.rl_impact_would_act_hint') })
    })
  }

  get figure_props4() {
    return this.memo('figure_props4', [this.tr, this.report, this.props, this.row], () => {
      if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
      return ({ label: this.tr('admin.rl_impact_filtered'), value: (this.report.out_of_scope ?? 0) + (this.report.out_of_rollout ?? 0), hint: this.tr('admin.rl_impact_filtered_hint') })
    })
  }

  get part1_props() {
    return this.memo('part1_props', [this.ratio, this.tr, this.props, this.row], () => {
      if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
      return ({ ratio: this.ratio, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<ProgressBar> formatValue: no .kbview property). */
  get Part1() {
    if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
    return __parts.Part1
  }

  get show_report_by_org() {
    if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
    return (this.report.by_org_unit?.length ?? 0) > 0
  }

  /** The rows of the Repeater over `(report.by_org_unit ?? []).slice(0, 8)`. */
  get rows_items() {
    return this.memo('rows_items', [this.report, this.props, this.row], () => {
      if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done') || !((this.report.by_org_unit?.length ?? 0) > 0)) return undefined as never
      return (this.report.by_org_unit ?? []).slice(0, 8).map((u) => {
      return { u, key: u.unit }
    })
    })
  }

  get show_report_by_day() {
    if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
    return (this.report.by_day?.length ?? 0) > 0
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part2() {
    if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done') || !((this.report.by_day?.length ?? 0) > 0)) return undefined as never
    return __parts.Part2
  }

  /** The rows of the Repeater over `(report.by_day ?? [])`. */
  get rows_items2() {
    return this.memo('rows_items2', [this.report, this.props, this.row], () => {
      if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done') || !((this.report.by_day?.length ?? 0) > 0)) return undefined as never
      return (this.report.by_day ?? []).map((d) => {
      const peak = Math.max(...(this.report.by_day ?? []).map(x => x.count), 1)
      return { d, peak, tooltip: ((!(!this.props.ruleId)) && (this.row?.status === 'done') && ((this.report.by_day?.length ?? 0) > 0)) ? (`${d.day} — ${d.count}`) : undefined, part2_props: ((!(!this.props.ruleId)) && (this.row?.status === 'done') && ((this.report.by_day?.length ?? 0) > 0)) ? ({ d: d, peak: peak }) : undefined, span_text: ((!(!this.props.ruleId)) && (this.row?.status === 'done') && ((this.report.by_day?.length ?? 0) > 0)) ? (d.day.slice(5)) : undefined, key: d.day }
    })
    })
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.report, this.props, this.row], () => {
      if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
      return ({ t: this.tr, report: this.report })
    })
  }

  /** A part of the screen still written in React (<Callout> icon: a value the property converts (null-when-false)). */
  get Part3() {
    if (!(!(!this.props.ruleId)) || !(this.row?.status === 'done')) return undefined as never
    return __parts.Part3
  }

  get show_row_running_start() {
    if (!(!(!this.props.ruleId))) return undefined as never
    return !this.row && !this.running && !this.start.isError
  }

  launch() {
    if (!this.props.ruleId) return
    const to = new Date()
    // One minute of margin. The server refuses a window starting before
    // `now - 30 days` rather than silently shortening it, and its `now` is a
    // round trip later than ours: an exact 30-day request would be refused for
    // the few seconds the request spent travelling.
    const from = new Date(to.getTime() - this.days * 86_400_000 + 60_000)
    this.start.mutate(
      { id: this.props.ruleId, from: from.toISOString(), to: to.toISOString() },
      { onSuccess: bt => this.runId = bt.id },
    )
  }

  button_click(_sender: unknown, args: MouseEventArgs) {
    const { d } = args.row as RowOf_rows_windows
    if (!(!(!this.props.ruleId))) return undefined as never
    this.days = d
  }

}

type RowOf_rows_windows = ImpactPanel['rows_windows'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type ImpactPanelStores = ReturnType<ImpactPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ImpactPanelHooks = ReturnType<ImpactPanel['useHooks']>

export default ImpactPanel.component()
