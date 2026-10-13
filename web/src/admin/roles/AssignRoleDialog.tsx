/**
 * Code-behind of `AssignRoleDialog.kbview` (converted from `AssignRoleDialog.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { Fragment } from 'react'
import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { Building2, Users } from "lucide-react"
import { useToast } from "@ui"
import { api } from "../../core/api/client"
import { PRIV, type Privilege, type Role } from "../../core/authz/types"
import { useAuthzLabels } from "../../core/authz/labels"
import { usePrivileges } from "../../core/authz/usePrivileges"
import type { OrgUnit, User, UserGroup } from "../../core/types"
import OrgUnitPicker from "../dialogs/OrgUnitPicker"
import { errorMessage, useCreateAssignment } from "./api"

import { ViewBase } from './AssignRoleDialog.kbview'
import * as __parts from './AssignRoleDialog.parts'

type SubjectKind = 'user' | 'group'

type Scope = 'instance' | 'org_unit'

export type AssignRoleDialogProps = {
  role:      Role
  catalogue: Privilege[]
  onClose:   () => void
}

export class AssignRoleDialog extends ViewBase {
  @bind accessor kind: SubjectKind = 'user'
  @bind accessor user: User | null = null
  @bind accessor groupId: string | null = null
  @bind accessor scope: Scope = 'instance'
  @bind accessor unitId: string | null = null
  @bind accessor pickerOpen = false
  @bind accessor expiresAt: string | null = null
  @bind accessor query = ''
  @bind accessor debounced = ''
  @bind accessor error = ''
  tr!: AssignRoleDialogStores['t']
  toast!: AssignRoleDialogStores['toast']
  can!: AssignRoleDialogStores['can']
  roleName!: (role: Role) => string
  found!: AssignRoleDialogHooks['found']
  groups!: AssignRoleDialogHooks['groups']
  units!: AssignRoleDialogStores['units']
  blockers!: Privilege[]
  create!: AssignRoleDialogHooks['create']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const toast = useToast()
    const { can } = usePrivileges()
    const { roleName } = useAuthzLabels()
    const { data: units } = useQuery({
      queryKey: ['admin-org-units'],
      queryFn:  () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
      enabled:  can(PRIV.ORG_UNITS_READ),
      staleTime: 30_000,
    })
    return { t, toast, can, roleName, units }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const toast = this.toast
    const can = this.can
    useEffect(() => { const id = setTimeout(() => this.debounced = this.query.trim(), 200); return () => clearTimeout(id) }, [this.query])
    useEffect(() => { if (!this.props.role.ou_delegable) { this.scope = 'instance'; this.unitId = null } }, [this.props.role.ou_delegable])
    const { data: found } = useQuery({
      queryKey: ['admin-user-search', this.debounced],
      queryFn:  () => api.get<{ users: User[] }>('/admin/users', { params: { search: this.debounced, limit: 6 } }).then(r => r.data.users),
      enabled:  this.kind === 'user' && this.debounced.length >= 1 && can(PRIV.USERS_READ),
      staleTime: 15_000,
    })
    this.publish({ found })
    const { data: groups } = useQuery({
      queryKey: ['admin-groups'],
      queryFn:  () => api.get<{ groups: UserGroup[] }>('/admin/groups').then(r => r.data.groups),
      enabled:  this.kind === 'group' && this.canGroups,
      staleTime: 60_000,
    })
    this.publish({ groups })
    const blockers = useMemo(() => {
      const byKey = new Map(this.props.catalogue.map(p => [p.key, p]))
      return this.props.role.privileges
        .map(k => byKey.get(k))
        .filter((p): p is Privilege => !!p && !p.is_ou_scopable)
    }, [this.props.role.privileges, this.props.catalogue])
    this.publish({ blockers })
    const create = useCreateAssignment(() => { toast.success(t('admin.assign_done')); this.props.onClose() })
    this.publish({ create })
    return { found, groups, blockers, create }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, toast: s.toast, can: s.can, roleName: s.roleName, units: s.units })
    const h = this.useHooks()
    this.publish({ found: h.found, groups: h.groups, blockers: h.blockers, create: h.create })
  }

  get canGroups(): boolean {
    return this.can(PRIV.GROUPS_READ)
  }

  get subjectReady(): boolean {
    return this.kind === 'user' ? !!this.user : !!this.groupId
  }

  get scopeReady(): boolean {
    return this.scope === 'instance' || !!this.unitId
  }

  get enabled_unless_subject_ready_scope_ready() {
    return !(!this.subjectReady || !this.scopeReady)
  }

  get title() {
    return `${this.tr('admin.assign_title')} · ${this.roleName(this.props.role)}`
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_kind_button_user_t() {
    return this.memo('content_kind_button_user_t', [this.kind, this.error, this.tr], () => ({ children: this.kindButton('user', this.tr('admin.assign_subject_user'), Users) }))
  }

  get content_kind_button_group_t() {
    return this.memo('content_kind_button_group_t', [this.kind, this.error, this.tr, this.canGroups], () => ({ children: this.kindButton('group', this.tr('admin.assign_subject_group'), Building2, this.canGroups) }))
  }

  get show_kind_user() {
    return this.kind === 'user'
  }

  get show_not_kind_user() {
    return !(this.kind === 'user')
  }

  get show_user() {
    return this.memo('show_user', [this.user, this.kind], () => {
      if (!(this.kind === 'user')) return undefined as never
      return !!(this.user)
    })
  }

  get show_not_user() {
    return this.memo('show_not_user', [this.user, this.kind], () => {
      if (!(this.kind === 'user')) return undefined as never
      return !(this.user)
    })
  }

  /** `<Avatar>`, rendered by a ReactHost. */
  get Avatar() {
    if (!(this.kind === 'user') || !(this.user)) return undefined as never
    return __parts.Avatar
  }

  get avatar_props() {
    return this.memo('avatar_props', [this.user, this.kind], () => {
      if (!(this.kind === 'user') || !(this.user)) return undefined as never
      return ({ user: this.user })
    })
  }

  get span_text() {
    if (!(this.kind === 'user') || !(this.user)) return undefined as never
    return this.user.display_name || this.user.username
  }

  get span_text2() {
    if (!(this.kind === 'user') || !(this.user)) return undefined as never
    return this.user.email
  }

  get show_debounced_found() {
    if (!(this.kind === 'user') || !(!(this.user))) return undefined as never
    return this.debounced.length >= 1 && (this.found ?? []).length > 0
  }

  /** `<Avatar>`, rendered by a ReactHost. */
  get Avatar2() {
    if (!(this.kind === 'user') || !(!(this.user)) || !(this.debounced.length >= 1 && (this.found ?? []).length > 0)) return undefined as never
    return __parts.Avatar
  }

  /** The rows of the Repeater over `found!`. */
  get rows_found() {
    return this.memo('rows_found', [this.found, this.kind, this.user, this.debounced], () => {
      if (!(this.kind === 'user') || !(!(this.user)) || !(this.debounced.length >= 1 && (this.found ?? []).length > 0)) return undefined as never
      return this.found!.map((u) => {
      return { u, avatar_props: ((this.kind === 'user') && (!(this.user)) && (this.debounced.length >= 1 && (this.found ?? []).length > 0)) ? ({ user: u }) : undefined, span_text: ((this.kind === 'user') && (!(this.user)) && (this.debounced.length >= 1 && (this.found ?? []).length > 0)) ? (u.display_name || u.username) : undefined, key: u.id }
    })
    })
  }

  get visible() {
    return this.memo('visible', [this.show_user, this.show_kind_user], () => this.show_user && this.show_kind_user)
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_user, this.show_kind_user], () => this.show_not_user && this.show_kind_user)
  }

  get part1_props() {
    return this.memo('part1_props', [this.groupId, this.memo, this.groups, this.tr, this.kind], () => {
      if (!(!(this.kind === 'user'))) return undefined as never
      return ({ groupId: this.groupId, setGroupId: this.memo("setGroupId:bound", [], () => this.setGroupId.bind(this)), groups: this.groups, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<ComboBox> width: no .kbview property). */
  get Part1() {
    if (!(!(this.kind === 'user'))) return undefined as never
    return __parts.Part1
  }

  get selected_value() {
    return this.scope === 'instance'
  }

  get label_class() {
    return `flex items-start gap-3 p-3 ${this.props.role.ou_delegable ? 'cursor-pointer' : 'cursor-not-allowed'}`
  }

  get tooltip() {
    return this.props.role.ou_delegable ? undefined : this.tr('admin.assign_scope_ou_blocked_short')
  }

  get selected_value2() {
    return this.scope === 'org_unit'
  }

  get enabled_unless_role_ou_delegable() {
    return !(!this.props.role.ou_delegable)
  }

  get span_class() {
    return `flex items-center gap-1.5 text-sm ${this.props.role.ou_delegable ? 'text-text-primary' : 'text-text-tertiary'}`
  }

  get show_not_role_ou_delegable() {
    return !(this.props.role.ou_delegable)
  }

  get show_scope_org_unit() {
    return this.scope === 'org_unit' && this.props.role.ou_delegable
  }

  get span_text3() {
    if (!(this.scope === 'org_unit' && this.props.role.ou_delegable)) return undefined as never
    return this.unitName(this.unitId)
  }

  get text() {
    if (!(this.scope === 'org_unit' && this.props.role.ou_delegable)) return undefined as never
    return this.unitId ? this.tr('admin.assign_change') : this.tr('admin.assign_pick_unit')
  }

  get show_role_ou_delegable() {
    return !this.props.role.ou_delegable
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.props, this.blockers], () => {
      if (!(!this.props.role.ou_delegable)) return undefined as never
      return ({ t: this.tr, role: this.props.role, blockers: this.blockers })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part2() {
    if (!(!this.props.role.ou_delegable)) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.expiresAt, this.memo, this.tr], () => ({ expiresAt: this.expiresAt, setExpiresAt: this.memo("setExpiresAt:bound", [], () => this.setExpiresAt.bind(this)), t: this.tr }))
  }

  /** A part of the screen still written in React (<DatePicker> clearable, minDate: no .kbview property). */
  get Part3() {
    return __parts.Part3
  }

  get show_error() {
    return !!(this.error)
  }

  /** `<OrgUnitPicker>`, rendered by a ReactHost. */
  get OrgUnitPicker() {
    if (!(this.pickerOpen)) return undefined as never
    return OrgUnitPicker
  }

  get org_unit_picker_props() {
    return this.memo('org_unit_picker_props', [this.tr, this.unitId, this.memo, this.pickerOpen], () => {
      if (!(this.pickerOpen)) return undefined as never
      return ({ title: this.tr('admin.assign_pick_unit'), currentId: this.unitId, onSelect: this.memo("setUnitId:bound", [], () => this.setUnitId.bind(this)), onClose: () => this.pickerOpen = false } as React.ComponentProps<typeof OrgUnitPicker>)
    })
  }

  unitName(id: string | null) {
    return (this.units ?? []).find(u => u.id === id)?.name ?? '—'
  }

  submit(e?: React.FormEvent) {
    e?.preventDefault()
    this.error = ''
    this.create.mutate(
      {
        role_id:     this.props.role.id,
        user_id:     this.kind === 'user' ? this.user!.id : undefined,
        group_id:    this.kind === 'group' ? this.groupId! : undefined,
        scope: this.scope,
        org_unit_id: this.scope === 'org_unit' ? this.unitId : null,
        expires_at:  this.expiresAt ? new Date(`${this.expiresAt}T23:59:59`).toISOString() : null,
      },
      { onError: err => this.error = errorMessage(err, this.tr('admin.assign_error')) },
    )
  }

  kindButton(value: SubjectKind, label: string, Icon: typeof Users, enabled = true) {
    return (
    <button
      key={value}
      type="button"
      disabled={!enabled}
      onClick={() => { this.kind = value; this.error = '' }}
      className={`flex-1 flex items-center justify-center gap-2 h-9 px-3 rounded-md border text-sm transition-colors ${
        this.kind === value
          ? 'border-primary bg-primary-light text-primary'
          : 'border-border text-text-secondary hover:bg-surface-1 disabled:hover:bg-transparent disabled:text-text-tertiary disabled:cursor-not-allowed'}`}
    >
      <Icon size={15} />{label}
    </button>
  )
  }

  floating_window_confirm(_sender: unknown, _args: EventArgs) {
    this.submit()
  }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    this.props.onClose?.()
  }

  panel_submit(_sender: unknown, args: EventArgs) {
    return this.submit(args.native as never)
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.kind === 'user') || !(this.user)) return undefined as never
    this.user = null
  }

  panel_click2(_sender: unknown, args: MouseEventArgs) {
    const { u } = args.row as RowOf_rows_found
    if (!(this.kind === 'user') || !(!(this.user)) || !(this.debounced.length >= 1 && (this.found ?? []).length > 0)) return undefined as never
 this.user = u; this.query = '' }

  radio_button_checked_changed(_sender: unknown, _args: ValueChangedEventArgs) {
    this.scope = 'instance'
  }

  radio_button_checked_changed2(_sender: unknown, _args: ValueChangedEventArgs) {
    this.props.role.ou_delegable && (this.scope = 'org_unit')
  }

  panel_click3(_sender: unknown, args: MouseEventArgs) {
    if (!(this.scope === 'org_unit' && this.props.role.ou_delegable)) return undefined as never
    const e = args.native as React.MouseEvent<HTMLButtonElement, MouseEvent>
 e.preventDefault(); this.pickerOpen = true }

  /** `setGroupId` of the TSX: a value, or an update of the previous one. */
  setGroupId(value: string | null | ((prev: string | null) => string | null)) {
    this.groupId = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.groupId) : value
  }

  /** `setExpiresAt` of the TSX: a value, or an update of the previous one. */
  setExpiresAt(value: string | null | ((prev: string | null) => string | null)) {
    this.expiresAt = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.expiresAt) : value
  }

  /** `setUnitId` of the TSX: a value, or an update of the previous one. */
  setUnitId(value: string | null | ((prev: string | null) => string | null)) {
    this.unitId = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.unitId) : value
  }

}

type RowOf_rows_found = AssignRoleDialog['rows_found'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type AssignRoleDialogStores = ReturnType<AssignRoleDialog['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AssignRoleDialogHooks = ReturnType<AssignRoleDialog['useHooks']>

export default AssignRoleDialog.component()
