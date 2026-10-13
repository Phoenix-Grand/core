/**
 * Code-behind of `AdminRolesPanel.kbview` (converted from `AdminRolesPanel.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { Fragment } from 'react'
import { useTranslation } from "react-i18next"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { useAdminAction } from "../adminAction"
import { useAdminParams } from "../adminRoute"
import { errorMessage, usePrivilegeCatalogue, useRoles } from "../roles/api"
import RoleDetail from "../roles/RoleDetail"
import RoleCreateDialog from "../roles/RoleCreateDialog"
import RolesList from "../roles/RolesList"
import AdminForbidden from "../controls/AdminForbidden"

import { ViewBase } from './AdminRolesPanel.kbview'

export class AdminRolesPanel extends ViewBase {
  @bind accessor creating = false
  tr!: AdminRolesPanelStores['t']
  params!: URLSearchParams
  can!: AdminRolesPanelStores['can']
  isSuperuser!: boolean
  roles!: AdminRolesPanelHooks['roles']
  catalogue!: AdminRolesPanelHooks['catalogue']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const params = useAdminParams()
    const { can, isSuperuser } = usePrivileges()
    return { t, params, can, isSuperuser }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const isSuperuser = this.isSuperuser
    const roles     = useRoles(this.mayRead)
    this.publish({ roles })
    const catalogue = usePrivilegeCatalogue(this.mayRead)
    this.publish({ catalogue })
    useAdminAction('create', () => { if (isSuperuser) this.creating = true })
    return { roles, catalogue }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, params: s.params, can: s.can, isSuperuser: s.isSuperuser })
    const h = this.useHooks()
    this.publish({ roles: h.roles, catalogue: h.catalogue })
  }

  get mayRead(): boolean {
    return this.can(PRIV.ROLES_READ)
  }

  get list() {
    return this.memo('list', [this.roles, this.mayRead], () => {
      if (!(!(!this.mayRead))) return undefined as never
      return this.roles.data ?? []
    })
  }

  get selected() {
    return this.memo('selected', [this.list, this.params, this.mayRead], () => {
      if (!(!(!this.mayRead))) return undefined as never
      return this.list.find(r => r.id === this.params.get('role'))
    })
  }

  get editor() {
    return this.memo('editor', [this.creating, this.catalogue, this.mayRead], () => {
      if (!(!(!this.mayRead))) return undefined as never
      return this.creating && (
    <RoleCreateDialog catalogue={this.catalogue.data ?? []} onClose={() => this.creating = false} />
  )
    })
  }

  get show_case_1() {
    return !!(!this.mayRead)
  }

  /** `<AdminForbidden>`, rendered by a ReactHost. */
  get AdminForbidden() {
    if (!(!this.mayRead)) return undefined as never
    return AdminForbidden
  }

  get admin_forbidden_props() {
    return this.memo('admin_forbidden_props', [this.mayRead], () => {
      if (!(!this.mayRead)) return undefined as never
      return ({ titleKey: "admin.nav_admin_roles" })
    })
  }

  get show_case_2() {
    return !(!this.mayRead) && !!(this.selected)
  }

  /** `<RoleDetail>`, rendered by a ReactHost. */
  get RoleDetail() {
    if (!(!(!this.mayRead)) || !(this.selected)) return undefined as never
    return RoleDetail
  }

  get role_detail_props() {
    return this.memo('role_detail_props', [this.selected, this.catalogue, this.mayRead], () => {
      if (!(!(!this.mayRead)) || !(this.selected)) return undefined as never
      return ({ role: this.selected, catalogue: this.catalogue.data ?? [] })
    })
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_editor() {
    return this.memo('content_editor', [this.editor, this.mayRead, this.selected], () => {
      if (!(!(!this.mayRead)) || !(this.selected)) return undefined as never
      return ({ children: this.editor })
    })
  }

  get show_main() {
    return !(!this.mayRead) && !(this.selected)
  }

  /** `<RolesList>`, rendered by a ReactHost. */
  get RolesList() {
    if (!(!(!this.mayRead)) || !(!(this.selected))) return undefined as never
    return RolesList
  }

  get roles_list_props() {
    return this.memo('roles_list_props', [this.list, this.catalogue, this.roles, this.tr, this.mayRead, this.selected], () => {
      if (!(!(!this.mayRead)) || !(!(this.selected))) return undefined as never
      return ({ roles: this.list, catalogue: this.catalogue.data ?? [], loading: this.roles.isLoading || this.catalogue.isLoading, error: this.roles.error ? errorMessage(this.roles.error, this.tr('admin.roles_load_error')) : undefined, onRetry: () => { this.roles.refetch(); this.catalogue.refetch() } } as React.ComponentProps<typeof RolesList>)
    })
  }

  get content_editor2() {
    return this.memo('content_editor2', [this.editor, this.mayRead, this.selected], () => {
      if (!(!(!this.mayRead)) || !(!(this.selected))) return undefined as never
      return ({ children: this.editor })
    })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AdminRolesPanelStores = ReturnType<AdminRolesPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AdminRolesPanelHooks = ReturnType<AdminRolesPanel['useHooks']>

export default AdminRolesPanel.component()
