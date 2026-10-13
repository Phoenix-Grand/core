/**
 * Code-behind of `DataMigrationSection.kbview` (converted from `DataMigrationSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import { Badge, type DataTableColumn, type DataTableRowAction } from "@ui"
import { usePrivileges } from "../../../authz/usePrivileges"
import type { AdminSectionProps } from "../registry"
import { adminUrlWith } from "../../adminAction"
import { DATA_MIGRATION_MANAGE } from "./privileges"
import CampaignWizard from "./CampaignWizard"
import { useCampaigns, type Campaign } from "./api"

import { ViewBase } from './DataMigrationSection.kbview'
import * as __parts from './DataMigrationSection.parts'

export type { AdminSectionProps }

export class DataMigrationSection extends ViewBase {
  @bind accessor composing = false
  tr!: DataMigrationSectionStores['t']
  can!: DataMigrationSectionStores['can']
  data!: DataMigrationSectionStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: DataMigrationSectionStores['refetch']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t }   = useTranslation()
    const { can } = usePrivileges()
    const { data, isLoading, isError, refetch } = useCampaigns()
    return { t, can, data, isLoading, isError, refetch }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch })
  }

  get canManage(): boolean {
    return this.can(DATA_MIGRATION_MANAGE)
  }

  get selected(): string | null {
    return this.props.params.get('campaign')
  }

  get campaigns(): Campaign[] {
    return this.memo('campaigns', [this.data, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return this.data?.campaigns ?? []
    })
  }

  get services() {
    return this.memo('services', [this.data, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return this.data?.services ?? []
    })
  }

  get noService(): boolean {
    if (!(!(this.selected))) return undefined as never
    return this.services.length > 0 && this.services.every(s => !s.available)
  }

  get columns(): DataTableColumn<Campaign>[] {
    return this.memo('columns', [this.tr, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return [
    {
      id: 'name',
      header: this.tr('admin.migr_col_campaign'),
      primary: true,
      minWidth: 220,
      sortValue: r => r.name,
      cell: r => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-text-primary">{r.name}</span>
          <span className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {r.source_host}
          </span>
        </span>
      ),
    },
    {
      id: 'service',
      header: this.tr('admin.migr_col_service'),
      sortValue: r => r.service,
      cell: r => <Badge variant="neutral">{this.tr(`admin.migr_service_${r.service}`)}</Badge>,
    },
    {
      id: 'accounts',
      header: this.tr('admin.migr_col_accounts'),
      minWidth: 200,
      sortValue: r => r.tally.done,
      cell: r => (
        <span className="flex min-w-0 flex-col">
          <span className="text-text-primary">
            {this.tr('admin.migr_accounts_done', { done: r.tally.done, total: r.tally.accounts })}
          </span>
          {r.tally.failed > 0 && (
            <span className="flex items-center gap-1.5 text-danger" style={{ fontSize: 'var(--kb-text-meta)' }}>
              <AlertTriangle size={12} /> {this.tr('admin.migr_accounts_failed', { count: r.tally.failed })}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'items',
      header: this.tr('admin.migr_col_items'),
      align: 'right',
      sortValue: r => r.tally.copied,
      cell: r => <span className="text-text-secondary">{r.tally.copied || '—'}</span>,
    },
    {
      id: 'status',
      header: this.tr('admin.migr_col_status'),
      minWidth: 160,
      sortValue: r => r.status,
      cell: r => (
        r.status === 'running'
          ? (
            <span className="flex items-center gap-1.5 text-primary">
              <Loader2 size={14} className="animate-spin" /> {this.tr('admin.migr_status_running')}
            </span>
          )
          : r.status === 'done'
            ? (
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 size={14} /> {this.tr('admin.migr_status_done')}
              </span>
            )
            : (
              <span className="text-text-secondary">{this.tr(`admin.migr_status_${r.status}`)}</span>
            )
      ),
    },
  ]
    })
  }

  get rowActions(): DataTableRowAction<Campaign>[] {
    return this.memo('rowActions', [this.tr, this.props, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return [
    { id: 'open', label: this.tr('admin.migr_action_open'), onClick: r => this.open(r.id) },
  ]
    })
  }

  get show_case_1() {
    return !!(this.selected)
  }

  /** `<CampaignDetail CampaignId>`: the selected campaign id, once known. */
  get campaignId() {
    if (!(this.selected)) return undefined as never
    return this.selected
  }

  get show_main() {
    return !(this.selected)
  }

  get part1_props() {
    return this.memo('part1_props', [this.noService, this.memo, this.composing, this.tr, this.selected, this.canManage], () => {
      if (!(!(this.selected)) || !(this.canManage)) return undefined as never
      return ({ noService: this.noService, setComposing: this.memo("setComposing:bound", [], () => this.setComposing.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part1() {
    if (!(!(this.selected)) || !(this.canManage)) return undefined as never
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.campaigns, this.columns, this.isLoading, this.rowActions, this.memo, this.props, this.isError, this.refetch, this.canManage, this.noService, this.composing, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return ({ t: this.tr, campaigns: this.campaigns, columns: this.columns, isLoading: this.isLoading, rowActions: this.rowActions, open: this.memo("open:bound", [], () => this.open.bind(this)), isError: this.isError, refetch: this.refetch, canManage: this.canManage, noService: this.noService, setComposing: this.memo("setComposing:bound", [], () => this.setComposing.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<DataTable> t, columns, rowKey, rowActions, onRowClick, onRetry, emptyState: no .kbview property). */
  get Part2() {
    if (!(!(this.selected))) return undefined as never
    return __parts.Part2
  }

  /** `<CampaignWizard>`, rendered by a ReactHost. */
  get CampaignWizard() {
    if (!(!(this.selected)) || !(this.composing)) return undefined as never
    return CampaignWizard
  }

  get campaign_wizard_props() {
    return this.memo('campaign_wizard_props', [this.services, this.composing, this.props, this.selected], () => {
      if (!(!(this.selected)) || !(this.composing)) return undefined as never
      return ({ services: this.services, onClose: () => this.composing = false, onCreated: c => { this.composing = false; this.open(c.id) } } as React.ComponentProps<typeof CampaignWizard>)
    })
  }

  open(id: string | null) {
    return this.props.navigate(adminUrlWith('data-migration', this.props.params, { campaign: id }))
  }

  /** `<CampaignDetail OnGone>`: the detail asked to return to the list. */
  campaign_detail_gone(_sender: unknown, _e: EventArgs) {
    this.open(null)
  }

  /** `setComposing` of the TSX: a value, or an update of the previous one. */
  setComposing(value: DataMigrationSection['composing'] | ((prev: DataMigrationSection['composing']) => DataMigrationSection['composing'])) {
    this.composing = typeof value === 'function' ? (value as (prev: DataMigrationSection['composing']) => DataMigrationSection['composing'])(this.composing) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DataMigrationSectionStores = ReturnType<DataMigrationSection['useStores']>

export default DataMigrationSection.component()
