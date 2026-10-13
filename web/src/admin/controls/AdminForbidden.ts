/**
 * Code-behind of `AdminForbidden.kbcontrol` (converted from `AdminForbidden.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"

import { ViewBase } from './AdminForbidden.kbcontrol'

export type AdminForbiddenProps = { titleKey?: string }

export class AdminForbidden extends ViewBase {
  tr!: AdminForbiddenStores['t']

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

  get description() {
    return this.props.titleKey
          ? this.tr('admin.forbidden_desc_section', { section: this.tr(this.props.titleKey) })
          : this.tr('admin.forbidden_desc')
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AdminForbiddenStores = ReturnType<AdminForbidden['useStores']>

export default AdminForbidden.component()
