import { cn } from './cn'
import type { ReactNode } from 'react'
import { useId } from 'react'

export interface CardProps {
  /** Section heading. Omit for a bare surface with no header band. */
  title?:    ReactNode
  /** Leading glyph shown before the title (a lucide icon element, typically). */
  icon?:     ReactNode
  /** Trailing controls of the header row (buttons, a menu, a badge…). */
  actions?:  ReactNode
  /** Secondary line under the title. */
  subtitle?: ReactNode
  /** Bottom band, separated by a hairline - totals, pagination, a submit row. */
  footer?:   ReactNode
  /** Tighter padding, for cards stacked in a dense settings column. */
  dense?:    boolean
  /** Drop the body padding entirely - for a table or list that must bleed to the
   *  card edges (the DataTable does this). */
  flush?:    boolean
  className?:     string
  bodyClassName?: string
  children?:      ReactNode
}

/**
 * Card - the single container for a titled block of admin/settings content.
 *
 * It replaces the three hand-copied variants that had drifted apart across the
 * admin panels (different radii, different border colours, headers built with
 * three different markups). Everything here is token-driven: `bg-surface-0`,
 * `border-border` and the `--kb-*` scales, so a theme that remaps its variables -
 * light or dark - re-skins every card at once.
 *
 * The root is `min-w-0` on purpose: a card is routinely a flex/grid child, and
 * without it a wide child (a table, a long path) would push the card past its
 * track and make the PAGE scroll horizontally. Wide content scrolls inside its
 * own box instead (see `flush` + DataTable).
 */
export function Card({
  title, icon, actions, subtitle, footer,
  dense = false, flush = false,
  className, bodyClassName, children,
}: CardProps) {
  const headingId = useId()
  const pad     = dense ? 'px-3 py-2.5' : 'px-4 py-3'
  const bodyPad = flush ? '' : dense ? 'p-3' : 'p-4'
  const hasHeader = title != null || icon != null || actions != null

  return (
    <section
      aria-labelledby={title != null ? headingId : undefined}
      className={cn(cn(
        'min-w-0 rounded-xl border border-border bg-surface-0',
        className,
      ))}
    >
      {hasHeader && (
        <div className={cn('flex items-start gap-3 border-b border-border', pad)}>
          {icon && (
            <span className="mt-0.5 flex shrink-0 items-center text-text-secondary" aria-hidden>
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {title != null && (
              <h3
                id={headingId}
                className="truncate font-medium text-text-primary"
                style={{ fontSize: dense ? 'var(--kb-text-body)' : 'var(--kb-text-heading)' }}
              >
                {title}
              </h3>
            )}
            {subtitle != null && (
              <p className="mt-0.5 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}

      {children != null && (
        <div className={cn(cn('min-w-0', bodyPad), bodyClassName)}>{children}</div>
      )}

      {footer != null && (
        <div className={cn('border-t border-border bg-surface-1 rounded-b-xl', pad)}>{footer}</div>
      )}
    </section>
  )
}
