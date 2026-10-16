/**
 * Code-behind of `DeviceDetail.kbcontrol` (converted from `DeviceDetail.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useToast } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../core/hooks/useConfirm"
import { formatAgo, formatWhen } from "../sections/format"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { useDevice, useForgetDevice, useSetApproval, useSignOutDevice } from "../../core/devices/useDevices"
import { DeclaredSignals, DeviceFacts, DeviceTimeline, SessionList } from "../../core/devices/panels"
import { approvalLabel, approvalSkin, deviceName } from "../../core/devices/labels"
import { useAdminCrumbs } from "../pages/AdminBreadcrumb"

import { ViewBase } from './DeviceDetail.kbcontrol'

export type DeviceDetailProps = { id: string; onBack: () => void }

export class DeviceDetail extends ViewBase {
  tr!: DeviceDetailStores['t']
  i18n!: DeviceDetailStores['i18n']
  can!: DeviceDetailStores['can']
  toast!: DeviceDetailStores['toast']
  confirm!: DeviceDetailStores['confirm']
  confirmState!: DeviceDetailStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: DeviceDetailHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: DeviceDetailHooks['refetch']
  setApproval!: DeviceDetailStores['setApproval']
  signOut!: DeviceDetailStores['signOut']
  forget!: DeviceDetailStores['forget']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { can } = usePrivileges()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const setApproval = useSetApproval()
    const signOut     = useSignOutDevice()
    const forget      = useForgetDevice()
    return { t, i18n, can, toast, confirm, confirmState, handleConfirm, handleCancel, setApproval, signOut, forget }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const { data, isLoading, isError, refetch } = useDevice(this.props.id)
    this.publish({ data, isLoading, isError, refetch })
    useAdminCrumbs(useMemo(
      () => (data ? [{ label: deviceName(t, data.device), title: deviceName(t, data.device) }] : []),
      [data, t],
    ))
    return { data, isLoading, isError, refetch }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, can: s.can, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, setApproval: s.setApproval, signOut: s.signOut, forget: s.forget })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch })
  }

  get canManage(): boolean {
    return this.can(PRIV.SESSIONS_DELETE)
  }

  get device() {
    return this.memo('device', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return this.data.device
    })
  }

  get skin(): { chip: string; dot: string; } {
    return this.memo('skin', [this.device, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return approvalSkin(this.device.approval)
    })
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.isError || !this.data)
  }

  get show_main() {
    return !(this.isLoading) && !(this.isError || !this.data)
  }

  get h1_text() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return deviceName(this.tr, this.device)
  }

  get span_class() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return `mt-1 inline-block rounded-full px-2 py-0.5 ${this.skin.chip}`
  }

  get span_text() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return approvalLabel(this.tr, this.device.approval)
  }

  get show_device_approval_blocked() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.device.approval === 'blocked'
  }

  get callout_text() {
    return this.memo('callout_text', [this.tr, this.device, this.i18n, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.device.approval === 'blocked')) return undefined as never
      return this.tr('devices.blocked_body', {
            who:  this.device.approval_label ?? '-',
            when: this.device.approval_at ? formatWhen(this.device.approval_at, this.i18n.language) : '-',
          }) + String(this.device.approval_reason ? ` - ${this.device.approval_reason}` : '')
    })
  }

  get show_device_approval_approved() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return this.device.approval !== 'approved'
  }

  get show_device_approval_blocked2() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return this.device.approval !== 'blocked'
  }

  get show_not_device_approval_blocked() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return !(this.device.approval !== 'blocked')
  }

  get enabled_unless_data_sessions() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return !(this.data.sessions.length === 0)
  }

  /** `<DeviceFacts>`, rendered by a ReactHost. */
  get DeviceFacts() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return DeviceFacts
  }

  get device_facts_props() {
    return this.memo('device_facts_props', [this.device, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ device: this.device })
    })
  }

  /** `<DeclaredSignals>`, rendered by a ReactHost. */
  get DeclaredSignals() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return DeclaredSignals
  }

  get sessions_title_n() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.data.sessions.length
  }

  /** `<SessionList>`, rendered by a ReactHost. */
  get SessionList() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return SessionList
  }

  get session_list_props() {
    return this.memo('session_list_props', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ sessions: this.data.sessions })
    })
  }

  /** `<DeviceTimeline>`, rendered by a ReactHost. */
  get DeviceTimeline() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return DeviceTimeline
  }

  get device_timeline_props() {
    return this.memo('device_timeline_props', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ events: this.data.events })
    })
  }

  get p_text() {
    return this.memo('p_text', [this.tr, this.device, this.i18n, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return this.tr('devices.first_seen_at', { when: formatWhen(this.device.first_seen_at, this.i18n.language) }) + String(' · ') + this.tr('devices.last_seen_ago', { ago: formatAgo(this.device.last_seen_at) })
    })
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

  apply(approval: 'approved' | 'blocked' | 'pending') {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.setApproval.mutate({ id: this.props.id, approval }, {
      onSuccess: () => this.toast.success(this.tr(
        approval === 'blocked' ? 'devices.toast_blocked'
          : approval === 'approved' ? 'devices.toast_approved' : 'devices.toast_unblocked',
      )),
      onError: () => this.toast.error(this.tr('devices.toast_failed')),
    })
  }

  async doForget() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    const ok = await this.confirm({
      title:   this.tr('devices.forget_title', { name: deviceName(this.tr, this.device) }),
      message: this.tr('devices.forget_message'),
      confirmLabel: this.tr('devices.forget_confirm'),
      variant: 'danger',
    })
    if (!ok) return
    this.forget.mutate(this.props.id, {
      onSuccess: () => { this.toast.success(this.tr('devices.toast_forgotten')); this.props.onBack() },
      onError:   () => this.toast.error(this.tr('devices.toast_failed')),
    })
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(this.isError || !this.data)) return undefined as never
    void this.refetch()
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage) || !(this.device.approval !== 'approved')) return undefined as never
    this.apply('approved')
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage) || !(this.device.approval !== 'blocked')) return undefined as never
    this.apply('blocked')
  }

  button_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage) || !(!(this.device.approval !== 'blocked'))) return undefined as never
    this.apply('pending')
  }

  button_click4(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    this.signOut.mutate(this.props.id, {
              onSuccess: () => this.toast.success(this.tr('devices.toast_signed_out')),
              onError:   () => this.toast.error(this.tr('devices.toast_failed')),
            })
  }

  button_click5(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    void this.doForget()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DeviceDetailStores = ReturnType<DeviceDetail['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type DeviceDetailHooks = ReturnType<DeviceDetail['useHooks']>

export default DeviceDetail.component()
