/**
 * Code-behind of `HBarList.kbcontrol` (converted from `HBarList.tsx` by @kubuno/views-migrate).
 */

import { ViewBase } from './HBarList.kbcontrol'
import * as __parts from './HBarList.parts.tsx'

export type HBarListProps = {
  /** `color` per item overrides the list's own — a printed report ties each bar
      to the slice and to the table row that carry the same entry. */
  items: { label: string; value: number; max: number; sub?: string; color?: string }[]
  color?: string
  /** Paints a nearly-full bar in the danger colour. Right when `max` is a LIMIT
      (a quota being consumed), wrong when it is merely the largest value in the
      list: the leader of a ranking would then always be red, and red would be
      saying "problem" about the most-used room, which is good news. */
  warnFull?: boolean
}

export class HBarList extends ViewBase {
  get color() {
    return this.props.color ?? '#1a73e8'
  }

  get warnFull() {
    return this.props.warnFull ?? true
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part1() {
    return __parts.Part1
  }

  /** The rows of the Repeater over `items`. */
  get rows_items() {
    return this.memo('rows_items', [this.props, this.warnFull, this.color], () => this.props.items.map((it, i) => {
      const pct = it.max > 0 ? Math.min(100, (it.value / it.max) * 100) : 0
      const over = this.warnFull && pct >= 90
      return { it, i, pct, over, tooltip: `${Math.round(pct)} %`, part1_props: { pct: pct, over: over, it: it, color: this.color }, key: i }
    }))
  }

}

export default HBarList.component()
