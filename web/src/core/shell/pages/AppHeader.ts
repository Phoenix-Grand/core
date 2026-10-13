/**
 * Code-behind of `AppHeader.kbcontrol` (converted from `AppHeader.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useIsMobile } from "@ui"
import { useLocation } from "react-router-dom"
import { useUiStore } from "../../store/uiStore"
import { useSearchStore, resolveSearchConfig } from "../../store/searchStore"
import SearchBar from "../SearchBar"
import HeaderActions from "../controls/HeaderActions"
import { Slot } from "../../slots/SlotRegistry"
import HealthTopbarChip from "../../../admin/health/HealthTopbarChip"
import BrandLink from "../controls/BrandLink"

import { ViewBase } from './AppHeader.kbcontrol'
import * as __parts from './AppHeader.parts.tsx'

export class AppHeader extends ViewBase {
  @bind accessor searchOpen = false
  tr!: AppHeaderStores['t']
  toggleSidebar!: () => void
  toggleSidebarCollapsed!: () => void
  sidebarCollapsed!: boolean
  pathname!: string
  isMobile!: boolean
  searchConfigs!: AppHeaderStores['searchConfigs']
  overlayRef!: AppHeaderStores['overlayRef']
  openSignal!: AppHeaderStores['openSignal']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { toggleSidebar, toggleSidebarCollapsed, sidebarCollapsed } = useUiStore()
    const { pathname } = useLocation()
    const isMobile      = useIsMobile()
    const searchConfigs = useSearchStore((s) => s.configs)
    const overlayRef = useRef<HTMLDivElement>(null)
    const openSignal = useSearchStore((s) => s.openSignal)
    return { t, toggleSidebar, toggleSidebarCollapsed, sidebarCollapsed, pathname, isMobile, searchConfigs, overlayRef, openSignal }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const pathname = this.pathname
    const overlayRef = this.overlayRef
    const openSignal = this.openSignal
    useEffect(() => { this.searchOpen = false }, [pathname])
    useEffect(() => {
      if (openSignal.seq === 0) return
      this.searchOpen = openSignal.open
    }, [openSignal])
    useEffect(() => {
      if (!this.searchOpen) return
      overlayRef.current?.querySelector('input')?.focus()
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.searchOpen = false }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [this.searchOpen])
    return {  }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, toggleSidebar: s.toggleSidebar, toggleSidebarCollapsed: s.toggleSidebarCollapsed, sidebarCollapsed: s.sidebarCollapsed, pathname: s.pathname, isMobile: s.isMobile, searchConfigs: s.searchConfigs, overlayRef: s.overlayRef, openSignal: s.openSignal })
    this.useHooks()
  }

  get isHome(): boolean {
    return this.pathname === '/'
  }

  get inlineSearch(): boolean {
    return !!resolveSearchConfig(this.searchConfigs, this.pathname)?.inline && !this.isMobile
  }

  get show_is_home() {
    return !this.isHome
  }

  get accessible_name() {
    if (!(!this.isHome)) return undefined as never
    return this.sidebarCollapsed ? this.tr('shell.expand_sidebar') : this.tr('shell.collapse_sidebar')
  }

  /** `<BrandLink>`, rendered by a ReactHost. */
  get BrandLink() {
    return BrandLink
  }

  get show_not_inline_search() {
    return !(this.inlineSearch)
  }

  /** `<SearchBar>`, rendered by a ReactHost. */
  get SearchBar() {
    return SearchBar
  }

  /** `<Slot>`, rendered by a ReactHost. */
  get Slot() {
    if (!(!(this.inlineSearch))) return undefined as never
    return Slot
  }

  get slot_props() {
    return this.memo('slot_props', [this.inlineSearch], () => {
      if (!(!(this.inlineSearch))) return undefined as never
      return ({ name: "header-leading" })
    })
  }

  /** `<HealthTopbarChip>`, rendered by a ReactHost. */
  get HealthTopbarChip() {
    return HealthTopbarChip
  }

  get show_inline_search() {
    return !this.inlineSearch
  }

  /** `<HeaderActions>`, rendered by a ReactHost. */
  get HeaderActions() {
    return HeaderActions
  }

  get show_search_open_inline_search() {
    return this.searchOpen && !this.inlineSearch
  }

  get part1_props() {
    return this.memo('part1_props', [this.overlayRef, this.memo, this.searchOpen, this.tr, this.inlineSearch], () => {
      if (!(this.searchOpen && !this.inlineSearch)) return undefined as never
      return ({ overlayRef: this.overlayRef, setSearchOpen: this.memo("setSearchOpen:bound", [], () => this.setSearchOpen.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<div ref>: attribute(s) without a .kbview property). */
  get Part1() {
    if (!(this.searchOpen && !this.inlineSearch)) return undefined as never
    return __parts.Part1
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    this.toggleSidebar()
  }

  panel_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!this.isHome)) return undefined as never
    this.toggleSidebarCollapsed()
  }

  panel_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(!this.inlineSearch)) return undefined as never
    this.searchOpen = true
  }

  /** `setSearchOpen` of the TSX: a value, or an update of the previous one. */
  setSearchOpen(value: AppHeader['searchOpen'] | ((prev: AppHeader['searchOpen']) => AppHeader['searchOpen'])) {
    this.searchOpen = typeof value === 'function' ? (value as (prev: AppHeader['searchOpen']) => AppHeader['searchOpen'])(this.searchOpen) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AppHeaderStores = ReturnType<AppHeader['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AppHeaderHooks = ReturnType<AppHeader['useHooks']>

export default AppHeader.component()
