/**
 * The parts of `BackupPanel.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Archive, CheckCircle2, Clock, DatabaseBackup, HardDriveDownload, PlayCircle, RotateCcw, ShieldCheck, XCircle } from "lucide-react"
import { Button, Callout, Card, DataTable, EmptyState, useToast, type DataTableColumn } from "@ui"
import { prompt } from "../../core/store/promptStore"
import { useAdminAction } from "../adminAction"
import { formatBytes, formatDuration, formatWhen } from "../sections/format"
import { errorMessage, useBackupFiles, useDeclareRestoreTest, useRestoreBackup, type BackupFile, type BackupOverview, type BackupRun } from "./api"
import type { BackupPanel } from './BackupPanel'
function statusIcon(run: BackupRun) {
  if (run.status === 'success') return <CheckCircle2 size={15} className="text-success" />
  if (run.status === 'failed') return <XCircle size={15} className="text-danger" />
  return <Clock size={15} className="text-text-tertiary" />
}

function StatusBanner({ data }: { data: BackupOverview }) {
  const { t, i18n } = useTranslation()
  const { policy, stats, running } = data

  if (running) {
    return (
      <Callout variant="info" title={t('admin.bk_state_running')} t={t}>
        {t('admin.bk_state_running_desc')}
      </Callout>
    )
  }

  if (!stats.last_success_at) {
    // Two different sentences, because they need two different actions: nobody
    // has armed a policy, versus a policy that is armed and has produced
    // nothing yet.
    return (
      <Callout
        variant={policy.enabled ? 'warning' : 'danger'}
        title={policy.enabled ? t('admin.bk_state_pending') : t('admin.bk_state_none')}
        t={t}
      >
        {policy.enabled ? t('admin.bk_state_pending_desc') : t('admin.bk_state_none_desc')}
      </Callout>
    )
  }

  const ageDays = Math.floor(
    (Date.now() - new Date(stats.last_success_at).getTime()) / 86_400_000,
  )
  const stale = ageDays > policy.stale_after_days
  const failing = stats.last_status === 'failed'

  if (failing) {
    return (
      <Callout variant="danger" title={t('admin.bk_state_failed')} t={t}>
        <p>{t('admin.bk_state_failed_desc', { count: stats.consecutive_failures })}</p>
        {stats.last_error && (
          <p className="mt-1 break-words font-mono" style={{ fontSize: 'var(--kb-text-micro)' }}>
            {stats.last_error}
          </p>
        )}
        <p className="mt-1">
          {t('admin.bk_state_last_ok', {
            when: formatWhen(stats.last_success_at, i18n.language),
          })}
        </p>
      </Callout>
    )
  }

  // A backup taken this morning with the schedule switched off is a countdown,
  // not a protection. It gets its own sentence rather than borrowing the "too
  // old" one, which would read as false today and only become true in three days.
  if (!policy.enabled) {
    return (
      <Callout variant="warning" title={t('admin.bk_state_off')} t={t}>
        {t('admin.bk_state_off_desc', {
          when: formatWhen(stats.last_success_at, i18n.language),
        })}
      </Callout>
    )
  }

  if (stale) {
    return (
      <Callout variant="warning" title={t('admin.bk_state_stale')} t={t}>
        {t('admin.bk_state_stale_desc', {
          when: formatWhen(stats.last_success_at, i18n.language),
          count: policy.stale_after_days,
        })}
      </Callout>
    )
  }

  return (
    <Callout variant="success" title={t('admin.bk_state_ok')} t={t}>
      {t('admin.bk_state_ok_desc', {
        when: formatWhen(stats.last_success_at, i18n.language),
        size: formatBytes(stats.last_success_bytes ?? 0),
      })}
    </Callout>
  )
}
export { StatusBanner }

function Coverage({ data }: { data: BackupOverview }) {
  const { t } = useTranslation()
  return (
    <Callout variant="info" title={t('admin.bk_coverage_title')} icon={<Archive size={16} />} t={t}>
      <p>{t('admin.bk_coverage_intro', { count: data.schemas.length })}</p>
      {data.schemas.length > 0 && (
        <p className="mt-1 break-words font-mono text-text-secondary" style={{ fontSize: 'var(--kb-text-micro)' }}>
          {data.schemas.join(' · ')}
        </p>
      )}
      <ul className="mt-1.5 list-disc pl-4 space-y-0.5">
        {data.covers.map(id => (
          <li key={id}>{t(`admin.bk_cov_${id}`)}</li>
        ))}
      </ul>
      <p className="mt-2 font-medium">{t('admin.bk_coverage_not')}</p>
      <ul className="mt-1 list-disc pl-4 space-y-0.5">
        {data.not_covers.map(id => (
          <li key={id}>{t(`admin.bk_notcov_${id}`)}</li>
        ))}
      </ul>
    </Callout>
  )
}
export { Coverage }

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>{label}</div>
      <div className="min-w-0 break-words text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
        {value}
      </div>
    </div>
  )
}
export { Fact }

function PolicySummary({ data }: { data: BackupOverview }) {
  const { t, i18n } = useTranslation()
  const { policy } = data
  const hour = `${String(policy.hour_utc).padStart(2, '0')}:00 UTC`

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
      <Fact
        label={t('admin.bk_fact_schedule')}
        value={
          policy.enabled
            ? t(policy.frequency === 'weekly' ? 'admin.bk_sched_weekly' : 'admin.bk_sched_daily', { hour })
            : t('admin.bk_sched_off')
        }
      />
      <Fact
        label={t('admin.bk_fact_next')}
        value={data.next_run_at ? formatWhen(data.next_run_at, i18n.language) : '-'}
      />
      <Fact
        label={t('admin.bk_fact_retention')}
        value={t('admin.bk_retention_value', { count: policy.retention_count })}
      />
      <Fact label={t('admin.bk_fact_destination')} value={policy.destination} />
    </div>
  )
}
export { PolicySummary }

function RestoreDrill({ data, canManage }: { data: BackupOverview; canManage: boolean }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const declare = useDeclareRestoreTest()
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)

  useAdminAction('declare-restore-test', () => {
    if (canManage) setOpen(true)
  })

  const submit = (clear: boolean) => {
    declare.mutate(
      clear ? { clear: true } : { note: note.trim() || undefined },
      {
        onSuccess: () => {
          setOpen(false)
          setNote('')
          toast.success(clear ? t('admin.bk_drill_cleared') : t('admin.bk_drill_saved'))
        },
        onError: e => toast.error(errorMessage(e, t('admin.bk_drill_failed'))),
      },
    )
  }

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
            <ShieldCheck size={16} className="shrink-0 text-text-secondary" />
            {t('admin.bk_drill_title')}
          </div>
          {/* The label the whole feature hangs on. Never softened, never removed:
              the platform verifies nothing here and must not look as if it did. */}
          <p className="mt-1 max-w-2xl text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {t('admin.bk_drill_declarative')}
          </p>
          <p className="mt-1 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {data.restore_test.at
              ? t('admin.bk_drill_last', { when: formatWhen(data.restore_test.at, i18n.language) })
              : t('admin.bk_drill_never')}
          </p>
        </div>
        {canManage && !open && (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {t('admin.bk_drill_declare')}
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-3 border-t border-border pt-3">
          <label
            className="block text-text-secondary"
            style={{ fontSize: 'var(--kb-text-meta)' }}
            htmlFor="bk-drill-note"
          >
            {t('admin.bk_drill_note_label')}
          </label>
          <input
            id="bk-drill-note"
            type="text"
            value={note}
            maxLength={500}
            onChange={e => setNote(e.target.value)}
            placeholder={t('admin.bk_drill_note_ph')}
            className="mt-1 w-full rounded-lg border border-border bg-surface-0 px-2.5 py-1.5 text-text-primary outline-none focus:border-primary"
            style={{ fontSize: 'var(--kb-text-body)' }}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" loading={declare.isPending} onClick={() => submit(false)}>
              {t('admin.bk_drill_confirm')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setNote('') }}>
              {t('common.cancel')}
            </Button>
            {data.restore_test.at && (
              <Button variant="ghost" size="sm" onClick={() => submit(true)}>
                {t('admin.bk_drill_clear')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
export { RestoreDrill }

function History({ data, loading }: { data: BackupOverview | undefined; loading: boolean }) {
  const { t, i18n } = useTranslation()

  const columns: DataTableColumn<BackupRun>[] = [
    {
      id: 'started_at',
      header: t('admin.bk_col_when'),
      minWidth: 160,
      sortValue: r => r.started_at,
      cell: r => (
        <span className="whitespace-nowrap">{formatWhen(r.started_at, i18n.language)}</span>
      ),
      primary: true,
    },
    {
      id: 'status',
      header: t('admin.bk_col_status'),
      minWidth: 120,
      sortValue: r => r.status,
      cell: r => (
        <span className="inline-flex items-center gap-1.5">
          {statusIcon(r)}
          {t(`admin.bk_status_${r.status}`)}
        </span>
      ),
    },
    {
      id: 'trigger',
      header: t('admin.bk_col_trigger'),
      minWidth: 130,
      sortValue: r => r.trigger_kind,
      cell: r =>
        r.trigger_kind === 'manual'
          ? t('admin.bk_trigger_manual', { who: r.actor_label || t('admin.bk_unknown_actor') })
          : t('admin.bk_trigger_scheduled'),
    },
    {
      id: 'size',
      header: t('admin.bk_col_size'),
      align: 'right',
      minWidth: 100,
      sortValue: r => r.size_bytes ?? -1,
      cell: r => (r.size_bytes == null ? '-' : formatBytes(r.size_bytes)),
    },
    {
      id: 'rows',
      header: t('admin.bk_col_rows'),
      align: 'right',
      minWidth: 110,
      defaultHidden: true,
      sortValue: r => r.rows_count ?? -1,
      cell: r =>
        r.rows_count == null
          ? '-'
          : t('admin.bk_rows_value', { rows: r.rows_count, tables: r.tables_count ?? 0 }),
    },
    {
      id: 'duration',
      header: t('admin.bk_col_duration'),
      align: 'right',
      minWidth: 100,
      sortValue: r => r.duration_ms ?? -1,
      cell: r => (r.duration_ms == null ? '-' : formatDuration(r.duration_ms)),
    },
    {
      id: 'file',
      header: t('admin.bk_col_file'),
      minWidth: 240,
      cell: r =>
        r.status === 'failed' ? (
          <span className="break-words text-danger" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {r.error ?? t('admin.bk_no_detail')}
          </span>
        ) : r.file_name ? (
          <span className="break-all font-mono" style={{ fontSize: 'var(--kb-text-micro)' }}>
            {r.file_name}
            {r.file_pruned && (
              <span className="ml-1.5 font-sans text-text-tertiary">
                {t('admin.bk_file_pruned')}
              </span>
            )}
          </span>
        ) : (
          '-'
        ),
    },
  ]

  return (
    <Card
      className="mt-4"
      flush
      icon={<DatabaseBackup size={18} />}
      title={t('admin.bk_history_title')}
      subtitle={t('admin.bk_history_sub')}
    >
      <DataTable
        rows={data?.history ?? []}
        columns={columns}
        rowKey={r => r.id}
        loading={loading}
        defaultSort={null}
        pageSize={0}
        minTableWidth={860}
        configurableColumns
        t={t}
        emptyState={
          <EmptyState
            icon={<DatabaseBackup size={26} />}
            title={t('admin.bk_history_empty')}
            description={t('admin.bk_history_empty_desc')}
            compact
            t={t}
          />
        }
      />
    </Card>
  )
}
export { History }

function RestoreFiles({ canRestore }: { canRestore: boolean }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const files = useBackupFiles(canRestore)
  const restore = useRestoreBackup()
  const [busy, setBusy] = useState<string | null>(null)

  // Only a super-user reaches this control; the endpoint re-checks anyway.
  if (!canRestore) return null

  const askAndRestore = async (file: BackupFile) => {
    // Strong confirmation: retype the exact file name. A restore replaces every
    // row of every schema, so a single click must never be enough.
    const typed = await prompt({
      title:        t('admin.bk_restore_confirm_title'),
      message:      t('admin.bk_restore_confirm_msg', { name: file.name }),
      placeholder:  file.name,
      confirmLabel: t('admin.bk_restore_confirm_btn'),
      cancelLabel:  t('common.cancel'),
    })
    if (typed === null) return
    if (typed.trim() !== file.name) {
      toast.error(t('admin.bk_restore_mismatch'))
      return
    }
    setBusy(file.name)
    restore.mutate(
      { file_name: file.name, confirm: file.name },
      {
        onSuccess: r => toast.success(t('admin.bk_restore_ok', { rows: r.rows, safety: r.safety_file })),
        onError:   e => toast.error(errorMessage(e, t('admin.bk_restore_failed'))),
        onSettled: () => setBusy(null),
      },
    )
  }

  const columns: DataTableColumn<BackupFile>[] = [
    {
      id: 'name',
      header: t('admin.bk_files_col_name'),
      minWidth: 280,
      sortValue: r => r.name,
      cell: r => <span className="break-all font-mono" style={{ fontSize: 'var(--kb-text-micro)' }}>{r.name}</span>,
      primary: true,
    },
    {
      id: 'modified_at',
      header: t('admin.bk_files_col_when'),
      minWidth: 150,
      sortValue: r => r.modified_at ?? '',
      cell: r => (r.modified_at ? formatWhen(r.modified_at, i18n.language) : '-'),
    },
    {
      id: 'size',
      header: t('admin.bk_files_col_size'),
      align: 'right',
      minWidth: 100,
      sortValue: r => r.size_bytes,
      cell: r => formatBytes(r.size_bytes),
    },
    {
      id: 'action',
      header: '',
      align: 'right',
      minWidth: 130,
      cell: r => (
        <Button
          size="sm"
          variant="secondary"
          icon={<RotateCcw size={14} />}
          loading={busy === r.name}
          disabled={restore.isPending}
          onClick={() => void askAndRestore(r)}
        >
          {t('admin.bk_restore_btn')}
        </Button>
      ),
    },
  ]

  return (
    <Card
      className="mt-4"
      flush
      icon={<HardDriveDownload size={18} />}
      title={t('admin.bk_files_title')}
      subtitle={t('admin.bk_files_sub')}
    >
      <div className="px-3 pt-3">
        <Callout variant="warning" title={t('admin.bk_restore_warn_title')} t={t}>
          {t('admin.bk_restore_warn_desc')}
        </Callout>
      </div>
      <DataTable
        rows={files.data?.files ?? []}
        columns={columns}
        rowKey={r => r.name}
        loading={files.isLoading}
        defaultSort={null}
        pageSize={0}
        minTableWidth={720}
        t={t}
        emptyState={
          <EmptyState
            icon={<HardDriveDownload size={26} />}
            title={t('admin.bk_files_empty')}
            description={t('admin.bk_files_empty_desc')}
            compact
            t={t}
          />
        }
      />
    </Card>
  )
}
export { RestoreFiles }

export function Part1({ anchor, t, canManage, run, data, trigger, isLoading }: { anchor: NonNullable<BackupPanel['anchor']>; t: NonNullable<BackupPanel['tr']>; canManage: NonNullable<BackupPanel['canManage']>; run: NonNullable<BackupPanel['run']>; data: NonNullable<BackupPanel['data']>; trigger: BackupPanel['trigger']; isLoading: NonNullable<BackupPanel['isLoading']> }) {
  return (
    <div ref={anchor}>
          <Card
            icon={<DatabaseBackup size={18} />}
            title={t('admin.bk_title')}
            subtitle={t('admin.bk_intro')}
            actions={
              canManage && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<PlayCircle size={15} />}
                  loading={run.isPending}
                  disabled={data.running}
                  onClick={trigger}
                >
                  {t('admin.bk_run_now')}
                </Button>
              )
            }
          >
            <div className="space-y-4">
              <StatusBanner data={data} />
              <PolicySummary data={data} />
              <Coverage data={data} />
              <RestoreDrill data={data} canManage={canManage} />
            </div>
          </Card>
    
          <History data={data} loading={isLoading} />
          <RestoreFiles canRestore={data.can_restore} />
        </div>
  )
}
