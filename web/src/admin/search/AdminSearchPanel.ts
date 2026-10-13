/**
 * Code-behind of `AdminSearchPanel.kbcontrol` (converted from `AdminSearchPanel.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { groupRuns, type AdminResult } from "./adminSearchIndex"
import type { RecentTarget } from "./adminSearchRecents"
import { ResultRow } from "./ResultRow"

import { ViewBase } from './AdminSearchPanel.kbcontrol'
import * as __parts from './AdminSearchPanel.parts'

export interface RowProps {
  result:   AdminResult
  active:   boolean
  optionId: string
  mobile:   boolean
  onPick:   (r: AdminResult) => void
  /** Keeps the input focused: a row must never steal it away from the field. */
  onHover:  () => void
}

export interface PanelProps {
  listId:      string
  optionId:    (index: number) => string
  /** Flat list in keyboard order — the single source of both orders. */
  results:     AdminResult[]
  activeIndex: number
  setActive:   (index: number) => void
  onPick:      (result: AdminResult) => void
  onNavigate:  (url: string) => void
  query:       string
  recents:     RecentTarget[]
  suggestions: AdminResult[]
  nearMisses:  AdminResult[]
  loading:     boolean
  mobile:      boolean
}

export class AdminSearchPanel extends ViewBase {
  tr!: AdminSearchPanelStores['t']

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

  get listId() {
    return (this.props).listId
  }

  get optionId() {
    return this.memo('optionId', [this.props], () => (this.props).optionId)
  }

  get results() {
    return this.memo('results', [this.props], () => (this.props).results)
  }

  get activeIndex() {
    return (this.props).activeIndex
  }

  get setActive() {
    return this.memo('setActive', [this.props], () => (this.props).setActive)
  }

  get onPick() {
    return this.memo('onPick', [this.props], () => (this.props).onPick)
  }

  get onNavigate() {
    return this.memo('onNavigate', [this.props], () => (this.props).onNavigate)
  }

  get query() {
    return (this.props).query
  }

  get mobile() {
    return (this.props).mobile
  }

  get nothing(): boolean {
    if (!(!!(!this.query.trim()))) return undefined as never
    return this.props.recents.length === 0 && this.props.suggestions.length === 0
  }

  get runs() {
    return this.memo('runs', [this.results, this.query, this.nothing], () => {
      if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(!(this.results.length === 0))) return undefined as never
      return groupRuns(this.results)
    })
  }

  get index(): number {
    if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(!(this.results.length === 0))) return undefined as never
    return -1
  }

  get show_case_1() {
    return !!((!this.query.trim()) && (this.nothing))
  }

  get part1_props() {
    return this.memo('part1_props', [this.listId, this.tr, this.query, this.nothing], () => {
      if (!((!this.query.trim()) && (this.nothing))) return undefined as never
      return ({ listId: this.listId, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<ul id>: attribute(s) without a .kbview property). */
  get Part1() {
    if (!((!this.query.trim()) && (this.nothing))) return undefined as never
    return __parts.Part1
  }

  get show_case_2() {
    return !((!this.query.trim()) && (this.nothing)) && !!(!this.query.trim())
  }

  get part2_props() {
    return this.memo('part2_props', [this.listId, this.tr, this.props, this.activeIndex, this.optionId, this.mobile, this.onPick, this.setActive, this.query, this.nothing], () => {
      if (!(!((!this.query.trim()) && (this.nothing))) || !(!this.query.trim())) return undefined as never
      return ({ listId: this.listId, t: this.tr, props: this.props, activeIndex: this.activeIndex, optionId: this.optionId, mobile: this.mobile, onPick: this.onPick, setActive: this.setActive })
    })
  }

  /** A part of the screen still written in React (<ul id>: attribute(s) without a .kbview property). */
  get Part2() {
    if (!(!((!this.query.trim()) && (this.nothing))) || !(!this.query.trim())) return undefined as never
    return __parts.Part2
  }

  get show_case_3() {
    return !((!this.query.trim()) && (this.nothing)) && !(!this.query.trim()) && !!(this.results.length === 0)
  }

  get search_none_title_q() {
    if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(this.results.length === 0)) return undefined as never
    return this.query.trim()
  }

  get description() {
    if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(this.results.length === 0)) return undefined as never
    return this.props.loading
              ? this.tr('admin.search_searching')
              : this.props.nearMisses.length > 0
                ? this.tr('admin.search_none_desc_near')
                : this.tr('admin.search_none_desc')
  }

  get show_near_misses() {
    if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(this.results.length === 0)) return undefined as never
    return this.props.nearMisses.length > 0
  }

  /** `<Heading>`, rendered by a ReactHost. */
  get Heading() {
    if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(this.results.length === 0) || !(this.props.nearMisses.length > 0)) return undefined as never
    return __parts.Heading
  }

  get heading_props() {
    return this.memo('heading_props', [this.tr, this.query, this.nothing, this.results, this.props], () => {
      if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(this.results.length === 0) || !(this.props.nearMisses.length > 0)) return undefined as never
      return ({ label: this.tr('admin.search_cat_suggested') })
    })
  }

  /** `<ResultRow>`, rendered by a ReactHost. */
  get ResultRow() {
    if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(this.results.length === 0) || !(this.props.nearMisses.length > 0)) return undefined as never
    return ResultRow
  }

  /** The rows of the Repeater over `props.nearMisses`. */
  get rows_near_misses() {
    return this.memo('rows_near_misses', [this.props, this.query, this.nothing, this.results, this.listId, this.mobile, this.onPick], () => {
      if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(this.results.length === 0) || !(this.props.nearMisses.length > 0)) return undefined as never
      return this.props.nearMisses.map((r) => {
      return { r, result_row_props: ((!((!this.query.trim()) && (this.nothing))) && (!(!this.query.trim())) && (this.results.length === 0) && (this.props.nearMisses.length > 0)) ? ({ result: r, active: false, optionId: `${this.listId}-near-${r.key}`, mobile: this.mobile, onPick: this.onPick, onHover: () => { /* not keyboard-reachable */ } } as React.ComponentProps<typeof ResultRow>) : undefined, key: r.key }
    })
    })
  }

  get show_main() {
    return !((!this.query.trim()) && (this.nothing)) && !(!this.query.trim()) && !(this.results.length === 0)
  }

  get part3_props() {
    return this.memo('part3_props', [this.listId, this.tr, this.runs, this.onNavigate, this.query, this.index, this.activeIndex, this.optionId, this.mobile, this.onPick, this.setActive, this.nothing, this.results], () => {
      if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(!(this.results.length === 0))) return undefined as never
      return ({ listId: this.listId, t: this.tr, runs: this.runs, onNavigate: this.onNavigate, query: this.query, index: this.index, activeIndex: this.activeIndex, optionId: this.optionId, mobile: this.mobile, onPick: this.onPick, setActive: this.setActive })
    })
  }

  /** A part of the screen still written in React (<ul id>: attribute(s) without a .kbview property). */
  get Part3() {
    if (!(!((!this.query.trim()) && (this.nothing))) || !(!(!this.query.trim())) || !(!(this.results.length === 0))) return undefined as never
    return __parts.Part3
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AdminSearchPanelStores = ReturnType<AdminSearchPanel['useStores']>

export default AdminSearchPanel.component()
