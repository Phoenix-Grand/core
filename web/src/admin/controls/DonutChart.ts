/**
 * Code-behind of `DonutChart.kbcontrol` (converted from `DonutChart.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'

import { ViewBase } from './DonutChart.kbcontrol'
import * as __parts from './DonutChart.parts.tsx'

export type DonutChartProps = { data: { label: string; value: number; color: string }[]; centerValue?: string; centerLabel?: string; size?: number }

export class DonutChart extends ViewBase {
  @bind accessor hi: number | null = null

  get size() {
    return this.props.size ?? 150
  }

  get total(): number {
    return this.props.data.reduce((s, d) => s + d.value, 0)
  }

  get stroke(): 18 {
    return 18
  }

  get r(): number {
    return (this.size - this.stroke - 6) / 2
  }

  get c(): number {
    return 2 * Math.PI * this.r
  }

  get offset(): number {
    return 0
  }

  get active(): { label: string; value: number; color: string; } | null {
    return this.memo('active', [this.hi, this.props], () => this.hi !== null ? this.props.data[this.hi] : null)
  }

  get part1_props() {
    return this.memo('part1_props', [this.size, this.memo, this.hi, this.r, this.stroke, this.total, this.props, this.c, this.offset, this.active], () => ({ size: this.size, setHi: this.memo("setHi:bound", [], () => this.setHi.bind(this)), r: this.r, stroke: this.stroke, total: this.total, data: this.props.data, hi: this.hi, c: this.c, offset: this.offset, active: this.active, centerValue: this.props.centerValue, centerLabel: this.props.centerLabel }))
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (<span> with a computed style). */
  get Part2() {
    return __parts.Part2
  }

  /** The rows of the Repeater over `data`. */
  get rows_data() {
    return this.memo('rows_data', [this.props, this.hi, this.total], () => this.props.data.map((d, i) => {
      return { d, i, li_class: `flex items-center gap-2 text-sm rounded-md px-1.5 py-1 -mx-1.5 cursor-default transition-colors ${this.hi === i ? 'bg-surface-1' : ''}`, part2_props: { d: d }, span_text: String(this.total > 0 ? Math.round((d.value / this.total) * 100) : 0) + "%", key: i }
    }))
  }

  panel_mouse_enter(_sender: unknown, args: MouseEventArgs) {
    const { i } = args.row as RowOf_rows_data
    this.hi = i
  }

  panel_mouse_leave(_sender: unknown, _args: MouseEventArgs) {
    this.hi = null
  }

  /** `setHi` of the TSX: a value, or an update of the previous one. */
  setHi(value: number | null | ((prev: number | null) => number | null)) {
    this.hi = typeof value === 'function' ? (value as (prev: number | null) => number | null)(this.hi) : value
  }

}

type RowOf_rows_data = DonutChart['rows_data'][number]

export default DonutChart.component()
