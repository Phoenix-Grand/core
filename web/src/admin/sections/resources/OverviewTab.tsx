/**
 * Code-behind of `OverviewTab.kbcontrol` (converted from `OverviewTab.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { Building2, CalendarRange, DoorOpen, Users } from "lucide-react"
import { useResourceOverview } from "./api"
import type { ResourcePane } from "./panes"

import { ViewBase } from './OverviewTab.kbcontrol'
import * as __parts from './OverviewTab.parts'

export type OverviewTabProps = { onGo: (pane: ResourcePane) => void }

export class OverviewTab extends ViewBase {
  tr!: OverviewTabStores['t']
  data!: OverviewTabStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: OverviewTabStores['refetch']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { data, isLoading, isError, refetch } = useResourceOverview()
    return { t, data, isLoading, isError, refetch }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch })
  }

  get allGaps(): { key: string; count: number; text: string; pane: ResourcePane }[] {
    return this.memo('allGaps', [this.data, this.tr, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return [
    {
      key: 'empty_buildings',
      count: this.data.empty_buildings,
      text: this.tr('admin.res_gap_empty_buildings', { count: this.data.empty_buildings }),
      pane: 'buildings',
    },
    {
      key: 'undescribed',
      count: this.data.undescribed,
      text: this.tr('admin.res_gap_undescribed', { count: this.data.undescribed }),
      pane: 'resources',
    },
    {
      key: 'unused_features',
      count: this.data.unused_features,
      text: this.tr('admin.res_gap_unused_features', { count: this.data.unused_features }),
      pane: 'features',
    },
  ]
    })
  }

  get gaps(): { key: string; count: number; text: string; pane: ResourcePane; }[] {
    return this.memo('gaps', [this.allGaps, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return this.allGaps.filter(g => g.count > 0)
    })
  }

  get isEmpty(): boolean {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data.buildings === 0 && this.data.resources === 0 && this.data.features === 0
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.isError || !this.data)
  }

  get show_main() {
    return !(this.isLoading) && !(this.isError || !this.data)
  }

  /** `<Stat>`, rendered by a ReactHost. */
  get Stat() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Stat
  }

  get stat_props() {
    return this.memo('stat_props', [this.data, this.tr, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ icon: <Building2 size={17} />, value: this.data.buildings, label: this.tr('admin.res_stat_buildings') })
    })
  }

  get stat_props2() {
    return this.memo('stat_props2', [this.data, this.tr, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ icon: <CalendarRange size={17} />, value: this.data.resources, label: this.tr('admin.res_stat_resources') })
    })
  }

  get stat_props3() {
    return this.memo('stat_props3', [this.data, this.tr, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ icon: <DoorOpen size={17} />, value: this.data.rooms, label: this.tr('admin.res_stat_rooms') })
    })
  }

  get stat_props4() {
    return this.memo('stat_props4', [this.data, this.tr, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ icon: <Users size={17} />, value: this.data.room_seats, label: this.tr('admin.res_stat_seats') })
    })
  }

  get show_is_empty() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return !this.isEmpty
  }

  get show_gaps() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!this.isEmpty)) return undefined as never
    return this.gaps.length === 0
  }

  get show_not_gaps() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!this.isEmpty)) return undefined as never
    return !(this.gaps.length === 0)
  }

  /** The rows of the Repeater over `gaps`. */
  get rows_gaps() {
    return this.memo('rows_gaps', [this.gaps, this.isLoading, this.isError, this.data, this.isEmpty], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!this.isEmpty) || !(!(this.gaps.length === 0))) return undefined as never
      return this.gaps.map((g) => {
      return { g, key: g.key }
    })
    })
  }

  callout_action(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(this.isError || !this.data)) return undefined as never
    void this.refetch()
  }

  button_click(_sender: unknown, args: MouseEventArgs) {
    const { g } = args.row as RowOf_rows_gaps
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!this.isEmpty) || !(!(this.gaps.length === 0))) return undefined as never
    this.props.onGo(g.pane)
  }

}

type RowOf_rows_gaps = OverviewTab['rows_gaps'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type OverviewTabStores = ReturnType<OverviewTab['useStores']>

export default OverviewTab.component()
