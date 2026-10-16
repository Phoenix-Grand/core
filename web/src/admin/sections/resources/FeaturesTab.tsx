/**
 * Code-behind of `FeaturesTab.kbcontrol` (converted from `FeaturesTab.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { type DataTableColumn, type DataTableRowAction } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../../core/hooks/useConfirm"
import FeatureDialog from "./FeatureDialog"
import { errorMessage, useDeleteFeature, useResourceFeatures, type ResourceFeature } from "./api"

import { ViewBase } from './FeaturesTab.kbcontrol'
import * as __parts from './FeaturesTab.parts'

export type FeaturesTabProps = { canManage: boolean }

export class FeaturesTab extends ViewBase {
  @bind accessor editing: ResourceFeature | 'new' | null = null
  @bind accessor error: string | null = null
  tr!: FeaturesTabStores['t']
  confirm!: FeaturesTabStores['confirm']
  confirmState!: FeaturesTabStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: FeaturesTabStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: FeaturesTabStores['refetch']
  remove!: FeaturesTabStores['remove']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const { data, isLoading, isError, refetch } = useResourceFeatures()
    const remove = useDeleteFeature()
    return { t, confirm, confirmState, handleConfirm, handleCancel, data, isLoading, isError, refetch, remove }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, remove: s.remove })
  }

  get columns(): DataTableColumn<ResourceFeature>[] {
    return this.memo('columns', [this.tr], () => [
    {
      id: 'name',
      header: this.tr('admin.res_feature_name'),
      primary: true,
      minWidth: 200,
      sortValue: r => r.name.toLowerCase(),
      cell: r => <span className="text-text-primary">{r.name}</span>,
    },
    {
      id: 'description',
      header: this.tr('admin.res_admin_note'),
      minWidth: 260,
      sortValue: r => (r.description ?? '').toLowerCase(),
      cell: r => (
        <span className="text-text-secondary">{r.description ?? '-'}</span>
      ),
    },
    {
      id: 'resource_count',
      header: this.tr('admin.res_col_used_by'),
      align: 'right',
      sortValue: r => r.resource_count,
      cell: r => (
        <span className={r.resource_count === 0 ? 'text-text-tertiary' : 'text-text-secondary'}>
          {r.resource_count}
        </span>
      ),
    },
  ])
  }

  get rowActions(): DataTableRowAction<ResourceFeature>[] {
    return this.memo('rowActions', [this.props, this.tr, this.editing, this.confirm, this.error, this.remove], () => this.props.canManage
    ? [
        { id: 'edit', label: this.tr('admin.res_action_edit'), onClick: r => this.editing = r },
        {
          id: 'delete',
          label: this.tr('admin.res_action_delete'),
          danger: true,
          onClick: async r => {
            const ok = await this.confirm({
              title: this.tr('admin.res_feature_delete_title'),
              // The count is in the sentence because deleting a feature is
              // allowed even while resources carry it: it silently shortens
              // their composed names, and that is worth saying first.
              message: r.resource_count > 0
                ? this.tr('admin.res_feature_delete_used', { name: r.name, count: r.resource_count })
                : this.tr('admin.res_feature_delete_message', { name: r.name }),
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

  /** A part of the screen still written in React (<DataTable> columns, rowKey, onRetry, rowActions, onRowClick, t, toolbar, emptyState: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get show_editing() {
    return this.memo('show_editing', [this.editing], () => !!(this.editing))
  }

  /** `<FeatureDialog>`, rendered by a ReactHost. */
  get FeatureDialog() {
    if (!(this.editing)) return undefined as never
    return FeatureDialog
  }

  get feature_dialog_props() {
    return this.memo('feature_dialog_props', [this.editing], () => {
      if (!(this.editing)) return undefined as never
      return ({ feature: this.editing === 'new' ? null : this.editing, onClose: () => this.editing = null } as React.ComponentProps<typeof FeatureDialog>)
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
  setEditing(value: ResourceFeature | 'new' | null | ((prev: ResourceFeature | 'new' | null) => ResourceFeature | 'new' | null)) {
    this.editing = typeof value === 'function' ? (value as (prev: ResourceFeature | 'new' | null) => ResourceFeature | 'new' | null)(this.editing) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type FeaturesTabStores = ReturnType<FeaturesTab['useStores']>

export default FeaturesTab.component()
