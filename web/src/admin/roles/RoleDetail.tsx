/**
 * Code-behind of `RoleDetail.kbcontrol` (converted from `RoleDetail.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { formatDate } from "../../core/intl/datetime"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { UserPlus } from "lucide-react"
import { Button, useToast } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../core/hooks/useConfirm"
import { PRIV, type Privilege, type Role, type RoleAssignment } from "../../core/authz/types"
import { useAuthzLabels } from "../../core/authz/labels"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { useAdminCrumbs } from "../pages/AdminBreadcrumb"
import { errorMessage, useAssignments, useDeleteAssignment } from "./api"
import AssignRoleDialog from "./AssignRoleDialog"
import RoleIdentityCard from "./RoleIdentityCard"
import RolePrivilegesCard from "./RolePrivilegesCard"

import { ViewBase } from './RoleDetail.kbcontrol'
import * as __parts from './RoleDetail.parts'

export type RoleDetailProps = {
  role:      Role
  catalogue: Privilege[]
}

export class RoleDetail extends ViewBase {
  @bind accessor assignOpen = false
  tr!: RoleDetailStores['t']
  toast!: RoleDetailStores['toast']
  can!: RoleDetailStores['can']
  isSuperuser!: boolean
  roleName!: (role: Role) => string
  confirm!: RoleDetailStores['confirm']
  confirmState!: RoleDetailStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  assignments!: RoleDetailHooks['assignments']
  isLoading!: boolean
  revoke!: RoleDetailStores['revoke']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const toast = useToast()
    const { can, isSuperuser } = usePrivileges()
    const { roleName } = useAuthzLabels()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const revoke = useDeleteAssignment(() => toast.success(t('admin.assign_revoked')))
    return { t, toast, can, isSuperuser, roleName, confirm, confirmState, handleConfirm, handleCancel, revoke }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const roleName = this.roleName
    const { data: assignments, isLoading } = useAssignments({ role_id: this.props.role.id })
    this.publish({ assignments, isLoading })
    useAdminCrumbs(useMemo(() => [{ label: roleName(this.props.role), title: roleName(this.props.role) }], [this.props.role]))
    return { assignments, isLoading }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, toast: s.toast, can: s.can, isSuperuser: s.isSuperuser, roleName: s.roleName, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, revoke: s.revoke })
    const h = this.useHooks()
    this.publish({ assignments: h.assignments, isLoading: h.isLoading })
  }

  get canGrant(): boolean {
    return this.can(PRIV.ROLES_MANAGE)
  }

  /** `<RoleIdentityCard>`, rendered by a ReactHost. */
  get RoleIdentityCard() {
    return RoleIdentityCard
  }

  get role_identity_card_props() {
    return this.memo('role_identity_card_props', [this.props, this.isSuperuser, this.canGrant, this.assignOpen, this.tr], () => ({ role: this.props.role, canEdit: this.isSuperuser, actions: this.canGrant ? (
            <Button size="sm" variant="ghost" icon={<UserPlus size={15} />} onClick={() => this.assignOpen = true}>
              {this.tr('admin.assign_title')}
            </Button>
          ) : undefined }))
  }

  get part1_props() {
    return this.memo('part1_props', [this.assignments, this.isLoading, this.tr, this.canGrant, this.memo, this.assignOpen, this.confirm, this.roleName, this.props, this.revoke, this.toast], () => ({ assignments: this.assignments, isLoading: this.isLoading, t: this.tr, canGrant: this.canGrant, setAssignOpen: this.memo("setAssignOpen:bound", [], () => this.setAssignOpen.bind(this)), when: this.memo("when:bound", [], () => this.when.bind(this)), askRevoke: this.memo("askRevoke:bound", [], () => this.askRevoke.bind(this)) }))
  }

  /** A part of the screen still written in React (<DataTable> rowKey, emptyState, columns, rowActions, configurableColumns, t: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  /** `<RolePrivilegesCard>`, rendered by a ReactHost. */
  get RolePrivilegesCard() {
    return RolePrivilegesCard
  }

  get role_privileges_card_props() {
    return this.memo('role_privileges_card_props', [this.props, this.isSuperuser], () => ({ role: this.props.role, catalogue: this.props.catalogue, canEdit: this.isSuperuser }))
  }

  /** `<AssignRoleDialog>`, rendered by a ReactHost. */
  get AssignRoleDialog() {
    if (!(this.assignOpen)) return undefined as never
    return AssignRoleDialog
  }

  get assign_role_dialog_props() {
    return this.memo('assign_role_dialog_props', [this.props, this.assignOpen], () => {
      if (!(this.assignOpen)) return undefined as never
      return ({ role: this.props.role, catalogue: this.props.catalogue, onClose: () => this.assignOpen = false } as React.ComponentProps<typeof AssignRoleDialog>)
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

  when(iso: string) {
    return formatDate(iso, 'date')
  }

  async askRevoke(row: RoleAssignment) {
    const ok = await this.confirm({
      title:        this.tr('admin.assign_revoke_title'),
      message:      this.tr('admin.assign_revoke_confirm', { subject: row.subject_label ?? '-', role: this.roleName(this.props.role) }),
      confirmLabel: this.tr('admin.assign_revoke'),
      cancelLabel:  this.tr('common.cancel'),
      variant:      'danger',
    })
    if (!ok) return
    this.revoke.mutate(row.id, { onError: err => this.toast.error(errorMessage(err, this.tr('admin.assign_revoke_error'))) })
  }

  /** `setAssignOpen` of the TSX: a value, or an update of the previous one. */
  setAssignOpen(value: RoleDetail['assignOpen'] | ((prev: RoleDetail['assignOpen']) => RoleDetail['assignOpen'])) {
    this.assignOpen = typeof value === 'function' ? (value as (prev: RoleDetail['assignOpen']) => RoleDetail['assignOpen'])(this.assignOpen) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type RoleDetailStores = ReturnType<RoleDetail['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type RoleDetailHooks = ReturnType<RoleDetail['useHooks']>

export default RoleDetail.component()
