/**
 * Code-behind of `AdminSectionNotFound.kbcontrol` (converted from `AdminSectionNotFound.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { ADMIN_ROOT } from "../adminRoute"

import { ViewBase } from './AdminSectionNotFound.kbcontrol'

export type AdminSectionNotFoundProps = { tab: string }

export class AdminSectionNotFound extends ViewBase {
  navigate!: AdminSectionNotFoundStores['navigate']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    return { t, navigate }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ navigate: s.navigate })
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    this.navigate(ADMIN_ROOT)
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AdminSectionNotFoundStores = ReturnType<AdminSectionNotFound['useStores']>

export default AdminSectionNotFound.component()
