/**
 * Code-behind of `DetectorsSection.kbview` (converted from `DetectorsSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { ShieldCheck, ShieldOff } from "lucide-react"
import { type DataTableColumn, type DataTableRowAction } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../hooks/useConfirm"
import { PRIV } from "../../authz/types"
import { usePrivileges } from "../../authz/usePrivileges"
import { adminUrl, useAdminAction } from "../adminAction"
import type { AdminSectionProps } from "../sections/registry"
import { useDetectors, useDeleteDetector, errorMessage, type Detector } from "./api"
import { asPercent, categoryLabel, categoryOrder, checksumLabel, kindLabel } from "./labels"

import { ViewBase } from './DetectorsSection.kbview'
import * as __parts from './DetectorsSection.parts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type { AdminSectionProps }

export class DetectorsSection extends ViewBase {
  @bind accessor editing: string | 'new' | null = null
  @bind accessor error: string | null = null
  tr!: DetectorsSectionStores['t']
  can!: DetectorsSectionStores['can']
  confirm!: DetectorsSectionStores['confirm']
  confirmState!: DetectorsSectionStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: DetectorsSectionStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: DetectorsSectionStores['refetch']
  remove!: DetectorsSectionStores['remove']
  openId!: string | null
  rows!: Detector[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t }   = useTranslation()
    const { can } = usePrivileges()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const { data, isLoading, isError, refetch } = useDetectors()
    const remove = useDeleteDetector()
    const rows = useMemo(() => {
      const list = data?.detectors ?? []
      return [...list].sort((a, b) =>
        categoryOrder(a.category) - categoryOrder(b.category) ||
        a.label.localeCompare(b.label))
    }, [data])
    return { t, can, confirm, confirmState, handleConfirm, handleCancel, data, isLoading, isError, refetch, remove, rows }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const data = this.data
    useAdminAction('create', () => { if (this.canManage) this.editing = 'new' })
    const openParam = this.openParam
    const openId = useMemo(() => {
      if (!openParam) return null
      if (UUID_RE.test(openParam)) return openParam
      return (data?.detectors ?? []).find(d => d.key === openParam)?.id ?? null
    }, [openParam, data])
    this.publish({ openId })
    return { openId }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, remove: s.remove, rows: s.rows })
    const h = this.useHooks()
    this.publish({ openId: h.openId })
  }

  get canManage(): boolean {
    return this.can(PRIV.RULES_MANAGE)
  }

  get openParam(): string | null {
    return this.props.params.get('detector')
  }

  get active(): string | null {
    return this.editing ?? this.openId
  }

  get columns(): DataTableColumn<Detector>[] {
    return this.memo('columns', [this.tr, this.active], () => {
      if (!(!(this.active))) return undefined as never
      return [
    {
      id: 'label',
      header: this.tr('admin.det_col_detector'),
      primary: true,
      minWidth: 220,
      sortValue: r => r.label,
      cell: r => (
        <div className="min-w-0">
          <div className="truncate text-text-primary">{r.label}</div>
          <div className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {r.key}
          </div>
        </div>
      ),
    },
    {
      id: 'category',
      header: this.tr('admin.det_col_category'),
      sortValue: r => categoryOrder(r.category),
      cell: r => <span className="text-text-secondary">{categoryLabel(this.tr, r.category)}</span>,
    },
    {
      id: 'kind',
      header: this.tr('admin.det_col_kind'),
      sortValue: r => r.kind,
      cell: r => (
        <span className="text-text-secondary">
          {kindLabel(this.tr, r.kind)}
          {r.checksum ? ` · ${checksumLabel(this.tr, r.checksum)}` : ''}
        </span>
      ),
    },
    {
      id: 'thresholds',
      header: this.tr('admin.det_col_thresholds'),
      minWidth: 200,
      cell: r => (
        <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {this.tr('admin.det_thresholds_summary', {
            confidence: asPercent(r.min_confidence),
            matches: r.min_matches,
            unique: r.min_unique_matches,
          })}
        </span>
      ),
    },
    {
      id: 'state',
      header: this.tr('admin.det_col_state'),
      sortValue: r => (r.is_enabled ? 0 : 1),
      cell: r => (
        <span className="inline-flex items-center gap-1.5">
          {r.is_enabled
            ? <ShieldCheck size={14} className="text-success" aria-hidden />
            : <ShieldOff size={14} className="text-text-tertiary" aria-hidden />}
          <span className={r.is_enabled ? 'text-text-secondary' : 'text-text-tertiary'}>
            {r.is_enabled ? this.tr('admin.det_state_on') : this.tr('admin.det_state_off')}
          </span>
        </span>
      ),
    },
    {
      id: 'origin',
      header: this.tr('admin.det_col_origin'),
      defaultHidden: true,
      sortValue: r => (r.is_builtin ? 0 : 1),
      cell: r => (
        <span className="text-text-tertiary">
          {r.is_builtin ? this.tr('admin.det_origin_builtin') : this.tr('admin.det_origin_custom')}
        </span>
      ),
    },
  ]
    })
  }

  get rowActions(): DataTableRowAction<Detector>[] {
    return this.memo('rowActions', [this.canManage, this.tr, this.editing, this.confirm, this.error, this.remove, this.active], () => {
      if (!(!(this.active))) return undefined as never
      return this.canManage
    ? [
        {
          id: 'edit',
          label: this.tr('admin.det_action_edit'),
          onClick: r => this.editing = r.id,
        },
        {
          id: 'delete',
          label: this.tr('admin.det_action_delete'),
          danger: true,
          hidden: r => r.is_builtin,
          onClick: async r => {
            const ok = await this.confirm({
              title: this.tr('admin.det_delete_title'),
              message: this.tr('admin.det_delete_message', { label: r.label }),
              confirmLabel: this.tr('admin.det_action_delete'),
              variant: 'danger',
            })
            if (!ok) return
            this.error = null
            try {
              await this.remove.mutateAsync(r.id)
            } catch (e) {
              this.error = errorMessage(e, this.tr('admin.det_delete_failed'))
            }
          },
        },
      ]
    : []
    })
  }

  get show_case_1() {
    return !!(this.active)
  }

  /** `<DetectorEditor Id>`: the detector being edited (`null` for a new one). */
  get editorId() {
    if (!(this.active)) return undefined as never
    return this.active === 'new' ? null : this.active
  }

  /** `<DetectorEditor Limits>`: the server's detector limits. */
  get editorLimits() {
    if (!(this.active)) return undefined as never
    return this.data?.limits
  }

  get show_main() {
    return !(this.active)
  }

  get show_error() {
    if (!(!(this.active))) return undefined as never
    return !!(this.error)
  }

  get part1_props() {
    return this.memo('part1_props', [this.rows, this.columns, this.isLoading, this.isError, this.tr, this.refetch, this.rowActions, this.memo, this.editing, this.canManage, this.active], () => {
      if (!(!(this.active))) return undefined as never
      return ({ rows: this.rows, columns: this.columns, isLoading: this.isLoading, isError: this.isError, t: this.tr, refetch: this.refetch, rowActions: this.rowActions, setEditing: this.memo("setEditing:bound", [], () => this.setEditing.bind(this)), canManage: this.canManage })
    })
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, onRetry, rowActions, onRowClick, configurableColumns, t, toolbar, emptyState: no .kbview property). */
  get Part1() {
    if (!(!(this.active))) return undefined as never
    return __parts.Part1
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.active], () => {
      if (!(!(this.active))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.active)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.active], () => {
      if (!(!(this.active)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  /** `<DetectorEditor OnClose>`: the editor closed. */
  detector_editor_close(_sender: unknown, _e: EventArgs) {
    this.editing = null
    if (this.openId) this.props.navigate(adminUrl({ tab: 'detectors' }))
  }

  /** `setEditing` of the TSX: a value, or an update of the previous one. */
  setEditing(value: string | 'new' | null | ((prev: string | 'new' | null) => string | 'new' | null)) {
    this.editing = typeof value === 'function' ? (value as (prev: string | 'new' | null) => string | 'new' | null)(this.editing) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DetectorsSectionStores = ReturnType<DetectorsSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type DetectorsSectionHooks = ReturnType<DetectorsSection['useHooks']>

export default DetectorsSection.component()
