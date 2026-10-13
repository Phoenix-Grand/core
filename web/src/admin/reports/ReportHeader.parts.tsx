/**
 * The parts of `ReportHeader.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { ReactNode } from "react"
import type { ReportHeader } from './ReportHeader'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>{label}</dt>
      <dd className="mt-0.5 text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
        {children}
      </dd>
    </div>
  )
}
export { Fact }

export function Part1({ t, periodLabel, model, generatedAt, generatedBy }: { t: NonNullable<ReportHeader['tr']>; periodLabel: NonNullable<ReportHeader['props']['periodLabel']>; model: NonNullable<ReportHeader['props']['model']>; generatedAt: NonNullable<ReportHeader['props']['generatedAt']>; generatedBy: NonNullable<ReportHeader['props']['generatedBy']> }) {
  return (
    <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label={t('admin.rep_period')}>
              {periodLabel}
            </Fact>
            {/* Spelt out rather than abbreviated: "du 1er juin 2026 à 00:00 au 1er
                juillet 2026 à 00:00" is the sentence somebody can check. */}
            <Fact label={t('admin.rep_window')}>
              {t('admin.rep_window_value', { from: model.from, to: model.to })}
            </Fact>
            <Fact label={t('admin.rep_timezone')}>{model.timezone}</Fact>
            <Fact label={t('admin.rep_generated')}>{generatedAt}</Fact>
            <Fact label={t('admin.rep_generated_by')}>{generatedBy}</Fact>
          </dl>
  )
}
