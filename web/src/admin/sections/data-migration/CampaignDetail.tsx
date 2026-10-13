/**
 * Code-behind of `CampaignDetail.kbcontrol` (converted from `CampaignDetail.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { RotateCw } from "lucide-react"
import { Button, useToast, type DataTableColumn } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../../core/hooks/useConfirm"
import { useAdminCrumbs } from "../../pages/AdminBreadcrumb"
import { errorMessage, useCampaignDetail, useDeleteCampaign, usePauseCampaign, useRetryAccount, useStartCampaign, type MigrationAccount } from "./api"

import { ViewBase } from './CampaignDetail.kbcontrol'
import * as __parts from './CampaignDetail.parts'
import { StatusChip } from './CampaignDetail.parts'

export type CampaignDetailProps = {
  campaignId: string
  canManage: boolean
  /** Called after a removal, so the page can return to the list. */
  onGone: () => void
}

export class CampaignDetail extends ViewBase {
  tr!: CampaignDetailStores['t']
  toast!: CampaignDetailStores['toast']
  confirm!: CampaignDetailStores['confirm']
  confirmState!: CampaignDetailStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: CampaignDetailHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: CampaignDetailHooks['refetch']
  start!: CampaignDetailStores['start']
  pause!: CampaignDetailStores['pause']
  retry!: CampaignDetailStores['retry']
  remove!: CampaignDetailStores['remove']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const start  = useStartCampaign()
    const pause  = usePauseCampaign()
    const retry  = useRetryAccount()
    const remove = useDeleteCampaign()
    return { t, toast, confirm, confirmState, handleConfirm, handleCancel, start, pause, retry, remove }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data, isLoading, isError, refetch } = useCampaignDetail(this.props.campaignId)
    this.publish({ data, isLoading, isError, refetch })
    useAdminCrumbs(this.campaign ? [{ label: this.campaign.name }] : [])
    return { data, isLoading, isError, refetch }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, start: s.start, pause: s.pause, retry: s.retry, remove: s.remove })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch })
  }

  get campaign() {
    return this.memo('campaign', [this.data], () => this.data?.campaign)
  }

  get accounts(): MigrationAccount[] {
    return this.memo('accounts', [this.data], () => this.data?.accounts ?? [])
  }

  get tally() {
    return this.memo('tally', [this.campaign, this.isLoading], () => {
      if (!(!(this.isLoading || !this.campaign))) return undefined as never
      return this.campaign.tally
    })
  }

  get progress(): number {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return this.tally.total > 0 ? Math.min(100, Math.round((this.tally.copied / this.tally.total) * 100)) : 0
  }

  get columns(): DataTableColumn<MigrationAccount>[] {
    return this.memo('columns', [this.tr, this.props, this.retry, this.toast, this.isLoading, this.campaign], () => {
      if (!(!(this.isLoading || !this.campaign))) return undefined as never
      return [
    {
      id: 'source',
      header: this.tr('admin.migr_col_source'),
      primary: true,
      minWidth: 200,
      sortValue: r => r.source_login,
      cell: r => <span className="truncate text-text-primary">{r.source_login}</span>,
    },
    {
      id: 'target',
      header: this.tr('admin.migr_col_target'),
      minWidth: 200,
      sortValue: r => r.target_email ?? '',
      cell: r => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-text-primary">{r.target_name || r.target_email || '—'}</span>
          {r.target_name && r.target_email && (
            <span className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {r.target_email}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'status',
      header: this.tr('admin.migr_col_status'),
      minWidth: 180,
      sortValue: r => r.status,
      cell: r => (
        <span className="flex min-w-0 flex-col">
          <StatusChip status={r.status} />
          {r.error && (
            <span className="truncate text-danger" style={{ fontSize: 'var(--kb-text-meta)' }} title={r.error}>
              {r.error}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'items',
      header: this.tr('admin.migr_col_items'),
      align: 'right',
      minWidth: 140,
      sortValue: r => r.items_copied,
      cell: r => (
        <span className="text-text-secondary">
          {r.items_total > 0
            ? this.tr('admin.migr_items_of', { copied: r.items_copied, total: r.items_total })
            : r.items_copied || '—'}
        </span>
      ),
    },
    {
      id: 'action',
      header: '',
      align: 'right',
      minWidth: 120,
      cell: r => (
        r.status === 'failed' && this.props.canManage
          ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={this.retry.isPending}
              onClick={e => {
                e.stopPropagation()
                this.retry.mutate(
                  { id: this.props.campaignId, accountId: r.id },
                  {
                    onSuccess: () => this.toast.success(this.tr('admin.migr_retry_queued')),
                    onError:   err => this.toast.error(errorMessage(err, this.tr('admin.migr_retry_failed'))),
                  },
                )
              }}
            >
              <RotateCw size={14} /> {this.tr('admin.migr_retry')}
            </Button>
          )
          : null
      ),
    },
  ]
    })
  }

  get show_case_1() {
    return !!(this.isLoading || !this.campaign)
  }

  get p_text() {
    if (!(this.isLoading || !this.campaign)) return undefined as never
    return this.isError ? this.tr('admin.migr_load_failed') : this.tr('admin.migr_loading')
  }

  get show_main() {
    return !(this.isLoading || !this.campaign)
  }

  get h1_text() {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return this.campaign.name
  }

  get migr_detail_sub_service() {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return this.tr(`admin.migr_service_${this.campaign.service}`)
  }

  get migr_detail_sub_host() {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return this.campaign.source_host
  }

  get show_campaign_status_running() {
    if (!(!(this.isLoading || !this.campaign)) || !(this.props.canManage)) return undefined as never
    return this.campaign.status === 'running'
  }

  get show_not_campaign_status_running() {
    if (!(!(this.isLoading || !this.campaign)) || !(this.props.canManage)) return undefined as never
    return !(this.campaign.status === 'running')
  }

  get part1_props() {
    return this.memo('part1_props', [this.pause, this.props, this.toast, this.tr, this.isLoading, this.campaign], () => {
      if (!(!(this.isLoading || !this.campaign)) || !(this.props.canManage) || !(this.campaign.status === 'running')) return undefined as never
      return ({ pause: this.pause, campaignId: this.props.campaignId, toast: this.toast, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part1() {
    if (!(!(this.isLoading || !this.campaign)) || !(this.props.canManage) || !(this.campaign.status === 'running')) return undefined as never
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.start, this.props, this.toast, this.tr, this.campaign, this.isLoading], () => {
      if (!(!(this.isLoading || !this.campaign)) || !(this.props.canManage) || !(!(this.campaign.status === 'running'))) return undefined as never
      return ({ start: this.start, campaignId: this.props.campaignId, toast: this.toast, t: this.tr, campaign: this.campaign })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part2() {
    if (!(!(this.isLoading || !this.campaign)) || !(this.props.canManage) || !(!(this.campaign.status === 'running'))) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.confirm, this.tr, this.campaign, this.remove, this.props, this.toast, this.isLoading], () => {
      if (!(!(this.isLoading || !this.campaign)) || !(this.props.canManage)) return undefined as never
      return ({ confirm: this.confirm, t: this.tr, campaign: this.campaign, remove: this.remove, campaignId: this.props.campaignId, toast: this.toast, onGone: this.props.onGone })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part3() {
    if (!(!(this.isLoading || !this.campaign)) || !(this.props.canManage)) return undefined as never
    return __parts.Part3
  }

  get show_campaign_error() {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return !!(this.campaign.error)
  }

  get callout_text() {
    if (!(!(this.isLoading || !this.campaign)) || !(this.campaign.error)) return undefined as never
    return this.campaign.error
  }

  get variant() {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return this.campaign.status === 'running' ? 'primary' : 'neutral'
  }

  get badge_text() {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return this.tr(`admin.migr_status_${this.campaign.status}`)
  }

  get show_campaign_since_date() {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return !!(this.campaign.since_date)
  }

  get migr_since_summary_date() {
    if (!(!(this.isLoading || !this.campaign)) || !(this.campaign.since_date)) return undefined as never
    return this.campaign.since_date
  }

  get show_campaign_exclude_folders() {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return this.campaign.exclude_folders.length > 0
  }

  get migr_excluded_summary_folders() {
    if (!(!(this.isLoading || !this.campaign)) || !(this.campaign.exclude_folders.length > 0)) return undefined as never
    return this.campaign.exclude_folders.join(', ')
  }

  get span_text() {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return this.tally.total > 0
              ? this.tr('admin.migr_items_progress', { copied: this.tally.copied, total: this.tally.total })
              : this.tr('admin.migr_items_unknown', { copied: this.tally.copied })
  }

  get part4_props() {
    return this.memo('part4_props', [this.tr, this.accounts, this.columns, this.isError, this.refetch, this.isLoading, this.campaign], () => {
      if (!(!(this.isLoading || !this.campaign))) return undefined as never
      return ({ t: this.tr, accounts: this.accounts, columns: this.columns, isError: this.isError, refetch: this.refetch })
    })
  }

  /** A part of the screen still written in React (<DataTable> t, columns, rowKey, onRetry: no .kbview property). */
  get Part4() {
    if (!(!(this.isLoading || !this.campaign))) return undefined as never
    return __parts.Part4
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.isLoading, this.campaign], () => {
      if (!(!(this.isLoading || !this.campaign))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.isLoading || !this.campaign)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.isLoading, this.campaign], () => {
      if (!(!(this.isLoading || !this.campaign)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type CampaignDetailStores = ReturnType<CampaignDetail['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type CampaignDetailHooks = ReturnType<CampaignDetail['useHooks']>

export default CampaignDetail.component()
