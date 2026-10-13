/**
 * Code-behind of `BuildingsTab.kbcontrol` (converted from `BuildingsTab.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { type DataTableColumn, type DataTableRowAction } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../../core/hooks/useConfirm"
import BuildingDialog from "./BuildingDialog"
import { errorMessage, useBuildings, useDeleteBuilding, type Building } from "./api"

import { ViewBase } from './BuildingsTab.kbcontrol'
import * as __parts from './BuildingsTab.parts'

export type BuildingsTabProps = { canManage: boolean }

export class BuildingsTab extends ViewBase {
  @bind accessor editing: Building | 'new' | null = null
  @bind accessor error: string | null = null
  tr!: BuildingsTabStores['t']
  confirm!: BuildingsTabStores['confirm']
  confirmState!: BuildingsTabStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: BuildingsTabStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: BuildingsTabStores['refetch']
  remove!: BuildingsTabStores['remove']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const { data, isLoading, isError, refetch } = useBuildings()
    const remove = useDeleteBuilding()
    return { t, confirm, confirmState, handleConfirm, handleCancel, data, isLoading, isError, refetch, remove }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, remove: s.remove })
  }

  get rows(): Building[] {
    return this.memo('rows', [this.data], () => this.data?.buildings ?? [])
  }

  get columns(): DataTableColumn<Building>[] {
    return this.memo('columns', [this.tr], () => [
    {
      id: 'building_key',
      header: this.tr('admin.res_building_key'),
      primary: true,
      minWidth: 200,
      sortValue: r => r.building_key.toLowerCase(),
      cell: r => (
        <div className="min-w-0">
          <div className="truncate text-text-primary">{r.building_key}</div>
          {r.name && (
            <div className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {r.name}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'address',
      header: this.tr('admin.res_address'),
      minWidth: 220,
      sortValue: r => r.address.toLowerCase(),
      cell: r => <span className="text-text-secondary">{r.address}</span>,
    },
    {
      id: 'floors',
      header: this.tr('admin.res_floors'),
      minWidth: 180,
      // Sorted by how many, not alphabetically: the order of the list itself is
      // meaningful and must be read as written, never re-sorted for display.
      sortValue: r => r.floors.length,
      cell: r => (
        <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {r.floors.join(' · ')}
        </span>
      ),
    },
    {
      id: 'resource_count',
      header: this.tr('admin.res_col_resources'),
      align: 'right',
      sortValue: r => r.resource_count,
      cell: r => <span className="text-text-secondary">{r.resource_count}</span>,
    },
  ])
  }

  get rowActions(): DataTableRowAction<Building>[] {
    return this.memo('rowActions', [this.props, this.tr, this.editing, this.confirm, this.error, this.remove], () => this.props.canManage
    ? [
        { id: 'edit', label: this.tr('admin.res_action_edit'), onClick: r => this.editing = r },
        {
          id: 'delete',
          label: this.tr('admin.res_action_delete'),
          danger: true,
          onClick: async r => {
            const ok = await this.confirm({
              title: this.tr('admin.res_building_delete_title'),
              message: this.tr('admin.res_building_delete_message', { key: r.building_key }),
              confirmLabel: this.tr('admin.res_action_delete'),
              variant: 'danger',
            })
            if (!ok) return
            this.error = null
            try {
              await this.remove.mutateAsync(r.id)
            } catch (e) {
              this.error = errorMessage(e, this.tr('admin.res_delete_failed'))
            }
          },
        },
      ]
    : [])
  }

  get show_error() {
    return !!(this.error)
  }

  get part1_props() {
    return this.memo('part1_props', [this.rows, this.columns, this.isLoading, this.isError, this.tr, this.refetch, this.rowActions, this.props, this.memo, this.editing], () => ({ rows: this.rows, columns: this.columns, isLoading: this.isLoading, isError: this.isError, t: this.tr, refetch: this.refetch, rowActions: this.rowActions, canManage: this.props.canManage, setEditing: this.memo("setEditing:bound", [], () => this.setEditing.bind(this)) }))
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, onRetry, rowActions, onRowClick, configurableColumns, t, toolbar, emptyState: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get show_editing() {
    return this.memo('show_editing', [this.editing], () => !!(this.editing))
  }

  /** `<BuildingDialog>`, rendered by a ReactHost. */
  get BuildingDialog() {
    if (!(this.editing)) return undefined as never
    return BuildingDialog
  }

  get building_dialog_props() {
    return this.memo('building_dialog_props', [this.editing, this.data], () => {
      if (!(this.editing)) return undefined as never
      return ({ building: this.editing === 'new' ? null : this.editing, floorMax: this.data?.limits.floors ?? 200, onClose: () => this.editing = null } as React.ComponentProps<typeof BuildingDialog>)
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

  /** `setEditing` of the TSX: a value, or an update of the previous one. */
  setEditing(value: Building | 'new' | null | ((prev: Building | 'new' | null) => Building | 'new' | null)) {
    this.editing = typeof value === 'function' ? (value as (prev: Building | 'new' | null) => Building | 'new' | null)(this.editing) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type BuildingsTabStores = ReturnType<BuildingsTab['useStores']>

export default BuildingsTab.component()
