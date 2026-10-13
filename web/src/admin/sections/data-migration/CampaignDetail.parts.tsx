/**
 * The parts of `CampaignDetail.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { AlertTriangle, CheckCircle2, Clock, Loader2, Pause, Play, Trash2 } from "lucide-react"
import { Button, DataTable } from "@ui"
import { errorMessage, type MigrationAccount } from "./api"
import type { CampaignDetail } from './CampaignDetail'

function StatusChip({ status }: { status: MigrationAccount['status'] }) {
  const { t } = useTranslation()
  const label = t(`admin.migr_acc_status_${status}`)
  if (status === 'done') {
    return (
      <span className="flex items-center gap-1.5 text-success">
        <CheckCircle2 size={14} /> {label}
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="flex items-center gap-1.5 text-danger">
        <AlertTriangle size={14} /> {label}
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="flex items-center gap-1.5 text-primary">
        <Loader2 size={14} className="animate-spin" /> {label}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5 text-text-tertiary">
      <Clock size={14} /> {label}
    </span>
  )
}
export { StatusChip }

export function Part1({ pause, campaignId, toast, t }: { pause: NonNullable<CampaignDetail['pause']>; campaignId: NonNullable<CampaignDetail['props']['campaignId']>; toast: NonNullable<CampaignDetail['toast']>; t: NonNullable<CampaignDetail['tr']> }) {
  return (
    <Button
                    variant="secondary"
                    disabled={pause.isPending}
                    onClick={() => pause.mutate(campaignId, {
                      onError: err => toast.error(errorMessage(err, t('admin.migr_save_failed'))),
                    })}
                  >
                    <Pause size={16} /> {t('admin.migr_pause')}
                  </Button>
  )
}

export function Part2({ start, campaignId, toast, t, campaign }: { start: NonNullable<CampaignDetail['start']>; campaignId: NonNullable<CampaignDetail['props']['campaignId']>; toast: NonNullable<CampaignDetail['toast']>; t: NonNullable<CampaignDetail['tr']>; campaign: NonNullable<CampaignDetail['campaign']> }) {
  return (
    <Button
                    variant="primary"
                    disabled={start.isPending}
                    onClick={() => start.mutate(campaignId, {
                      onError: err => toast.error(errorMessage(err, t('admin.migr_save_failed'))),
                    })}
                  >
                    <Play size={16} /> {campaign.started_at ? t('admin.migr_resume') : t('admin.migr_start')}
                  </Button>
  )
}

export function Part3({ confirm, t, campaign, remove, campaignId, toast, onGone }: { confirm: NonNullable<CampaignDetail['confirm']>; t: NonNullable<CampaignDetail['tr']>; campaign: NonNullable<CampaignDetail['campaign']>; remove: NonNullable<CampaignDetail['remove']>; campaignId: NonNullable<CampaignDetail['props']['campaignId']>; toast: NonNullable<CampaignDetail['toast']>; onGone: NonNullable<CampaignDetail['props']['onGone']> }) {
  return (
    <Button
                  variant="ghost"
                  onClick={() => void confirm({
                    title:   t('admin.migr_delete_title'),
                    message: t('admin.migr_delete_message', { name: campaign.name }),
                    confirmLabel: t('admin.migr_delete'),
                    variant: 'danger',
                  }).then(ok => {
                    if (!ok) return
                    remove.mutate(campaignId, {
                      onSuccess: () => { toast.success(t('admin.migr_deleted')); onGone() },
                      onError:   err => toast.error(errorMessage(err, t('admin.migr_save_failed'))),
                    })
                  })}
                >
                  <Trash2 size={16} /> {t('admin.migr_delete')}
                </Button>
  )
}

export function Part4({ t, accounts, columns, isError, refetch }: { t: NonNullable<CampaignDetail['tr']>; accounts: NonNullable<CampaignDetail['accounts']>; columns: NonNullable<CampaignDetail['columns']>; isError: NonNullable<CampaignDetail['isError']>; refetch: NonNullable<CampaignDetail['refetch']> }) {
  return (
    <DataTable<MigrationAccount>
            t={t}
            rows={accounts}
            columns={columns}
            rowKey={r => r.id}
            pageSize={25}
            error={isError ? t('admin.migr_load_failed') : undefined}
            onRetry={() => void refetch()}
          />
  )
}
