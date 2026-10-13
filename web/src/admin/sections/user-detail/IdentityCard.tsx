/**
 * Code-behind of `IdentityCard.kbcontrol` (converted from `IdentityCard.tsx` by @kubuno/views-migrate).
 */
import { Fragment } from 'react'
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { Power, KeyRound, Building2 } from "lucide-react"
import { api } from "../../../core/api/client"
import { useAuthStore } from "../../../core/store/authStore"
import type { OrgUnit, User } from "../../../core/types"
import { PRIV } from "../../../core/authz/types"
import { usePrivileges } from "../../../core/authz/usePrivileges"
import { formatAgo, formatDay } from "../format"
import { UserAvatar } from "./UserAvatar"

import { ViewBase } from './IdentityCard.kbcontrol'
import * as __parts from './IdentityCard.parts'

interface Props {
  user: User
  /** Sticky on a wide screen; stacked above the tabs on a narrow one. */
  mobile:   boolean
  busy:     boolean
  onToggleActive: () => void
  /** Opens one of the sheet's tabs — the actions that already have a card there
   *  send the operator to it rather than growing a second way to do the job. */
  goPane:   (pane: 'profile' | 'security') => void
}

export type { Props }

export class IdentityCard extends ViewBase {
  tr!: IdentityCardStores['t']
  can!: IdentityCardStores['can']
  me!: User | null
  units!: IdentityCardStores['units']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { can } = usePrivileges()
    const me = useAuthStore(s => s.user)
    const { data: units } = useQuery({
      queryKey: ['admin-org-units'],
      queryFn:  () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
      enabled:  can(PRIV.ORG_UNITS_READ),
      staleTime: 30_000,
    })
    return { t, can, me, units }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, me: s.me, units: s.units })
  }

  get isSelf(): boolean {
    return this.me?.id === this.props.user.id
  }

  get unitName(): string | undefined {
    return this.units?.find(u => u.id === this.props.user.org_unit_id)?.name
  }

  get aside_class() {
    return `rounded-xl border border-border bg-white ${
        this.props.mobile
          ? 'w-full'
          // Same 52px as the accounts panel: the console's breadcrumb bar is
          // sticky at the top of this scrolling area and would clip the card.
          : 'sticky top-[52px] self-start shrink-0 w-[300px]'}`
  }

  get roleLabel() {
    return this.tr(`admin.role_${this.props.user.role}`, { defaultValue: this.props.user.role })
  }

  /** `<UserAvatar>`, rendered by a ReactHost. */
  get UserAvatar() {
    return UserAvatar
  }

  get user_avatar_props() {
    return this.memo('user_avatar_props', [this.props], () => ({ user: this.props.user, size: 44 }))
  }

  get h1_text() {
    return this.props.user.display_name || this.props.user.username
  }

  get statusLabel() {
    return this.props.user.is_active ? this.tr('admin.active') : this.tr('admin.inactive')
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_meta_t_admin() {
    return this.memo('content_meta_t_admin', [this.tr, this.props], () => ({ children: this.meta(this.tr('admin.ud_last_login'), this.props.user.last_login_at ? formatAgo(this.props.user.last_login_at) : '—') }))
  }

  get content_meta_t_admin2() {
    return this.memo('content_meta_t_admin2', [this.tr, this.props], () => ({ children: this.meta(this.tr('admin.ud_created'), formatDay(this.props.user.created_at, navigator.language)) }))
  }

  get show_unit_name() {
    return !!(this.unitName)
  }

  get show_can_priv_user() {
    return this.can(PRIV.USER_PASSWORD)
  }

  /** `<Action>`, rendered by a ReactHost. */
  get Action() {
    if (!(this.can(PRIV.USER_PASSWORD))) return undefined as never
    return __parts.Action
  }

  get action_props() {
    return this.memo('action_props', [this.tr, this.props, this.can], () => {
      if (!(this.can(PRIV.USER_PASSWORD))) return undefined as never
      return ({ icon: <KeyRound size={15} />, label: this.tr('admin.act_reset_password'), onClick: () => this.props.goPane('security') } as React.ComponentProps<typeof __parts.Action>)
    })
  }

  get show_can_priv_org() {
    return this.can(PRIV.ORG_UNITS_READ)
  }

  /** `<Action>`, rendered by a ReactHost. */
  get Action2() {
    if (!(this.can(PRIV.ORG_UNITS_READ))) return undefined as never
    return __parts.Action
  }

  get action_props2() {
    return this.memo('action_props2', [this.tr, this.props, this.can], () => {
      if (!(this.can(PRIV.ORG_UNITS_READ))) return undefined as never
      return ({ icon: <Building2 size={15} />, label: this.tr('admin.bulk_ou_action'), onClick: () => this.props.goPane('profile') } as React.ComponentProps<typeof __parts.Action>)
    })
  }

  get show_can_priv_users() {
    return this.can(PRIV.USERS_UPDATE)
  }

  /** `<Action>`, rendered by a ReactHost. */
  get Action3() {
    if (!(this.can(PRIV.USERS_UPDATE))) return undefined as never
    return __parts.Action
  }

  get action_props3() {
    return this.memo('action_props3', [this.props, this.tr, this.isSelf, this.can], () => {
      if (!(this.can(PRIV.USERS_UPDATE))) return undefined as never
      return ({ icon: <Power size={15} />, label: this.props.user.is_active ? this.tr('admin.disable') : this.tr('admin.enable'), danger: this.props.user.is_active, onClick: this.props.onToggleActive, disabled: this.isSelf || this.props.busy, reason: this.isSelf ? this.tr('admin.ud_self_action_blocked') : undefined })
    })
  }

  meta(label: string, value: string) {
    return (
    <div className="flex flex-col">
      <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>{label}</span>
      <span className="text-text-primary" style={{ fontSize: 'var(--kb-text-meta)' }}>{value}</span>
    </div>
  )
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type IdentityCardStores = ReturnType<IdentityCard['useStores']>

export default IdentityCard.component()
