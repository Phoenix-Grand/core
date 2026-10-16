import { cn } from './cn'
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { Button } from './Button'
import { uiT } from './uiText'

/**
 * The FOUR situations an empty area can be in. They look similar and are
 * routinely conflated, yet they call for different words and - above all -
 * different actions. Picking the wrong one actively misleads:
 *
 *  • `first-use`   - the collection is genuinely empty and nothing is filtered.
 *                    This is the only variant that invites CREATION: the primary
 *                    action is "New user", "Add a domain"…  Tone: welcoming.
 *
 *  • `no-results`  - rows exist, but the active search/filters match none of
 *                    them. The way out is to WIDEN the query, so the action is
 *                    "Clear the filters" / "Reset the search".  NEVER offer a
 *                    create button here: the user is looking for something that
 *                    probably exists, and creating a duplicate is the one thing
 *                    they must not be nudged into. The component enforces this
 *                    by rendering the action as `secondary`, and warns in dev if
 *                    it is handed a `primary` one.
 *
 *  • `error`       - the data could not be loaded. Nothing is known about the
 *                    collection, so claiming "no user" would be a lie. The
 *                    action is "Retry"; the description says what failed.
 *
 *  • `unavailable` - the feature exists but is out of reach here: module not
 *                    installed, insufficient rights, plan restriction. There is
 *                    usually no action at all - only `docHref`, pointing at what
 *                    would unlock it.
 */
export type EmptyStateVariant = 'first-use' | 'no-results' | 'error' | 'unavailable'

export interface EmptyStateAction {
  label:    string
  onClick:  () => void
  icon?:    ReactNode
  /** Overrides the button style implied by the variant. */
  variant?: 'primary' | 'secondary' | 'ghost'
  disabled?: boolean
}

export interface EmptyStateProps {
  /** Illustrative glyph - an already-sized lucide element, e.g. `<Users size={26} />`. */
  icon:             ReactNode
  title:            string
  description?:     ReactNode
  /** Main way out. Its meaning is dictated by `variant` (see above). */
  action?:          EmptyStateAction
  secondaryAction?: EmptyStateAction
  /** "Learn more" link - documentation, not an action. */
  docHref?:         string
  docLabel?:        string
  variant?:         EmptyStateVariant
  /** Half the vertical breathing room - for an empty state inside a small card. */
  compact?:         boolean
  className?:       string
  t?:               TFunction
}

/** Icon medallion tint per variant - all token-backed, so themes re-skin it. */
const MEDALLION: Record<EmptyStateVariant, string> = {
  'first-use':   'bg-primary-light text-primary',
  'no-results':  'bg-surface-2 text-text-secondary',
  'error':       'bg-danger-light text-danger',
  'unavailable': 'bg-surface-2 text-text-tertiary',
}

/** Default button style of the main action, per variant. */
const ACTION_VARIANT: Record<EmptyStateVariant, 'primary' | 'secondary'> = {
  'first-use':   'primary',
  'no-results':  'secondary',
  'error':       'secondary',
  'unavailable': 'secondary',
}

export function EmptyState({
  icon, title, description, action, secondaryAction, docHref, docLabel,
  variant = 'first-use', compact = false, className, t,
}: EmptyStateProps) {
  const tr = uiT(t)

  // Dev-time guard for the confusion this component exists to prevent: a
  // "no result" screen must not push a creation. Silent in production.
  if (import.meta.env?.DEV && variant === 'no-results' && action?.variant === 'primary') {
    console.warn(
      '[EmptyState] variant="no-results" with a primary action: a filtered-empty screen ' +
      'should offer "clear the filters", not a creation. Use variant="first-use" if the ' +
      'collection really is empty.',
    )
  }

  const mainVariant = action?.variant ?? ACTION_VARIANT[variant]

  return (
    <div
      // `status` (polite) rather than `alert`: the region appears as the result
      // of the user's own action, and must not interrupt them mid-sentence.
      role="status"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-12',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex items-center justify-center rounded-full',
          compact ? 'h-11 w-11' : 'h-14 w-14',
          MEDALLION[variant],
        )}
      >
        {icon}
      </span>

      <div className="max-w-sm">
        <p
          className="font-medium text-text-primary"
          style={{ fontSize: compact ? 'var(--kb-text-body)' : 'var(--kb-text-heading)' }}
        >
          {title}
        </p>
        {description != null && (
          <p className="mt-1 leading-relaxed text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
            {description}
          </p>
        )}
      </div>

      {(action || secondaryAction) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action && (
            <Button
              variant={mainVariant}
              size="sm"
              icon={action.icon}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button
              variant={secondaryAction.variant ?? 'ghost'}
              size="sm"
              icon={secondaryAction.icon}
              disabled={secondaryAction.disabled}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}

      {docHref && (
        <a
          href={docHref}
          target="_blank"
          rel="noreferrer"
          className="rounded-sm text-primary underline-offset-2 hover:underline
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{ fontSize: 'var(--kb-text-meta)' }}
        >
          {docLabel ?? tr('ui.learn_more')}
        </a>
      )}
    </div>
  )
}
