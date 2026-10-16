/**
 * Code-behind of `OrgUnitScopePanel.kbcontrol` (converted from `OrgUnitScopePanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useNavigate } from 'react-router-dom'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { foldIncludes } from "@ui"
import type { OrgUnit } from "../../core/types"
import { adminUrl } from "../adminAction"

import { ViewBase } from './OrgUnitScopePanel.kbcontrol'
import * as __parts from './OrgUnitScopePanel.parts.tsx'

const MAX_DEPTH = 32

export interface OrgUnitScope {
  /** `all` ignores `unitIds`: the listing spans every unit the caller may see. */
  mode:        'all' | 'selected'
  unitIds:     string[]
  descendants: boolean
}

export const ALL_UNITS: OrgUnitScope = { mode: 'all', unitIds: [], descendants: true }

interface Props {
  units:    OrgUnit[]
  value:    OrgUnitScope
  onChange: (next: OrgUnitScope) => void
  /** Accounts per unit, own count only - the panel adds nothing up itself. */
  counts?:  Record<string, number>
  collapsed:          boolean
  onCollapsedChange:  (collapsed: boolean) => void
}

const childrenOf = (units: OrgUnit[], parentId: string | null) =>
  units.filter(u => u.parent_id === parentId).sort((a, b) => a.name.localeCompare(b.name))

export type { Props }

