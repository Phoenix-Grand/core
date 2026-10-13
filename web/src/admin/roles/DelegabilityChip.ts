/**
 * Code-behind of `DelegabilityChip.kbcontrol` (converted from `DelegabilityChip.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { type Role } from "../../core/authz/types"

import { ViewBase } from './DelegabilityChip.kbcontrol'

export type DelegabilityChipProps = { role: Role }

export class DelegabilityChip extends ViewBase {
  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    this.useStores()
  }

  get show_not_role_ou_delegable() {
    return !(this.props.role.ou_delegable)
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DelegabilityChipStores = ReturnType<DelegabilityChip['useStores']>

export default DelegabilityChip.component()
