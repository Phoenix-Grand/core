/**
 * Code-behind of `DatabasePanel.kbview` (converted from `DatabasePanel.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { usePrivileges } from "../../core/authz/usePrivileges"

import { ViewBase } from './DatabasePanel.kbview'

export class DatabasePanel extends ViewBase {
  isSuperuser!: boolean

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { isSuperuser } = usePrivileges()
    return { t, isSuperuser }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ isSuperuser: s.isSuperuser })
  }

  get show_case_1() {
    return !!(!this.isSuperuser)
  }

  get show_main() {
    return !(!this.isSuperuser)
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DatabasePanelStores = ReturnType<DatabasePanel['useStores']>

export default DatabasePanel.component()
