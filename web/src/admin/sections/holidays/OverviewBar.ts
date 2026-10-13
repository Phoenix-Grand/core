/**
 * Code-behind of `OverviewBar.kbcontrol` (converted from `OverviewBar.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useHolidaysOverview, useReloadDataset } from "./api"

import { ViewBase } from './OverviewBar.kbcontrol'
import * as __parts from './OverviewBar.parts'

export type OverviewBarProps = { canManage: boolean }

export class OverviewBar extends ViewBase {
  @bind accessor error: string | null = null
  tr!: OverviewBarStores['t']
  data!: OverviewBarStores['data']
  reload!: OverviewBarStores['reload']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { data } = useHolidaysOverview()
    const reload = useReloadDataset()
    return { t, data, reload }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, data: s.data, reload: s.reload })
  }

  get stale(): boolean {
    if (!(!(!this.data))) return undefined as never
    return this.data.dataset_loaded !== this.data.dataset_shipped
  }

  get show_case_1() {
    return !!(!this.data)
  }

  get show_main() {
    return !(!this.data)
  }

  /** `<Figure>`, rendered by a ReactHost. */
  get Figure() {
    if (!(!(!this.data))) return undefined as never
    return __parts.Figure
  }

  get figure_props() {
    return this.memo('figure_props', [this.data, this.tr], () => {
      if (!(!(!this.data))) return undefined as never
      return ({ value: this.data.countries, label: this.tr('admin.hol_stat_countries') })
    })
  }

  get figure_props2() {
    return this.memo('figure_props2', [this.data, this.tr], () => {
      if (!(!(!this.data))) return undefined as never
      return ({ value: this.data.holidays, label: this.tr('admin.hol_stat_days') })
    })
  }

  get figure_props3() {
    return this.memo('figure_props3', [this.data, this.tr], () => {
      if (!(!(!this.data))) return undefined as never
      return ({ value: this.data.overridden, label: this.tr('admin.hol_stat_corrected') })
    })
  }

  get figure_props4() {
    return this.memo('figure_props4', [this.data, this.tr], () => {
      if (!(!(!this.data))) return undefined as never
      return ({ value: this.data.custom, label: this.tr('admin.hol_stat_custom') })
    })
  }

  get hol_dataset_version() {
    if (!(!(!this.data))) return undefined as never
    return this.data.dataset_loaded ?? '—'
  }

  get part1_props() {
    return this.memo('part1_props', [this.reload, this.memo, this.error, this.tr, this.data, this.props], () => {
      if (!(!(!this.data)) || !(this.props.canManage)) return undefined as never
      return ({ reload: this.reload, setError: this.memo("setError:bound", [], () => this.setError.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part1() {
    if (!(!(!this.data)) || !(this.props.canManage)) return undefined as never
    return __parts.Part1
  }

  get hol_dataset_stale_version() {
    if (!(!(!this.data)) || !(this.stale)) return undefined as never
    return this.data.dataset_shipped
  }

  get show_data_orphans() {
    if (!(!(!this.data))) return undefined as never
    return this.data.orphans > 0
  }

  get hol_orphans_count() {
    if (!(!(!this.data)) || !(this.data.orphans > 0)) return undefined as never
    return this.data.orphans
  }

  get show_error() {
    if (!(!(!this.data))) return undefined as never
    return !!(this.error)
  }

  /** `setError` of the TSX: a value, or an update of the previous one. */
  setError(value: string | null | ((prev: string | null) => string | null)) {
    this.error = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.error) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type OverviewBarStores = ReturnType<OverviewBar['useStores']>

export default OverviewBar.component()
