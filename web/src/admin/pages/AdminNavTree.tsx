/**
 * Code-behind of `AdminNavTree.kbcontrol` (converted from `AdminNavTree.tsx` by @kubuno/views-migrate).
 */
import { Fragment } from 'react'
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { ChevronDown } from "lucide-react"
import { ADMIN_NAV, NAV_INDEX, canSeeTab, filterNav, type AdminNavItem, type NavMeta } from "../adminNav"
import { adminPath, useAdminPlace } from "../adminRoute"
import { LIVE_STATE_KEY, groupsOf, useAdminModules, useModuleLiveState, type ModuleLiveState } from "../adminModules"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { useAdminPins } from "../nav/adminPins"
import { moduleGlyph, type ModuleGlyph } from "../nav/moduleGlyph"

import { ViewBase } from './AdminNavTree.kbcontrol'
import * as __parts from './AdminNavTree.parts.tsx'
import { StateGlyph, PinButton } from './AdminNavTree.parts.tsx'

interface DynamicNavChild {
  /** Record id - the segment after the section (`/admin/modules/<id>`). */
  id:    string
  /** Already-translated label: a display name, not a translation key. */
  label: string
  /**
   * The module's own glyph, as it appears everywhere else in the product - a
   * row of twenty-odd names reads as a list; the same row with each
   * application's icon reads as the applications the operator already knows.
   *
   * A component, not an icon name, because `WaffleAppRegistry` is where a
   * module's face is actually decided and some of them are BRAND LOGOS in
   * colour (PaintSharp), which no name-to-Lucide map can express.
   */
  Icon?: ModuleGlyph | null
  /** How the row is toned down or flagged, and why (shown as its tooltip). */
  state: ModuleLiveState
  /**
   * The first page the record declares, when it declares any.
   *
   * Only the FIRST one, because that is all this tree needs: the row links
   * straight to it rather than to the record's bare address, which would
   * redirect on arrival and make the view flicker. The other pages are the
   * business of the record's own page.
   */
  firstPane: string | null
}

function useDynamicChildren(): Record<string, DynamicNavChild[]> {
  const { data }  = useAdminModules()
  const liveState = useModuleLiveState()

  return useMemo<Record<string, DynamicNavChild[]>>(() => {
    const modules: DynamicNavChild[] = [...(data ?? [])]
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
      .map(m => ({
        id:    m.id,
        label: m.display_name,
        Icon:  moduleGlyph(m),
        state: liveState(m),
        // Declared by the module, forwarded verbatim by the core with the
        // inventory: no request per module, and no module named here.
        firstPane: groupsOf(m)[0]?.id ?? null,
      }))
    return { modules }
  }, [data, liveState])
}

const isSecondaryTop = (topId: string | undefined): boolean =>
  !!topId && ADMIN_NAV.some(i => i.secondary && i.id === topId)

export type AdminNavTreeProps = { collapsed?: boolean }

