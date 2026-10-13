/**
 * The parts of `DataExportSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { AlertTriangle, Ban, CheckCircle2, Clock, Download, FileArchive, ShieldAlert, Trash2, XCircle } from "lucide-react"
import { Badge, Button, Callout, Card, DataTable, EmptyState, ProgressBar, type DataTableColumn, type DataTableRowAction } from "@ui"
import { formatBytes, formatDuration, formatWhen } from "../format"
import { signedUrl } from "../../../core/api/signedUrl"
import { downloadUrl, type DataExportOverview, type ExportRun } from "./api"
const STATUS_SKIN: Record<string, 'neutral' | 'primary' | 'success' | 'warning' | 'danger'> = {
  pending:   'neutral',
  running:   'primary',
  ready:     'success',
  failed:    'danger',
  cancelled: 'warning',
  expired:   'neutral',
}

function Eligibility({ data, canExecute }: { data: DataExportOverview; canExecute: boolean }) {
  const { t } = useTranslation()

  if (!canExecute) {
    return (
      <Callout variant="info" icon={<ShieldAlert size={16} />} t={t}>
        {t('admin.dx_no_privilege')}
      </Callout>
    )
  }
  if (data.eligibility.ok) return null

  return (
    <Callout variant="warning" title={t('admin.dx_blocked_title')} t={t}>
      <ul className="ml-4 list-disc space-y-1">
        {data.eligibility.blockers.map(b => (
          <li key={b.reason}>
            {t(`admin.dx_blocker_${b.reason}`, {
              days:     b.days ?? 0,
              required: b.required ?? 0,
              detail:   b.detail ?? '',
              defaultValue: b.reason,
            })}
          </li>
        ))}
      </ul>
    </Callout>
  )
}
export { Eligibility }

function ActiveRun({ data, canExecute, onCancel, busy }: {
  data:       DataExportOverview
  canExecute: boolean
  onCancel:   (id: string) => void
  busy:       boolean
}) {
  const { t, i18n } = useTranslation()
  const run = data.active
  if (!run) return null

  const progress = data.progress
  return (
    <div className="rounded-lg border border-border bg-surface-1 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
            <Clock size={15} className="shrink-0 text-primary" />
            {t('admin.dx_running_title', { who: run.actor_label ?? '—' })}
          </span>
          <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {t('admin.dx_running_desc', {
              count: run.subjects_total,
              when:  formatWhen(run.available_at, i18n.language),
            })}
          </span>
        </span>
        {canExecute && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Ban size={15} />}
            loading={busy}
            onClick={() => onCancel(run.id)}
          >
            {t('admin.dx_cancel')}
          </Button>
        )}
      </div>
      <div className="mt-3">
        <ProgressBar
          value={progress?.subjects_done ?? 0}
          max={Math.max(progress?.subjects_total ?? 1, 1)}
          variant="primary"
          label={t('admin.dx_progress', {
            done:  progress?.subjects_done ?? 0,
            total: progress?.subjects_total ?? 0,
          })}
          showValue
        />
      </div>
    </div>
  )
}
export { ActiveRun }

function Coverage({ data }: { data: DataExportOverview }) {
  const { t } = useTranslation()
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-lg border border-border bg-surface-1 p-3">
        <p className="text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {t('admin.dx_covers_title')}
        </p>
        <ul className="mt-1.5 space-y-1">
          {data.covers.map(id => (
            <li key={id} className="flex items-start gap-1.5 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />
              <span className="min-w-0">{t(`admin.dx_cov_${id}`, { defaultValue: id })}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-lg border border-border bg-surface-1 p-3">
        <p className="text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {t('admin.dx_not_covers_title')}
        </p>
        <ul className="mt-1.5 space-y-1">
          {data.not_covers.map(id => (
            <li key={id} className="flex items-start gap-1.5 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              <XCircle size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
              <span className="min-w-0">{t(`admin.dx_ncov_${id}`, { defaultValue: id })}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
export { Coverage }

function PolicySummary({ data }: { data: DataExportOverview }) {
  const { t } = useTranslation()
  const p = data.policy
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
      <Fact label={t('admin.dx_fact_hold')}      value={t('admin.dx_hours', { count: p.hold_hours })} />
      <Fact label={t('admin.dx_fact_retention')} value={t('admin.dx_days', { count: p.retention_days })} />
      <Fact label={t('admin.dx_fact_accounts')}  value={String(data.active_accounts)} />
      <Fact label={t('admin.dx_fact_destination')} value={p.destination} mono />
    </div>
  )
}
export { PolicySummary }

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>{label}</span>
      <span
        className={`min-w-0 break-words text-text-primary ${mono ? 'font-mono' : ''}`}
        style={{ fontSize: 'var(--kb-text-body)' }}
      >
        {value}
      </span>
    </span>
  )
}
export { Fact }

function History({ data, canExecute, onOpen, onCancel, onDelete }: {
  data:       DataExportOverview
  canExecute: boolean
  onOpen:     (id: string) => void
  onCancel:   (id: string) => void
  onDelete:   (run: ExportRun) => void
}) {
  const { t, i18n } = useTranslation()
  const now = Date.parse(data.now)

  /** Is this archive fetchable right now? The four conditions, in one place. */
  const fetchable = (r: ExportRun) =>
    r.status === 'ready'
    && !r.file_deleted
    && now >= Date.parse(r.available_at)
    && now < Date.parse(r.expires_at)

  const columns: DataTableColumn<ExportRun>[] = [
    {
      id: 'requested_at',
      header: t('admin.dx_col_when'),
      primary: true,
      minWidth: 190,
      sortValue: r => r.requested_at,
      cell: r => (
        <span className="flex min-w-0 flex-col">
          <span className="whitespace-nowrap text-text-primary">
            {formatWhen(r.requested_at, i18n.language)}
          </span>
          <span className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {r.actor_label ?? '—'}
          </span>
        </span>
      ),
    },
    {
      id: 'scope',
      header: t('admin.dx_col_scope'),
      minWidth: 150,
      sortValue: r => r.subjects_total,
      cell: r => (
        <span className="flex min-w-0 flex-col">
          <span className="text-text-primary">
            {r.scope === 'instance' ? t('admin.dx_scope_instance') : t('admin.dx_scope_accounts')}
          </span>
          <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {t('admin.dx_accounts', { count: r.subjects_total })}
          </span>
        </span>
      ),
    },
    {
      id: 'status',
      header: t('admin.dx_col_status'),
      minWidth: 200,
      sortValue: r => r.status,
      cell: r => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>
            <Badge variant={STATUS_SKIN[r.status] ?? 'neutral'}>
              {t(`admin.dx_status_${r.status}`, { defaultValue: r.status })}
            </Badge>
          </span>
          <span className="min-w-0 break-words text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {r.status === 'running' || r.status === 'pending'
              ? t('admin.dx_state_progress', { done: r.subjects_done, total: r.subjects_total })
              : r.status === 'ready' && !r.file_deleted && now < Date.parse(r.available_at)
                ? t('admin.dx_state_held', { when: formatWhen(r.available_at, i18n.language) })
                : r.status === 'ready' && !r.file_deleted
                  ? t('admin.dx_state_until', { when: formatWhen(r.expires_at, i18n.language) })
                  : r.file_deleted
                    ? t('admin.dx_state_deleted')
                    : r.error ?? ''}
          </span>
        </span>
      ),
    },
    {
      id: 'size',
      header: t('admin.dx_col_size'),
      align: 'right',
      minWidth: 100,
      sortValue: r => r.size_bytes ?? -1,
      cell: r => (r.size_bytes == null ? '—' : formatBytes(r.size_bytes)),
    },
    {
      id: 'downloads',
      header: t('admin.dx_col_downloads'),
      align: 'right',
      minWidth: 110,
      sortValue: r => r.download_count,
      cell: r => (
        <span className={r.download_count > 0 ? 'text-text-primary' : 'text-text-tertiary'}>
          {r.download_count}
        </span>
      ),
    },
    {
      id: 'duration',
      header: t('admin.dx_col_duration'),
      align: 'right',
      minWidth: 100,
      defaultHidden: true,
      sortValue: r => r.duration_ms ?? -1,
      cell: r => (r.duration_ms == null ? '—' : formatDuration(r.duration_ms)),
    },
    {
      id: 'entries',
      header: t('admin.dx_col_entries'),
      align: 'right',
      minWidth: 100,
      defaultHidden: true,
      sortValue: r => r.entries_count ?? -1,
      cell: r => (r.entries_count == null ? '—' : String(r.entries_count)),
    },
  ]

  const actions: DataTableRowAction<ExportRun>[] = [
    {
      id: 'download',
      label: t('admin.dx_download'),
      icon: <Download size={15} />,
      hidden: r => !fetchable(r),
      // A full-page navigation, not an XHR: the browser streams the archive to
      // disk with its own progress and its own resume, and nothing of it ever
      // sits in this tab's memory.
      // It cannot send the Authorization header, so the URL carries a signed
      // ticket bound to this export (reusable for its few minutes: the browser
      // may retry).
      onClick: r => { void signedUrl(downloadUrl(r.id), { purpose: 'download' }).then(u => { window.location.href = u }) },
    },
    {
      id: 'subjects',
      label: t('admin.dx_see_accounts'),
      icon: <FileArchive size={15} />,
      onClick: r => onOpen(r.id),
    },
    {
      id: 'cancel',
      label: t('admin.dx_cancel'),
      icon: <Ban size={15} />,
      danger: true,
      hidden: r => !canExecute || (r.status !== 'pending' && r.status !== 'running'),
      onClick: r => onCancel(r.id),
    },
    {
      id: 'delete',
      label: t('admin.dx_delete'),
      icon: <Trash2 size={15} />,
      danger: true,
      hidden: r => !canExecute || r.file_deleted || r.status !== 'ready',
      onClick: r => onDelete(r),
    },
  ]

  return (
    <Card
      className="mt-4"
      flush
      icon={<FileArchive size={18} />}
      title={t('admin.dx_history_title')}
      subtitle={t('admin.dx_history_sub')}
    >
      <DataTable
        rows={data.history}
        columns={columns}
        rowKey={r => r.id}
        rowActions={actions}
        defaultSort={null}
        pageSize={0}
        minTableWidth={900}
        configurableColumns
        t={t}
        emptyState={(
          <EmptyState
            icon={<AlertTriangle size={26} />}
            title={t('admin.dx_history_empty')}
            description={t('admin.dx_history_empty_desc')}
            compact
            t={t}
          />
        )}
      />
    </Card>
  )
}
export { History }
