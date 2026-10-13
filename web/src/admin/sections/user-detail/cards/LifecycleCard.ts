/**
 * Code-behind of `LifecycleCard.kbcontrol` (converted from `LifecycleCard.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import type { User } from "../../../../core/types"

import { ViewBase } from './LifecycleCard.kbcontrol'
import * as __parts from './LifecycleCard.parts'

export type LifecycleCardProps = { user: User }

export class LifecycleCard extends ViewBase {
  tr!: LifecycleCardStores['t']
  i18n!: LifecycleCardStores['i18n']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    return { t, i18n }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n })
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.props, this.i18n], () => ({ t: this.tr, user: this.props.user, i18n: this.i18n, user_last_login_at: this.props.user?.last_login_at }))
  }

  /** A part of the screen still written in React (<dl> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type LifecycleCardStores = ReturnType<LifecycleCard['useStores']>

export default LifecycleCard.component()
