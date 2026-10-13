/**
 * Code-behind of `QuotaPolicyCard.kbcontrol` (converted from `QuotaPolicyCard.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import type { OrgUnit } from "../../core/types"
import { useConfirm } from "../../core/hooks/useConfirm"
import ConfirmDialog from "@ui/ConfirmDialog"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { formatBytes } from "../sections/format"
import OrgUnitPicker from "../dialogs/OrgUnitPicker"
import { splitQuota, toBytes, type QuotaUnit } from "./QuotaField"
import { errorMessage, useSetDefaultQuota, type StorageOverview } from "./api"

import { ViewBase } from './QuotaPolicyCard.kbcontrol'
import * as __parts from './QuotaPolicyCard.parts'

export type QuotaPolicyCardProps = { overview: StorageOverview }

export class QuotaPolicyCard extends ViewBase {
  @bind accessor editing: { unitId: string | null; name: string } | null = null
  @bind accessor picking = false
  @bind accessor amount = '10'
  @bind accessor unit: QuotaUnit = 'GiB'
  @bind accessor error: string | null = null
  tr!: QuotaPolicyCardStores['t']
  can!: QuotaPolicyCardStores['can']
  confirm!: QuotaPolicyCardStores['confirm']
  confirmState!: QuotaPolicyCardStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  save!: QuotaPolicyCardStores['save']
  units!: QuotaPolicyCardHooks['units']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { can } = usePrivileges()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const save = useSetDefaultQuota()
    return { t, can, confirm, confirmState, handleConfirm, handleCancel, save }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data: units } = useQuery({
      queryKey:  ['admin-org-units'],
      queryFn:   () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
      staleTime: 30_000,
      enabled:   this.canManage,
    })
    this.publish({ units })
    return { units }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, save: s.save })
    const h = this.useHooks()
    this.publish({ units: h.units })
  }

  get canManage(): boolean {
    return this.can(PRIV.SETTINGS_MANAGE)
  }

  get policy() {
    return this.memo('policy', [this.props], () => this.props.overview.policy)
  }

  get show_not_can_manage() {
    return !(this.canManage)
  }

  get span_text() {
    return this.policy.instance_bytes != null ? formatBytes(this.policy.instance_bytes) : '—'
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.policy], () => {
      if (!(this.policy.instance_locked)) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Lock aria-label>: an icon attribute without a property). */
  get Part1() {
    if (!(this.policy.instance_locked)) return undefined as never
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<Lock aria-label>: an icon attribute without a property). */
  get Part2() {
    return __parts.Part2
  }

  /** The rows of the Repeater over `policy.units`. */
  get rows_units() {
    return this.memo('rows_units', [this.policy, this.canManage], () => this.policy.units.map((u) => {
      return { u, span_text: u.bytes != null ? formatBytes(u.bytes) : '—', show_can_manage_u_unit: !!(this.canManage && u.unit_id), key: u.unit_id ?? u.unit_name }
    }))
  }

  get show_policy_units() {
    return this.policy.units.length === 0
  }

  get show_error() {
    return !!(this.error)
  }

  get show_editing() {
    return this.memo('show_editing', [this.editing], () => !!(this.editing))
  }

  /** `<QuotaField Label>`: the field's label for the unit being edited. */
  get quotaFieldLabel() {
    if (!(this.editing)) return undefined as never
    return this.tr('admin.sto_policy_field', { name: this.editing.name })
  }

  get enabled_unless_save_is_pending() {
    if (!(this.editing)) return undefined as never
    return !(this.save.isPending)
  }

  /** `<OrgUnitPicker>`, rendered by a ReactHost. */
  get OrgUnitPicker() {
    if (!(this.picking)) return undefined as never
    return OrgUnitPicker
  }

  get org_unit_picker_props() {
    return this.memo('org_unit_picker_props', [this.tr, this.policy, this.amount, this.unit, this.error, this.editing, this.picking, this.units], () => {
      if (!(this.picking)) return undefined as never
      const units = this.units
      return ({ title: this.tr('admin.sto_policy_pick_unit'), currentId: null, onSelect: id => {
            const existing = this.policy.units.find(u => u.unit_id === id)
            const name = existing?.unit_name ?? units?.find(u => u.id === id)?.name ?? ''
            this.openEditor(id, name, existing?.bytes ?? this.policy.instance_bytes)
          }, onClose: () => this.picking = false } as React.ComponentProps<typeof OrgUnitPicker>)
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

  openEditor(unitId: string | null, name: string, bytes: number | null) {
    const split = splitQuota(bytes ?? 10 * 1024 ** 3)
    this.amount = split.amount
    this.unit = split.unit
    this.error = null
    this.editing = { unitId, name }
  }

  async submit() {
    if (!this.editing) return
    const bytes = toBytes(this.amount, this.unit)
    if (bytes == null) { this.error = this.tr('admin.sto_quota_invalid'); return }
    try {
      await this.save.mutateAsync({ unitId: this.editing.unitId, bytes })
      this.editing = null
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.sto_policy_failed'))
    }
  }

  async revert(unitId: string, name: string) {
    const ok = await this.confirm({
      title:        this.tr('admin.sto_policy_revert_title'),
      message:      this.tr('admin.sto_policy_revert_msg', { name }),
      confirmLabel: this.tr('admin.sto_policy_revert'),
    })
    if (!ok) return
    try {
      await this.save.mutateAsync({ unitId, bytes: null })
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.sto_policy_failed'))
    }
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.canManage)) return undefined as never
    this.picking = true
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.canManage)) return undefined as never
    this.openEditor(null, this.tr('admin.sto_policy_instance'), this.policy.instance_bytes)
  }

  button_click3(_sender: unknown, args: MouseEventArgs) {
    const { u } = args.row as RowOf_rows_units
    if (!(this.canManage && (args.row as RowOf_rows_units).u.unit_id)) return undefined as never
    this.openEditor(u.unit_id, u.unit_name, u.bytes)
  }

  button_click4(_sender: unknown, args: MouseEventArgs) {
    const { u } = args.row as RowOf_rows_units
    if (!(this.canManage && (args.row as RowOf_rows_units).u.unit_id)) return undefined as never
    void this.revert(u.unit_id as string, u.unit_name)
  }

  button_click5(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.editing)) return undefined as never
    this.editing = null
  }

  button_click6(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.editing)) return undefined as never
    void this.submit()
  }

  /** `<QuotaField OnAmount>`: the amount changed. */
  quota_field_amount(_sender: unknown, args: ValueChangedEventArgs) {
    this.setAmount(args.value as string)
  }

  /** `<QuotaField OnUnit>`: the unit changed. */
  quota_field_unit(_sender: unknown, args: ValueChangedEventArgs) {
    this.setUnit(args.value as QuotaUnit)
  }

  /** `setAmount` of the TSX: a value, or an update of the previous one. */
  setAmount(value: QuotaPolicyCard['amount'] | ((prev: QuotaPolicyCard['amount']) => QuotaPolicyCard['amount'])) {
    this.amount = typeof value === 'function' ? (value as (prev: QuotaPolicyCard['amount']) => QuotaPolicyCard['amount'])(this.amount) : value
  }

  /** `setUnit` of the TSX: a value, or an update of the previous one. */
  setUnit(value: QuotaUnit | ((prev: QuotaUnit) => QuotaUnit)) {
    this.unit = typeof value === 'function' ? (value as (prev: QuotaUnit) => QuotaUnit)(this.unit) : value
  }

}

type RowOf_rows_units = QuotaPolicyCard['rows_units'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type QuotaPolicyCardStores = ReturnType<QuotaPolicyCard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type QuotaPolicyCardHooks = ReturnType<QuotaPolicyCard['useHooks']>

export default QuotaPolicyCard.component()
