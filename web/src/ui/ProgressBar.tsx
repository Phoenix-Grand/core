import { cn } from './cn'
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { uiT } from './uiText'

export type ProgressVariant = 'auto' | 'primary' | 'success' | 'warning' | 'danger'

export interface ProgressBarProps {
  value:  number
  /** Denominator. Defaults to 100, i.e. `value` read as a percentage. */
  max?:   number
  /**
   * `auto` (default) colours the fill from the thresholds below - the behaviour
   * every hand-rolled quota bar in the admin was re-implementing, each with its
   * own hard-coded `#d93025`. Pass an explicit variant to pin a colour (a
   * download bar is not "dangerous" at 95 %).
   */
  variant?: ProgressVariant
  label?:     ReactNode
  /** Prints the numeric value opposite the label. */
  showValue?: boolean
  /** Formats that value. Default: rounded percentage. */
  formatValue?: (value: number, max: number) => string
  /** Fraction (0-1) at which `auto` turns warning / danger. */
  warnAt?:    number
  dangerAt?:  number
  size?:      'sm' | 'md'
  /** Unknown progress: an animated sliver instead of a fill. `value` is ignored. */
  indeterminate?: boolean
  className?: string
  t?:         TFunction
}

const TRACK: Record<'sm' | 'md', string> = { sm: 'h-1.5', md: 'h-2' }

/**
 * Keyframes for the indeterminate sliver, rendered as part of the component
 * rather than declared in the host stylesheet. `@ui` is consumed by 18 module
 * bundles AND re-rendered inside the admin theme preview's Shadow DOM, where a
 * rule living in the host's `index.css` would not reach: emitting the `<style>`
 * from the component itself makes it land in whatever tree the bar renders into.
 * Identical duplicate declarations are inert.
 */
const SLIDE_KEYFRAMES = `@keyframes kb-progress-slide{
  0%{transform:translateX(-100%)}100%{transform:translateX(300%)}
}`

const FILL: Record<Exclude<ProgressVariant, 'auto'>, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger:  'bg-danger',
}

/**
 * ProgressBar - one bar for quotas, uploads, indexing and any bounded task.
 *
 * Thresholds are the point of the component: a storage bar must go amber before
 * it goes red, and it must do so at the SAME ratio everywhere. They default to
 * 75 % (warning) and 90 % (danger), and are overridable per instance rather than
 * re-derived at each call site.
 *
 * Colours come from `bg-primary` / `bg-warning` / `bg-danger`, so a theme
 * remapping those variables recolours every bar - including in dark mode, where
 * the hard-coded `#d93025` of the current admin bars reads far too heavy.
 */
export function ProgressBar({
  value, max = 100,
  variant = 'auto',
  label, showValue = false, formatValue,
  warnAt = 0.75, dangerAt = 0.9,
  size = 'md',
  indeterminate = false,
  className, t,
}: ProgressBarProps) {
  const tr = uiT(t)
  const safeMax = max > 0 ? max : 1
  const clamped = Math.min(Math.max(value, 0), safeMax)
  const ratio   = clamped / safeMax
  const pct     = ratio * 100

  const resolved: Exclude<ProgressVariant, 'auto'> =
    variant !== 'auto' ? variant
      : ratio >= dangerAt ? 'danger'
      : ratio >= warnAt   ? 'warning'
      : 'primary'

  const text = formatValue
    ? formatValue(clamped, safeMax)
    : `${Math.round(pct)} %`

  const hasHeader = label != null || showValue

  return (
    <div className={cn('min-w-0', className)}>
      {hasHeader && (
        <div
          className="mb-1 flex items-baseline justify-between gap-2"
          style={{ fontSize: 'var(--kb-text-body)' }}
        >
          {label != null
            ? <span className="min-w-0 truncate text-text-secondary">{label}</span>
            : <span />}
          {showValue && <span className="shrink-0 tabular-nums text-text-secondary">{text}</span>}
        </div>
      )}

      <div
        role="progressbar"
        aria-label={label == null ? tr('ui.pb_progress') : undefined}
        // An indeterminate bar deliberately omits `aria-valuenow`: that absence
        // is precisely what tells assistive tech the progress is unknown.
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : safeMax}
        aria-valuenow={indeterminate ? undefined : clamped}
        aria-valuetext={indeterminate ? undefined : text}
        className={cn('w-full overflow-hidden rounded-full bg-surface-2', TRACK[size])}
      >
        {indeterminate ? (
          <>
            <style>{SLIDE_KEYFRAMES}</style>
            <div
              className={cn('h-full w-1/3 rounded-full', FILL[resolved])}
              style={{ animation: 'kb-progress-slide 1.3s ease-in-out infinite' }}
            />
          </>
        ) : (
          <div
            className={cn('h-full rounded-full transition-[width,background-color] duration-300', FILL[resolved])}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  )
}
