/**
 * Code-behind of `ResourcesTab.kbcontrol` (converted from `ResourcesTab.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { type DataTableColumn, type DataTableRowAction } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../../core/hooks/useConfirm"
import ResourceDialog from "./ResourceDialog"
import { errorMessage, useDeleteResource, useResources, type Resource } from "./api"

import { ViewBase } from './ResourcesTab.kbcontrol'
import * as __parts from './ResourcesTab.parts'

export type ResourcesTabProps = { canManage: boolean }

export class ResourcesTab extends ViewBase {
  @bind accessor editing: Resource | 'new' | null = null
  @bind accessor error: string | null = null
  tr!: ResourcesTabStores['t']
  confirm!: ResourcesTabStores['confirm']
  confirmState!: ResourcesTabStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: ResourcesTabStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: ResourcesTabStores['refetch']
  remove!: ResourcesTabStores['remove']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const { data, isLoading, isError, refetch } = useResources()
    const remove = useDeleteResource()
    return { t, confirm, confirmState, handleConfirm, handleCancel, data, isLoading, isError, refetch, remove }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, remove: s.remove })
  }

  get columns(): DataTableColumn<Resource>[] {
    return this.memo('columns', [this.tr], () => [
    {
      id: 'generated_name',
      header: this.tr('admin.res_generated_name'),
      primary: true,
      minWidth: 260,
      sortValue: r => r.generated_name.toLowerCase(),
      cell: r => (
        <div className="min-w-0">
          <div className="truncate text-text-primary">{r.generated_name}</div>
          <div className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {r.name}
          </div>
        </div>
      ),
    },
    {
      id: 'category',
      header: this.tr('admin.res_category'),
      sortValue: r => (r.category === 'meeting_room' ? 0 : 1),
      cell: r => (
        <span className="text-text-secondary">
          {r.category === 'meeting_room'
            ? this.tr('admin.res_category_room')
            : r.resource_type ?? this.tr('admin.res_category_other')}
        </span>
      ),
    },
    {
      id: 'building',
      header: this.tr('admin.res_building'),
      minWidth: 160,
      sortValue: r => r.building.key.toLowerCase(),
      cell: r => (
        <span className="text-text-secondary">
          {r.building.name ?? r.building.key}
        </span>
      ),
    },
    {
      id: 'floor',
      header: this.tr('admin.res_floor'),
      sortValue: r => r.floor_name.toLowerCase(),
      cell: r => (
        <span className="text-text-secondary">
          {r.floor_section ? `${r.floor_name} · ${r.floor_section}` : r.floor_name}
        </span>
      ),
    },
    {
      id: 'capacity',
      header: this.tr('admin.res_capacity'),
      align: 'right',
      sortValue: r => r.capacity,
      cell: r => <span className="text-text-secondary">{r.capacity}</span>,
    },
    {
      id: 'features',
      header: this.tr('admin.res_features'),
      minWidth: 180,
      defaultHidden: true,
      sortValue: r => r.feature_names.length,
      cell: r => (
        <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {r.feature_names.length > 0 ? r.feature_names.join(' · ') : '—'}
        </span>
      ),
    },
  ])
  }

  get rowActions(): DataTableRowAction<Resource>[] {
    return this.memo('rowActions', [this.props, this.tr, this.editing, this.confirm, this.error, this.remove], () => this.props.canManage
    ? [
        { id: 'edit', label: this.tr('admin.res_action_edit'), onClick: r => this.editing = r },
        {
          id: 'delete',
          label: this.tr('admin.res_action_delete'),
          danger: true,
          onClick: async r => {
            const ok = await this.confirm({
              title: this.tr('admin.res_resource_delete_title'),
              message: this.tr('admin.res_resource_delete_message', { name: r.generated_name }),
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
    return this.memo('part1_props', [this.data, this.columns, this.isLoading, this.isError, this.tr, this.refetch, this.rowActions, this.props, this.memo, this.editing], () => ({ data: this.data, columns: this.columns, isLoading: this.isLoading, isError: this.isError, t: this.tr, refetch: this.refetch, rowActions: this.rowActions, canManage: this.props.canManage, setEditing: this.memo("setEditing:bound", [], () => this.setEditing.bind(this)) }))
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, onRetry, rowActions, onRowClick, configurableColumns, t, toolbar, emptyState: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get show_editing() {
    return this.memo('show_editing', [this.editing], () => !!(this.editing))
  }

  /** `<ResourceDialog>`, rendered by a ReactHost. */
  get ResourceDialog() {
    if (!(this.editing)) return undefined as never
    return ResourceDialog
  }

  get resource_dialog_props() {
    return this.memo('resource_dialog_props', [this.editing], () => {
      if (!(this.editing)) return undefined as never
      return ({ resource: this.editing === 'new' ? null : this.editing, onClose: () => this.editing = null } as React.ComponentProps<typeof ResourceDialog>)
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
  setEditing(value: Resource | 'new' | null | ((prev: Resource | 'new' | null) => Resource | 'new' | null)) {
    this.editing = typeof value === 'function' ? (value as (prev: Resource | 'new' | null) => Resource | 'new' | null)(this.editing) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ResourcesTabStores = ReturnType<ResourcesTab['useStores']>

export default ResourcesTab.component()
