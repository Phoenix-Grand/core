/**
 * The trail that says where you are.
 *
 * Extracted from the file explorer's breadcrumb, which was the only one in the
 * product built as a component rather than as three spans in a page. Both now
 * render this: a second implementation would drift on the first hover colour
 * somebody adjusted, and a console whose trail looks different depending on the
 * screen is a console that teaches people to stop reading it.
 *
 * ## What it is, and what it is not
 *
 * It is a *navigation* landmark: `<nav>` labelled, an ordered list, the last
 * item marked `aria-current="page"` and deliberately NOT a link - you do not
 * navigate to where you already are. The chevrons are decoration and carry
 * `aria-hidden`, so a screen reader announces "Annuaire, lien - Utilisateurs,
 * page actuelle" rather than spelling out punctuation.
 *
 * It is not a back button. A back button answers "undo my last step"; a trail
 * answers "what contains this". Where a page offers both, the trail is the one
 * that survives arriving from a link.
 *
 * ## Collapsing
 *
 * Past `maxVisible` segments the middle is replaced by a `…` button that opens
 * the hidden ones - the first and the last two always stay. Wrapping onto a
 * second line was the alternative and it is worse: the trail sits in a fixed
 * bar, and a second line pushes the page's content down by a row that appears
 * and disappears as somebody navigates.
 */
import { useState, type ReactNode } from 'react'
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import { MenuDropdown, type MenuItem } from './MenuDropdown'

export interface Crumb {
  /** What the segment reads as. */
  label: ReactNode
  /**
   * Where it goes. A real `href` when there is one - a trail is made of links,
   * and a link somebody cannot open in a new tab is a button in disguise.
   */
  href?: string
  /** Called instead of following `href` (which is then prevented). */
  onClick?: () => void
  /** Rendered before the label - a home glyph on the root, a folder, an avatar. */
  icon?: ReactNode
  /** Plain-text form, for the collapsed menu and the tooltip. */
  title?: string
}

export interface BreadcrumbProps {
  /** Root first, current page last. The last one is never a link. */
  items: Crumb[]
  /** Names the landmark. Give it the translated "Fil d'Ariane". */
  ariaLabel?: string
  /**
   * How many segments stay visible before the middle collapses. Below 3 the
   * collapse cannot help - first and last already fill it.
   */
  maxVisible?: number
  /** Rendered after the trail, on the same line (an action, a picker…). */
  trailing?: ReactNode
  className?: string
  /** Longest a single segment may grow before it truncates. */
  maxSegmentWidth?: string
  /**
   * Scale of the trail. `lg` turns it into the page's heading - which is what
   * the file explorer's trail actually is - without touching the consoles that
   * render it as a secondary line.
   */
  size?: 'sm' | 'lg'
}

const LINK_BASE =
  'inline-flex items-center transition-colors rounded-sm outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-primary'

export function BreadcrumbBase({
  items,
  ariaLabel,
  maxVisible = 4,
  trailing,
  className = '',
  maxSegmentWidth = '14rem',
  size = 'sm',
}: BreadcrumbProps) {
  const large = size === 'lg'
  // At heading size the medium weight reads as bold; the reference trail is set
  // in the regular face.
  const TEXT = large ? 'text-2xl font-normal' : 'text-sm font-medium'
  const LINK = `${LINK_BASE} ${TEXT} text-text-secondary hover:text-primary`
  const chevron = large ? 20 : 14
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  if (items.length === 0) return null

  // First, then the last two: enough to say where you came from and where you
  // are, which is what somebody scanning a collapsed trail is looking for.
  const collapsed = items.length > maxVisible
  const hidden = collapsed ? items.slice(1, items.length - 2) : []
  const shown = collapsed ? [items[0], ...items.slice(items.length - 2)] : items
  const collapseAfter = collapsed ? 0 : -1

  const hiddenItems: MenuItem[] = hidden.map(crumb => ({
    type: 'action',
    label: crumb.title ?? (typeof crumb.label === 'string' ? crumb.label : ''),
    icon: crumb.icon,
    onClick: () => {
      setMenu(null)
      crumb.onClick?.()
      if (!crumb.onClick && crumb.href) window.location.assign(crumb.href)
    },
  }))

  const segment = (crumb: Crumb, isLast: boolean) => {
    const content = (
      <>
        {crumb.icon && <span className="me-1.5 inline-flex shrink-0">{crumb.icon}</span>}
        <span className="truncate" style={{ maxWidth: maxSegmentWidth }}>{crumb.label}</span>
      </>
    )
    // The page you are on is not a destination.
    if (isLast) {
      return (
        <span
          className={`inline-flex items-center ${TEXT} text-text-primary`}
          title={crumb.title}
        >
          {content}
        </span>
      )
    }
    if (crumb.href) {
      return (
        <a
          href={crumb.href}
          title={crumb.title}
          className={LINK}
          onClick={e => {
            if (!crumb.onClick) return
            // A modified click is somebody asking for a new tab; let the anchor
            // do its job instead of hijacking it into a client-side navigation.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
            e.preventDefault()
            crumb.onClick()
          }}
        >
          {content}
        </a>
      )
    }
    return (
      <button type="button" className={LINK} title={crumb.title} onClick={crumb.onClick}>
        {content}
      </button>
    )
  }

  return (
    <nav className={`flex min-w-0 items-center ${className}`} aria-label={ariaLabel}>
      <ol className="inline-flex min-w-0 items-center gap-1.5">
        {shown.map((crumb, index) => {
          const isLast = index === shown.length - 1
          return (
            <li key={index} className="inline-flex min-w-0 items-center gap-1.5" aria-current={isLast ? 'page' : undefined}>
              {index > 0 && <ChevronRight size={chevron} aria-hidden="true" className="shrink-0 text-text-tertiary" />}
              {segment(crumb, isLast)}
              {index === collapseAfter && (
                <>
                  <ChevronRight size={chevron} aria-hidden="true" className="shrink-0 text-text-tertiary" />
                  <button
                    type="button"
                    aria-label={`${hidden.length}`}
                    title={hidden.map(c => c.title ?? c.label).join(' › ')}
                    className={`${LINK} px-0.5`}
                    onClick={e => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setMenu({ x: r.left, y: r.bottom + 4 })
                    }}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ol>

      {trailing}

      {menu && (
        <MenuDropdown items={hiddenItems} pos={{ top: menu.y, left: menu.x }} onClose={() => setMenu(null)} />
      )}
    </nav>
  )
}
