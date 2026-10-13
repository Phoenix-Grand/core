/**
 * The parts of `ReportSummary.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { ReportSummary } from './ReportSummary'

export function Part1({ tone, Arrow, model_delta, i18n }: { tone: NonNullable<ReportSummary['tone']>; Arrow: NonNullable<ReportSummary['Arrow']>; model_delta: number; i18n: NonNullable<ReportSummary['i18n']> }) {
  return (
    <p data-tone className="mt-0.5 flex items-center gap-1 tabular-nums" style={{ color: tone, fontSize: 'var(--kb-text-body)' }}>
                  <Arrow size={14} aria-hidden />
                  {`${model_delta > 0 ? '+' : ''}${model_delta.toLocaleString(i18n.language)} %`}
                </p>
  )
}

export function Part2() {
  return (
    <span data-tone aria-hidden style={{ color: 'var(--color-primary)' }}>—</span>
  )
}
