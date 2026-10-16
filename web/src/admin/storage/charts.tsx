import { useUiTheme } from '../../core/hooks/useUiTheme'
// ── The categorical scale ────────────────────────────────────────────────────

/**
 * Slots of the categorical scale, in fixed order. Never cycled.
 *
 * Written out in full rather than composed from an index: Tailwind prunes
 * `@theme` variables it cannot see referenced in the source, so a name built at
 * runtime (`--kb-chart-${n}`) resolves to a variable that was never emitted.
 *
 * The dark steps are a separate, separately-validated set rather than a filter
 * over the light ones, and the choice is made in JS: Kubuno's themes are applied
 * by writing variables from the theme store, not through `prefers-color-scheme`,
 * so a CSS-only switch would stay light on a hand-picked dark theme.
 */
export const SERIES_LIGHT = [
  'var(--kb-chart-1)', 'var(--kb-chart-2)', 'var(--kb-chart-3)', 'var(--kb-chart-4)',
  'var(--kb-chart-5)', 'var(--kb-chart-6)', 'var(--kb-chart-7)', 'var(--kb-chart-8)',
] as const

export const SERIES_DARK = [
  'var(--kb-chart-1-dark)', 'var(--kb-chart-2-dark)', 'var(--kb-chart-3-dark)', 'var(--kb-chart-4-dark)',
  'var(--kb-chart-5-dark)', 'var(--kb-chart-6-dark)', 'var(--kb-chart-7-dark)', 'var(--kb-chart-8-dark)',
] as const

/** Beyond this many series, the tail folds into one entry. Never a ninth hue. */
export const MAX_SERIES = SERIES_LIGHT.length

/** The scale for the theme actually in force. */
export function useSeriesScale(): readonly string[] {
  return useUiTheme() === 'dark' ? SERIES_DARK : SERIES_LIGHT
}

/** The colour of what has no identity: a residual, a fold, an unknown. */
export const NEUTRAL_SERIES = 'var(--color-border-strong)'

// ── Composition bar ──────────────────────────────────────────────────────────

export interface Segment {
  id:    string
  label: string
  value: number
  /** A CSS colour *expression* - always `var(--…)`, never a literal. */
  color: string
  /**
   * The remainder, not a part: it is left as bare track rather than painted.
   *
   * "Free space" is what the bar has not filled, and painting it in a near-track
   * grey produces two adjacent light greys nobody can tell apart. It keeps its
   * legend entry - the number is the point - with a hairline ring so the swatch
   * is visible against the card.
   */
  track?: boolean
}

// ── Trend ────────────────────────────────────────────────────────────────────

export interface TrendDatum { day: string; value: number }
