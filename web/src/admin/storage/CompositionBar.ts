/**
 * Code-behind of `CompositionBar.kbcontrol` (converted from `CompositionBar.tsx` by @kubuno/views-migrate).
 */
import { formatBytes } from "../sections/format"
import { type Segment } from "./charts"

import { ViewBase } from './CompositionBar.kbcontrol'
import * as __parts from './CompositionBar.parts'

export type CompositionBarProps = {
  segments:  Segment[]
  total:     number
  ariaLabel: string
  format?:   (n: number) => string
}

export class CompositionBar extends ViewBase {
  get format() {
    return this.props.format ?? formatBytes
  }

  get safeTotal(): number {
    return this.props.total > 0 ? this.props.total : 1
  }

  get visible(): Segment[] {
    return this.memo('visible', [this.props, this.safeTotal], () => this.props.segments.filter(s => !s.track && s.value / this.safeTotal >= 0.005))
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part1() {
    return __parts.Part1
  }

  /** The rows of the Repeater over `visible`. */
  get rows_visible() {
    return this.memo('rows_visible', [this.visible, this.safeTotal], () => this.visible.map((s, i) => {
      return { s, i, part1_props: { s: s, safeTotal: this.safeTotal, i: i }, key: s.id }
    }))
  }

  /** A part of the screen still written in React (<span> with a computed style). */
  get Part2() {
    return __parts.Part2
  }

  /** The rows of the Repeater over `segments`. */
  get rows_segments() {
    return this.memo('rows_segments', [this.props, this.format], () => this.props.segments.map((s) => {
      return { s, part2_props: { s: s }, span_text: this.format(s.value), key: s.id }
    }))
  }

}

export default CompositionBar.component()
