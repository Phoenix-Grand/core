/**
 * Code-behind of `ScopeTree.kbcontrol` (converted from `ScopeTree.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { Fragment } from 'react'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { Building2 } from "lucide-react"
import { foldIncludes } from "@ui"
import { api } from "../../../core/api/client"
import type { OrgUnit } from "../../../core/types"
import { orgUnitPath, type ActiveScope } from "../scopeTypes"

import { ViewBase } from './ScopeTree.kbcontrol'
import * as __parts from './ScopeTree.parts.tsx'

const MAX_DEPTH = 32

const FILTER_THRESHOLD = 8

const childrenOf = (units: OrgUnit[], parentId: string | null) =>
  units.filter(u => u.parent_id === parentId).sort((a, b) => a.name.localeCompare(b.name))

export interface ScopeTreeProps {
  scope:    ActiveScope
  onChange: (next: ActiveScope) => void
  /** Units holding their own value for at least one setting of this page -
   *  marked with a dot, so a branch that diverges is findable without opening
   *  it. Empty is the normal case and shows nothing. */
  overriding?: Set<string>
}

export class ScopeTree extends ViewBase {
  @bind accessor needle = ''
  tr!: ScopeTreeStores['t']
  expanded!: Set<string>
  setExpanded!: ScopeTreeStores['setExpanded']
  units!: ScopeTreeStores['units']
  openPath!: Set<string>

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const { data } = useQuery({
      queryKey: ['admin-org-units'],
      queryFn: () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
      staleTime: 30_000,
    })
    const units = useMemo(() => data ?? [], [data])
    return { t, expanded, setExpanded, data, units }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const units = this.units
    const root = this.root
    const openPath = useMemo(() => {
      const ids = new Set<string>()
      if (root) ids.add(root.id)
      for (const u of orgUnitPath(units, this.props.scope.type === 'org_unit' ? this.props.scope.id : null)) ids.add(u.id)
      return ids
    }, [units, root, this.props.scope.type, this.props.scope.id])
    this.publish({ openPath })
    return { openPath }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, expanded: s.expanded, setExpanded: s.setExpanded, units: s.units })
    const h = this.useHooks()
    this.publish({ openPath: h.openPath })
  }

  get root(): OrgUnit | null {
    return this.memo('root', [this.units], () => this.units.find(u => u.parent_id === null) ?? null)
  }

  get rows(): { unit: OrgUnit; depth: number; kids: number }[] {
    return this.memo('rows', [this.expanded, this.openPath, this.units, this.root], () => (() => {
      const rows: { unit: OrgUnit; depth: number; kids: number }[] = []
      const isOpen = (id: string) => this.expanded.has(id) || this.openPath.has(id)
      const walk = (u: OrgUnit, depth: number) => {
    if (depth > MAX_DEPTH) return
    const kids = childrenOf(this.units, u.id)
    rows.push({ unit: u, depth, kids: kids.length })
    if (isOpen(u.id)) kids.forEach(k => walk(k, depth + 1))
  }
      if (this.root) walk(this.root, 0)
      return rows
    })())
  }

  get filtering(): boolean {
    return this.needle.trim().length > 0
  }

  get results(): OrgUnit[] {
    return this.memo('results', [this.units, this.needle], () => {
      const needle = this.needle
      const filtering = needle.trim().length > 0
      return filtering
    ? this.units
        .filter(u => foldIncludes(`${u.name} ${orgUnitPath(this.units, u.id).map(p => p.name).join(' ')}`, needle.trim()))
        .sort((a, b) => a.name.localeCompare(b.name))
    : []
    })
  }

  get isInstance(): boolean {
    return this.props.scope.type === 'instance'
  }

  get instanceRow() {
    return this.memo('instanceRow', [this.props, this.isInstance, this.tr], () => (
    <div className="flex items-center">
      <span className="h-6 w-5 shrink-0" aria-hidden />
      <button
        type="button"
        onClick={() => this.props.onChange({ type: 'instance', id: null })}
        className={this.rowClass(this.isInstance)}
        aria-current={this.isInstance ? 'true' : undefined}
      >
        <Building2 size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm">
          {this.tr('admin.m_scope_instance', { defaultValue: "Toute l'instance" })}
        </span>
      </button>
    </div>
  ))
  }

  get show_units_filter_threshold() {
    return this.units.length > FILTER_THRESHOLD
  }

  get part1_props() {
    return this.memo('part1_props', [this.needle, this.memo, this.tr, this.units], () => {
      if (!(this.units.length > FILTER_THRESHOLD)) return undefined as never
      return ({ needle: this.needle, setNeedle: this.memo("setNeedle:bound", [], () => this.setNeedle.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<TextField LeftIcon>: an icon size the element cannot take). */
  get Part1() {
    if (!(this.units.length > FILTER_THRESHOLD)) return undefined as never
    return __parts.Part1
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_instance_row() {
    return this.memo('content_instance_row', [this.instanceRow], () => ({ children: this.instanceRow }))
  }

  get show_not_filtering() {
    return !(this.filtering)
  }

  get show_results() {
    if (!(this.filtering)) return undefined as never
    return this.results.length === 0
  }

  get show_not_results() {
    if (!(this.filtering)) return undefined as never
    return !(this.results.length === 0)
  }

  /** The rows of the Repeater over `results`. */
  get rows_results() {
    return this.memo('rows_results', [this.results, this.filtering, this.props, this.units], () => {
      if (!(this.filtering) || !(!(this.results.length === 0))) return undefined as never
      return this.results.map((u) => {
      return { u, button_class: ((this.filtering) && (!(this.results.length === 0))) ? (this.rowClass(this.props.scope.type === 'org_unit' && this.props.scope.id === u.id)) : undefined, span_text: ((this.filtering) && (!(this.results.length === 0))) ? (orgUnitPath(this.units, u.id).slice(0, -1).map(p => p.name).join(' / ')) : undefined, key: u.id }
    })
    })
  }

  get visible() {
    return this.memo('visible', [this.show_results, this.filtering], () => this.show_results && this.filtering)
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_results, this.filtering], () => this.show_not_results && this.filtering)
  }

  get part2_props() {
    return this.memo('part2_props', [this.rows, this.props, this.memo, this.expanded, this.openPath, this.setExpanded, this.tr, this.filtering], () => {
      if (!(!(this.filtering))) return undefined as never
      return ({ rows: this.rows, scope: this.props.scope, isOpen: this.memo("isOpen:bound", [], () => this.isOpen.bind(this)), toggle: this.memo("toggle:bound", [], () => this.toggle.bind(this)), onChange: this.props.onChange, rowClass: this.memo("rowClass:bound", [], () => this.rowClass.bind(this)), overriding: this.props.overriding, t: this.tr })
    })
  }

  /** A part of the screen still written in React (a list callback destructuring its item). */
  get Part2() {
    if (!(!(this.filtering))) return undefined as never
    return __parts.Part2
  }

  isOpen(id: string) {
    return this.expanded.has(id) || this.openPath.has(id)
  }

  toggle(id: string) {
    return this.setExpanded(prev => {
      const next = new Set(prev)
      // A row opened by the path has no entry of its own; closing it has to add
      // every other open id first, or the click would look ignored.
      if (this.isOpen(id)) { for (const o of this.openPath) next.add(o); next.delete(id) }
      else next.add(id)
      return next
    })
  }

  walk(u: OrgUnit, depth: number) {
    if (depth > MAX_DEPTH) return
    const kids = childrenOf(this.units, u.id)
    this.rows.push({ unit: u, depth, kids: kids.length })
    if (this.isOpen(u.id)) kids.forEach(k => this.walk(k, depth + 1))
  }

  rowClass(selected: boolean) {
    return `flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
      selected ? 'bg-primary-light text-primary' : 'text-text-primary hover:bg-surface-2'
    }`
  }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { u } = args.row as RowOf_rows_results
    if (!(this.filtering) || !(!(this.results.length === 0))) return undefined as never
    this.props.onChange({ type: 'org_unit', id: u.id })
  }

  /** `setNeedle` of the TSX: a value, or an update of the previous one. */
  setNeedle(value: ScopeTree['needle'] | ((prev: ScopeTree['needle']) => ScopeTree['needle'])) {
    this.needle = typeof value === 'function' ? (value as (prev: ScopeTree['needle']) => ScopeTree['needle'])(this.needle) : value
  }

}

type RowOf_rows_results = ScopeTree['rows_results'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type ScopeTreeStores = ReturnType<ScopeTree['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ScopeTreeHooks = ReturnType<ScopeTree['useHooks']>

export default ScopeTree.component()
