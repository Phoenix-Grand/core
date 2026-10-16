/**
 * Marks a file whose earlier revisions are still stored - and still charged to
 * the owner's quota.
 *
 * Without it the accounting is invisible: somebody saves a document twenty
 * times, sees one 2 MB file in the listing, and is billed for 40. Every other
 * surface that states the figure (the details panel, the item menu, the storage
 * page) has to be opened first, which only helps a person who already suspects
 * there is something to look for. This is the one place that tells the people
 * who do not.
 *
 * Deliberately inert. A click handler here would swallow the `pointerdown` the
 * card needs to start a marquee selection, and `pointer-events: none` would
 * take away the tooltip that carries the weight - so the badge shows, and
 * reclaiming the space stays where it can be confirmed properly (context menu,
 * details panel).
 *
 * Translated from the `drive` namespace, like everything else in this explorer:
 * the strings belong to the module that owns version histories, not to the
 * shell that renders its rows. `defaultValue` covers the case of an explorer
 * mounted by a module that never loaded those translations (a file picker).
 */
import { useTranslation } from 'react-i18next'
import { History } from 'lucide-react'
import { formatSize, type FileItem } from '../api'

/**
 * Revisions a file must keep before the badge appears.
 *
 * One, and it cannot be anything else: `version_count` excludes the current
 * content, so a file at 1 already holds one revision that costs the account
 * quota. A threshold of 2 would charge for a revision and hide it in the same
 * breath.
 */
const MIN_VERSIONS_SHOWN = 1

export function VersionBadge({
  file, variant,
}: {
  file: FileItem
  /** `overlay` sits on the card's preview; `inline` follows the name in a row. */
  variant: 'overlay' | 'inline'
}) {
  const { t } = useTranslation('drive')
  const count = file.version_count ?? 0
  if (count < MIN_VERSIONS_SHOWN) return null

  const title = t('version.badge_title', {
    count,
    size: formatSize(file.version_bytes ?? 0),
    defaultValue: '{{count}} earlier versions · {{size}} counted against your quota',
  })

  // An opaque chip rather than a translucent overlay: the badge lands on photo
  // thumbnails as often as on white icon backgrounds, and only a solid one
  // stays legible on both.
  const base =
    'inline-flex items-center gap-0.5 rounded-full border border-border bg-surface-1 ' +
    'text-text-secondary font-medium shrink-0 select-none'

  return (
    <span
      title={title}
      aria-label={title}
      className={
        variant === 'overlay'
          ? `${base} absolute top-1 left-1 z-10 px-1.5 py-0.5 text-[10px] leading-none shadow-sm`
          : `${base} px-1 py-px text-[10px] leading-none`
      }
    >
      <History size={10} className="shrink-0" />
      {count}
    </span>
  )
}
