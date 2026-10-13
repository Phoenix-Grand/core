/**
 * Code-behind of `SettingsPage.kbview` (converted from `SettingsPage.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useSearchParams, useNavigate } from "react-router-dom"
import { useIsMobile } from "@ui"
import { Slot } from "../slots/SlotRegistry"
import { useSettingsNav, type Tab } from "./navigation"
import ProfileTab from "./sections/pages/ProfileTab"
import NotificationsTab from "./sections/pages/NotificationsTab"
import ThemesTab from "./sections/pages/ThemesTab"
import ClientsTab from "./sections/pages/ClientsTab"
import SecurityTab from "./sections/pages/SecurityTab"
import SessionsTab from "./sections/pages/SessionsTab"
import ApiTokensTab from "./sections/pages/ApiTokensTab"
import MyDataTab from "./sections/my-data/MyDataTab"

import { ViewBase } from './SettingsPage.kbview'

export class SettingsPage extends ViewBase {
  tr!: SettingsPageStores['t']
  params!: SettingsPageStores['params']
  navigate!: SettingsPageStores['navigate']
  isMobile!: SettingsPageStores['isMobile']
  nav!: SettingsPageStores['nav']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const [params] = useSearchParams()
    const navigate = useNavigate()
    const isMobile = useIsMobile()
    const nav = useSettingsNav()
    return { t, params, navigate, isMobile, nav }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, params: s.params, navigate: s.navigate, isMobile: s.isMobile, nav: s.nav })
  }

  get rawTab() {
    return this.params.get('tab')
  }

  get tab() {
    return (this.rawTab as Tab) || 'profile'
  }

  get current() {
    return this.memo('current', [this.nav, this.tab], () => this.nav.find(navItem => navItem.id === this.tab))
  }

  get show_case_1() {
    return !!(this.isMobile && !this.rawTab)
  }

  get show_main() {
    return !(this.isMobile && !this.rawTab)
  }

  get show_not_is_mobile() {
    if (!(!(this.isMobile && !this.rawTab))) return undefined as never
    return !(this.isMobile)
  }

  get span_text() {
    if (!(!(this.isMobile && !this.rawTab)) || !(this.isMobile)) return undefined as never
    return this.current ? this.tr(this.current.labelKey, { defaultValue: this.current.defaultLabel }) : this.tr('settings.page_title')
  }

  get h1_text() {
    if (!(!(this.isMobile && !this.rawTab)) || !(!(this.isMobile))) return undefined as never
    return this.current ? this.tr(this.current.labelKey, { defaultValue: this.current.defaultLabel }) : this.tr('settings.page_title')
  }

  get show_tab_profile() {
    if (!(!(this.isMobile && !this.rawTab))) return undefined as never
    return this.tab === 'profile'
  }

  /** `<ProfileTab>`, rendered by a ReactHost. */
  get ProfileTab() {
    return ProfileTab
  }

  get show_tab_notifications() {
    if (!(!(this.isMobile && !this.rawTab))) return undefined as never
    return this.tab === 'notifications'
  }

  /** `<NotificationsTab>`, rendered by a ReactHost. */
  get NotificationsTab() {
    return NotificationsTab
  }

  get show_tab_themes() {
    if (!(!(this.isMobile && !this.rawTab))) return undefined as never
    return this.tab === 'themes'
  }

  /** `<ThemesTab>`, rendered by a ReactHost. */
  get ThemesTab() {
    return ThemesTab
  }

  get show_tab_clients() {
    if (!(!(this.isMobile && !this.rawTab))) return undefined as never
    return this.tab === 'clients'
  }

  /** `<ClientsTab>`, rendered by a ReactHost. */
  get ClientsTab() {
    return ClientsTab
  }

  get show_tab_security() {
    if (!(!(this.isMobile && !this.rawTab))) return undefined as never
    return this.tab === 'security'
  }

  /** `<SecurityTab>`, rendered by a ReactHost. */
  get SecurityTab() {
    return SecurityTab
  }

  get show_tab_sessions() {
    if (!(!(this.isMobile && !this.rawTab))) return undefined as never
    return this.tab === 'sessions'
  }

  /** `<SessionsTab>`, rendered by a ReactHost. */
  get SessionsTab() {
    return SessionsTab
  }

  get show_tab_api_tokens() {
    if (!(!(this.isMobile && !this.rawTab))) return undefined as never
    return this.tab === 'api-tokens'
  }

  /** `<ApiTokensTab>`, rendered by a ReactHost. */
  get ApiTokensTab() {
    return ApiTokensTab
  }

  get show_tab_my_data() {
    if (!(!(this.isMobile && !this.rawTab))) return undefined as never
    return this.tab === 'my-data'       && !!this.current
  }

  /** `<MyDataTab>`, rendered by a ReactHost. */
  get MyDataTab() {
    return MyDataTab
  }

  get show_is_mobile() {
    if (!(!(this.isMobile && !this.rawTab))) return undefined as never
    return !this.isMobile
  }

  /** `<Slot>`, rendered by a ReactHost. */
  get Slot() {
    if (!(!(this.isMobile && !this.rawTab)) || !(!this.isMobile)) return undefined as never
    return Slot
  }

  get slot_props() {
    return this.memo('slot_props', [this.isMobile, this.rawTab], () => {
      if (!(!(this.isMobile && !this.rawTab)) || !(!this.isMobile)) return undefined as never
      return ({ name: "settings-sections" })
    })
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    this.navigate('/settings')
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SettingsPageStores = ReturnType<SettingsPage['useStores']>

export default SettingsPage.component()
