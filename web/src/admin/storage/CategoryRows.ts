/**
 * Code-behind of `CategoryRows.kbcontrol` (converted from `CategoryRows.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { categoryLabel, type CategoryRules } from "./categories"
import type { CategoryUsage } from "./api"

import { ViewBase } from './CategoryRows.kbcontrol'
import * as __parts from './CategoryRows.parts'

export type CategoryRowsProps = {
  rows:  CategoryUsage[]
  rules: CategoryRules
}

export class CategoryRows extends ViewBase {
  tr!: CategoryRowsStores['t']

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

  get held(): CategoryUsage[] {
    return this.memo('held', [this.props], () => this.props.rows
    .filter(r => this.props.rules.held(r) && r.used_bytes > 0)
    .sort((a, b) => this.props.rules.order(a.category) - this.props.rules.order(b.category)))
  }

  get show_case_1() {
    return !!(this.held.length === 0)
  }

  get show_main() {
    return !(this.held.length === 0)
  }

  /** `<CategoryRow>`, rendered by a ReactHost. */
  get CategoryRow() {
    if (!(!(this.held.length === 0))) return undefined as never
    return __parts.CategoryRow
  }

  /** The rows of the Repeater over `held`. */
  get rows_held() {
    return this.memo('rows_held', [this.held, this.tr, this.props], () => {
      if (!(!(this.held.length === 0))) return undefined as never
      return this.held.map((row) => {
      return { row, category_row_props: ((!(this.held.length === 0))) ? ({ label: categoryLabel(this.tr, row.category), color: null, billable: this.props.rules.billable(row), row: row, showSwatch: false }) : undefined, key: row.category }
    })
    })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type CategoryRowsStores = ReturnType<CategoryRows['useStores']>

export default CategoryRows.component()
