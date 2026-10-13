/**
 * Code-behind of `HomeSection.kbview` (converted from `HomeSection.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { canSeeTab } from "../adminNav"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { useAdminStats } from "./adminStats"
import GettingStartedCard from "../health/GettingStartedCard"
import AlertsCard from "../alerts/AlertsCard"

import { ViewBase } from './HomeSection.kbview'
import * as __parts from './HomeSection.parts'

export class HomeSection extends ViewBase {
  tr!: HomeSectionStores['t']
  can!: HomeSectionStores['can']
  stats!: HomeSectionStores['stats']
  isLoading!: HomeSectionStores['isLoading']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { can } = usePrivileges()
    const { data: stats, isLoading } = useAdminStats()
    return { t, can, stats, isLoading }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, stats: s.stats, isLoading: s.isLoading })
  }

  get hasStats() {
    return this.can(PRIV.STATS_READ)
  }

  get storageUsed() {
    return this.stats?.storage_used ?? 0
  }

  get storageQuota() {
    return this.stats?.storage_quota_total ?? 0
  }

  get storagePct() {
    return this.storageQuota > 0 ? Math.min(100, (this.storageUsed / this.storageQuota) * 100) : 0
  }

  /** `<GettingStartedCard>`, rendered by a ReactHost. */
  get GettingStartedCard() {
    return GettingStartedCard
  }

  get show_sees_users() {
    return this.sees('users')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.hasStats, this.stats], () => {
      if (!(this.sees('users'))) return undefined as never
      return ({ t: this.tr, hasStats: this.hasStats, num: this.num.bind(this), stats: this.stats, sees: this.sees.bind(this) })
    })
  }

  /** A part of the screen still written in React (<HomeCard> is no .kbview element (a local or dynamic component)). */
  get Part1() {
    if (!(this.sees('users'))) return undefined as never
    return __parts.Part1
  }

  get show_sees_modules() {
    return this.sees('modules')
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.hasStats, this.stats], () => {
      if (!(this.sees('modules'))) return undefined as never
      return ({ t: this.tr, hasStats: this.hasStats, num: this.num.bind(this), stats: this.stats, sees: this.sees.bind(this) })
    })
  }

  /** A part of the screen still written in React (<HomeCard> is no .kbview element (a local or dynamic component)). */
  get Part2() {
    if (!(this.sees('modules'))) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.storageUsed, this.storageQuota, this.storagePct, this.hasStats], () => {
      if (!(this.hasStats)) return undefined as never
      return ({ t: this.tr, storageUsed: this.storageUsed, storageQuota: this.storageQuota, storagePct: this.storagePct })
    })
  }

  /** A part of the screen still written in React (<HomeCard> is no .kbview element (a local or dynamic component)). */
  get Part3() {
    if (!(this.hasStats)) return undefined as never
    return __parts.Part3
  }

  get show_sees_sso() {
    return this.sees('sso')
  }

  get part4_props() {
    return this.memo('part4_props', [this.tr], () => {
      if (!(this.sees('sso'))) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<HomeCard> is no .kbview element (a local or dynamic component)). */
  get Part4() {
    if (!(this.sees('sso'))) return undefined as never
    return __parts.Part4
  }

  get show_sees_alerts() {
    return this.sees('alerts')
  }

  /** `<AlertsCard>`, rendered by a ReactHost. */
  get AlertsCard() {
    return AlertsCard
  }

  get show_sees_groups() {
    return this.sees('groups')
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr], () => {
      if (!(this.sees('groups'))) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<HomeCard> is no .kbview element (a local or dynamic component)). */
  get Part5() {
    if (!(this.sees('groups'))) return undefined as never
    return __parts.Part5
  }

  get show_sees_settings() {
    return this.sees('settings')
  }

  get part6_props() {
    return this.memo('part6_props', [this.tr], () => {
      if (!(this.sees('settings'))) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<HomeCard> is no .kbview element (a local or dynamic component)). */
  get Part6() {
    if (!(this.sees('settings'))) return undefined as never
    return __parts.Part6
  }

  get show_sees_event_log() {
    return this.sees('event-log')
  }

  get part7_props() {
    return this.memo('part7_props', [this.tr], () => {
      if (!(this.sees('event-log'))) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<HomeCard> is no .kbview element (a local or dynamic component)). */
  get Part7() {
    if (!(this.sees('event-log'))) return undefined as never
    return __parts.Part7
  }

  sees(tab: string) {
    return canSeeTab(tab, this.can)
  }

  num(v?: number) {
    return (this.isLoading ? '…' : (v ?? 0).toLocaleString())
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type HomeSectionStores = ReturnType<HomeSection['useStores']>

export default HomeSection.component()
