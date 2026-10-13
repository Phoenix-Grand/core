/**
 * Code-behind of `HealthTopbarChip.kbcontrol` (converted from `HealthTopbarChip.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { useLocation, useNavigate } from "react-router-dom"
import { AlertTriangle, OctagonAlert } from "lucide-react"
import { useAuthStore } from "../../core/store/authStore"
import { useHealthChecks } from "./useHealthChecks"
import { adminUrl } from "../adminAction"
import { SNOOZE_DAYS, isSnoozed, snooze } from "./snooze"

import { ViewBase } from './HealthTopbarChip.kbcontrol'
import * as __parts from './HealthTopbarChip.parts'

export class HealthTopbarChip extends ViewBase {
  tr!: HealthTopbarChipStores['t']
  navigate!: HealthTopbarChipStores['navigate']
  pathname!: string
  user!: HealthTopbarChipStores['user']
  snoozedAt!: HealthTopbarChipStores['snoozedAt']
  data!: HealthTopbarChipHooks['data']
  onSnooze!: () => void

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { pathname } = useLocation()
    const user = useAuthStore(s => s.user)
    const [snoozedAt, setSnoozedAt] = useState<boolean>(() => isSnoozed())
    const onSnooze = useCallback(() => {
      snooze()
      setSnoozedAt(isSnoozed())
    }, [])
    return { t, navigate, pathname, user, snoozedAt, setSnoozedAt, onSnooze }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data } = useHealthChecks(this.relevant)
    this.publish({ data })
    return { data }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, navigate: s.navigate, pathname: s.pathname, user: s.user, snoozedAt: s.snoozedAt, onSnooze: s.onSnooze })
    const h = this.useHooks()
    this.publish({ data: h.data })
  }

  get relevant(): boolean {
    return this.user?.role === 'admin' &&
    this.pathname.startsWith('/admin') &&
    !this.pathname.includes('security-health')
  }

  get critical() {
    if (!(!(!this.relevant || !this.data))) return undefined as never
    return (this.data.counts).critical
  }

  get warning() {
    if (!(!(!this.relevant || !this.data))) return undefined as never
    return (this.data.counts).warning
  }

  get isCritical(): boolean {
    if (!(!(!this.relevant || !this.data))) return undefined as never
    return this.critical > 0
  }

  get Icon() {
    return this.memo('Icon', [this.isCritical, this.relevant, this.data, this.warning, this.snoozedAt], () => {
      if (!(!(!this.relevant || !this.data)) || !(!(!this.isCritical && (this.warning === 0 || this.snoozedAt)))) return undefined as never
      return this.isCritical ? OctagonAlert : AlertTriangle
    })
  }

  get tone(): "border-danger" | "border-warning" {
    if (!(!(!this.relevant || !this.data)) || !(!(!this.isCritical && (this.warning === 0 || this.snoozedAt)))) return undefined as never
    return this.isCritical ? 'border-danger' : 'border-warning'
  }

  get show_case_1() {
    return !!(!this.relevant || !this.data)
  }

  get show_case_2() {
    return !(!this.relevant || !this.data) && !!(!this.isCritical && (this.warning === 0 || this.snoozedAt))
  }

  get show_main() {
    return !(!this.relevant || !this.data) && !(!this.isCritical && (this.warning === 0 || this.snoozedAt))
  }

  get div_class() {
    if (!(!(!this.relevant || !this.data)) || !(!(!this.isCritical && (this.warning === 0 || this.snoozedAt)))) return undefined as never
    return `hidden md:flex min-w-0 items-center gap-2 rounded-full border ${this.tone}
                  bg-surface-0 py-1 pl-3 pr-1.5 shadow-sm`
  }

  get part1_props() {
    return this.memo('part1_props', [this.Icon, this.isCritical, this.relevant, this.data, this.warning, this.snoozedAt], () => {
      if (!(!(!this.relevant || !this.data)) || !(!(!this.isCritical && (this.warning === 0 || this.snoozedAt)))) return undefined as never
      return ({ Icon: this.Icon, isCritical: this.isCritical })
    })
  }

  /** A part of the screen still written in React (<Icon> is no .kbview element (a local or dynamic component)). */
  get Part1() {
    if (!(!(!this.relevant || !this.data)) || !(!(!this.isCritical && (this.warning === 0 || this.snoozedAt)))) return undefined as never
    return __parts.Part1
  }

  get span_text() {
    if (!(!(!this.relevant || !this.data)) || !(!(!this.isCritical && (this.warning === 0 || this.snoozedAt)))) return undefined as never
    return this.isCritical
          ? this.tr('admin.hc_banner_critical_title', { n: this.critical })
          : this.tr('admin.hc_banner_warning_title', { n: this.warning })
  }

  get show_is_critical() {
    if (!(!(!this.relevant || !this.data)) || !(!(!this.isCritical && (this.warning === 0 || this.snoozedAt)))) return undefined as never
    return !this.isCritical
  }

  get hc_banner_warning_body_days() {
    if (!(!(!this.relevant || !this.data)) || !(!(!this.isCritical && (this.warning === 0 || this.snoozedAt))) || !(!this.isCritical)) return undefined as never
    return SNOOZE_DAYS
  }

  open() {
    if (!(!(!this.relevant || !this.data))) return undefined as never
    return this.navigate(adminUrl({ tab: 'security-health' }))
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(!this.relevant || !this.data)) || !(!(!this.isCritical && (this.warning === 0 || this.snoozedAt))) || !(!this.isCritical)) return undefined as never
    this.onSnooze()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type HealthTopbarChipStores = ReturnType<HealthTopbarChip['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type HealthTopbarChipHooks = ReturnType<HealthTopbarChip['useHooks']>

export default HealthTopbarChip.component()
