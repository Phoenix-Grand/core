/**
 * Code-behind of `UserSecurityTab.kbcontrol` (converted from `SecurityTab.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import type { User } from "../../../core/types"
import PasswordResetCard from "./PasswordResetCard"
import RequirePasswordChangeCard from "./RequirePasswordChangeCard"

import { ViewBase } from './UserSecurityTab.kbcontrol'
import * as __parts from './UserSecurityTab.parts.tsx'

export type SecurityTabProps = { user: User }

export class UserSecurityTab extends ViewBase {
  tr!: SecurityTabStores['t']

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

  get variant() {
    return this.props.user.totp_enabled ? 'success' : 'warning'
  }

  get title() {
    return this.props.user.totp_enabled ? this.tr('admin.ud_2fa_on') : this.tr('admin.ud_2fa_off')
  }

  get callout_text() {
    return this.props.user.totp_enabled ? this.tr('admin.ud_2fa_on_desc') : this.tr('admin.ud_2fa_off_desc')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.props], () => ({ t: this.tr, user: this.props.user, user_oauth_provider: this.props.user?.oauth_provider }))
  }

  /** A part of the screen still written in React (<dl> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

  get show_user_must_change() {
    return !!(this.props.user.must_change_password)
  }

  /** `<PasswordResetCard>`, rendered by a ReactHost. */
  get PasswordResetCard() {
    return PasswordResetCard
  }

  get password_reset_card_props() {
    return this.memo('password_reset_card_props', [this.props], () => ({ user: this.props.user }))
  }

  /** `<RequirePasswordChangeCard>`, rendered by a ReactHost. */
  get RequirePasswordChangeCard() {
    return RequirePasswordChangeCard
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SecurityTabStores = ReturnType<UserSecurityTab['useStores']>

export default UserSecurityTab.component()
