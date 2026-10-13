/**
 * Code-behind of `RolesList.kbcontrol` (converted from `RolesList.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { useToast } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../core/hooks/useConfirm"
import { PRIV, type Privilege, type Role } from "../../core/authz/types"
import { useAuthzLabels } from "../../core/authz/labels"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { adminUrl } from "../adminAction"
import { errorMessage, useDeleteRole } from "./api"
import AssignRoleDialog from "./AssignRoleDialog"
import RoleCreateDialog from "./RoleCreateDialog"

import { ViewBase } from './RolesList.kbcontrol'
import * as __parts from './RolesList.parts'

export type RolesListProps = {
  roles:     Role[]
  catalogue: Privilege[]
  loading:   boolean
  error?:    string
  onRetry?:  () => void
}

export class RolesList extends ViewBase {
  @bind accessor q = ''
  @bind accessor assign: Role | null = null
  @bind accessor creating = false
  tr!: RolesListStores['t']
  toast!: RolesListStores['toast']
  navigate!: RolesListStores['navigate']
  can!: RolesListStores['can']
  isSuperuser!: boolean
  roleName!: (role: Role) => string
  roleDescription!: (role: Role) => string | null
  confirm!: RolesListStores['confirm']
  confirmState!: RolesListStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  remove!: RolesListStores['remove']
  rows!: Role[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const toast = useToast()
    const navigate = useNavigate()
    const { can, isSuperuser } = usePrivileges()
    const { roleName, roleDescription } = useAuthzLabels()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const remove = useDeleteRole(() => toast.success(t('admin.role_deleted')))
    return { t, toast, navigate, can, isSuperuser, roleName, roleDescription, confirm, confirmState, handleConfirm, handleCancel, remove }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const roleName = this.roleName
    const roleDescription = this.roleDescription
    const rows = useMemo(() => {
      const needle = this.q.trim().toLowerCase()
      if (!needle) return this.props.roles
      return this.props.roles.filter(r =>
        `${roleName(r)} ${r.slug} ${roleDescription(r) ?? ''}`.toLowerCase().includes(needle))
    }, [this.props.roles, this.q, roleName, roleDescription])
    this.publish({ rows })
    return { rows }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, toast: s.toast, navigate: s.navigate, can: s.can, isSuperuser: s.isSuperuser, roleName: s.roleName, roleDescription: s.roleDescription, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, remove: s.remove })
    const h = this.useHooks()
    this.publish({ rows: h.rows })
  }

  get canGrant(): boolean {
    return this.can(PRIV.ROLES_MANAGE)
  }

  get show_can_grant() {
    return !this.canGrant
  }

  get part1_props() {
    return this.memo('part1_props', [this.rows, this.props, this.q, this.memo, this.tr, this.isSuperuser, this.creating, this.roleName, this.roleDescription, this.canGrant, this.assign, this.navigate, this.confirm, this.remove, this.toast], () => ({ rows: this.rows, loading: this.props.loading, error: this.props.error, onRetry: this.props.onRetry, q: this.q, setQ: this.memo("setQ:bound", [], () => this.setQ.bind(this)), t: this.tr, isSuperuser: this.isSuperuser, setCreating: this.memo("setCreating:bound", [], () => this.setCreating.bind(this)), roleName: this.roleName, roleDescription: this.roleDescription, canGrant: this.canGrant, setAssign: this.memo("setAssign:bound", [], () => this.setAssign.bind(this)), openRole: this.memo("openRole:bound", [], () => this.openRole.bind(this)), askDelete: this.memo("askDelete:bound", [], () => this.askDelete.bind(this)) }))
  }

  /** A part of the screen still written in React (<DataTable> rowKey, onRetry, filtered, onClearFilters, toolbar, emptyState, columns, rowActions, t: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get show_assign() {
    return this.memo('show_assign', [this.assign], () => !!(this.assign))
  }

  /** `<AssignRoleDialog>`, rendered by a ReactHost. */
  get AssignRoleDialog() {
    if (!(this.assign)) return undefined as never
    return AssignRoleDialog
  }

  get assign_role_dialog_props() {
    return this.memo('assign_role_dialog_props', [this.assign, this.props], () => {
      if (!(this.assign)) return undefined as never
      return ({ role: this.assign, catalogue: this.props.catalogue, onClose: () => this.assign = null } as React.ComponentProps<typeof AssignRoleDialog>)
    })
  }

  /** `<RoleCreateDialog>`, rendered by a ReactHost. */
  get RoleCreateDialog() {
    if (!(this.creating)) return undefined as never
    return RoleCreateDialog
  }

  get role_create_dialog_props() {
    return this.memo('role_create_dialog_props', [this.props, this.creating], () => {
      if (!(this.creating)) return undefined as never
      return ({ catalogue: this.props.catalogue, onClose: () => this.creating = false } as React.ComponentProps<typeof RoleCreateDialog>)
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

  openRole(role: Role) {
    return this.navigate(adminUrl({ tab: 'admin-roles', params: { role: role.id } }))
  }

  async askDelete(role: Role) {
    const ok = await this.confirm({
      title:        this.tr('admin.role_delete_title'),
      message:      this.tr('admin.role_delete_confirm', { name: this.roleName(role), count: role.assignment_count }),
      confirmLabel: this.tr('common.delete'),
      cancelLabel:  this.tr('common.cancel'),
      variant:      'danger',
    })
    if (!ok) return
    this.remove.mutate(role.id, {
      onError: err => this.toast.error(errorMessage(err, this.tr('admin.role_delete_error'))),
    })
  }

  /** `setQ` of the TSX: a value, or an update of the previous one. */
  setQ(value: RolesList['q'] | ((prev: RolesList['q']) => RolesList['q'])) {
    this.q = typeof value === 'function' ? (value as (prev: RolesList['q']) => RolesList['q'])(this.q) : value
  }

  /** `setCreating` of the TSX: a value, or an update of the previous one. */
  setCreating(value: RolesList['creating'] | ((prev: RolesList['creating']) => RolesList['creating'])) {
    this.creating = typeof value === 'function' ? (value as (prev: RolesList['creating']) => RolesList['creating'])(this.creating) : value
  }

  /** `setAssign` of the TSX: a value, or an update of the previous one. */
  setAssign(value: Role | null | ((prev: Role | null) => Role | null)) {
    this.assign = typeof value === 'function' ? (value as (prev: Role | null) => Role | null)(this.assign) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type RolesListStores = ReturnType<RolesList['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type RolesListHooks = ReturnType<RolesList['useHooks']>

export default RolesList.component()
