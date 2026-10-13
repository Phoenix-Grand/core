/**
 * Code-behind of `ComingSoon.kbcontrol` (converted from `ComingSoon.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"

import { ViewBase } from './ComingSoon.kbcontrol'

export type ComingSoonProps = { titleKey: string }

export class ComingSoon extends ViewBase {
  tr!: ComingSoonStores['t']

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

  get h2_text() {
    return this.tr(this.props.titleKey)
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ComingSoonStores = ReturnType<ComingSoon['useStores']>

export default ComingSoon.component()
