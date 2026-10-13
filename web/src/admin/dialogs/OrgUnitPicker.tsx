/**
 * Code-behind of `OrgUnitPicker.kbview` (converted from `OrgUnitPicker.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useState, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import { ChevronRight, Plus } from "lucide-react"
import { Input, foldIncludes } from "@ui"
import type { OrgUnit } from "../../core/types"

import { ViewBase } from './OrgUnitPicker.kbview'
import * as __parts from './OrgUnitPicker.parts.tsx'

const MAX_DEPTH = 32

const ouChildren = (units: OrgUnit[], parentId: string | null) =>
  units.filter(u => u.parent_id === parentId).sort((a, b) => a.name.localeCompare(b.name))

function ouPath(units: OrgUnit[], unit: OrgUnit): string {
  const names: string[] = []
  const byId = new Map(units.map(u => [u.id, u]))
  let cur = unit.parent_id ? byId.get(unit.parent_id) : undefined
  // Bounded walk: a cycle is refused server-side, but a corrupted tree must not
  // freeze the picker.
  for (let i = 0; cur && i < 64; i++) {
    names.unshift(cur.name)
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  return names.join(' / ')
}

function ouMatches(units: OrgUnit[], unit: OrgUnit, needle: string): boolean {
  return foldIncludes(`${unit.name} ${ouPath(units, unit)}`, needle)
}

export type OrgUnitPickerProps = {
  title: string
  currentId: string | null
  excludeId?: string          // hide this subtree (e.g. when moving a unit into a parent)
  onSelect: (id: string) => void
  onClose: () => void
}

export class OrgUnitPicker extends ViewBase {
  @bind accessor addUnder: string | null = null
  @bind accessor name = ''
  @bind accessor needle = ''
  @bind accessor createError = ''
  tr!: OrgUnitPickerStores['t']
  qc!: OrgUnitPickerStores['qc']
  data!: OrgUnitPickerStores['data']
  sel!: string | null
  setSel!: OrgUnitPickerHooks['setSel']
  expanded!: Set<string>
  setExpanded!: OrgUnitPickerStores['setExpanded']
  treeRef!: OrgUnitPickerStores['treeRef']
  create!: OrgUnitPickerHooks['create']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const { data } = useQuery({
      queryKey: ['admin-org-units'],
      queryFn: () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
      staleTime: 30_000,
    })
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const treeRef = useRef<HTMLDivElement>(null)
    return { t, qc, data, expanded, setExpanded, treeRef }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const qc = this.qc
    const setExpanded = this.setExpanded
    const [sel, setSel]           = useState<string | null>(this.props.currentId ?? null)
    this.publish({ sel, setSel })
    const root = this.root
    useEffect(() => { if (root) { setExpanded(s => new Set(s).add(root.id)); setSel(p => p ?? root.id) } }, [root])
    const create = useMutation({
      mutationFn: (p: { name: string; parent_id: string }) => api.post<{ org_unit: OrgUnit }>('/admin/org-units', p).then(r => r.data.org_unit),
      onSuccess: (u) => { this.addUnder = null; this.name = ''; this.createError = ''; if (u.parent_id) setExpanded(s => new Set(s).add(u.parent_id!)); setSel(u.id); qc.invalidateQueries({ queryKey: ['admin-org-units'] }) },
      // Both shapes: the API client rejects with a FLAT `{ message, code }`
      // (`normalizeError`, api/client.ts), so reading `response.data.message`
      // alone loses "a unit named X already exists under the same parent".
      onError: (err) => {
        const e = err as { message?: string; response?: { data?: { message?: string } } }
        this.createError = e?.response?.data?.message ?? e?.message ?? t('admin.ou_create_error')
      },
    })
    this.publish({ create })
    return { sel, setSel, create }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, qc: s.qc, data: s.data, expanded: s.expanded, setExpanded: s.setExpanded, treeRef: s.treeRef })
    const h = this.useHooks()
    this.publish({ sel: h.sel, setSel: h.setSel, create: h.create })
  }

  get units() {
    return this.memo('units', [this.data], () => this.data ?? [])
  }

  get root(): OrgUnit | undefined {
    return this.memo('root', [this.units], () => this.units.find(u => u.parent_id === null))
  }

  get visible(): { u: OrgUnit; depth: number; kids: number }[] {
    return this.memo('visible', [this.props, this.units, this.expanded, this.root], () => (() => {
      const visible: { u: OrgUnit; depth: number; kids: number }[] = []
      const walk = (u: OrgUnit, depth: number) => {
    if (depth > MAX_DEPTH || u.id === this.props.excludeId) return
    const kids = ouChildren(this.units, u.id)
    visible.push({ u, depth, kids: kids.length })
    if (this.expanded.has(u.id)) kids.forEach(c => walk(c, depth + 1))
  }
      if (this.root) walk(this.root, 0)
      return visible
    })())
  }

  get results(): OrgUnit[] {
    return this.memo('results', [this.needle, this.units, this.props], () => this.needle.trim()
    ? this.units.filter(u => !this.excluded(u) && ouMatches(this.units, u, this.needle.trim()))
          .sort((a, b) => a.name.localeCompare(b.name))
    : [])
  }

  get enabled_unless_sel() {
    return !(!this.sel)
  }

  get part1_props() {
    return this.memo('part1_props', [this.needle, this.memo, this.tr], () => ({ needle: this.needle, setNeedle: this.memo("setNeedle:bound", [], () => this.setNeedle.bind(this)), t: this.tr }))
  }

  /** A part of the screen still written in React (<TextField LeftIcon>: an icon size the element cannot take). */
  get Part1() {
    return __parts.Part1
  }

  get show_needle_trim() {
    return !!(this.needle.trim())
  }

  get show_not_needle_trim() {
    return !(this.needle.trim())
  }

  get show_results() {
    if (!(this.needle.trim())) return undefined as never
    return this.results.length === 0
  }

  get show_not_results() {
    if (!(this.needle.trim())) return undefined as never
    return !(this.results.length === 0)
  }

  /** The rows of the Repeater over `results`. */
  get rows_results() {
    return this.memo('rows_results', [this.results, this.needle, this.sel, this.units], () => {
      if (!(this.needle.trim()) || !(!(this.results.length === 0))) return undefined as never
      return this.results.map((u) => {
      return { u, button_class: ((this.needle.trim()) && (!(this.results.length === 0))) ? (`w-full text-left px-2 py-1.5 rounded ${this.sel === u.id ? 'bg-primary-light text-primary' : 'hover:bg-surface-2 text-text-primary'}`) : undefined, show_ou_path_units_u: ((this.needle.trim()) && (!(this.results.length === 0))) ? (!!(ouPath(this.units, u))) : undefined, span_text: ((this.needle.trim()) && (!(this.results.length === 0)) && (ouPath(this.units, u))) ? (ouPath(this.units, u)) : undefined, key: u.id }
    })
    })
  }

  get visible2() {
    return this.memo('visible2', [this.show_results, this.show_needle_trim], () => this.show_results && this.show_needle_trim)
  }

  get visible3() {
    return this.memo('visible3', [this.show_not_results, this.show_needle_trim], () => this.show_not_results && this.show_needle_trim)
  }

  get show_root() {
    return this.memo('show_root', [this.root, this.needle], () => {
      if (!(!(this.needle.trim()))) return undefined as never
      return !!(this.root)
    })
  }

  get show_not_root() {
    return this.memo('show_not_root', [this.root, this.needle], () => {
      if (!(!(this.needle.trim()))) return undefined as never
      return !(this.root)
    })
  }

  get part2_props() {
    return this.memo('part2_props', [this.treeRef, this.props, this.memo, this.sel, this.visible, this.setSel, this.expanded, this.setExpanded, this.addUnder, this.name, this.createError, this.tr, this.create, this.needle, this.root], () => {
      if (!(!(this.needle.trim())) || !(this.root)) return undefined as never
      return ({ treeRef: this.treeRef, title: this.props.title, onTreeKey: this.memo("onTreeKey:bound", [], () => this.onTreeKey.bind(this)), visible: this.visible, renderRow: this.memo("renderRow:bound", [], () => this.renderRow.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<div ref>: attribute(s) without a .kbview property). */
  get Part2() {
    if (!(!(this.needle.trim())) || !(this.root)) return undefined as never
    return __parts.Part2
  }

  get visible4() {
    return this.memo('visible4', [this.show_root, this.show_not_needle_trim], () => this.show_root && this.show_not_needle_trim)
  }

  get visible5() {
    return this.memo('visible5', [this.show_not_root, this.show_not_needle_trim], () => this.show_not_root && this.show_not_needle_trim)
  }

  toggle(id: string) {
    return this.setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  walk(u: OrgUnit, depth: number) {
    if (depth > MAX_DEPTH || u.id === this.props.excludeId) return
    const kids = ouChildren(this.units, u.id)
    this.visible.push({ u, depth, kids: kids.length })
    if (this.expanded.has(u.id)) kids.forEach(c => this.walk(c, depth + 1))
  }

  onTreeKey(e: React.KeyboardEvent) {
    const sel = this.sel
    const i = this.visible.findIndex(v => v.u.id === sel)
    const at = (n: number) => { const v = this.visible[n]; if (v) { this.setSel(v.u.id); e.preventDefault() } }
    switch (e.key) {
      case 'ArrowDown': at(i + 1); break
      case 'ArrowUp':   at(i - 1); break
      case 'Home':      at(0); break
      case 'End':       at(this.visible.length - 1); break
      case 'ArrowRight': {
        const cur = this.visible[i]
        if (!cur || cur.kids === 0) return
        if (!this.expanded.has(cur.u.id)) { this.toggle(cur.u.id); e.preventDefault() }
        else at(i + 1)
        break
      }
      case 'ArrowLeft': {
        const cur = this.visible[i]
        if (!cur) return
        if (cur.kids > 0 && this.expanded.has(cur.u.id)) { this.toggle(cur.u.id); e.preventDefault() }
        else if (cur.u.parent_id) {
          const p = this.visible.findIndex(v => v.u.id === cur.u.parent_id)
          if (p >= 0) at(p)
        }
        break
      }
      case 'Enter':
        if (sel) { this.props.onSelect(sel); this.props.onClose(); e.preventDefault() }
        break
    }
  }

  renderRow({ u, depth, kids }: { u: OrgUnit; depth: number; kids: number }) {
    const sel = this.sel
    const open = this.expanded.has(u.id)
    return (
      <div key={u.id}>
        <div
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={sel === u.id}
          aria-expanded={kids > 0 ? open : undefined}
          // Roving tabindex: one stop for the whole tree, the arrows do the rest.
          tabIndex={sel === u.id ? 0 : -1}
          ref={el => { if (el && sel === u.id && this.treeRef.current?.contains(document.activeElement)) el.focus() }}
          onClick={() => this.setSel(u.id)}
          className={`flex items-center gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-primary
                      ${sel === u.id ? 'bg-primary-light text-primary' : 'hover:bg-surface-2 text-text-primary'}`}
          style={{ paddingLeft: depth * 18 }}
        >
          <button
            type="button" tabIndex={-1} aria-hidden="true"
            onClick={e => { e.stopPropagation(); this.toggle(u.id) }}
            className="w-5 h-5 flex items-center justify-center text-text-tertiary shrink-0"
          >
            {kids > 0 && <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />}
          </button>
          <span className="flex-1 text-left text-sm px-2 py-1.5">{u.name}</span>
          <button
            type="button" tabIndex={-1}
            onClick={e => { e.stopPropagation(); this.addUnder = u.id; this.name = ''; this.createError = ''; this.setExpanded(s => new Set(s).add(u.id)) }}
            title={this.tr('admin.ou_add')}
            className="p-1 text-text-tertiary hover:text-primary"
          >
            <Plus size={14} />
          </button>
        </div>
        {this.addUnder === u.id && (
          // Nothing is POSTed until this form is validated: the `+` used to send
          // the request on the spot, so a unit outlived the dialog that was
          // cancelled right after.
          <div className="py-1.5" style={{ paddingLeft: depth * 18 + 28 }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <Input
                value={this.name}
                autoFocus
                onChange={e => this.name = e.target.value}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Enter' && this.name.trim()) this.create.mutate({ name: this.name.trim(), parent_id: u.id })
                  if (e.key === 'Escape') { this.addUnder = null; this.createError = '' }
                }}
                placeholder={this.tr('admin.ou_name_ph')}
              />
              <button
                type="button"
                disabled={!this.name.trim() || this.create.isPending}
                onClick={() => this.create.mutate({ name: this.name.trim(), parent_id: u.id })}
                className="text-sm text-primary disabled:opacity-40 whitespace-nowrap"
              >
                {this.tr('admin.ou_create')}
              </button>
              <button
                type="button"
                onClick={() => { this.addUnder = null; this.createError = '' }}
                className="text-sm text-text-tertiary whitespace-nowrap"
              >
                {this.tr('admin.ou_cancel')}
              </button>
            </div>
            {this.createError && <p className="text-sm text-danger mt-1">{this.createError}</p>}
          </div>
        )}
      </div>
    )
  }

  excluded(u: OrgUnit): boolean {
    if (!this.props.excludeId) return false
    const byId = new Map(this.units.map(x => [x.id, x]))
    let cur: OrgUnit | undefined = u
    for (let i = 0; cur && i < 64; i++) {
      if (cur.id === this.props.excludeId) return true
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
    }
    return false
  }

  panel_mouse_down(_sender: unknown, args: MouseEventArgs) {
    const e = args.native as React.MouseEvent<HTMLDivElement, MouseEvent>
    e.stopPropagation()
  }

  floating_window_confirm(_sender: unknown, _args: EventArgs) {
 if (this.sel) { this.props.onSelect(this.sel); this.props.onClose() } }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    this.props.onClose?.()
  }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { u } = args.row as RowOf_rows_results
    if (!(this.needle.trim()) || !(!(this.results.length === 0))) return undefined as never
    this.setSel(u.id)
  }

  /** `setNeedle` of the TSX: a value, or an update of the previous one. */
  setNeedle(value: OrgUnitPicker['needle'] | ((prev: OrgUnitPicker['needle']) => OrgUnitPicker['needle'])) {
    this.needle = typeof value === 'function' ? (value as (prev: OrgUnitPicker['needle']) => OrgUnitPicker['needle'])(this.needle) : value
  }

}

type RowOf_rows_results = OrgUnitPicker['rows_results'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type OrgUnitPickerStores = ReturnType<OrgUnitPicker['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type OrgUnitPickerHooks = ReturnType<OrgUnitPicker['useHooks']>

export default OrgUnitPicker.component()
