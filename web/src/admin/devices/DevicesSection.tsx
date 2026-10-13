/**
 * Code-behind of `DevicesSection.kbview` (converted from `DevicesSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Ban, Check, LogOut, Search, SlidersHorizontal, Trash2, X } from "lucide-react"
import { Button, Input, useToast, type DataTableColumn, type DataTableRowAction } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../core/hooks/useConfirm"
import { formatAgo, formatWhen } from "../sections/format"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import type { AdminSectionProps } from "../sections/registry"
import { adminUrl } from "../adminAction"
import { useDeviceFacets, useDevices, useForgetDevice, useSetApproval, useSignOutDevice } from "../../core/devices/useDevices"
import { approvalLabel, approvalSkin, deviceName, deviceTypeLabel, signalLevelLabel } from "../../core/devices/labels"
import { EMPTY_DEVICE_FILTERS, type Device, type DeviceFilters } from "../../core/devices/types"

import { ViewBase } from './DevicesSection.kbview'
import * as __parts from './DevicesSection.parts'
import { FilterControls } from './DevicesSection.parts'

export type { AdminSectionProps }

export class DevicesSection extends ViewBase {
  @bind accessor sheet = false
  tr!: DevicesSectionStores['t']
  i18n!: DevicesSectionStores['i18n']
  can!: DevicesSectionStores['can']
  toast!: DevicesSectionStores['toast']
  confirm!: DevicesSectionStores['confirm']
  confirmState!: DevicesSectionStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  filters!: DeviceFilters
  setFilters!: DevicesSectionHooks['setFilters']
  draft!: DevicesSectionHooks['draft']
  setDraft!: DevicesSectionHooks['setDraft']
  data!: DevicesSectionHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: DevicesSectionHooks['refetch']
  facets!: DevicesSectionHooks['facets']
  setApproval!: DevicesSectionStores['setApproval']
  signOut!: DevicesSectionStores['signOut']
  forget!: DevicesSectionStores['forget']

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
    const [filters, setFilters] = useState<DeviceFilters>(() => ({
      ...EMPTY_DEVICE_FILTERS,
      q:        this.props.params.get('q') ?? '',
      approval: this.props.params.get('approval') ?? '',
      // Deep link from an account sheet: "the devices of this person".
      ...(this.props.params.get('user') ? {} : {}),
    }))
    this.publish({ filters, setFilters })
    const [draft, setDraft] = useState<string>(() => this.props.params.get('q') ?? '')
    this.publish({ draft, setDraft })
    const query = useMemo(
      () => ({ ...filters, ...(this.userId ? { user_id: this.userId } : {}) }) as DeviceFilters,
      [filters, this.userId],
    )
    const { data, isLoading, isError, refetch } = useDevices(query, !this.openId)
    this.publish({ data, isLoading, isError, refetch })
    const { data: facets } = useDeviceFacets(!this.openId)
    this.publish({ facets })
    return { filters, setFilters, draft, setDraft, query, data, isLoading, isError, refetch, facets }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, can: s.can, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, setApproval: s.setApproval, signOut: s.signOut, forget: s.forget })
    const h = this.useHooks()
    this.publish({ filters: h.filters, setFilters: h.setFilters, draft: h.draft, setDraft: h.setDraft, data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch, facets: h.facets })
  }

  get openId(): string | null {
    return this.props.params.get('device')
  }

  get userId(): string {
    return this.props.params.get('user') ?? ''
  }

  get canManage(): boolean {
    return this.can(PRIV.SESSIONS_DELETE)
  }

  get rows(): Device[] {
    return this.memo('rows', [this.data, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return this.data?.devices ?? []
    })
  }

  get anyFilter(): boolean {
    if (!(!(this.openId))) return undefined as never
    return Object.values(this.filters).some(Boolean)
  }

  get columns(): DataTableColumn<Device>[] {
    return this.memo('columns', [this.tr, this.i18n, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return [
    {
      id: 'device',
      header: this.tr('devices.col_device'),
      primary: true,
      required: true,
      minWidth: 220,
      cell: (d) => (
        <div className="flex min-w-0 items-start gap-2">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${approvalSkin(d.approval).dot}`} aria-hidden />
          <div className="min-w-0">
            <div className="line-clamp-2 whitespace-normal break-words text-text-primary">
              {deviceName(this.tr, d)}
            </div>
            <div className="line-clamp-2 whitespace-normal break-words text-text-tertiary"
              style={{ fontSize: 'var(--kb-text-meta)' }}>
              {deviceTypeLabel(this.tr, d.device_type)}
              {d.browser ? ` · ${d.browser}` : ''}
            </div>
          </div>
        </div>
      ),
      sortValue: (d) => deviceName(this.tr, d),
    },
    {
      id: 'user',
      header: this.tr('devices.col_account'),
      width: 170,
      cell: (d) => <span className="truncate text-text-secondary">{d.user_label ?? '—'}</span>,
      sortValue: (d) => d.user_label ?? '',
    },
    {
      id: 'platform',
      header: this.tr('devices.col_platform'),
      width: 150,
      cell: (d) => (
        <span className="truncate text-text-secondary">
          {[d.platform, d.platform_version].filter(Boolean).join(' ') || '—'}
        </span>
      ),
      sortValue: (d) => d.platform ?? '',
    },
    {
      id: 'approval',
      header: this.tr('devices.col_approval'),
      width: 120,
      cell: (d) => (
        <span className={`inline-block rounded-full px-1.5 py-0.5 ${approvalSkin(d.approval).chip}`}
          style={{ fontSize: 'var(--kb-text-micro)' }}>
          {approvalLabel(this.tr, d.approval)}
        </span>
      ),
      sortValue: (d) => d.approval,
    },
    {
      id: 'signal',
      header: this.tr('devices.col_signal'),
      width: 120,
      // "Observed" is the honest default and the overwhelming majority. Showing
      // the level in the list is what stops a reader assuming the platform
      // checked anything about the machine.
      cell: (d) => <span className="text-text-secondary">{signalLevelLabel(this.tr, d.signal_level)}</span>,
      sortValue: (d) => d.signal_level,
    },
    {
      id: 'sessions',
      header: this.tr('devices.col_sessions'),
      width: 80,
      align: 'right',
      cell: (d) => <span className="tabular-nums text-text-secondary">{d.active_sessions}</span>,
      sortValue: (d) => d.active_sessions,
    },
    {
      id: 'country',
      header: this.tr('devices.col_country'),
      width: 90,
      cell: (d) => <span className="text-text-secondary">{d.last_country ?? '—'}</span>,
      sortValue: (d) => d.last_country ?? '',
    },
    {
      id: 'last_seen',
      header: this.tr('devices.col_last_seen'),
      width: 150,
      cell: (d) => (
        <span className="whitespace-nowrap text-text-secondary" title={formatWhen(d.last_seen_at, this.i18n.language)}>
          {formatAgo(d.last_seen_at)}
        </span>
      ),
      sortValue: (d) => new Date(d.last_seen_at),
    },
  ]
    })
  }

  get rowActions(): DataTableRowAction<Device>[] {
    return this.memo('rowActions', [this.canManage, this.tr, this.openId, this.setApproval, this.toast, this.memo, this.signOut, this.confirm, this.forget], () => {
      if (!(!(this.openId))) return undefined as never
      return this.canManage ? [
    {
      id: 'approve', label: this.tr('devices.approve'), icon: <Check size={15} />,
      onClick: d => this.runApproval(d, 'approved'), hidden: d => d.approval === 'approved',
    },
    {
      id: 'block', label: this.tr('devices.block'), icon: <Ban size={15} />,
      onClick: d => this.runApproval(d, 'blocked'), hidden: d => d.approval === 'blocked',
    },
    {
      id: 'unblock', label: this.tr('devices.unblock'), icon: <Check size={15} />,
      onClick: d => this.runApproval(d, 'pending'), hidden: d => d.approval !== 'blocked',
    },
    {
      id: 'sign-out', label: this.tr('devices.sign_out'), icon: <LogOut size={15} />,
      onClick: this.memo("runSignOut:bound", [], () => this.runSignOut.bind(this)), hidden: d => d.active_sessions === 0,
    },
    {
      id: 'forget', label: this.tr('devices.forget'), icon: <Trash2 size={15} />,
      onClick: d => void this.runForget(d),
    },
  ] : []
    })
  }

  get toolbar() {
    return this.memo('toolbar', [this.setFilters, this.draft, this.setDraft, this.tr, this.memo, this.facets, this.sheet, this.openId, this.filters], () => {
      if (!(!(this.openId))) return undefined as never
      const filters = this.filters
      const anyFilter = Object.values(filters).some(Boolean)
      return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <form className="flex items-center" onSubmit={e => { e.preventDefault(); this.set('q', this.draft) }}>
        <Input value={this.draft} onChange={e => this.setDraft(e.target.value)}
          placeholder={this.tr('devices.search_ph')} leftIcon={<Search size={15} />} className="w-52 pl-9" />
      </form>
      <div className="hidden flex-wrap items-center gap-2 sm:flex">
        <FilterControls filters={filters} set={this.memo("set:bound", [], () => this.set.bind(this))} facets={this.facets} stacked={false} />
      </div>
      <Button variant="secondary" size="sm" className="sm:hidden"
        icon={<SlidersHorizontal size={14} />} onClick={() => this.sheet = true}>
        {this.tr('devices.filters')}
      </Button>
      {anyFilter && (
        <Button variant="ghost" size="sm" icon={<X size={14} />}
          onClick={() => { this.setFilters(EMPTY_DEVICE_FILTERS); this.setDraft('') }}>
          {this.tr('devices.reset_filters')}
        </Button>
      )}
    </div>
  )
    })
  }

  get show_case_1() {
    return !!(this.openId)
  }

  /** `<DeviceDetail Id>`: the id of the device whose detail is open. */
  get device_detail_id(): string {
    if (!(this.openId)) return undefined as never
    return this.openId
  }

  /** `<DeviceDetail OnBack>`: leave the detail and return to the list. */
  device_detail_back(_sender: unknown, _e: EventArgs) {
    if (!(this.openId)) return undefined as never
    this.props.navigate(adminUrl({ tab: 'device-sessions' }))
  }

  get show_main() {
    return !(this.openId)
  }

  get show_data() {
    return this.memo('show_data', [this.data, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return !!(this.data)
    })
  }

  get count_count() {
    if (!(!(this.openId)) || !(this.data)) return undefined as never
    return this.data.total
  }

  get show_user_id() {
    if (!(!(this.openId))) return undefined as never
    return !!(this.userId)
  }

  get show_data_data_country() {
    if (!(!(this.openId))) return undefined as never
    return !!(this.data && !this.data.country_db_available)
  }

  get part1_props() {
    return this.memo('part1_props', [this.rows, this.columns, this.isLoading, this.isError, this.tr, this.refetch, this.anyFilter, this.setFilters, this.setDraft, this.toolbar, this.rowActions, this.props, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return ({ rows: this.rows, columns: this.columns, isLoading: this.isLoading, isError: this.isError, t: this.tr, refetch: this.refetch, anyFilter: this.anyFilter, setFilters: this.setFilters, setDraft: this.setDraft, toolbar: this.toolbar, rowActions: this.rowActions, navigate: this.props.navigate })
    })
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, onRetry, filtered, onClearFilters, toolbar, rowActions, onRowClick, configurableColumns, t, emptyState: no .kbview property). */
  get Part1() {
    if (!(!(this.openId))) return undefined as never
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.sheet, this.memo, this.tr, this.filters, this.setFilters, this.facets, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return ({ sheet: this.sheet, setSheet: this.memo("setSheet:bound", [], () => this.setSheet.bind(this)), t: this.tr, filters: this.filters, set: this.memo("set:bound", [], () => this.set.bind(this)), facets: this.facets })
    })
  }

  /** A part of the screen still written in React (<MobileSheet> is no .kbview element (@ui#MobileSheet)). */
  get Part2() {
    if (!(!(this.openId))) return undefined as never
    return __parts.Part2
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.openId], () => {
      if (!(!(this.openId))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.openId)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.openId], () => {
      if (!(!(this.openId)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  set<K extends keyof DeviceFilters>(key: K, value: DeviceFilters[K]) {
    return this.setFilters(f => ({ ...f, [key]: value }))
  }

  runApproval(device: Device, approval: 'approved' | 'blocked' | 'pending') {
    if (!(!(this.openId))) return undefined as never
    return this.setApproval.mutate({ id: device.id, approval }, {
      onSuccess: () => this.toast.success(this.tr(
        approval === 'blocked' ? 'devices.toast_blocked'
          : approval === 'approved' ? 'devices.toast_approved' : 'devices.toast_unblocked',
      )),
      onError: () => this.toast.error(this.tr('devices.toast_failed')),
    })
  }

  runSignOut(device: Device) {
    if (!(!(this.openId))) return undefined as never
    return this.signOut.mutate(device.id, {
    onSuccess: () => this.toast.success(this.tr('devices.toast_signed_out')),
    onError:   () => this.toast.error(this.tr('devices.toast_failed')),
  })
  }

  async runForget(device: Device) {
    if (!(!(this.openId))) return undefined as never
    // The confirmation carries the whole point of the action: this is the
    // sentence that stops an operator believing they just wiped a phone.
    const ok = await this.confirm({
      title:   this.tr('devices.forget_title', { name: deviceName(this.tr, device) }),
      message: this.tr('devices.forget_message'),
      confirmLabel: this.tr('devices.forget_confirm'),
      variant: 'danger',
    })
    if (!ok) return
    this.forget.mutate(device.id, {
      onSuccess: () => this.toast.success(this.tr('devices.toast_forgotten')),
      onError:   () => this.toast.error(this.tr('devices.toast_failed')),
    })
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.openId)) || !(this.userId)) return undefined as never
    this.props.navigate(adminUrl({ tab: 'device-sessions' }))
  }

  /** `setSheet` of the TSX: a value, or an update of the previous one. */
  setSheet(value: DevicesSection['sheet'] | ((prev: DevicesSection['sheet']) => DevicesSection['sheet'])) {
    this.sheet = typeof value === 'function' ? (value as (prev: DevicesSection['sheet']) => DevicesSection['sheet'])(this.sheet) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DevicesSectionStores = ReturnType<DevicesSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type DevicesSectionHooks = ReturnType<DevicesSection['useHooks']>

export default DevicesSection.component()
