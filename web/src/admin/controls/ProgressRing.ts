/**
 * Code-behind of `ProgressRing.kbcontrol` (converted from `ProgressRing.tsx` by @kubuno/views-migrate).
 */

import { ViewBase } from './ProgressRing.kbcontrol'
import * as __parts from './ProgressRing.parts.tsx'

export type ProgressRingProps = { pct: number; label?: string; value: string; sub?: string; color?: string; size?: number }

export class ProgressRing extends ViewBase {
  get color() {
    return this.props.color ?? '#1a73e8'
  }

  get size() {
    return this.props.size ?? 132
  }

  get stroke(): 12 {
    return 12
  }

  get r(): number {
    return (this.size - this.stroke) / 2
  }

  get c(): number {
    return 2 * Math.PI * this.r
  }

  get clamped(): number {
    return Math.max(0, Math.min(100, this.props.pct))
  }

  get part1_props() {
    return this.memo('part1_props', [this.size, this.r, this.stroke, this.color, this.c, this.clamped, this.props], () => ({ size: this.size, r: this.r, stroke: this.stroke, color: this.color, c: this.c, clamped: this.clamped, value: this.props.value, label: this.props.label }))
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part1() {
    return __parts.Part1
  }

  get show_sub() {
    return !!(this.props.sub)
  }

}

export default ProgressRing.component()
