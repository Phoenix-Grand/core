/**
 * The parts of `ExecutionsPanel.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Badge } from "@ui"
import { actionStatusLabel, actionStatusVariant, severityLabel, severityVariant, windowLabel } from "./labels"
import type { ExecutionRow } from "./types"

function Detail({ row, ruleSeverity }: { row: ExecutionRow; ruleSeverity: string | undefined }) {
  const { t } = useTranslation()
  const d = row.detail ?? {}
  const verdicts = d.actions ?? []

  return (
    <div className="flex min-w-0 flex-col gap-3 bg-surface-1 px-4 py-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-text-secondary"
        style={{ fontSize: 'var(--kb-text-meta)' }}>
        <span>{t('admin.rl_log_event', { type: row.event_type })}</span>
        <span>{t('admin.rl_log_version', { n: row.rule_version })}</span>
        <span>{t('admin.rl_log_duration', { ms: row.duration_ms })}</span>
        <span>{t('admin.rl_log_depth', { n: row.depth })}</span>
        {d.leaves_evaluated !== undefined && <span>{t('admin.rl_log_leaves', { count: d.leaves_evaluated })}</span>}
        {d.scope_applied !== undefined && (
          <span>{t(d.scope_applied ? 'admin.rl_log_scope_yes' : 'admin.rl_log_scope_no')}</span>
        )}
        {d.rollout_percent !== undefined && d.rollout_percent < 100 && (
          <span>{t('admin.rl_log_rollout', { percent: d.rollout_percent })}</span>
        )}
        {ruleSeverity && (
          <span>
            {t('admin.rl_log_severity')} <Badge variant={severityVariant(ruleSeverity)} size="sm">
              {severityLabel(t, ruleSeverity)}
            </Badge>
          </span>
        )}
      </div>

      {d.threshold && (
        <div className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.rl_log_threshold', {
            count: d.threshold.hits, needed: d.threshold.needed,
            window: windowLabel(t, d.threshold.window_s),
          })}
        </div>
      )}

      <div className="min-w-0">
        <h4 className="mb-1 text-text-primary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.rl_log_actions', {
            total: row.actions_total, count: row.actions_ok, failed: row.actions_failed,
          })}
        </h4>
        {verdicts.length === 0 ? (
          <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {row.actions_total === 0 ? t('admin.rl_log_no_action') : t('admin.rl_log_no_verdict')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {verdicts.map((v, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-mono text-text-primary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                  {v.action}
                </span>
                <Badge variant={actionStatusVariant(v.status)} size="sm">
                  {actionStatusLabel(t, v.status)}
                </Badge>
                {v.error && (
                  <span className="min-w-0 truncate text-danger" style={{ fontSize: 'var(--kb-text-meta)' }}>
                    {v.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {(row.resource_type || row.actor_user_id) && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-text-tertiary"
          style={{ fontSize: 'var(--kb-text-micro)' }}>
          {row.actor_user_id && <span className="font-mono">{t('admin.rl_log_actor_id', { id: row.actor_user_id })}</span>}
          {row.resource_type && (
            <span className="font-mono">{row.resource_type}: {row.resource_id ?? '—'}</span>
          )}
        </div>
      )}
    </div>
  )
}
export { Detail }
