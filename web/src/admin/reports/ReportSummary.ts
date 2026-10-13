/**
 * Code-behind of `ReportSummary.kbcontrol` (converted from `ReportSummary.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react"
import type { ReportModel } from "./model"

import { ViewBase } from './ReportSummary.kbcontrol'
import * as __parts from './ReportSummary.parts'

export type ReportSummaryProps = { model: ReportModel }

export class ReportSummary extends ViewBase {
  tr!: ReportSummaryStores['t']
  i18n!: ReportSummaryStores['i18n']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    return { t, i18n }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n })
  }

  get facts(): string[] {
    return this.memo('facts', [this.i18n, this.peak, this.props, this.seriesSum, this.tr], () => (() => {
      const facts: string[] = []
      const pct = (v: number) => `${v.toLocaleString(this.i18n.language, { maximumFractionDigits: 1 })} %`
      if (this.peak && this.peak.value > 0 && this.props.model.series.length > 1) {
    facts.push(
      this.seriesSum > 0
        ? this.tr('admin.rep_sum_peak_share', {
            label: this.peak.label,
            value: this.props.model.fmt(this.peak.value),
            share: pct((this.peak.value / this.seriesSum) * 100),
          })
        : this.tr('admin.rep_sum_peak', { label: this.peak.label, value: this.props.model.fmt(this.peak.value) }),
    )
    // A window whose activity sits on a single interval is a different animal
    // from one where it is spread; the reader is told which, with the figure.
    const empty = this.props.model.series.filter(r => r.value === 0).length
    if (empty > 0 && empty < this.props.model.series.length) {
      facts.push(this.tr('admin.rep_sum_quiet', { count: empty, total: this.props.model.series.length }))
    }
  }
      if (this.props.model.breakdown.length >= 3 && this.props.model.breakdownTotal > 0) {
    const top3 = this.props.model.breakdown.slice(0, 3).reduce((a, r) => a + r.value, 0)
    facts.push(this.tr('admin.rep_sum_top3', {
      count: Math.min(3, this.props.model.breakdown.length),
      entries: this.props.model.breakdown.length,
      share: pct((top3 / this.props.model.breakdownTotal) * 100),
    }))
  } else if (this.props.model.breakdown.length > 0 && this.props.model.breakdownTotal > 0) {
    const first = this.props.model.breakdown[0]
    if (first.share !== null) {
      facts.push(this.tr('admin.rep_sum_leader', { label: first.label, share: pct(first.share) }))
    }
  }
      if (!this.props.model.snapshot && this.props.model.delta !== null && this.props.model.previous !== null) {
    facts.push(this.tr(this.props.model.delta >= 0 ? 'admin.rep_sum_up' : 'admin.rep_sum_down', {
      delta:    pct(Math.abs(this.props.model.delta)),
      previous: this.props.model.fmt(this.props.model.previous),
    }))
  }
      return facts
    })())
  }

  get peak(): { label: string; value: number; } | null {
    return this.memo('peak', [this.props], () => this.props.model.series.reduce<{ label: string; value: number } | null>(
    (best, r) => (best === null || r.value > best.value ? { label: r.label, value: r.value } : best),
    null,
  ))
  }

  get seriesSum(): number {
    return this.props.model.series.reduce((a, r) => a + r.value, 0)
  }

  get rising(): boolean {
    if (!(!(this.facts.length === 0))) return undefined as never
    return (this.props.model.delta ?? 0) > 0
  }

  get falling(): boolean {
    if (!(!(this.facts.length === 0))) return undefined as never
    return (this.props.model.delta ?? 0) < 0
  }

  get tone(): "var(--color-text-secondary)" | "var(--color-success)" | "var(--color-danger)" {
    if (!(!(this.facts.length === 0))) return undefined as never
    const model = this.props.model
    const rising = (model.delta ?? 0) > 0
    const falling = (model.delta ?? 0) < 0
    return model.snapshot || model.delta === null ? 'var(--color-text-secondary)'
    : rising ? 'var(--color-success)' : falling ? 'var(--color-danger)' : 'var(--color-text-secondary)'
  }

  get Arrow() {
    return this.memo('Arrow', [this.facts, this.props], () => {
      if (!(!(this.facts.length === 0))) return undefined as never
      const model = this.props.model
      const rising = (model.delta ?? 0) > 0
      return model.delta === null || model.snapshot ? ArrowRight : rising ? ArrowUpRight : ArrowDownRight
    })
  }

  get show_case_1() {
    return !!(this.facts.length === 0)
  }

  get show_main() {
    return !(this.facts.length === 0)
  }

  get show_model_snapshot_model() {
    if (!(!(this.facts.length === 0))) return undefined as never
    return !this.props.model.snapshot && this.props.model.delta !== null
  }

  get part1_props() {
    return this.memo('part1_props', [this.tone, this.Arrow, this.props, this.i18n, this.facts], () => {
      if (!(!(this.facts.length === 0)) || !(!this.props.model.snapshot && this.props.model.delta !== null)) return undefined as never
      return ({ tone: this.tone, Arrow: this.Arrow, model_delta: this.props.model?.delta, i18n: this.i18n })
    })
  }

  /** A part of the screen still written in React (<p> with a computed style). */
  get Part1() {
    if (!(!(this.facts.length === 0)) || !(!this.props.model.snapshot && this.props.model.delta !== null)) return undefined as never
    return __parts.Part1
  }

  /** A part of the screen still written in React (<span data-tone>: data attributes on a text). */
  get Part2() {
    return __parts.Part2
  }

  /** The rows of the Repeater over `facts`. */
  get rows_facts() {
    return this.memo('rows_facts', [this.facts], () => {
      if (!(!(this.facts.length === 0))) return undefined as never
      return this.facts.map((f, i) => {
      return { f, i, key: i }
    })
    })
  }

  pct(v: number) {
    return `${v.toLocaleString(this.i18n.language, { maximumFractionDigits: 1 })} %`
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ReportSummaryStores = ReturnType<ReportSummary['useStores']>

export default ReportSummary.component()
