/**
 * Code-behind of `CategoryComposition.kbcontrol` (converted from `CategoryComposition.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { formatBytes } from "../sections/format"
import { NEUTRAL_SERIES, type Segment } from "./charts"
import { type CategoryReading } from "./categories"

import { ViewBase } from './CategoryComposition.kbcontrol'
import * as __parts from './CategoryComposition.parts'

export type CategoryCompositionProps = {
  reading:   CategoryReading
  /** The server's own held total - the bar's denominator, not a re-derived sum. */
  heldBytes: number
  ariaLabel: string
  delegatedBytes:   number
  delegatedObjects: number
}

export class CategoryComposition extends ViewBase {
  tr!: CategoryCompositionStores['t']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
  }

  get segments(): Segment[] {
    return this.memo('segments', [this.props, this.tr], () => [
    ...this.props.reading.slices.map(s => ({
      id:    s.row.category,
      label: s.label,
      value: s.row.used_bytes,
      color: s.color,
    })),
    ...(this.props.reading.folded ? [{
      id:    '__cat_other',
      label: this.tr('admin.sto_cat_other', { count: this.props.reading.folded.count }),
      value: this.props.reading.folded.bytes,
      color: NEUTRAL_SERIES,
    }] : []),
  ])
  }

  get notBilled(): number {
    return Math.max(this.props.reading.heldBytes - this.props.reading.billedBytes, 0)
  }

  get show_segments() {
    return this.segments.length > 0
  }

  get show_not_segments() {
    return !(this.segments.length > 0)
  }

  /** `<CompositionBar Total>`: the server's held total, the bar's denominator. */
  get cc_total() {
    if (!(this.segments.length > 0)) return undefined as never
    return Math.max(this.props.heldBytes, this.props.reading.heldBytes, 1)
  }

  get sto_cat_split_billed() {
    if (!(this.segments.length > 0)) return undefined as never
    return formatBytes(this.props.reading.billedBytes)
  }

  get sto_cat_split_not_billed() {
    if (!(this.segments.length > 0)) return undefined as never
    return formatBytes(this.notBilled)
  }

  /** `<CategoryRow>`, rendered by a ReactHost. */
  get CategoryRow() {
    if (!(this.segments.length > 0)) return undefined as never
    return __parts.CategoryRow
  }

  /** The rows of the Repeater over `reading.slices`. */
  get rows_slices() {
    return this.memo('rows_slices', [this.props, this.segments], () => {
      if (!(this.segments.length > 0)) return undefined as never
      return this.props.reading.slices.map((s) => {
      return { s, category_row_props: ((this.segments.length > 0)) ? ({ label: s.label, color: s.color, billable: s.billable, row: s.row, showSwatch: true }) : undefined, key: s.row.category }
    })
    })
  }

  get show_reading_trash() {
    return this.memo('show_reading_trash', [this.props], () => !!(this.props.reading.trash))
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.props], () => {
      if (!(this.props.reading.trash)) return undefined as never
      return ({ t: this.tr, reading_trash: this.props.reading?.trash })
    })
  }

  /** A part of the screen still written in React (<Callout> icon: a value the property converts (null-when-false)). */
  get Part1() {
    if (!(this.props.reading.trash)) return undefined as never
    return __parts.Part1
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type CategoryCompositionStores = ReturnType<CategoryComposition['useStores']>

export default CategoryComposition.component()