export class OrgUnitScopePanel extends ViewBase {
  @bind accessor needle = ''
  @bind accessor multi = false
  tr!: OrgUnitScopePanelStores['t']
  expanded!: Set<string>
  setExpanded!: OrgUnitScopePanelStores['setExpanded']
  matching!: Set<string> | null
  navigate!: ReturnType<typeof useNavigate>

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    return { t, expanded, setExpanded }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const matching = useMemo(() => {
      const q = this.needle.trim()
      if (!q) return null
      const byId = new Map(this.props.units.map(u => [u.id, u]))
      const keep = new Set<string>()
      for (const u of this.props.units) {
        if (!foldIncludes(u.name, q)) continue
        keep.add(u.id)
        let parent = u.parent_id ? byId.get(u.parent_id) : undefined
        for (let i = 0; parent && i < MAX_DEPTH * 2; i++) {
          keep.add(parent.id)
          parent = parent.parent_id ? byId.get(parent.parent_id) : undefined
        }
      }
      return keep
    }, [this.props.units, this.needle])
    this.publish({ matching })
    return { matching }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, expanded: s.expanded, setExpanded: s.setExpanded })
    const h = this.useHooks()
    this.publish({ matching: h.matching })
    this.navigate = useNavigate()
  }

  get root(): OrgUnit | undefined {
    return this.memo('root', [this.props], () => this.props.units.find(u => u.parent_id === null))
  }

  get rows(): { u: OrgUnit; depth: number; kids: number }[] {
    return this.memo('rows', [this.matching, this.props, this.expanded, this.root], () => (() => {
      const rows: { u: OrgUnit; depth: number; kids: number }[] = []
      const walk = (u: OrgUnit, depth: number) => {
    if (depth > MAX_DEPTH) return
    if (this.matching && !this.matching.has(u.id)) return
    const kids = childrenOf(this.props.units, u.id).filter(c => !this.matching || this.matching.has(c.id))
    rows.push({ u, depth, kids: kids.length })
    if (this.matching || this.expanded.has(u.id) || depth === 0) kids.forEach(c => walk(c, depth + 1))
  }
      if (this.root) walk(this.root, 0)
      return rows
    })())
  }

  get selected(): Set<string> {
    return this.memo('selected', [this.props], () => new Set(this.props.value.unitIds))
  }

  get show_case_1() {
    return !!(this.props.collapsed)
  }

  get show_main() {
    return !(this.props.collapsed)
  }

  get selected_value() {
    if (!(!(this.props.collapsed))) return undefined as never
    return this.props.value.mode === 'all'
  }

  get selected_value2() {
    if (!(!(this.props.collapsed))) return undefined as never
    return this.props.value.mode === 'selected'
  }

  /** The rows of the Repeater over `([false, true] as const)`. */
  get rows_items() {
    return this.memo('rows_items', [this.props, this.multi, this.tr], () => {
      if (!(!(this.props.collapsed))) return undefined as never
      return ([false, true] as const).map((m) => {
      return { m, button_class: ((!(this.props.collapsed))) ? (`flex-1 px-3 py-1.5 transition-colors ${
                this.multi === m ? 'bg-primary-light text-primary font-medium' : 'text-text-secondary hover:bg-surface-2'}`) : undefined, text: ((!(this.props.collapsed))) ? (m ? this.tr('admin.ou_pick_multi') : this.tr('admin.ou_pick_single')) : undefined, key: String(m) }
    })
    })
  }

  get show_rows() {
    if (!(!(this.props.collapsed))) return undefined as never
    return this.rows.length === 0
  }

  get part1_props() {
    return this.memo('part1_props', [this.rows, this.matching, this.expanded, this.selected, this.memo, this.multi, this.props, this.setExpanded], () => {
      if (!(!(this.props.collapsed))) return undefined as never
      return ({ rows: this.rows, matching: this.matching, expanded: this.expanded, selected: this.selected, pick: this.memo("pick:bound", [], () => this.pick.bind(this)), toggle: this.memo("toggle:bound", [], () => this.toggle.bind(this)), multi: this.multi, counts: this.props.counts })
    })
  }

  /** A part of the screen still written in React (a list callback destructuring its item). */
  get Part1() {
    if (!(!(this.props.collapsed))) return undefined as never
    return __parts.Part1
  }

  get show_value_mode_selected() {
    if (!(!(this.props.collapsed))) return undefined as never
    return this.props.value.mode === 'selected' && this.props.value.unitIds.length > 0
  }

  get part2_props() {
    return this.memo('part2_props', [this.props, this.tr], () => {
      if (!(!(this.props.collapsed)) || !(this.props.value.mode === 'selected' && this.props.value.unitIds.length > 0)) return undefined as never
      return ({ value: this.props.value, onChange: this.props.onChange, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<CheckBox> labelClassName: no .kbview property). */
  get Part2() {
    if (!(!(this.props.collapsed)) || !(this.props.value.mode === 'selected' && this.props.value.unitIds.length > 0)) return undefined as never
    return __parts.Part2
  }

  get href() {
    if (!(!(this.props.collapsed))) return undefined as never
    return adminUrl({ tab: 'org-units' })
  }

  toggle(id: string) {
    return this.setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  walk(u: OrgUnit, depth: number) {
    const matching = this.matching
    if (depth > MAX_DEPTH) return
    if (matching && !matching.has(u.id)) return
    const kids = childrenOf(this.props.units, u.id).filter(c => !matching || matching.has(c.id))
    this.rows.push({ u, depth, kids: kids.length })
    if (matching || this.expanded.has(u.id) || depth === 0) kids.forEach(c => this.walk(c, depth + 1))
  }

  pick(id: string) {
    if (this.multi) {
      const next = new Set(this.selected)
      next.has(id) ? next.delete(id) : next.add(id)
      this.props.onChange({ ...this.props.value, mode: next.size ? 'selected' : 'all', unitIds: [...next] })
    } else {
      this.props.onChange({ ...this.props.value, mode: 'selected', unitIds: [id] })
    }
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.props.collapsed)) return undefined as never
    this.props.onCollapsedChange(false)
  }

  panel_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.props.collapsed))) return undefined as never
    this.props.onCollapsedChange(true)
  }

  radio_button_checked_changed(_sender: unknown, _args: ValueChangedEventArgs) {
    if (!(!(this.props.collapsed))) return undefined as never
    this.props.onChange({ ...this.props.value, mode: 'all', unitIds: [] })
  }

  radio_button_checked_changed2(_sender: unknown, _args: ValueChangedEventArgs) {
    if (!(!(this.props.collapsed))) return undefined as never
    this.props.onChange({ ...this.props.value, mode: 'selected' })
  }

  panel_click3(_sender: unknown, args: MouseEventArgs) {
    const { m } = args.row as RowOf_rows_items
    if (!(!(this.props.collapsed))) return undefined as never
                this.multi = m
                // Narrowing back to one: keep the first, or the list would still
                // be scoped to units the panel no longer shows as chosen.
                if (!m && this.props.value.unitIds.length > 1) this.props.onChange({ ...this.props.value, unitIds: this.props.value.unitIds.slice(0, 1) })
              }

  link_label_click(_sender: unknown, _args: MouseEventArgs) {
    this.navigate(adminUrl({ tab: 'org-units' }))
  }

}

type RowOf_rows_items = OrgUnitScopePanel['rows_items'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type OrgUnitScopePanelStores = ReturnType<OrgUnitScopePanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type OrgUnitScopePanelHooks = ReturnType<OrgUnitScopePanel['useHooks']>

export default OrgUnitScopePanel.component()
