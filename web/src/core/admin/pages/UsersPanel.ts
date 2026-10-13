/**
 * Code-behind of `UsersPanel.kbcontrol` (converted from `UsersPanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { OrgUnit, User } from "../../types"
import { ConfirmDialog, useToast } from "@ui"
import { PRIV } from "../../authz/types"
import { usePrivileges } from "../../authz/usePrivileges"
import { useConfirm } from "../../hooks/useConfirm"
import OrgUnitPicker from "../dialogs/OrgUnitPicker"
import { ALL_UNITS, type OrgUnitScope } from "./OrgUnitScopePanel"
import { adminUrl, useAdminAction } from "../adminAction"

import { ViewBase } from './UsersPanel.kbcontrol'
import * as __parts from './UsersPanel.parts.tsx'

function errMessage(err: unknown): string | undefined {
  const e = err as { message?: string; response?: { data?: { message?: string } } }
  return e?.response?.data?.message ?? e?.message
}

export class UsersPanel extends ViewBase {
  @bind accessor page = 0
  @bind accessor showCreate = false
  @bind accessor panelCollapsed = false
  @bind accessor bulkPicker = false
  @bind accessor pendingReset = false
  tr!: UsersPanelStores['t']
  can!: UsersPanelStores['can']
  params!: URLSearchParams
  navigate!: UsersPanelStores['navigate']
  search!: UsersPanelStores['search']
  setSearch!: UsersPanelStores['setSearch']
  queryClient!: UsersPanelStores['queryClient']
  toast!: UsersPanelStores['toast']
  confirm!: UsersPanelStores['confirm']
  confirmState!: UsersPanelStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  scope!: OrgUnitScope
  setScope!: UsersPanelStores['setScope']
  selected!: Set<string>
  setSelected!: UsersPanelStores['setSelected']
  units!: UsersPanelStores['units']
  data!: UsersPanelHooks['data']
  toggleActive!: UsersPanelStores['toggleActive']
  bulkMove!: UsersPanelHooks['bulkMove']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { can } = usePrivileges()
    const [params] = useSearchParams()
    const navigate = useNavigate()
    const [search, setSearch] = useState<string>(params.get('q') ?? '')
    const queryClient = useQueryClient()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const [scope, setScope] = useState<OrgUnitScope>(ALL_UNITS)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const { data: units } = useQuery({
      queryKey: ['admin-org-units'],
      queryFn:  () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
      enabled:  can(PRIV.ORG_UNITS_READ),
      staleTime: 30_000,
    })
    const toggleActive = useMutation({
      mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
        api.patch(`/admin/users/${id}`, { is_active }),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
      onError: (err) => toast.error(errMessage(err) ?? t('admin.update_error')),
    })
    return { t, can, params, navigate, search, setSearch, queryClient, toast, confirm, confirmState, handleConfirm, handleCancel, scope, setScope, selected, setSelected, units, toggleActive }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const search = this.search
    const queryClient = this.queryClient
    const toast = this.toast
    const scope = this.scope
    const selected = this.selected
    const setSelected = this.setSelected
    useAdminAction('create', () => this.showCreate = true)
    useAdminAction('reset-password', () => this.pendingReset = true)
    const { data } = useQuery({
      queryKey: ['admin-users', search, this.page, this.scopedUnits.join(','), scope.descendants],
      queryFn: () =>
        api.get<{ users: User[]; total: number }>('/admin/users', {
          params: {
            search: search || undefined,
            org_unit_ids: this.scopedUnits.length ? this.scopedUnits.join(',') : undefined,
            include_descendants: this.scopedUnits.length ? scope.descendants : undefined,
            limit: this.limit, offset: this.page * this.limit,
          },
        }).then((r) => r.data),
    })
    this.publish({ data })
    const bulkMove = useMutation({
      mutationFn: (orgUnitId: string) =>
        api.post<{ moved: number }>('/admin/users/bulk/org-unit', {
          user_ids: [...selected], org_unit_id: orgUnitId,
        }).then(r => r.data),
      onSuccess: (res, orgUnitId) => {
        setSelected(new Set())
        queryClient.invalidateQueries({ queryKey: ['admin-users'] })
        // The unit manager counts accounts from this same endpoint.
        queryClient.invalidateQueries({ queryKey: ['admin-org-unit-counts'] })
        toast.success(t('admin.bulk_ou_done', {
          count: res.moved, unit: this.unitName(orgUnitId) ?? '',
        }))
      },
      onError: (err) => toast.error(errMessage(err) ?? t('admin.update_error')),
    })
    this.publish({ bulkMove })
    return { data, bulkMove }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, params: s.params, navigate: s.navigate, search: s.search, setSearch: s.setSearch, queryClient: s.queryClient, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, scope: s.scope, setScope: s.setScope, selected: s.selected, setSelected: s.setSelected, units: s.units, toggleActive: s.toggleActive })
    const h = this.useHooks()
    this.publish({ data: h.data, bulkMove: h.bulkMove })
  }

  get limit(): 20 {
    return 20
  }

  get scopedUnits(): string[] {
    return this.memo('scopedUnits', [this.scope], () => this.scope.mode === 'selected' ? this.scope.unitIds : [])
  }

  get pageIds(): string[] {
    return this.memo('pageIds', [this.data], () => (this.data?.users ?? []).map(u => u.id))
  }

  get allOnPage(): boolean {
    return this.pageIds.length > 0 && this.pageIds.every(id => this.selected.has(id))
  }

  get canBulk(): boolean {
    return this.can(PRIV.USERS_UPDATE) && this.can(PRIV.ORG_UNITS_READ)
  }

  get ROLE_COLORS(): Record<string, string> {
    return this.memo('ROLE_COLORS', [], () => ({
    admin: 'bg-danger-light text-danger',
    user: 'bg-primary-light text-primary',
    guest: 'bg-surface-2 text-text-secondary',
  }))
  }

  /** `<CreateUserModal>`, rendered by a ReactHost. */
  get CreateUserModal() {
    if (!(this.showCreate)) return undefined as never
    return __parts.CreateUserModal
  }

  get create_user_modal_props() {
    return this.memo('create_user_modal_props', [this.showCreate], () => {
      if (!(this.showCreate)) return undefined as never
      return ({ onClose: () => this.showCreate = false } as React.ComponentProps<typeof __parts.CreateUserModal>)
    })
  }

  get show_can_priv_org() {
    return this.can(PRIV.ORG_UNITS_READ)
  }

  /** `<OrgUnitScopePanel Units>`: the org units, or an empty list while they load. */
  get scopeUnits() {
    if (!(this.can(PRIV.ORG_UNITS_READ))) return undefined as never
    return this.units ?? []
  }

  get show_can_priv_settings() {
    return this.can(PRIV.SETTINGS_MANAGE)
  }

  /** `<RegistrationToggle>`, rendered by a ReactHost. */
  get RegistrationToggle() {
    return __parts.RegistrationToggle
  }

  get span_text() {
    return this.memo('span_text', [this.data, this.tr], () => String(this.data?.total ?? 0) + " " + this.tr('admin.users_count'))
  }

  get show_can_priv_users() {
    return this.can(PRIV.USERS_CREATE)
  }

  get show_selected_size() {
    return this.selected.size > 0
  }

  get text() {
    return this.memo('text', [this.tr, this.selected], () => {
      if (!(this.selected.size > 0)) return undefined as never
      return " " + this.tr('admin.bulk_clear')
    })
  }

  get part1_props() {
    return this.memo('part1_props', [this.canBulk, this.allOnPage, this.memo, this.setSelected, this.pageIds, this.tr, this.can, this.data, this.pendingReset, this.navigate, this.selected, this.units, this.ROLE_COLORS, this.toggleActive], () => ({ canBulk: this.canBulk, allOnPage: this.allOnPage, togglePage: this.memo("togglePage:bound", [], () => this.togglePage.bind(this)), t: this.tr, can: this.can, data: this.data, openUser: this.memo("openUser:bound", [], () => this.openUser.bind(this)), selected: this.selected, toggleOne: this.memo("toggleOne:bound", [], () => this.toggleOne.bind(this)), unitName: this.memo("unitName:bound", [], () => this.unitName.bind(this)), ROLE_COLORS: this.ROLE_COLORS, toggleActive: this.toggleActive }))
  }

  /** A part of the screen still written in React (<table> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

  get show_data_data_total() {
    return !!(this.data && this.data.total > this.limit)
  }

  get enabled_unless_page() {
    if (!(this.data && this.data.total > this.limit)) return undefined as never
    return !(this.page === 0)
  }

  get span_text2() {
    return this.memo('span_text2', [this.tr, this.page, this.data, this.limit], () => {
      if (!(this.data && this.data.total > this.limit)) return undefined as never
      return this.tr('admin.page') + " " + String(this.page + 1) + " / " + String(Math.ceil(this.data.total / this.limit))
    })
  }

  get enabled_unless_page_limit_data() {
    if (!(this.data && this.data.total > this.limit)) return undefined as never
    return !((this.page + 1) * this.limit >= this.data.total)
  }

  /** `<OrgUnitPicker>`, rendered by a ReactHost. */
  get OrgUnitPicker() {
    if (!(this.bulkPicker)) return undefined as never
    return OrgUnitPicker
  }

  get org_unit_picker_props() {
    return this.memo('org_unit_picker_props', [this.tr, this.selected, this.memo, this.confirm, this.units, this.bulkMove, this.bulkPicker], () => {
      if (!(this.bulkPicker)) return undefined as never
      return ({ title: this.tr('admin.bulk_ou_title', { count: this.selected.size }), currentId: null, onSelect: this.memo("askBulkMove:bound", [], () => this.askBulkMove.bind(this)), onClose: () => this.bulkPicker = false } as React.ComponentProps<typeof OrgUnitPicker>)
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

  unitName(id: string | null) {
    return (this.units ?? []).find(u => u.id === id)?.name ?? null
  }

  openUser(u: User, pane?: string) {
    if (this.pendingReset) {
      this.pendingReset = false
      this.navigate(adminUrl({
        tab: 'users', action: 'reset-password', id: u.id,
        params: { user: u.id, pane: 'security' },
      }))
      return
    }
    this.navigate(adminUrl({ tab: 'users', params: { user: u.id, pane } }))
  }

  async askBulkMove(orgUnitId: string) {
    const ok = await this.confirm({
      title:   this.tr('admin.bulk_ou_confirm_title'),
      message: this.tr('admin.bulk_ou_confirm_msg', {
        count: this.selected.size, unit: this.unitName(orgUnitId) ?? '',
      }),
      confirmLabel: this.tr('admin.bulk_ou_action'),
    })
    if (ok) this.bulkMove.mutate(orgUnitId)
  }

  toggleOne(id: string) {
    return this.setSelected(s => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
  })
  }

  togglePage() {
    return this.setSelected(s => {
    const n = new Set(s)
    if (this.allOnPage) this.pageIds.forEach(id => n.delete(id))
    else           this.pageIds.forEach(id => n.add(id))
    return n
  })
  }

  callout_action(_sender: unknown, _args: EventArgs) {
    if (!(this.pendingReset)) return undefined as never
    this.pendingReset = false
  }

  text_field_text_changed(_sender: unknown, args: EventArgs) {
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
 this.setSearch(e.target.value); this.page = 0 }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.can(PRIV.USERS_CREATE))) return undefined as never
    this.showCreate = true
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.selected.size > 0) || !(this.canBulk)) return undefined as never
    this.bulkPicker = true
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.selected.size > 0)) return undefined as never
    this.setSelected(new Set())
  }

  button_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.data && this.data.total > this.limit)) return undefined as never
    this.page = Math.max(0, this.page - 1)
  }

  button_click4(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.data && this.data.total > this.limit)) return undefined as never
    this.page = this.page + 1
  }

  /** `<OrgUnitScopePanel OnChange>`: the scope changed; reset to the first page. */
  org_unit_scope_panel_change(_sender: unknown, args: ValueChangedEventArgs) {
    const next = args.value as OrgUnitScope
    this.setScope(next); this.page = 0
  }

  /** `<OrgUnitScopePanel OnCollapsedChange>`: the panel was collapsed or expanded. */
  org_unit_scope_panel_collapsed_change(_sender: unknown, args: ValueChangedEventArgs) {
    this.setPanelCollapsed(args.value as boolean)
  }

  /** `setPanelCollapsed` of the TSX: a value, or an update of the previous one. */
  setPanelCollapsed(value: UsersPanel['panelCollapsed'] | ((prev: UsersPanel['panelCollapsed']) => UsersPanel['panelCollapsed'])) {
    this.panelCollapsed = typeof value === 'function' ? (value as (prev: UsersPanel['panelCollapsed']) => UsersPanel['panelCollapsed'])(this.panelCollapsed) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type UsersPanelStores = ReturnType<UsersPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type UsersPanelHooks = ReturnType<UsersPanel['useHooks']>

export default UsersPanel.component()
