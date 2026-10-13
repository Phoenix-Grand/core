/**
 * The parts of `AlertDetail.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { CheckCircle2, ExternalLink, Hand, Layers, MessageSquare, RotateCcw, Trash2, User } from "lucide-react"
import { Button, Card, Combobox, Textarea } from "@ui"
import { formatAgo, formatWhen } from "../sections/format"
import { actionLabel, alertTitle, eventLabel, kindLabel, severityLabel, sourceLabel, statusLabel } from "./labels"
import { actionHref, type Alert, type AlertAction, type AlertEvent, type AlertStatus } from "./types"
import { adminUrl } from "../adminAction"
import type { AlertDetail } from './AlertDetail'
const EVENT_ICON = {
  created:    Layers,
  status:     CheckCircle2,
  severity:   Hand,
  assigned:   User,
  comment:    MessageSquare,
  recurrence: RotateCcw,
} as const

function translateValue(t: ReturnType<typeof useTranslation>['t'], raw: string | null): string {
  if (!raw) return '—'
  const known = ['new', 'acknowledged', 'resolved', 'ignored']
  if (known.includes(raw)) return statusLabel(t, raw as AlertStatus)
  if (['critical', 'warning', 'info'].includes(raw)) return severityLabel(t, raw as 'critical')
  return raw
}

function ActionButtons({ alert, onExecute, busy }: {
  alert:     Alert
  onExecute: (verb: 'retry-jobs' | 'discard-jobs') => void
  busy:      boolean
}) {
  const { t } = useTranslation()

  // The server already dropped the actions the caller may not run, so an empty
  // list means "nothing this operator can do", not "nothing to do".
  if (alert.actions.length === 0) return null

  const render = (a: AlertAction, index: number) => {
    const label = actionLabel(t, a, alert)
    if (a.executes) {
      return (
        <Button
          key={a.id}
          variant={index === 0 ? 'primary' : 'secondary'}
          size="sm"
          disabled={busy}
          icon={a.id === 'retry-jobs' ? <RotateCcw size={14} /> : <Trash2 size={14} />}
          onClick={() => onExecute(a.id as 'retry-jobs' | 'discard-jobs')}
        >
          {label}
        </Button>
      )
    }
    return (
      <Link key={a.id} to={actionHref(a)}>
        <Button variant={index === 0 ? 'primary' : 'secondary'} size="sm" icon={<ExternalLink size={14} />}>
          {label}
        </Button>
      </Link>
    )
  }

  return (
    <Card className="mb-4" title={t('admin.al_actions_title')} subtitle={t('admin.al_actions_sub')}>
      <div className="flex flex-wrap gap-2">{alert.actions.map(render)}</div>
    </Card>
  )
}
export { ActionButtons }

function Timeline({ events }: { events: AlertEvent[] }) {
  const { t, i18n } = useTranslation()

  if (events.length === 0) {
    return <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>{t('admin.al_timeline_empty')}</p>
  }

  return (
    <ol className="min-w-0 space-y-3">
      {events.map(e => {
        const Icon = EVENT_ICON[e.kind] ?? Layers
        // A transition reads as "from → to"; a recurrence carries its running
        // count; a comment is its own body.
        const detail = e.kind === 'recurrence'
          ? t('admin.al_ev_recurrence_n', { n: e.to_value ?? '?' })
          : e.from_value || e.to_value
            ? `${translateValue(t, e.from_value)} → ${translateValue(t, e.to_value)}`
            : null

        return (
          <li key={e.id} className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 shrink-0 text-text-tertiary"><Icon size={15} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-text-primary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                  {eventLabel(t, e.kind)}
                </span>
                {detail && (
                  <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>{detail}</span>
                )}
                <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>
                  {e.actor_label} · {formatWhen(e.occurred_at, i18n.language)}
                </span>
              </div>
              {e.body && (
                <p className="mt-0.5 break-words text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                  {e.body}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
export { Timeline }

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className="min-w-0 break-words text-text-primary">{value}</dd>
    </div>
  )
}
export { Row }

export function Part1({ alert, assign, toast, t, assigneeOptions }: { alert: NonNullable<AlertDetail['alert']>; assign: NonNullable<AlertDetail['assign']>; toast: NonNullable<AlertDetail['toast']>; t: NonNullable<AlertDetail['tr']>; assigneeOptions: NonNullable<AlertDetail['assigneeOptions']> }) {
  return (
    <Combobox
                      value={alert.assignee_id}
                      onChange={(v) => assign.mutate({ id: alert.id, assignee_id: v }, {
                        onSuccess: () => toast.success(t('admin.al_toast_assigned')),
                        onError:   () => toast.error(t('admin.al_toast_assign_failed')),
                      })}
                      options={assigneeOptions}
                      placeholder={t('admin.al_assignee_none')}
                      searchPlaceholder={t('admin.al_assignee_search')}
                      emptyLabel={t('admin.al_assignee_empty')}
                      clearable
                      onClear={() => assign.mutate({ id: alert.id, assignee_id: null })}
                      aria-label={t('admin.al_assignee')}
                    />
  )
}

export function Part2({ draft, setDraft, t }: { draft: NonNullable<AlertDetail['draft']>; setDraft: NonNullable<AlertDetail['setDraft']>; t: NonNullable<AlertDetail['tr']> }) {
  return (
    <Textarea
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      rows={2}
                      placeholder={t('admin.al_comment_ph')}
                      aria-label={t('admin.al_comment_ph')}
                    />
  )
}

export function Part3({ t, alert, i18n, alert_module_id, alert_subject_label, alert_assignee_label, alert_closed_at }: { t: NonNullable<AlertDetail['tr']>; alert: NonNullable<AlertDetail['alert']>; i18n: NonNullable<AlertDetail['i18n']>; alert_module_id: string; alert_subject_label: string; alert_assignee_label: string; alert_closed_at: string }) {
  return (
    <dl className="space-y-1.5" style={{ fontSize: 'var(--kb-text-meta)' }}>
                  <Row label={t('admin.al_field_kind')} value={kindLabel(t, alert.kind)} />
                  <Row label={t('admin.al_field_source')} value={sourceLabel(t, alert.source)} />
                  <Row label={t('admin.al_field_occurrences')} value={String(alert.occurrences)} />
                  <Row label={t('admin.al_field_first_seen')} value={formatWhen(alert.first_seen_at, i18n.language)} />
                  <Row label={t('admin.al_field_last_seen')} value={`${formatWhen(alert.last_seen_at, i18n.language)} (${formatAgo(alert.last_seen_at)})`} />
                  {alert.module_id && <Row label={t('admin.al_field_module')} value={alert_module_id} />}
                  {alert.subject_label && <Row label={t('admin.al_field_subject')} value={alert_subject_label} />}
                  {alert.assignee_label && <Row label={t('admin.al_field_assignee')} value={alert_assignee_label} />}
                  {alert.closed_at && <Row label={t('admin.al_field_closed')} value={formatWhen(alert_closed_at, i18n.language)} />}
                </dl>
  )
}

export function Part4({ r, t }: { r: NonNullable<AlertDetail['rows_related']>[number]['r']; t: NonNullable<AlertDetail['tr']> }) {
  return (
    <Link
                          to={adminUrl({ tab: 'alerts', params: { alert: r.id } })}
                          className="block truncate rounded-sm text-primary underline-offset-2 hover:underline
                                     focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          style={{ fontSize: 'var(--kb-text-meta)' }}
                        >
                          {alertTitle(t, r)}
                        </Link>
  )
}
