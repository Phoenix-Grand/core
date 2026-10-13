/**
 * The parts of `ImpactPanel.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { AlertTriangle } from "lucide-react"
import { Callout, ProgressBar } from "@ui"
import type { ImpactPanel } from './ImpactPanel'

function Figure({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface-0 px-3 py-2">
      <div className="tabular-nums text-text-primary" style={{ fontSize: 'var(--kb-text-page)' }}>{value}</div>
      <div className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>{label}</div>
      {hint && <div className="mt-0.5 text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>{hint}</div>}
    </div>
  )
}
export { Figure }

export function Part1({ ratio, t }: { ratio: NonNullable<ImpactPanel['ratio']>; t: NonNullable<ImpactPanel['tr']> }) {
  return (
    <ProgressBar value={ratio} max={100} variant="primary" size="sm"
                  label={t('admin.rl_impact_ratio')} showValue
                  formatValue={v => `${v.toFixed(1)} %`} t={t} />
  )
}

export function Part2({ d, peak }: { d: NonNullable<ImpactPanel['rows_items2']>[number]['d']; peak: NonNullable<ImpactPanel['rows_items2']>[number]['peak'] }) {
  return (
    <div className="w-full rounded-t bg-primary"
                            style={{ height: `${Math.max(3, (d.count / peak) * 56)}px` }} aria-hidden />
  )
}

export function Part3({ t, report }: { t: NonNullable<ImpactPanel['tr']>; report: NonNullable<ImpactPanel['report']> }) {
  return (
    <Callout variant="warning" icon={<AlertTriangle size={16} />}
                  title={t('admin.rl_impact_limits_title')}>
                  <ul className="ms-4 list-disc">
                    {(report.limitations ?? []).map((l, i) => <li key={i}>{l}</li>)}
                    {report.truncated && <li>{t('admin.rl_impact_truncated')}</li>}
                  </ul>
                </Callout>
  )
}
