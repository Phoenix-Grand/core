/**
 * Code-behind of `DetectorTrial.kbcontrol` (converted from `DetectorTrial.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { errorMessage, useTestDetector, type DetectorInput, type TestResult } from "./api"
import { asPercent } from "./labels"

import { ViewBase } from './DetectorTrial.kbcontrol'
import * as __parts from './DetectorTrial.parts'

interface Props {
  /** A saved detector… */
  detectorId?: string | null
  /** …or the one being written, so a pattern can be tried before it is saved. */
  draft?:      DetectorInput | null
  /** Reason the draft cannot be tried yet (incomplete form). */
  draftError?: string | null
}

interface Segment {
  text:       string
  confidence: number | null
  counted:    boolean
}

function segments(sample: string, result: TestResult | undefined): Segment[] {
  if (!result || result.matches.length === 0) {
    return sample ? [{ text: sample, confidence: null, counted: false }] : []
  }
  const bytes   = new TextEncoder().encode(sample)
  const decoder = new TextDecoder()
  const slice   = (from: number, to: number) => decoder.decode(bytes.slice(from, to))

  const ordered = [...result.matches].sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  let cursor = 0
  for (const m of ordered) {
    // Overlapping matches would otherwise produce negative-length runs.
    if (m.start < cursor) continue
    if (m.start > cursor) out.push({ text: slice(cursor, m.start), confidence: null, counted: false })
    out.push({ text: slice(m.start, m.end), confidence: m.confidence, counted: m.counted })
    cursor = m.end
  }
  if (cursor < bytes.length) {
    out.push({ text: slice(cursor, bytes.length), confidence: null, counted: false })
  }
  return out
}

export type { Props }

export class DetectorTrial extends ViewBase {
  @bind accessor sample = ''
  @bind accessor error: string | null = null
  tr!: DetectorTrialStores['t']
  trial!: DetectorTrialStores['trial']
  runs!: Segment[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const trial = useTestDetector()
    return { t, trial }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const result = this.result
    const runs   = useMemo(() => segments(this.sample, result), [this.sample, result])
    this.publish({ runs })
    return { runs }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, trial: s.trial })
    const h = this.useHooks()
    this.publish({ runs: h.runs })
  }

  get result(): TestResult | undefined {
    return this.memo('result', [this.trial], () => this.trial.data)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<label htmlFor>: attribute(s) without a .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.sample, this.memo, this.tr], () => ({ sample: this.sample, setSample: this.memo("setSample:bound", [], () => this.setSample.bind(this)), t: this.tr }))
  }

  /** A part of the screen still written in React (<textarea> has no .kbview element yet). */
  get Part2() {
    return __parts.Part2
  }

  get enabled_unless_sample_trim() {
    return !(!this.sample.trim())
  }

  get show_error() {
    return !!(this.error)
  }

  get show_result() {
    return this.memo('show_result', [this.result], () => !!(this.result))
  }

  get variant() {
    if (!(this.result)) return undefined as never
    return this.result.summary.would_match ? 'warning' : 'info'
  }

  get title() {
    if (!(this.result)) return undefined as never
    return this.result.summary.would_match
              ? this.tr('admin.det_trial_would_match')
              : this.tr('admin.det_trial_would_not_match')
  }

  get det_trial_counts_count() {
    if (!(this.result)) return undefined as never
    return this.result.summary.matches
  }

  get det_trial_counts_unique() {
    if (!(this.result)) return undefined as never
    return this.result.summary.unique_matches
  }

  get det_trial_counts_best() {
    if (!(this.result)) return undefined as never
    return asPercent(this.result.summary.best_confidence)
  }

  get det_trial_counts_min_matches() {
    if (!(this.result)) return undefined as never
    return this.result.summary.min_matches
  }

  get det_trial_counts_min_unique() {
    if (!(this.result)) return undefined as never
    return this.result.summary.min_unique_matches
  }

  get det_trial_counts_min_confidence() {
    if (!(this.result)) return undefined as never
    return asPercent(this.result.summary.min_confidence)
  }

  get show_result_scan_truncated() {
    if (!(this.result)) return undefined as never
    return this.result.scan.truncated || this.result.scan.timed_out || this.result.scan.saturated
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.result], () => {
      if (!(this.result) || !((this.result.scan.truncated || this.result.scan.timed_out || this.result.scan.saturated))) return undefined as never
      return ({ t: this.tr, result: this.result })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part3() {
    if (!(this.result) || !((this.result.scan.truncated || this.result.scan.timed_out || this.result.scan.saturated))) return undefined as never
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.runs, this.result], () => {
      if (!(this.result)) return undefined as never
      return ({ runs: this.runs })
    })
  }

  /** A part of the screen still written in React (a list whose item is not a single element). */
  get Part4() {
    if (!(this.result)) return undefined as never
    return __parts.Part4
  }

  async run() {
    this.error = null
    if (this.props.draftError) { this.error = this.props.draftError; return }
    try {
      await this.trial.mutateAsync(
        this.props.draft ? { sample: this.sample, draft: this.props.draft } : { sample: this.sample, detector_id: this.props.detectorId ?? undefined },
      )
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.det_trial_failed'))
    }
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    void this.run()
  }

  /** `setSample` of the TSX: a value, or an update of the previous one. */
  setSample(value: DetectorTrial['sample'] | ((prev: DetectorTrial['sample']) => DetectorTrial['sample'])) {
    this.sample = typeof value === 'function' ? (value as (prev: DetectorTrial['sample']) => DetectorTrial['sample'])(this.sample) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DetectorTrialStores = ReturnType<DetectorTrial['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type DetectorTrialHooks = ReturnType<DetectorTrial['useHooks']>

export default DetectorTrial.component()