export class AdminNavTree extends ViewBase {
  tr!: AdminNavTreeStores['t']
  can!: AdminNavTreeStores['can']
  place!: AdminNavTreeStores['place']
  dynamic!: Record<string, DynamicNavChild[]>
  pins!: AdminNavTreeStores['pins']
  nav!: AdminNavItem[]
  showMore!: AdminNavTreeHooks['showMore']
  setShowMore!: AdminNavTreeHooks['setShowMore']
  expanded!: Set<string>
  setExpanded!: AdminNavTreeHooks['setExpanded']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t }       = useTranslation()
    const { can }     = usePrivileges()
    const place       = useAdminPlace()
    const dynamic     = useDynamicChildren()
    const pins        = useAdminPins()
    const nav = useMemo(() => filterNav(ADMIN_NAV, can), [can])
    return { t, can, place, dynamic, pins, nav }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const place = this.place
    const activeMeta = this.activeMeta
    const [showMore, setShowMore] = useState<boolean>(() => isSecondaryTop(activeMeta?.topId))
    this.publish({ showMore, setShowMore })
    useEffect(() => {
      if (isSecondaryTop(activeMeta?.topId)) setShowMore(true)
    }, [activeMeta?.topId])
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeMeta?.ancestors ?? []))
    this.publish({ expanded, setExpanded })
    useEffect(() => {
      setExpanded(prev => {
        const next = new Set(prev)
        activeMeta?.ancestors.forEach(a => next.add(a))
        if (place.entity) next.add(this.active)
        return next
      })
    }, [this.active, place.entity])
    return { showMore, setShowMore, expanded, setExpanded }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, place: s.place, dynamic: s.dynamic, pins: s.pins, nav: s.nav })
    const h = this.useHooks()
    this.publish({ showMore: h.showMore, setShowMore: h.setShowMore, expanded: h.expanded, setExpanded: h.setExpanded })
  }

  get active(): string {
    return this.place.tab
  }

  get activeMeta(): NavMeta | undefined {
    return this.memo('activeMeta', [this.active], () => NAV_INDEX.get(this.active))
  }

  get LINK_CLASS(): "flex h-full min-w-0 flex-1 items-center gap-3" {
    if (!(!(this.props.collapsed))) return undefined as never
    return 'flex h-full min-w-0 flex-1 items-center gap-3'
  }

  get CARET_SLOT(): "flex h-6 w-[22px] shrink-0 items-center justify-center" {
    if (!(!(this.props.collapsed))) return undefined as never
    return 'flex h-6 w-[22px] shrink-0 items-center justify-center'
  }

  get caretSpacer() {
    return this.memo('caretSpacer', [this.CARET_SLOT, this.props], () => {
      if (!(!(this.props.collapsed))) return undefined as never
      return <span className={this.CARET_SLOT} aria-hidden />
    })
  }

  get INDENT_STEP(): 22 {
    if (!(!(this.props.collapsed))) return undefined as never
    return 22
  }

  get ICON_SLOT(): 20 {
    if (!(!(this.props.collapsed))) return undefined as never
    return 20
  }

  get LABEL_GAP(): 12 {
    if (!(!(this.props.collapsed))) return undefined as never
    return 12
  }

  get BASE_INSET(): 4 {
    if (!(!(this.props.collapsed))) return undefined as never
    return 4
  }

  get primary(): AdminNavItem[] {
    return this.memo('primary', [this.nav, this.props], () => {
      if (!(!(this.props.collapsed))) return undefined as never
      return this.nav.filter(i => !i.secondary)
    })
  }

  get secondary(): AdminNavItem[] {
    return this.memo('secondary', [this.nav, this.props], () => {
      if (!(!(this.props.collapsed))) return undefined as never
      return this.nav.filter(i => i.secondary)
    })
  }

  get pinned(): NavMeta[] {
    return this.memo('pinned', [this.pins, this.can, this.props], () => {
      if (!(!(this.props.collapsed))) return undefined as never
      return this.pins.pins
    .map(id => NAV_INDEX.get(id))
    .filter((meta): meta is NavMeta =>
      !!meta && !meta.item.children?.length && canSeeTab(meta.item.id, this.can))
    })
  }

  get show_case_1() {
    return !!(this.props.collapsed)
  }

  /** A part of the screen still written in React (<Link aria-current>). */
  get Part1() {
    if (!(this.props.collapsed)) return undefined as never
    return __parts.Part1
  }

  /** The rows of the Repeater over `nav`. */
  get rows_nav() {
    return this.memo('rows_nav', [this.nav, this.props, this.tr, this.activeMeta], () => {
      if (!(this.props.collapsed)) return undefined as never
      return this.nav.map((it) => {
      return { it, part1_props: ((this.props.collapsed)) ? ({ it: it, t: this.tr, activeMeta: this.activeMeta, It_Icon: it?.Icon }) : undefined, key: it.id }
    })
    })
  }

  get show_main() {
    return !(this.props.collapsed)
  }

  get show_pinned() {
    if (!(!(this.props.collapsed))) return undefined as never
    return this.pinned.length > 0
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part2() {
    if (!(!(this.props.collapsed)) || !(this.pinned.length > 0)) return undefined as never
    return __parts.Part2
  }

  /** The rows of the Repeater over `pinned`. */
  get rows_pinned() {
    return this.memo('rows_pinned', [this.pinned, this.tr, this.active, this.props, this.memo, this.BASE_INSET, this.ICON_SLOT, this.LABEL_GAP, this.INDENT_STEP, this.caretSpacer, this.LINK_CLASS, this.pins], () => {
      if (!(!(this.props.collapsed)) || !(this.pinned.length > 0)) return undefined as never
      return this.pinned.map((meta) => {
      const TopIcon = NAV_INDEX.get(meta.topId)?.item.Icon
      const label = this.tr(meta.item.labelKey)
      const isActive = meta.item.id === this.active
      return { meta, TopIcon, label, isActive, part2_props: ((!(this.props.collapsed)) && (this.pinned.length > 0)) ? ({ meta: meta, indent: this.memo("indent:bound", [], () => this.indent.bind(this)), rowClass: this.memo("rowClass:bound", [], () => this.rowClass.bind(this)), isActive: isActive, caretSpacer: this.caretSpacer, label: label, LINK_CLASS: this.LINK_CLASS, TopIcon: TopIcon, t: this.tr, pins: this.pins }) : undefined, key: `pin:${meta.item.id}` }
    })
    })
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_render_items_primary() {
    return this.memo('content_render_items_primary', [this.props, this.activeMeta, this.dynamic, this.expanded, this.active, this.place, this.BASE_INSET, this.ICON_SLOT, this.LABEL_GAP, this.INDENT_STEP, this.tr, this.pins, this.setExpanded, this.CARET_SLOT, this.caretSpacer, this.LINK_CLASS, this.primary], () => {
      if (!(!(this.props.collapsed))) return undefined as never
      return ({ children: this.renderItems(this.primary, 0) })
    })
  }

  get content_show_more_render_items_secondary() {
    return this.memo('content_show_more_render_items_secondary', [this.showMore, this.props, this.activeMeta, this.dynamic, this.expanded, this.active, this.place, this.BASE_INSET, this.ICON_SLOT, this.LABEL_GAP, this.INDENT_STEP, this.tr, this.pins, this.setExpanded, this.CARET_SLOT, this.caretSpacer, this.LINK_CLASS, this.secondary], () => {
      if (!(!(this.props.collapsed))) return undefined as never
      return ({ children: this.showMore && this.renderItems(this.secondary, 0) })
    })
  }

  get show_secondary() {
    if (!(!(this.props.collapsed))) return undefined as never
    return this.secondary.length > 0
  }

  get part3_props() {
    return this.memo('part3_props', [this.showMore, this.setShowMore, this.memo, this.props, this.BASE_INSET, this.ICON_SLOT, this.LABEL_GAP, this.INDENT_STEP, this.CARET_SLOT, this.tr, this.secondary], () => {
      if (!(!(this.props.collapsed)) || !(this.secondary.length > 0)) return undefined as never
      return ({ showMore: this.showMore, setShowMore: this.setShowMore, indent: this.memo("indent:bound", [], () => this.indent.bind(this)), rowClass: this.memo("rowClass:bound", [], () => this.rowClass.bind(this)), CARET_SLOT: this.CARET_SLOT, caretIcon: this.memo("caretIcon:bound", [], () => this.caretIcon.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<a aria-expanded>: attribute(s) without a .kbview property). */
  get Part3() {
    if (!(!(this.props.collapsed)) || !(this.secondary.length > 0)) return undefined as never
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.memo, this.props, this.BASE_INSET, this.ICON_SLOT, this.LABEL_GAP, this.INDENT_STEP, this.tr], () => {
      if (!(!(this.props.collapsed))) return undefined as never
      return ({ indent: this.memo("indent:bound", [], () => this.indent.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Link style>). */
  get Part4() {
    if (!(!(this.props.collapsed))) return undefined as never
    return __parts.Part4
  }

  toggle(id: string) {
    return this.setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  rowClass(isActive: boolean, holdsActive: boolean) {
    if (!(!(this.props.collapsed))) return undefined as never
    return `group/row w-full h-10 flex items-center pr-2 rounded-full text-sm text-left transition-colors ${
      isActive
        ? 'bg-primary-light text-primary font-medium'
        : `hover:bg-surface-2 ${holdsActive ? 'text-primary' : 'text-text-secondary'}`}`
  }

  caretIcon(open: boolean) {
    if (!(!(this.props.collapsed))) return undefined as never
    return (
    <ChevronDown
      size={16} strokeWidth={1.5}
      className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
    />
  )
  }

  indent(depth: number) {
    if (!(!(this.props.collapsed))) return undefined as never
    return depth === 0
      ? this.BASE_INSET
      : this.BASE_INSET + this.ICON_SLOT + this.LABEL_GAP + (depth - 1) * this.INDENT_STEP
  }

  renderDynamic(tab: string, children: DynamicNavChild[], depth: number): ReactNode {
    if (!(!(this.props.collapsed))) return undefined as never
    return children.map(child => {
      // A LEAF, whichever of its pages is open: the pages are not rows of this
      // tree, so the module's own row is the only thing that can say "you are
      // in here" - and it must keep saying it on every page inside.
      const isActive   = tab === this.active && this.place.entity === child.id
      const notable    = child.state === 'disabled' || child.state === 'unreachable'
      const stateLabel = this.tr(LIVE_STATE_KEY[child.state])
      const title      = notable ? `${child.label} - ${stateLabel}` : child.label
      // Its first page, when it has any: the record's bare address heals to that
      // page anyway, and a menu row that redirects on arrival flickers.
      const target     = adminPath(tab, child.id, child.firstPane)
      // The SLOT is kept even when there is no glyph, so one module missing an
      // icon does not shift its neighbours' labels out of column.
      const RecordIcon = child.Icon
      const label = (
        <>
          <span className="w-[18px] shrink-0 flex items-center justify-center">
            {RecordIcon && <RecordIcon size={17} />}
          </span>
          <span className={`truncate flex-1 ${
            !isActive && child.state === 'disabled' ? 'text-text-tertiary' : ''}`}>
            {child.label}
          </span>
          <StateGlyph state={child.state} title={stateLabel} />
        </>
      )
      return (
        <div
          key={`${tab}:${child.id}`}
          style={{ paddingLeft: this.indent(depth) }}
          className={this.rowClass(isActive, false)}
        >
          {this.caretSpacer}
          <Link
            to={target} title={title}
            aria-current={isActive ? 'page' : undefined}
            className={this.LINK_CLASS}
          >
            {label}
          </Link>
        </div>
      )
    })
  }

  renderItems(items: AdminNavItem[], depth: number): ReactNode {
    if (!(!(this.props.collapsed))) return undefined as never
    const activeMeta = this.activeMeta
    return items.map(item => {
      const runtime  = this.dynamic[item.id] ?? []
      const declared = item.children ?? []
      const isGroup  = declared.length > 0
      // Both a place and a branch: the section's own page, plus its records.
      const isHybrid = !isGroup && runtime.length > 0
      const isOpen   = this.expanded.has(item.id)
      // On the section itself. `aria-current="page"` is reserved for exactly
      // this: the row whose href IS the address.
      const isActive = !isGroup && item.id === this.active && !(isHybrid && this.place.entity)
      // One of its records is open. While the branch is unfolded the record's
      // own row carries the highlight; folded, the parent has to, or nothing on
      // screen says where the operator is.
      const holdsRecord = isHybrid && item.id === this.active && !!this.place.entity && !isOpen
      // A folded group the operator is currently inside: toned, not filled.
      const holdsLeaf   = isGroup && !isOpen && !!activeMeta?.ancestors.includes(item.id)
      const padLeft  = this.indent(depth)
      const itemLabel = this.tr(item.labelKey)
      const body = (
        <>
          {depth === 0 && item.Icon && <item.Icon size={20} strokeWidth={1.5} className="shrink-0" />}
          <span className="truncate flex-1">{itemLabel}</span>
          {item.badge && (
            <span className="font-medium px-1.5 py-0.5 rounded bg-primary-light text-primary shrink-0"
                  style={{ fontSize: 'var(--kb-text-micro)' }}>
              {item.badge}
            </span>
          )}
        </>
      )
      // A group names no address, so there is nothing to pin; every other row is
      // a page, and a page is what the shortcut list holds.
      const pin = !isGroup && (
        <PinButton
          pinned={this.pins.isPinned(item.id)}
          offered={this.pins.canPin}
          label={this.tr(this.pins.isPinned(item.id) ? 'admin.nav_unpin' : 'admin.nav_pin', { section: itemLabel })}
          onToggle={() => this.pins.toggle(item.id)}
        />
      )
      return (
        <div key={item.id}>
          {isGroup ? (
            // Expand-only: it names no address, so the anchor is the sidebar's
            // "pure action" form - href="#" plus preventDefault, or the page
            // jumps to the top and the URL grows a stray hash. The WHOLE row
            // toggles, the caret at its head only says which way.
            <a
              href="#" role="button" aria-expanded={isOpen}
              onClick={e => { e.preventDefault(); this.toggle(item.id) }}
              style={{ paddingLeft: padLeft }} className={this.rowClass(false, holdsLeaf)}
            >
              <span className={this.CARET_SLOT} aria-hidden>{this.caretIcon(isOpen)}</span>
              <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>
            </a>
          ) : (
            <div style={{ paddingLeft: padLeft }} className={this.rowClass(isActive || holdsRecord, false)}>
              {/* Both a place and a branch: the caret unfolds its records, the
                  link opens the section. Nesting the button inside the anchor
                  would be invalid markup and would trap the keyboard - hence
                  two controls sharing one row, the caret first. */}
              {isHybrid ? (
                <button
                  type="button" aria-expanded={isOpen}
                  aria-label={this.tr(isOpen ? 'admin.nav_collapse' : 'admin.nav_expand', { section: itemLabel })}
                  onClick={() => this.toggle(item.id)}
                  className={`${this.CARET_SLOT} rounded-full hover:text-text-primary`}
                >
                  {this.caretIcon(isOpen)}
                </button>
              ) : this.caretSpacer}
              <Link
                to={adminPath(item.id)} title={itemLabel}
                aria-current={isActive ? 'page' : undefined}
                className={this.LINK_CLASS}
              >
                {body}
              </Link>
              {pin}
            </div>
          )}
          {isGroup && isOpen && <div>{this.renderItems(declared, depth + 1)}</div>}
          {isHybrid && isOpen && <div>{this.renderDynamic(item.id, runtime, depth + 1)}</div>}
        </div>
      )
    })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AdminNavTreeStores = ReturnType<AdminNavTree['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AdminNavTreeHooks = ReturnType<AdminNavTree['useHooks']>

export default AdminNavTree.component()
