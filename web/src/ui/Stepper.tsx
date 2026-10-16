import { cn } from './cn'
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import type { TFunction } from 'i18next'
import { uiT } from './uiText'

/**
 * Validation state of one step. `error` is what makes a Stepper more than a
 * decoration: a wizard whose third step failed validation must SAY so on the
 * indicator, otherwise the user walks forward and discovers it at submit time.
 */
export type StepStatus = 'pending' | 'current' | 'complete' | 'error' | 'disabled'

export interface StepDef {
  id:           string
  label:        string
  description?: string
  /**
   * Explicit status. When omitted it is derived from the position relative to
   * the current step (before → complete, at → current, after → pending), which
   * covers the linear happy path with no bookkeeping at the call site.
   */
  status?:      StepStatus
  optional?:    boolean
}

export interface StepperProps {
  steps:    StepDef[]
  /** Current step, by id or by index. */
  current:  string | number
  /** Called when a reachable step is clicked. Omit to make the indicator inert. */
  onStepChange?: (id: string, index: number) => void
  orientation?:  'horizontal' | 'vertical'
  /**
   * Allow jumping FORWARD past the current step. Off by default: a wizard's
   * later steps usually depend on data the user has not entered yet.
   */
  allowForward?: boolean
  /** Content of the active step, rendered under (or beside) the indicator. */
  children?:  ReactNode
  className?: string
  t?:         TFunction
}

/** Below this container width the horizontal indicator would wrap onto several
 *  lines - a shape the project explicitly rejects - so it collapses instead. */
const COMPACT_WIDTH = 560

/** Container-width watcher. The window is the wrong ruler here: a Stepper often
 *  lives in a narrow column (a dialog, a side panel, the admin theme preview's
 *  390 px stage) on a perfectly wide screen. A measured width of 0 (collapsed
 *  panel) counts as narrow - it is a real measurement, not a missing one. */
function useCompact(ref: RefObject<HTMLElement | null>, threshold: number): boolean {
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setCompact(el.clientWidth < threshold)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      setCompact((entries[0]?.contentRect.width ?? el.clientWidth) < threshold)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, threshold])
  return compact
}

function resolveStatus(step: StepDef, index: number, currentIndex: number): StepStatus {
  if (step.status) return step.status
  if (index < currentIndex) return 'complete'
  if (index === currentIndex) return 'current'
  return 'pending'
}

/** Bullet skin per status - token-backed, so themes recolour the whole trail. */
const BULLET: Record<StepStatus, string> = {
  complete: 'bg-primary text-white border-primary',
  current:  'bg-white text-primary border-primary',
  error:    'bg-danger text-white border-danger',
  pending:  'bg-white text-text-tertiary border-border',
  disabled: 'bg-surface-2 text-text-tertiary border-border',
}

const LABEL: Record<StepStatus, string> = {
  complete: 'text-text-primary',
  current:  'text-primary font-medium',
  error:    'text-danger font-medium',
  pending:  'text-text-secondary',
  disabled: 'text-text-tertiary',
}

/**
 * Stepper - the progress spine of a multi-step assistant.
 *
 * Semantics: an ordered list (`<ol>`), the active step carrying
 * `aria-current="step"`; each bullet is a real `<button>` when the step is
 * reachable and a plain `<span>` when it is not, so the Tab order only ever
 * offers what can actually be activated. Status is announced in words through
 * the accessible name ("Completed" / "Needs attention"), never by colour alone.
 *
 * Narrow containers do not shrink the trail - they replace it: "Step 2 of 5",
 * the current label, and a slim progress rail. That is a different hierarchy,
 * not a squeezed one, and it never wraps onto a second row.
 */
