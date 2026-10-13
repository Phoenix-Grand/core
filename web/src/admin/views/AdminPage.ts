/**
 * Code-behind of `AdminPage.kbview` (converted from `AdminPage.tsx` by @kubuno/views-migrate).
 */
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { Slot } from "../../core/slots/SlotRegistry"
import { useSidebarStore } from "../../core/store/sidebarStore"
import { useToolbarStore } from "../../core/store/toolbarStore"
import { useSearchStore } from "../../core/store/searchStore"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { NAV_INDEX, canSeeTab } from "../adminNav"
import { canonicalAdminUrl, sectionParams, tabFromPath } from "../adminRoute"
import AdminNavTree from "../pages/AdminNavTree"
import AdminSearchBar from "../pages/AdminSearchBar"
import ComingSoon from "../sections/ComingSoon"
import { ADMIN_SECTIONS } from "../sections/registry"
import AdminBreadcrumb from "../pages/AdminBreadcrumb"
import AdminForbidden from "../controls/AdminForbidden"
import AdminSectionNotFound from "../pages/AdminSectionNotFound"

import { ViewBase } from './AdminPage.kbview'
import * as __parts from './AdminPage.parts.tsx'

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export class AdminPage extends ViewBase {
  tr!: AdminPageStores['t']
  can!: AdminPageStores['can']
  isAdmin!: boolean
  isLoading!: boolean
  navigate!: AdminPageStores['navigate']
  pathname!: string
  params!: URLSearchParams

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { can, isAdmin, isLoading } = usePrivileges()
    const navigate = useNavigate()
    const { pathname } = useLocation()
    const [params] = useSearchParams()
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        const combo = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k'
        const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)
        if (!combo && !slash) return
        e.preventDefault()
        useSearchStore.getState().requestSearchOpen(true)
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [])
    return { t, can, isAdmin, isLoading, navigate, pathname, params }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, isAdmin: s.isAdmin, isLoading: s.isLoading, navigate: s.navigate, pathname: s.pathname, params: s.params })
  }

  get tab(): string {
    return tabFromPath(this.pathname)
  }

  get legacy(): string | null {
    return canonicalAdminUrl(this.pathname, this.params)
  }

  get forSection(): URLSearchParams {
    return this.memo('forSection', [this.pathname, this.params], () => sectionParams(this.pathname, this.params))
  }

  get meta() {
    return this.memo('meta', [this.tab, this.legacy, this.isLoading, this.isAdmin], () => {
      if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin))) return undefined as never
      return NAV_INDEX.get(this.tab)
    })
  }

  get titleKey(): string | undefined {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin))) return undefined as never
    return this.meta?.item.labelKey
  }

  get section() {
    return this.memo('section', [this.tab, this.legacy, this.isLoading, this.isAdmin], () => {
      if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin))) return undefined as never
      return ADMIN_SECTIONS[this.tab]
    })
  }

  get Section() {
    return this.memo('Section', [this.section, this.legacy, this.isLoading, this.isAdmin], () => {
      if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin))) return undefined as never
      return this.section?.Component
    })
  }

  get show_case_1() {
    return !!(this.legacy)
  }

  /** `<Navigate>`, rendered by a ReactHost. */
  get Navigate() {
    if (!(this.legacy)) return undefined as never
    return Navigate
  }

  get navigate_props() {
    return this.memo('navigate_props', [this.legacy], () => {
      if (!(this.legacy)) return undefined as never
      return ({ to: this.legacy, replace: true })
    })
  }

  get show_case_2() {
    return !(this.legacy) && !!(this.isLoading)
  }

  get show_case_3() {
    return !(this.legacy) && !(this.isLoading) && !!(!this.isAdmin)
  }

  /** `<Navigate>`, rendered by a ReactHost. */
  get Navigate2() {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!this.isAdmin)) return undefined as never
    return Navigate
  }

  get navigate_props2() {
    return this.memo('navigate_props2', [this.legacy, this.isLoading, this.isAdmin], () => {
      if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!this.isAdmin)) return undefined as never
      return ({ to: "/", replace: true })
    })
  }

  get show_case_4() {
    return !(this.legacy) && !(this.isLoading) && !(!this.isAdmin) && !!(!this.meta)
  }

  /** `<AdminSectionNotFound>`, rendered by a ReactHost. */
  get AdminSectionNotFound() {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!this.meta)) return undefined as never
    return AdminSectionNotFound
  }

  get admin_section_not_found_props() {
    return this.memo('admin_section_not_found_props', [this.tab, this.legacy, this.isLoading, this.isAdmin, this.meta], () => {
      if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!this.meta)) return undefined as never
      return ({ tab: this.tab })
    })
  }

  get show_case_5() {
    return !(this.legacy) && !(this.isLoading) && !(!this.isAdmin) && !(!this.meta) && !!(!canSeeTab(this.tab, this.can))
  }

  /** `<AdminForbidden>`, rendered by a ReactHost. */
  get AdminForbidden() {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!canSeeTab(this.tab, this.can))) return undefined as never
    return AdminForbidden
  }

  get admin_forbidden_props() {
    return this.memo('admin_forbidden_props', [this.titleKey, this.legacy, this.isLoading, this.isAdmin, this.meta, this.tab, this.can], () => {
      if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!canSeeTab(this.tab, this.can))) return undefined as never
      return ({ titleKey: this.titleKey })
    })
  }

  get show_main() {
    return !(this.legacy) && !(this.isLoading) && !(!this.isAdmin) && !(!this.meta) && !(!canSeeTab(this.tab, this.can))
  }

  /** `<AdminBreadcrumb>`, rendered by a ReactHost. */
  get AdminBreadcrumb() {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can)))) return undefined as never
    return AdminBreadcrumb
  }

  get admin_breadcrumb_props() {
    return this.memo('admin_breadcrumb_props', [this.tab, this.legacy, this.isLoading, this.isAdmin, this.meta, this.can], () => {
      if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can)))) return undefined as never
      return ({ tab: this.tab })
    })
  }

  get show_section_own_header() {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can)))) return undefined as never
    return !this.section?.ownHeader
  }

  get h1_text() {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can))) || !(!this.section?.ownHeader)) return undefined as never
    return this.titleKey ? this.tr(this.titleKey) : this.tr('user.admin')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tab, this.Section, this.forSection, this.navigate, this.legacy, this.isLoading, this.isAdmin, this.meta, this.can], () => {
      if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can)))) return undefined as never
      return ({ tab: this.tab, Section: this.Section, forSection: this.forSection, navigate: this.navigate })
    })
  }

  /** A part of the screen still written in React (<AdminSectionBoundary> is no .kbview element (./AdminSectionBoundary#default)). */
  get Part1() {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can)))) return undefined as never
    return __parts.Part1
  }

  get show_meta_item_soon() {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can)))) return undefined as never
    return !!(this.meta?.item.soon)
  }

  /** `<ComingSoon>`, rendered by a ReactHost. */
  get ComingSoon() {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can))) || !(this.meta?.item.soon)) return undefined as never
    return ComingSoon
  }

  get coming_soon_props() {
    return this.memo('coming_soon_props', [this.titleKey, this.legacy, this.isLoading, this.isAdmin, this.meta, this.tab, this.can], () => {
      if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can))) || !(this.meta?.item.soon)) return undefined as never
      return ({ titleKey: this.titleKey ?? 'user.admin' })
    })
  }

  /** `<Slot>`, rendered by a ReactHost. */
  get Slot() {
    if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can)))) return undefined as never
    return Slot
  }

  get slot_props() {
    return this.memo('slot_props', [this.legacy, this.isLoading, this.isAdmin, this.meta, this.tab, this.can], () => {
      if (!(!(this.legacy)) || !(!(this.isLoading)) || !(!(!this.isAdmin)) || !(!(!this.meta)) || !(!(!canSeeTab(this.tab, this.can)))) return undefined as never
      return ({ name: "admin-panels" })
    })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AdminPageStores = ReturnType<AdminPage['useStores']>

export default AdminPage.component()

useSidebarStore.getState().register({
  moduleId:      'core-admin',
  routePrefix:   '/admin',
  SidebarBody:   AdminNavTree,
  collapsedBody: true,
})

useToolbarStore.getState().register({
  moduleId:    'core-admin',
  routePrefix: '/admin',
  padding:     24,
})

useSearchStore.getState().register({
  moduleId:        'core-admin',
  routePrefix:     '/admin',
  placeholder:     'Rechercher des utilisateurs, groupes ou paramètres',
  placeholderKey:  'admin.search_ph',
  SearchComponent: AdminSearchBar,
  inline:          true,
})
