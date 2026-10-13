/**
 * Code-behind of `UsersSection.kbview` (converted from `UsersSection.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import UsersPanel from "../pages/UsersPanel"
import UserDetailSection from "./user-detail/UserDetailSection"
import type { AdminSectionProps } from "./registry"

import { ViewBase } from './UsersSection.kbview'

export type { AdminSectionProps }

export class UsersSection extends ViewBase {
  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    this.useStores()
  }

  get userId(): string | null {
    return this.props.params.get('user')
  }

  get show_case_1() {
    return !!(this.userId)
  }

  /** `<UserDetailSection>`, rendered by a ReactHost. */
  get UserDetailSection() {
    if (!(this.userId)) return undefined as never
    return UserDetailSection
  }

  get user_detail_section_props() {
    return this.memo('user_detail_section_props', [this.userId, this.props], () => {
      if (!(this.userId)) return undefined as never
      return ({ userId: this.userId, params: this.props.params, navigate: this.props.navigate })
    })
  }

  get show_main() {
    return !(this.userId)
  }

  /** `<UsersPanel>`, rendered by a ReactHost. */
  get UsersPanel() {
    return UsersPanel
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type UsersSectionStores = ReturnType<UsersSection['useStores']>

export default UsersSection.component()
