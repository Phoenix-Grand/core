/**
 * Code-behind of `TableFragment.kbcontrol` (converted from `TableFragment.tsx` by @kubuno/views-migrate).
 */
import { Fragment } from 'react'
import { useTranslation } from "react-i18next"
import type { TableItem } from "./types"

import { ViewBase } from './TableFragment.kbcontrol'
import * as __parts from './TableFragment.parts'

export type TableFragmentProps = {
  item:   TableItem
  /** Which rows this fragment shows, and whether it is the first/last one. */
  slice?: { from: number; to: number; continued: boolean; last: boolean }
  /**
   * Column widths, in pixels, taken once from the whole table.
   *
   * Without them a fragment lays its columns out from the rows it happens to
   * carry: the sheet whose addresses are short gets a narrow address column,
   * its neighbours' rows wrap where the measured ones did not, and the cut
   * lands somewhere other than where it was computed. Pinning the columns
   * makes every fragment the same table — which is also what a reader expects
   * of a table continued overleaf.
   */
  widths?: number[]
}

export class TableFragment extends ViewBase {
  tr!: TableFragmentStores['t']

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

  get from(): number {
    return this.props.slice?.from ?? 0
  }

  get to(): number {
    return this.props.slice?.to   ?? this.props.item.rows.length
  }

  get last(): boolean {
    return this.props.slice?.last ?? true
  }

  get h2_text() {
    return this.props.slice?.continued ? this.tr('admin.rep_continued', { title: this.props.item.title }) : this.props.item.title
  }

  get part1_props() {
    return this.memo('part1_props', [this.props, this.from, this.to, this.last], () => ({ item: this.props.item, widths: this.props.widths, from: this.from, to: this.to, last: this.last, item_foot: this.props.item?.foot }))
  }

  /** A part of the screen still written in React (<table> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

  get show_last_item_note() {
    return this.memo('show_last_item_note', [this.last, this.props], () => !!(this.last && this.props.item.note))
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_item_note() {
    return this.memo('content_item_note', [this.props, this.last], () => {
      if (!(this.last && this.props.item.note)) return undefined as never
      return ({ children: this.props.item.note })
    })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type TableFragmentStores = ReturnType<TableFragment['useStores']>

export default TableFragment.component()
