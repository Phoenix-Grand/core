/**
 * Code-behind of `SubscriptionSection.kbview` (converted from `SubscriptionSection.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { PRIV } from "../../../core/authz/types"
import { usePrivileges } from "../../../core/authz/usePrivileges"
import { useSubscription } from "./api"

import { ViewBase } from './SubscriptionSection.kbview'

export class SubscriptionSection extends ViewBase {
  can!: SubscriptionSectionStores['can']
  data!: SubscriptionSectionStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: SubscriptionSectionStores['refetch']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { can } = usePrivileges()
    const { data, isLoading, isError, refetch } = useSubscription()
    return { t, can, data, isLoading, isError, refetch }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ can: s.can, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch })
  }

  get canManage(): boolean {
    return this.can(PRIV.SETTINGS_MANAGE)
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.isError || !this.data)
  }

  get show_main() {
    return !(this.isLoading) && !(this.isError || !this.data)
  }

  /** `<LicenceCard Licence>`: the instance licence, present only within `show_main`. */
  get licenceCardLicence() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data.licence
  }

  /** `<InstanceCard Instance>`: the instance info, present only within `show_main`. */
  get instanceCardInstance() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data.instance
  }

  /** `<InstanceCard Accounts>`: the account counts, present only within `show_main`. */
  get instanceCardAccounts() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data.accounts
  }

  /** `<SupportCard Support>`: the support/contract info, present only within `show_main`. */
  get supportCardSupport() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data.support
  }

  get show_data_modules_data() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return !!(this.data.modules && this.data.modules.length > 0)
  }

  /** `<ModulesLicenceCard Modules>`: the installed modules, present only when there is at least one. */
  get modulesLicenceCardModules() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.data.modules && this.data.modules.length > 0)) return undefined as never
    return this.data.modules
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(this.isError || !this.data)) return undefined as never
    void this.refetch()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SubscriptionSectionStores = ReturnType<SubscriptionSection['useStores']>

export default SubscriptionSection.component()
