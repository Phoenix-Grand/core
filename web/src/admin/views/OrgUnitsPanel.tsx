/**
 * Code-behind of `OrgUnitsPanel.kbview` (converted from `OrgUnitsPanel.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useSearchParams } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import { Plus, FolderInput, Pencil, Trash2 } from "lucide-react"
import { ConfirmDialog, useToast, foldIncludes, type MenuItem, type MenuDropdownPos } from "@ui"
import OrgUnitPicker from "../dialogs/OrgUnitPicker"
import { useConfirm } from "../../core/hooks/useConfirm"
import { useAdminAction } from "../adminAction"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import type { OrgUnit } from "../../core/types"

import { ViewBase } from './OrgUnitsPanel.kbview'
import * as __parts from './OrgUnitsPanel.parts.tsx'

const MAX_DEPTH = 32

function flatten(units: OrgUnit[], parentId: string | null, depth: number, out: { u: OrgUnit; depth: number }[]) {
  if (depth > MAX_DEPTH) return
  units.filter(x => x.parent_id === parentId).sort((a, b) => a.name.localeCompare(b.name)).forEach(u => {
    out.push({ u, depth })
    flatten(units, u.id, depth + 1, out)
  })
}

function errMessage(err: unknown): string | undefined {
  const e = err as { message?: string; response?: { data?: { message?: string } } }
  return e?.response?.data?.message ?? e?.message
}

export class OrgUnitsPanel extends ViewBase {
  @bind accessor dialog: { mode: 'create' | 'edit'; unit?: OrgUnit; parentId?: string } | null = null
  @bind accessor moveUnit: OrgUnit | null = null
  @bind accessor menu: { unit: OrgUnit; pos: MenuDropdownPos } | null = null
  @bind accessor pendingCreate = false
  tr!: OrgUnitsPanelStores['t']
  qc!: OrgUnitsPanelStores['qc']
  can!: OrgUnitsPanelStores['can']
  data!: OrgUnitsPanelStores['data']
  counts!: OrgUnitsPanelStores['counts']
  params!: URLSearchParams
  toast!: OrgUnitsPanelStores['toast']
  confirm!: OrgUnitsPanelStores['confirm']
  confirmState!: OrgUnitsPanelStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  move!: OrgUnitsPanelHooks['move']
  remove!: OrgUnitsPanelHooks['remove']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const { can } = usePrivileges()
    const { data } = useQuery({
      queryKey: ['admin-org-units'],
      queryFn: () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
      staleTime: 30_000,
    })
    const { data: counts } = useQuery({
      queryKey: ['admin-org-unit-counts'],
      queryFn: () =>
        api.get<{ org_unit_counts?: { org_unit_id: string; count: number }[] }>('/admin/users', {
          params: { limit: 0, counts: true },
        }).then(r => r.data.org_unit_counts ?? []),
      enabled: can(PRIV.USERS_READ),
      staleTime: 30_000,
    })
    const [params] = useSearchParams()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    return { t, qc, can, data, counts, params, toast, confirm, confirmState, handleConfirm, handleCancel }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const toast = this.toast
    useAdminAction('create', () => this.pendingCreate = true)
    useEffect(() => {
      if (!this.pendingCreate || this.units.length === 0) return
      this.pendingCreate = false
      this.dialog = { mode: 'create', parentId: this.units.find(u => u.parent_id === null)?.id }
    }, [this.pendingCreate, this.units])
    const move = useMutation({
      mutationFn: (p: { id: string; parent_id: string }) =>
        api.patch(`/admin/org-units/${p.id}`, { parent_id: p.parent_id }),
      onSuccess: this.memo("invalidate_:bound", [], () => this.invalidate_.bind(this)),
      onError: err => toast.error(errMessage(err) ?? t('admin.ou_move_error')),
    })
    this.publish({ move })
    const remove = useMutation({
      mutationFn: (id: string) => api.delete(`/admin/org-units/${id}`),
      onSuccess: this.memo("invalidate_:bound", [], () => this.invalidate_.bind(this)),
      onError: err => toast.error(errMessage(err) ?? t('admin.ou_delete_error')),
    })
    this.publish({ remove })
    return { move, remove }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, qc: s.qc, can: s.can, data: s.data, counts: s.counts, params: s.params, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel })
    const h = this.useHooks()
    this.publish({ move: h.move, remove: h.remove })
  }

  get units() {
    return this.memo('units', [this.data], () => this.data ?? [])
  }

  get own(): Map<string, number> {
    return this.memo('own', [this.counts], () => new Map((this.counts ?? []).map(c => [c.org_unit_id, c.count])))
  }

  get search(): string {
    return this.params.get('q') ?? ''
  }

  get needle(): string {
    return this.search.trim()
  }

  get flat(): { u: OrgUnit; depth: number }[] {
    return this.memo('flat', [this.units], () => (() => {
      const flat: { u: OrgUnit; depth: number }[] = []
      flatten(this.units, null, 0, flat)
      return flat
    })())
  }

  get rows(): { u: OrgUnit; depth: number; }[] {
    return this.memo('rows', [this.needle, this.units, this.flat], () => this.needle
    ? this.units.filter(u => foldIncludes(`${u.name} ${u.description ?? ''}`, this.needle)).map(u => ({ u, depth: 0 }))
    : this.flat)
  }

  get span_text() {
    return this.memo('span_text', [this.tr, this.units], () => "| " + this.tr('admin.ou_count', { count: this.units.length }))
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.can, this.rows, this.own, this.memo, this.units, this.dialog, this.moveUnit, this.menu], () => ({ t: this.tr, can: this.can, rows: this.rows, own: this.own, subtreeCount: this.memo("subtreeCount:bound", [], () => this.subtreeCount.bind(this)), setDialog: this.memo("setDialog:bound", [], () => this.setDialog.bind(this)), setMoveUnit: this.memo("setMoveUnit:bound", [], () => this.setMoveUnit.bind(this)), openMenu: this.memo("openMenu:bound", [], () => this.openMenu.bind(this)) }))
  }

  /** A part of the screen still written in React (<table> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

  get show_menu() {
    return this.memo('show_menu', [this.menu], () => !!(this.menu))
  }

  get part2_props() {
    return this.memo('part2_props', [this.memo, this.tr, this.dialog, this.moveUnit, this.confirm, this.remove, this.menu], () => {
      if (!(this.menu)) return undefined as never
      return ({ menuItems: this.memo("menuItems:bound", [], () => this.menuItems.bind(this)), menu: this.menu, setMenu: this.memo("setMenu:bound", [], () => this.setMenu.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<ContextMenu> pos, onClose: no .kbview property). */
  get Part2() {
    if (!(this.menu)) return undefined as never
    return __parts.Part2
  }

  get show_dialog() {
    return this.memo('show_dialog', [this.dialog], () => !!(this.dialog))
  }

  /** `<OrgUnitDialog>`, rendered by a ReactHost. */
  get OrgUnitDialog() {
    if (!(this.dialog)) return undefined as never
    return __parts.OrgUnitDialog
  }

  get org_unit_dialog_props() {
    return this.memo('org_unit_dialog_props', [this.dialog, this.units], () => {
      if (!(this.dialog)) return undefined as never
      return ({ ...this.dialog, units: this.units, onClose: () => this.dialog = null } as React.ComponentProps<typeof __parts.OrgUnitDialog>)
    })
  }

  get show_move_unit() {
    return this.memo('show_move_unit', [this.moveUnit], () => !!(this.moveUnit))
  }

  /** `<OrgUnitPicker>`, rendered by a ReactHost. */
  get OrgUnitPicker() {
    if (!(this.moveUnit)) return undefined as never
    return OrgUnitPicker
  }

  get org_unit_picker_props() {
    return this.memo('org_unit_picker_props', [this.tr, this.move, this.moveUnit], () => {
      if (!(this.moveUnit)) return undefined as never
      const moveUnit = this.moveUnit
      return ({ title: this.tr('admin.ou_move_title', { name: moveUnit.name }), currentId: moveUnit.parent_id, excludeId: moveUnit.id, onSelect: (id) => this.move.mutate({ id: moveUnit.id, parent_id: id }), onClose: () => this.moveUnit = null } as React.ComponentProps<typeof OrgUnitPicker>)
    })
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState], () => !!(this.confirmState))
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel], () => {
      if (!(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  subtreeCount(id: string, depth = 0): number {
    return depth > MAX_DEPTH
      ? 0
      : (this.own.get(id) ?? 0)
        + this.units.filter(u => u.parent_id === id).reduce((n, u) => n + this.subtreeCount(u.id, depth + 1), 0)
  }

  invalidate_() {
    this.qc.invalidateQueries({ queryKey: ['admin-org-units'] })
    // Moving or deleting a unit reshuffles which accounts sit where.
    this.qc.invalidateQueries({ queryKey: ['admin-org-unit-counts'] })
  }

  async askDelete(u: OrgUnit) {
    const ok = await this.confirm({
      title:        this.tr('admin.ou_delete_title', { name: u.name }),
      message:      this.tr('admin.ou_delete_confirm'),
      confirmLabel: this.tr('admin.ou_delete'),
      variant:      'danger',
    })
    if (ok) this.remove.mutate(u.id)
  }

  openMenu(u: OrgUnit, el: HTMLElement) {
    const r = el.getBoundingClientRect()
    this.menu = { unit: u, pos: { top: r.bottom + 4, left: Math.max(8, r.right - 180) } }
  }

  menuItems(u: OrgUnit): MenuItem[] {
    return [
    { type: 'action', label: this.tr('admin.ou_add'),    icon: <Plus size={15} />,       onClick: () => this.dialog = { mode: 'create', parentId: u.id } },
    { type: 'action', label: this.tr('admin.ou_rename'), icon: <Pencil size={15} />,     onClick: () => this.dialog = { mode: 'edit', unit: u } },
    ...(u.parent_id !== null
      ? [{ type: 'action' as const, label: this.tr('admin.ou_move'), icon: <FolderInput size={15} />, onClick: () => this.moveUnit = u },
         { type: 'separator' as const },
         { type: 'action' as const, label: this.tr('admin.ou_delete'), danger: true, icon: <Trash2 size={15} />, onClick: () => { void this.askDelete(u) } }]
      : []),
  ]
  }

  /** `setDialog` of the TSX: a value, or an update of the previous one. */
  setDialog(value: { mode: 'create' | 'edit'; unit?: OrgUnit; parentId?: string } | null | ((prev: { mode: 'create' | 'edit'; unit?: OrgUnit; parentId?: string } | null) => { mode: 'create' | 'edit'; unit?: OrgUnit; parentId?: string } | null)) {
    this.dialog = typeof value === 'function' ? (value as (prev: { mode: 'create' | 'edit'; unit?: OrgUnit; parentId?: string } | null) => { mode: 'create' | 'edit'; unit?: OrgUnit; parentId?: string } | null)(this.dialog) : value
  }

  /** `setMoveUnit` of the TSX: a value, or an update of the previous one. */
  setMoveUnit(value: OrgUnit | null | ((prev: OrgUnit | null) => OrgUnit | null)) {
    this.moveUnit = typeof value === 'function' ? (value as (prev: OrgUnit | null) => OrgUnit | null)(this.moveUnit) : value
  }

  /** `setMenu` of the TSX: a value, or an update of the previous one. */
  setMenu(value: { unit: OrgUnit; pos: MenuDropdownPos } | null | ((prev: { unit: OrgUnit; pos: MenuDropdownPos } | null) => { unit: OrgUnit; pos: MenuDropdownPos } | null)) {
    this.menu = typeof value === 'function' ? (value as (prev: { unit: OrgUnit; pos: MenuDropdownPos } | null) => { unit: OrgUnit; pos: MenuDropdownPos } | null)(this.menu) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type OrgUnitsPanelStores = ReturnType<OrgUnitsPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type OrgUnitsPanelHooks = ReturnType<OrgUnitsPanel['useHooks']>

export default OrgUnitsPanel.component()
