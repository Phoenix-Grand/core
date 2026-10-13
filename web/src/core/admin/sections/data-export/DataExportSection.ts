/**
 * Code-behind of `DataExportSection.kbview` (converted from `DataExportSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useToast } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../../hooks/useConfirm"
import { usePrivileges } from "../../../authz/usePrivileges"
import { useAdminAction } from "../../adminAction"
import { adminUrlWith } from "../../adminAction"
import type { AdminSectionProps } from "../registry"
import { DATA_EXPORT_EXECUTE, DATA_EXPORT_READ } from "./privileges"
import ExportRequestDialog from "./ExportRequestDialog"
import { errorMessage, useCancelExport, useDataExport, useDeleteExport, type ExportRun } from "./api"

import { ViewBase } from './DataExportSection.kbview'
import * as __parts from './DataExportSection.parts'

export type { AdminSectionProps }

export class DataExportSection extends ViewBase {
  @bind accessor composing = false
  tr!: DataExportSectionStores['t']
  toast!: DataExportSectionStores['toast']
  can!: DataExportSectionStores['can']
  data!: DataExportSectionStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: DataExportSectionStores['refetch']
  cancel!: DataExportSectionStores['cancel']
  remove!: DataExportSectionStores['remove']
  confirm!: DataExportSectionStores['confirm']
  confirmState!: DataExportSectionStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const toast = useToast()
    const { can } = usePrivileges()
    const { data, isLoading, isError, refetch } = useDataExport()
    const cancel = useCancelExport()
    const remove = useDeleteExport()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const wasRunning = useRef(false)
    useEffect(() => {
      const running = !!data?.active
      if (wasRunning.current && !running) toast.success(t('admin.dx_finished'))
      wasRunning.current = running
    }, [data?.active, toast, t])
    return { t, toast, can, data, isLoading, isError, refetch, cancel, remove, confirm, confirmState, handleConfirm, handleCancel, wasRunning }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    useAdminAction('cancel', id => { if (this.canExecute && id) void this.askCancel(id) })
    return {  }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, toast: s.toast, can: s.can, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, cancel: s.cancel, remove: s.remove, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel })
    this.useHooks()
  }

  get canRead(): boolean {
    return this.can(DATA_EXPORT_READ)
  }

  get canExecute(): boolean {
    return this.can(DATA_EXPORT_EXECUTE)
  }

  get selected(): string | null {
    return this.props.params.get('export')
  }

  get show_case_1() {
    return !!(!this.canRead)
  }

  get show_case_2() {
    return !(!this.canRead) && !!(this.isLoading)
  }

  get show_case_3() {
    return !(!this.canRead) && !(this.isLoading) && !!(this.isError || !this.data)
  }

  get show_main() {
    return !(!this.canRead) && !(this.isLoading) && !(this.isError || !this.data)
  }

  get enabled_unless_data_eligibility_ok() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canExecute)) return undefined as never
    return !(!this.data.eligibility.ok)
  }

  /** `<Eligibility>`, rendered by a ReactHost. */
  get Eligibility() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Eligibility
  }

  get eligibility_props() {
    return this.memo('eligibility_props', [this.data, this.canExecute, this.canRead, this.isLoading, this.isError], () => {
      if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ data: this.data, canExecute: this.canExecute })
    })
  }

  /** `<ActiveRun>`, rendered by a ReactHost. */
  get ActiveRun() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.ActiveRun
  }

  get active_run_props() {
    return this.memo('active_run_props', [this.data, this.canExecute, this.memo, this.confirm, this.tr, this.cancel, this.toast, this.canRead, this.isLoading, this.isError], () => {
      if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ data: this.data, canExecute: this.canExecute, onCancel: this.memo("askCancel:bound", [], () => this.askCancel.bind(this)), busy: this.cancel.isPending })
    })
  }

  /** `<Coverage>`, rendered by a ReactHost. */
  get Coverage() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Coverage
  }

  get coverage_props() {
    return this.memo('coverage_props', [this.data, this.canRead, this.isLoading, this.isError], () => {
      if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ data: this.data })
    })
  }

  /** `<PolicySummary>`, rendered by a ReactHost. */
  get PolicySummary() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.PolicySummary
  }

  /** `<History>`, rendered by a ReactHost. */
  get History() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.History
  }

  get history_props() {
    return this.memo('history_props', [this.data, this.canExecute, this.memo, this.props, this.confirm, this.tr, this.cancel, this.toast, this.remove, this.canRead, this.isLoading, this.isError], () => {
      if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ data: this.data, canExecute: this.canExecute, onOpen: this.memo("open:bound", [], () => this.open.bind(this)), onCancel: this.memo("askCancel:bound", [], () => this.askCancel.bind(this)), onDelete: this.memo("askDelete:bound", [], () => this.askDelete.bind(this)) })
    })
  }

  get show_selected() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return !!(this.selected)
  }

  /** `<ExportSubjectsCard ExportId>`: the selected export's id. */
  get exportId() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.selected)) return undefined as never
    return this.selected
  }

  /** `<ExportRequestDialog>`, rendered by a ReactHost. */
  get ExportRequestDialog() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.composing)) return undefined as never
    return ExportRequestDialog
  }

  get export_request_dialog_props() {
    return this.memo('export_request_dialog_props', [this.data, this.composing, this.toast, this.tr, this.props, this.canRead, this.isLoading, this.isError], () => {
      if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.composing)) return undefined as never
      return ({ overview: this.data, onClose: () => this.composing = false, onRequested: id => {
            this.composing = false
            this.toast.success(this.tr('admin.dx_requested'))
            if (id) this.open(id)
          } } as React.ComponentProps<typeof ExportRequestDialog>)
    })
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.canRead, this.isLoading, this.isError, this.data], () => {
      if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.canRead, this.isLoading, this.isError, this.data], () => {
      if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  open(id: string | null) {
    return this.props.navigate(adminUrlWith('data-export', this.props.params, { export: id }))
  }

  async askCancel(id: string) {
    const ok = await this.confirm({
      title:        this.tr('admin.dx_cancel_title'),
      message:      this.tr('admin.dx_cancel_msg'),
      confirmLabel: this.tr('admin.dx_cancel_confirm'),
      variant:      'danger',
    })
    if (!ok) return
    this.cancel.mutate(id, {
      onSuccess: () => this.toast.success(this.tr('admin.dx_cancelled')),
      onError:   e => this.toast.error(errorMessage(e, this.tr('admin.dx_cancel_failed'))),
    })
  }

  async askDelete(run: ExportRun) {
    const ok = await this.confirm({
      title:        this.tr('admin.dx_delete_title'),
      message:      this.tr('admin.dx_delete_msg', { count: run.subjects_total }),
      confirmLabel: this.tr('common.delete'),
      variant:      'danger',
    })
    if (!ok) return
    this.remove.mutate(run.id, {
      onSuccess: () => this.toast.success(this.tr('admin.dx_deleted')),
      onError:   e => this.toast.error(errorMessage(e, this.tr('admin.dx_delete_failed'))),
    })
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(this.isError || !this.data)) return undefined as never
    void this.refetch()
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(!this.canRead)) || !(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canExecute)) return undefined as never
    this.composing = true
  }

  export_subjects_card_close(_sender: unknown, _e: EventArgs) {
    this.open(null)
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DataExportSectionStores = ReturnType<DataExportSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type DataExportSectionHooks = ReturnType<DataExportSection['useHooks']>

export default DataExportSection.component()
