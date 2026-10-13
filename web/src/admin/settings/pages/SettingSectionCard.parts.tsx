/**
 * The parts of `SettingSectionCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ChevronDown } from "lucide-react"
import type { SettingSectionCard } from './SettingSectionCard'

export function Part1({ onToggle, open, bodyId, icon, title, description, status }: { onToggle: NonNullable<SettingSectionCard['props']['onToggle']>; open: NonNullable<SettingSectionCard['props']['open']>; bodyId: NonNullable<SettingSectionCard['bodyId']>; icon: NonNullable<SettingSectionCard['props']['icon']>; title: SettingSectionCard['props']['title']; description: NonNullable<SettingSectionCard['props']['description']>; status: NonNullable<SettingSectionCard['props']['status']> }) {
  return (
    <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={bodyId}
            className="flex w-full min-w-0 items-center gap-4 rounded-xl px-5 py-4 text-left transition-colors
                       hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {icon && <span className="shrink-0 text-text-secondary">{icon}</span>}
            <span className="min-w-0 flex-1">
              <span
                className="block truncate font-medium text-text-primary"
                style={{ fontSize: 'var(--kb-text-heading)' }}
              >
                {title}
              </span>
              {description != null && (
                <span
                  className="mt-1 block leading-relaxed text-text-secondary"
                  style={{ fontSize: 'var(--kb-text-meta)' }}
                >
                  {description}
                </span>
              )}
            </span>
            {status != null && (
              <span
                className="hidden shrink-0 text-right text-text-secondary sm:block"
                style={{ fontSize: 'var(--kb-text-meta)' }}
              >
                {status}
              </span>
            )}
            <ChevronDown
              size={18}
              aria-hidden
              className={`shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </button>
  )
}

export function Part2({ bodyId, aside, children, footer }: { bodyId: NonNullable<SettingSectionCard['bodyId']>; aside: NonNullable<SettingSectionCard['props']['aside']>; children: SettingSectionCard['props']['children']; footer: SettingSectionCard['props']['footer'] }) {
  return (
    <div id={bodyId}>
              <div className="md:flex md:items-start">
                {aside != null && (
                  // The rows carry their own `px-5`, so the right column takes none:
                  // that is what keeps each row's hairline running the full width of
                  // the column instead of stopping short of it.
                  <div className="border-t border-border px-5 py-4 md:w-[285px] md:shrink-0">
                    {aside}
                  </div>
                )}
                <div className="min-w-0 md:flex-1">{children}</div>
              </div>
              {footer}
            </div>
  )
}
