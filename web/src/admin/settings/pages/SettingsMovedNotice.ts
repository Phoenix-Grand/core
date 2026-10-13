/**
 * Code-behind of `SettingsMovedNotice.kbcontrol` (converted from `SettingsMovedNotice.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { usePrivileges } from "../../../core/authz/usePrivileges"
import { canSeeTab } from "../../adminNav"
import { SETTINGS_PAGES, FALLBACK_TAB } from "../settingsMap"

import { ViewBase } from './SettingsMovedNotice.kbcontrol'
import * as __parts from './SettingsMovedNotice.parts.tsx'

export class SettingsMovedNotice extends ViewBase {
  tr!: SettingsMovedNoticeStores['t']
  can!: SettingsMovedNoticeStores['can']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { can } = usePrivileges()
    return { t, can }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can })
  }

  get targets(): string[] {
    return this.memo('targets', [this.can], () => SETTINGS_PAGES
    .map(p => p.tab)
    .filter(tab => tab !== FALLBACK_TAB && canSeeTab(tab, this.can)))
  }

  get show_case_1() {
    return !!(this.targets.length === 0)
  }

  get show_main() {
    return !(this.targets.length === 0)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.targets], () => {
      if (!(!(this.targets.length === 0))) return undefined as never
      return ({ t: this.tr, targets: this.targets })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part1() {
    if (!(!(this.targets.length === 0))) return undefined as never
    return __parts.Part1
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SettingsMovedNoticeStores = ReturnType<SettingsMovedNotice['useStores']>

export default SettingsMovedNotice.component()