export function Stepper({
  steps, current, onStepChange,
  orientation = 'horizontal',
  allowForward = false,
  children, className, t,
}: StepperProps) {
  const tr = uiT(t)
  const rootRef = useRef<HTMLDivElement>(null)
  const compact = useCompact(rootRef, COMPACT_WIDTH)

  const currentIndex = useMemo(() => {
    if (typeof current === 'number') return Math.min(Math.max(current, 0), steps.length - 1)
    const i = steps.findIndex(s => s.id === current)
    return i >= 0 ? i : 0
  }, [current, steps])

  const reachable = (index: number, status: StepStatus) =>
    !!onStepChange && status !== 'disabled' && (allowForward || index <= currentIndex)

  const statusLabel = useCallback((status: StepStatus) =>
    status === 'complete' ? tr('ui.st_done') : status === 'error' ? tr('ui.st_error') : '', [tr])

  const vertical = orientation === 'vertical' && !compact

  // ── Compact: "Step 2 of 5" + label + rail ──────────────────────────────────
  const compactView = (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate font-medium text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {steps[currentIndex]?.label}
        </p>
        <p className="shrink-0 tabular-nums text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {tr('ui.st_step')} {currentIndex + 1} {tr('ui.st_of')} {steps.length}
        </p>
      </div>
      {steps[currentIndex]?.description && (
        <p className="mt-0.5 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {steps[currentIndex].description}
        </p>
      )}
      <div className="mt-2 flex gap-1" aria-hidden>
        {steps.map((s, i) => {
          const st = resolveStatus(s, i, currentIndex)
          return (
            <span
              key={s.id}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                st === 'error' ? 'bg-danger' : i <= currentIndex ? 'bg-primary' : 'bg-surface-3',
              )}
            />
          )
        })}
      </div>
    </div>
  )

  // ── Full trail ─────────────────────────────────────────────────────────────
  const trail = (
    <ol className={cn('flex min-w-0', vertical ? 'flex-col gap-3' : 'items-start gap-1')}>
      {steps.map((step, i) => {
        const status = resolveStatus(step, i, currentIndex)
        const clickable = reachable(i, status)
        const extra = statusLabel(status)

        const bullet = (
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors',
              BULLET[status],
            )}
            style={{ fontSize: 'var(--kb-text-meta)' }}
          >
            {status === 'complete' ? <Check size={14} />
              : status === 'error' ? <AlertTriangle size={13} />
              : i + 1}
          </span>
        )

        const body = (
          <span className={cn('min-w-0', vertical ? 'text-left' : 'text-left')}>
            <span className={cn('block truncate', LABEL[status])} style={{ fontSize: 'var(--kb-text-body)' }}>
              {step.label}
              {step.optional && (
                <span className="ml-1 font-normal text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                  ({tr('ui.st_optional')})
                </span>
              )}
            </span>
            {step.description && (
              <span className="block truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {step.description}
              </span>
            )}
          </span>
        )

        const inner = (
          <span className={cn('flex min-w-0 items-center gap-2.5', vertical ? '' : 'flex-1')}>
            {bullet}
            {body}
          </span>
        )

        return (
          <li
            key={step.id}
            aria-current={status === 'current' ? 'step' : undefined}
            className={cn('flex min-w-0', vertical ? 'flex-col' : 'flex-1 items-center gap-1')}
          >
            {clickable ? (
              <button
                type="button"
                onClick={() => onStepChange?.(step.id, i)}
                // Status is part of the accessible name: colour alone never
                // conveys "done" or "failed".
                aria-label={extra ? `${step.label} - ${extra}` : step.label}
                className="flex min-w-0 flex-1 items-center rounded-md px-1 py-1 text-left transition-colors
                           hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {inner}
              </button>
            ) : (
              <span className="flex min-w-0 flex-1 items-center px-1 py-1" aria-label={extra || undefined}>
                {inner}
              </span>
            )}

            {/* Connector: decorative, and never the last one. */}
            {i < steps.length - 1 && (
              vertical
                ? <span aria-hidden className={cn('ml-4 h-4 w-px', i < currentIndex ? 'bg-primary' : 'bg-border')} />
                : <span aria-hidden className={cn('h-px min-w-4 flex-1', i < currentIndex ? 'bg-primary' : 'bg-border')} />
            )}
          </li>
        )
      })}
    </ol>
  )

  return (
    <div ref={rootRef} className={cn('min-w-0', className)}>
      {compact ? compactView : trail}
      {children != null && <div className="mt-4 min-w-0">{children}</div>}
    </div>
  )
}

export interface UseStepperResult {
  /** Id of the active step. */
  id:      string
  index:   number
  isFirst: boolean
  isLast:  boolean
  next:    () => void
  prev:    () => void
  goTo:    (id: string) => void
  /** Flag a step as failing (or clear it) - drives its `error` status. */
  setError:  (id: string, failed: boolean) => void
  /** Statuses to spread onto the step definitions handed to `<Stepper>`. */
  statuses:  Record<string, StepStatus>
  /** Steps with `status` already resolved - pass straight to `<Stepper steps>`. */
  resolved:  StepDef[]
}

/**
 * Companion hook: holds the cursor and the per-step validation map so a wizard
 * does not re-implement "which steps are done, which one broke" every time.
 */
export function useStepper(steps: StepDef[], initial?: string): UseStepperResult {
  const [index, setIndex] = useState(() => {
    const i = initial ? steps.findIndex(s => s.id === initial) : 0
    return i >= 0 ? i : 0
  })
  const [errors, setErrors] = useState<Record<string, boolean>>({})

  const clamp = useCallback((i: number) => Math.min(Math.max(i, 0), steps.length - 1), [steps.length])

  const statuses = useMemo(() => {
    const out: Record<string, StepStatus> = {}
    steps.forEach((s, i) => {
      out[s.id] = errors[s.id] ? 'error' : i < index ? 'complete' : i === index ? 'current' : 'pending'
    })
    return out
  }, [steps, index, errors])

  const resolved = useMemo(
    () => steps.map(s => ({ ...s, status: s.status ?? statuses[s.id] })),
    [steps, statuses],
  )

  return {
    id:      steps[index]?.id ?? '',
    index,
    isFirst: index === 0,
    isLast:  index === steps.length - 1,
    next:    () => setIndex(i => clamp(i + 1)),
    prev:    () => setIndex(i => clamp(i - 1)),
    goTo:    (id: string) => { const i = steps.findIndex(s => s.id === id); if (i >= 0) setIndex(i) },
    setError: (id: string, failed: boolean) => setErrors(e => ({ ...e, [id]: failed })),
    statuses,
    resolved,
  }
}
