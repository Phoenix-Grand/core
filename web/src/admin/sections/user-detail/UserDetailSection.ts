/**
 * Code-behind of `UserDetailSection.kbcontrol` (converted from `UserDetailSection.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { NavigateFunction } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ConfirmDialog, DataTableSkeleton, useIsMobile, useToast, type TabDef } from "@ui"
import { api } from "../../../core/api/client"
import { useConfirm } from "../../../core/hooks/useConfirm"
import type { User } from "../../../core/types"
import { confirmLeave } from "../../inline-edit/unsaved"
import { adminUrl, adminUrlWith } from "../../adminAction"
import { useAdminCrumbs } from "../../pages/AdminBreadcrumb"
import ProfileTab from "./UserProfileTab"
import SecurityTab from "./UserSecurityTab"

import { ViewBase } from './UserDetailSection.kbcontrol'
import * as __parts from './UserDetailSection.parts'

type Pane = 'profile' | 'security' | 'activity'

const PANES: Pane[] = ['profile', 'security', 'activity']

export type UserDetailSectionProps = {
  userId:   string
  params:   URLSearchParams
  navigate: NavigateFunction
}

export class UserDetailSection extends ViewBase {
  tr!: UserDetailSectionStores['t']
  qc!: UserDetailSectionStores['qc']
  toast!: UserDetailSectionStores['toast']
  mobile!: boolean
  confirm!: UserDetailSectionStores['confirm']
  confirmState!: UserDetailSectionStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: UserDetailSectionHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: UserDetailSectionHooks['refetch']
  toggleActive!: UserDetailSectionHooks['toggleActive']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const toast = useToast()
    const mobile = useIsMobile()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    return { t, qc, toast, mobile, confirm, confirmState, handleConfirm, handleCancel }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const qc = this.qc
    const toast = this.toast
    const { data, isLoading, isError, refetch } = useQuery({
      queryKey: ['admin-user', this.props.userId],
      queryFn:  () => api.get<{ user: User }>(`/admin/users/${this.props.userId}`).then(r => r.data.user),
    })
    this.publish({ data, isLoading, isError, refetch })
    const toggleActive = useMutation({
      mutationFn: (is_active: boolean) => api.patch(`/admin/users/${this.props.userId}`, { is_active }),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ['admin-user', this.props.userId] })
        void qc.invalidateQueries({ queryKey: ['admin-users'] })
        toast.success(t('admin.ud_status_saved'))
      },
      onError: () => toast.error(t('admin.update_error')),
    })
    this.publish({ toggleActive })
    useAdminCrumbs(useMemo(
      () => (data ? [{ label: data.display_name || data.username, title: data.display_name || data.username }] : []),
      [data],
    ))
    return { data, isLoading, isError, refetch, toggleActive }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, qc: s.qc, toast: s.toast, mobile: s.mobile, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch, toggleActive: h.toggleActive })
  }

  get paneParam(): Pane | null {
    return this.props.params.get('pane') as Pane | null
  }

  get pane(): Pane {
    return this.paneParam && PANES.includes(this.paneParam) ? this.paneParam : 'profile'
  }

  get user(): User {
    return this.memo('user', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return this.data
    })
  }

  get tabs(): TabDef<Pane>[] {
    return this.memo('tabs', [this.tr, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return [
    { id: 'profile',  label: this.tr('admin.ud_tab_profile') },
    { id: 'security', label: this.tr('admin.ud_tab_security') },
    { id: 'activity', label: this.tr('admin.ud_tab_activity') },
  ]
    })
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  /** `<DataTableSkeleton>`, rendered by a ReactHost. */
  get DataTableSkeleton() {
    if (!(this.isLoading)) return undefined as never
    return DataTableSkeleton
  }

  get data_table_skeleton_props() {
    return this.memo('data_table_skeleton_props', [this.tr, this.isLoading], () => {
      if (!(this.isLoading)) return undefined as never
      return ({ t: this.tr, columns: 3, rows: 6 })
    })
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.isError || !this.data)
  }

  get show_main() {
    return !(this.isLoading) && !(this.isError || !this.data)
  }

  get div_class() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.mobile ? 'flex flex-col gap-4' : 'flex items-start gap-4'
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.tabs, this.pane, this.memo, this.confirm, this.props, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ t: this.tr, tabs: this.tabs, pane: this.pane, setPane: this.memo("setPane:bound", [], () => this.setPane.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Tabs> tabs: no .kbview property). */
  get Part1() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Part1
  }

  get show_pane_profile() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.pane === 'profile'
  }

  /** `<ProfileTab>`, rendered by a ReactHost. */
  get ProfileTab() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.pane === 'profile')) return undefined as never
    return ProfileTab
  }

  get profile_tab_props() {
    return this.memo('profile_tab_props', [this.user, this.isLoading, this.isError, this.data, this.pane], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.pane === 'profile')) return undefined as never
      return ({ user: this.user })
    })
  }

  get show_pane_security() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.pane === 'security'
  }

  /** `<SecurityTab>`, rendered by a ReactHost. */
  get SecurityTab() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.pane === 'security')) return undefined as never
    return SecurityTab
  }

  get security_tab_props() {
    return this.memo('security_tab_props', [this.user, this.isLoading, this.isError, this.data, this.pane], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.pane === 'security')) return undefined as never
      return ({ user: this.user })
    })
  }

  get show_pane_activity() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.pane === 'activity'
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  async setPane(next: Pane) {
    if (!await confirmLeave(this.confirm, this.tr)) return
    this.props.navigate(adminUrlWith('users', this.props.params, { pane: next }), { replace: true })
  }

  async back() {
    if (!await confirmLeave(this.confirm, this.tr)) return
    this.props.navigate(adminUrl({ tab: 'users' }))
  }

  async askToggleActive(user: User) {
    const ok = await this.confirm({
      title: user.is_active ? this.tr('admin.ud_disable_title') : this.tr('admin.ud_enable_title'),
      message: user.is_active
        ? this.tr('admin.ud_disable_msg', { name: user.display_name || user.username })
        : this.tr('admin.ud_enable_msg', { name: user.display_name || user.username }),
      confirmLabel: user.is_active ? this.tr('admin.disable') : this.tr('admin.enable'),
      variant:      user.is_active ? 'danger' : 'default',
    })
    if (ok) this.toggleActive.mutate(!user.is_active)
  }

  /** `<IdentityCard OnToggleActive>`: enable or disable the account. */
  identity_card_toggle_active(_sender: unknown, _e: EventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    void this.askToggleActive(this.user)
  }

  /** `<IdentityCard GoPane>`: jump to one of the sheet's tabs. */
  identity_card_go_pane(_sender: unknown, args: ValueChangedEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    void this.setPane(args.value as 'profile' | 'security')
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(this.isError || !this.data)) return undefined as never
    void this.refetch()
  }

  empty_state_secondary_action(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(this.isError || !this.data)) return undefined as never
    void this.back()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type UserDetailSectionStores = ReturnType<UserDetailSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type UserDetailSectionHooks = ReturnType<UserDetailSection['useHooks']>

export default UserDetailSection.component()
