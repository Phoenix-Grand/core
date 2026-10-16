import { cn } from './cn'
import { useState, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import { uiT } from './uiText'

export type CalloutVariant = 'info' | 'success' | 'warning' | 'danger'

export interface CalloutProps {
  variant?:     CalloutVariant
  title?:       ReactNode
  children?:    ReactNode
  /** Single inline action - "Retry", "Configure", "See the log"… */
  action?:      { label: string; onClick: () => void; icon?: ReactNode }
  /** Adds a close button. Pair it with `onDismiss` to be told about it. */
  dismissible?: boolean
  onDismiss?:   () => void
  /** Replaces the variant's default glyph. Pass `null` to drop the icon. */
  icon?:        ReactNode | null
  className?:   string
  t?:           TFunction
}

/**
 * Callout - an inline banner that qualifies the block it sits in: a hint, a
 * confirmation, a caveat, a failure. Not a toast (which is transient and floats
 * over the page) and not a dialog (which blocks).
 *
 * Colour rules, deliberate:
 *  • the tinted BACKGROUND carries the severity - the project forbids the
 *    left accent bar, so the whole surface is tinted instead;
 *  • body text stays `text-text-primary`. Painting a paragraph in
 *    `--color-warning` (#f9ab00 on #fef7e0) would fail contrast outright; the
 *    accent colour is reserved for the ICON, where contrast is not a legibility
 *    requirement. The hairline stays neutral (`border-border`) - an accent
 *    border would need an opacity modifier, and every Tailwind opacity modifier
 *    bakes a static light-theme hex as its fallback.
 * Everything resolves through theme variables, so the dark theme's remapped
 * `*-light` surfaces (e.g. `--color-warning-light: #3d3218`) work unchanged.
 */
const SKIN: Record<CalloutVariant, { box: string; icon: string; Glyph: typeof Info; live: 'polite' | 'assertive' }> = {
  info:    { box: 'bg-primary-light', icon: 'text-primary', Glyph: Info,          live: 'polite' },
  success: { box: 'bg-success-light', icon: 'text-success', Glyph: CheckCircle2,  live: 'polite' },
  warning: { box: 'bg-warning-light', icon: 'text-warning', Glyph: AlertTriangle, live: 'polite' },
  danger:  { box: 'bg-danger-light',  icon: 'text-danger',  Glyph: AlertCircle,   live: 'assertive' },
}

export function Callout({
  variant = 'info', title, children, action,
  dismissible = false, onDismiss, icon, className, t,
}: CalloutProps) {
  const tr = uiT(t)
  const [closed, setClosed] = useState(false)
  const skin = SKIN[variant]

  if (closed) return null

  const Glyph = skin.Glyph
  const glyph = icon === null ? null : (icon ?? <Glyph size={16} />)

  return (
    <div
      // A failure interrupts (`alert`); the rest is announced politely when the
      // region updates, without stealing the reader's place.
      role={variant === 'danger' ? 'alert' : 'status'}
      aria-live={skin.live}
      className={cn('flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5', skin.box, className)}
    >
      {glyph && <span className={cn('mt-px shrink-0', skin.icon)} aria-hidden>{glyph}</span>}

      <div className="min-w-0 flex-1" style={{ fontSize: 'var(--kb-text-body)' }}>
        {title != null && <p className="font-medium text-text-primary">{title}</p>}
        {/* Plain `text-text-primary`, not `/85`: Tailwind bakes a STATIC hex
            fallback next to the `color-mix()` of every opacity modifier, and
            that frozen light-theme value is exactly the kind of hard-coded
            colour a dark theme cannot remap. */}
        {children != null && (
          <div className={cn('text-text-primary leading-relaxed', title != null && 'mt-0.5')}>{children}</div>
        )}
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className={cn(
              'mt-1.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 -ml-2 transition-colors',
              'hover:bg-[var(--kb-black-08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              skin.icon,
            )}
            style={{ fontSize: 'var(--kb-text-body)' }}
          >
            {action.icon}
            {action.label}
          </button>
        )}
      </div>

      {dismissible && (
        <button
          type="button"
          aria-label={tr('ui.close')}
          onClick={() => { setClosed(true); onDismiss?.() }}
          className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-text-secondary transition-colors
                     hover:bg-[var(--kb-black-08)] hover:text-text-primary
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
