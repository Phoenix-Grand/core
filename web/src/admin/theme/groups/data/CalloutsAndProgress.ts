/**
 * Code-behind of `CalloutsAndProgress.kbcontrol` (converted from `CalloutsAndProgress.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"

import { ViewBase } from './CalloutsAndProgress.kbcontrol'

export class CalloutsAndProgress extends ViewBase {
  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    this.useStores()
  }

  callout_action(_sender: unknown, _args: EventArgs) {
}

  callout_action2(_sender: unknown, _args: EventArgs) {
}

}

/** What `useStores()` gives (the types of the fields it fills). */
export type CalloutsAndProgressStores = ReturnType<CalloutsAndProgress['useStores']>

export default CalloutsAndProgress.component()
