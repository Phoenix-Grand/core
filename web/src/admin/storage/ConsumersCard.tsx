/**
 * Code-behind of `ConsumersCard.kbcontrol` (converted from `ConsumersCard.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { ProgressBar, type DataTableColumn, type DataTableRowAction } from "@ui"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { adminUrl, useAdminAction } from "../adminAction"
import { formatBytes } from "../sections/format"
import AccountUsageDialog from "./AccountUsageDialog"
import { useStorageConsumers, type Consumer, type ConsumerFilter, type ConsumerSort } from "./api"

import { ViewBase } from './ConsumersCard.kbcontrol'
import * as __parts from './ConsumersCard.parts'

export type ConsumersCardProps = {
  warnPercent: number
  /** `/admin/storage?filter=full` - the saturated accounts, addressable directly. */
  initialFilter?: ConsumerFilter
}

export class ConsumersCard extends ViewBase {
  @bind accessor sort: ConsumerSort = 'used'
  @bind accessor limit = 25
  @bind accessor inspecting: Consumer | null = null
  tr!: ConsumersCardStores['t']
  navigate!: ConsumersCardStores['navigate']
  can!: ConsumersCardStores['can']
  filter!: ConsumerFilter
  setFilter!: ConsumersCardHooks['setFilter']
  data!: ConsumersCardHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: ConsumersCardHooks['refetch']
  rows!: Consumer[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { can } = usePrivileges()
    return { t, navigate, can }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [filter, setFilter] = useState<ConsumerFilter>(this.initialFilter)
    this.publish({ filter, setFilter })
    const { data, isLoading, isError, refetch } = useStorageConsumers(filter, this.sort, this.limit)
    this.publish({ data, isLoading, isError, refetch })
    const rows = useMemo(() => data?.consumers ?? [], [data])
    this.publish({ rows })
    useAdminAction('set-quota', id => { if (this.canEdit && id) this.openQuota(id) })
    return { filter, setFilter, data, isLoading, isError, refetch, rows }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, navigate: s.navigate, can: s.can })
    const h = this.useHooks()
    this.publish({ filter: h.filter, setFilter: h.setFilter, data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch, rows: h.rows })
  }

  get initialFilter() {
    return this.props.initialFilter ?? 'all'
  }

  get canEdit(): boolean {
    return this.can(PRIV.USERS_UPDATE)
  }

  get columns(): DataTableColumn<Consumer>[] {
    return this.memo('columns', [this.tr, this.props], () => [
    {
      id: 'account',
      header: this.tr('admin.sto_col_account'),
      primary: true,
      required: true,
      minWidth: 200,
      sortValue: r => r.display_name?.trim() || r.username,
      cell: r => (
        <div className="min-w-0">
          <div className="truncate text-text-primary">{r.display_name?.trim() || r.username}</div>
          <div className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {r.email}
          </div>
        </div>
      ),
    },
    {
      id: 'unit',
      header: this.tr('admin.sto_col_unit'),
      sortValue: r => r.unit_name ?? '',
      cell: r => (
        <span className="text-text-secondary">{r.unit_name ?? this.tr('admin.sto_no_unit')}</span>
      ),
    },
    {
      id: 'used',
      header: this.tr('admin.sto_col_used'),
      align: 'right',
      sortValue: r => r.used_bytes,
      cell: r => <span className="tabular-nums text-text-primary">{formatBytes(r.used_bytes)}</span>,
    },
    {
      id: 'quota',
      header: this.tr('admin.sto_col_quota'),
      align: 'right',
      sortValue: r => r.quota_bytes,
      cell: r => <span className="tabular-nums text-text-secondary">{formatBytes(r.quota_bytes)}</span>,
    },
    {
      id: 'fill',
      header: this.tr('admin.sto_col_fill'),
      minWidth: 160,
      sortValue: r => (r.quota_bytes > 0 ? r.used_bytes / r.quota_bytes : 0),
      cell: r => (
        <ProgressBar
          value={r.used_bytes}
          max={Math.max(r.quota_bytes, 1)}
          size="sm"
          showValue
          // The amber/red thresholds are the instance's own, so the colour on
          // this row and the alert in the queue draw the line in one place.
          warnAt={this.props.warnPercent / 100}
          dangerAt={1}
          t={this.tr}
        />
      ),
    },
  ])
  }

  get rowActions(): DataTableRowAction<Consumer>[] {
    return this.memo('rowActions', [this.tr, this.inspecting, this.canEdit, this.navigate], () => [
    { id: 'detail', label: this.tr('admin.sto_action_detail'), onClick: r => this.inspecting = r },
    ...(this.canEdit
      ? [{ id: 'quota', label: this.tr('admin.sto_action_quota'), onClick: (r: Consumer) => this.openQuota(r.id) }]
      : []),
  ])
  }

  get part1_props() {
    return this.memo('part1_props', [this.rows, this.columns, this.isLoading, this.isError, this.tr, this.refetch, this.rowActions, this.memo, this.inspecting, this.filter, this.setFilter, this.sort], () => ({ rows: this.rows, columns: this.columns, isLoading: this.isLoading, isError: this.isError, t: this.tr, refetch: this.refetch, rowActions: this.rowActions, setInspecting: this.memo("setInspecting:bound", [], () => this.setInspecting.bind(this)), filter: this.filter, setFilter: this.setFilter, sort: this.sort, setSort: this.memo("setSort:bound", [], () => this.setSort.bind(this)) }))
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, onRetry, rowActions, onRowClick, filtered, onClearFilters, defaultSort, minTableWidth, t, toolbar, emptyState: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get show_data_scoped() {
    return !!(this.data?.scoped)
  }

  get show_rows_limit_limit() {
    return this.rows.length >= this.limit && this.limit < 200
  }

  get show_inspecting() {
    return this.memo('show_inspecting', [this.inspecting], () => !!(this.inspecting))
  }

  /** `<AccountUsageDialog>`, rendered by a ReactHost. */
  get AccountUsageDialog() {
    if (!(this.inspecting)) return undefined as never
    return AccountUsageDialog
  }

  get account_usage_dialog_props() {
    return this.memo('account_usage_dialog_props', [this.inspecting, this.canEdit, this.navigate], () => {
      if (!(this.inspecting)) return undefined as never
      const inspecting = this.inspecting
      return ({ account: inspecting, onClose: () => this.inspecting = null, onEditQuota: this.canEdit
            ? () => { const id = inspecting.id; this.inspecting = null; this.openQuota(id) }
            : undefined } as React.ComponentProps<typeof AccountUsageDialog>)
    })
  }

  openQuota(id: string) {
    return this.navigate(adminUrl({
      tab: 'users', action: 'set-quota', id,
      params: { user: id, pane: 'profile' },
    }))
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.rows.length >= this.limit && this.limit < 200)) return undefined as never
    this.limit = 200
  }

  /** `setInspecting` of the TSX: a value, or an update of the previous one. */
  setInspecting(value: Consumer | null | ((prev: Consumer | null) => Consumer | null)) {
    this.inspecting = typeof value === 'function' ? (value as (prev: Consumer | null) => Consumer | null)(this.inspecting) : value
  }

  /** `setSort` of the TSX: a value, or an update of the previous one. */
  setSort(value: ConsumerSort | ((prev: ConsumerSort) => ConsumerSort)) {
    this.sort = typeof value === 'function' ? (value as (prev: ConsumerSort) => ConsumerSort)(this.sort) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ConsumersCardStores = ReturnType<ConsumersCard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ConsumersCardHooks = ReturnType<ConsumersCard['useHooks']>

export default ConsumersCard.component()
