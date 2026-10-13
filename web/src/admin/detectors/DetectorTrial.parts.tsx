/**
 * The parts of `DetectorTrial.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Callout } from "@ui"
import { asPercent } from "./labels"
import type { DetectorTrial } from './DetectorTrial'

export function Part1({ t }: { t: NonNullable<DetectorTrial['tr']> }) {
  return (
    <label
            className="block text-text-secondary"
            style={{ fontSize: 'var(--kb-text-meta)' }}
            htmlFor="detector-sample"
          >
            {t('admin.det_trial_sample')}
          </label>
  )
}

export function Part2({ sample, setSample, t }: { sample: NonNullable<DetectorTrial['sample']>; setSample: NonNullable<DetectorTrial['setSample']>; t: NonNullable<DetectorTrial['tr']> }) {
  return (
    <textarea
            id="detector-sample"
            value={sample}
            onChange={e => setSample(e.target.value)}
            rows={6}
            spellCheck={false}
            // A sample is pasted, not dictated: turning the assistive features off
            // stops the browser from "correcting" an IBAN into something else.
            autoComplete="off"
            autoCorrect="off"
            placeholder={t('admin.det_trial_placeholder')}
            className="mt-1 w-full resize-y rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            style={{ fontSize: 'var(--kb-text-body)' }}
          />
  )
}

export function Part3({ t, result }: { t: NonNullable<DetectorTrial['tr']>; result: NonNullable<DetectorTrial['result']> }) {
  return (
    <Callout variant="warning" title={t('admin.det_trial_incomplete')} t={t}>
                    {result.scan.truncated && <div>{t('admin.det_trial_truncated')}</div>}
                    {result.scan.timed_out && <div>{t('admin.det_trial_timed_out')}</div>}
                    {result.scan.saturated && <div>{t('admin.det_trial_saturated')}</div>}
                  </Callout>
  )
}

export function Part4({ runs }: { runs: NonNullable<DetectorTrial['runs']> }) {
  return (
    <>{runs.map((run, i) => run.confidence === null
                  ? <span key={i}>{run.text}</span>
                  : (
                    <mark
                      key={i}
                      // Counted matches carry the danger tint, matches below the
                      // floor a neutral one: "found but not enough" is exactly the
                      // state an administrator is tuning against, and colouring the
                      // two the same hides the thing they came here to see.
                      className={run.counted
                        ? 'rounded-sm bg-danger-light px-0.5 text-text-primary'
                        : 'rounded-sm bg-surface-3 px-0.5 text-text-secondary'}
                      title={asPercent(run.confidence)}
                    >
                      {run.text}
                    </mark>
                  ))}</>
  )
}
