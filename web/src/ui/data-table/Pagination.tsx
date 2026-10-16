import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import type { TFunction } from 'i18next'
import { uiT } from '../uiText'

export interface PaginationProps {
  /** 0-based. The two hand-rolled admin paginations disagreed on this (one was
   *  0-based, the other 1-based); the component settles it - 0-based in the API,
   *  1-based in what the user reads. */
  page:      number
  pageCount: number
  total:     number
  pageSize:  number
  pageSizeOptions?: number[]
  onPageChange:     (page: number) => void
  onPageSizeChange?: (size: number) => void
  /** Narrow container: drop the size selector and the first/last jumps. */
  compact?: boolean
  t?: TFunction
}

const NAV_BTN =
  'flex h-7 w-7 items-center justify-center rounded-md text-text-secondary transition-colors ' +
  'hover:bg-surface-2 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'disabled:pointer-events-none disabled:opacity-40'

/** The single pagination bar - always inside the table's own footer band. */
export function Pagination({
  page, pageCount, total, pageSize, pageSizeOptions,
  onPageChange, onPageSizeChange, compact = false, t,
}: PaginationProps) {
  const tr = uiT(t)
  const first = total === 0 ? 0 : page * pageSize + 1
  const last  = Math.min((page + 1) * pageSize, total)

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
      // Body size, like the header and the cells - the footer carries controls
      // (page size, navigation), not a caption.
      style={{ fontSize: 'var(--kb-text-body)' }}
    >
      <div className="flex items-center gap-3 text-text-secondary">
        {/* Page size as a radio GROUP, not a select. Three or four values do not
            justify a popup - one click instead of two - and, decisively, it is
            fully token-driven: `@ui`'s Dropdown paints its trigger text with a
            hard-coded `#202124`, which vanishes on a dark theme's surface.
            Hidden when the container is narrow (the count alone is enough). */}
        {!compact && onPageSizeChange && pageSizeOptions && pageSizeOptions.length > 1 && (
          <span className="flex items-center gap-1.5" role="radiogroup" aria-label={tr('ui.dt_rows_per_page')}>
            <span>{tr('ui.dt_rows_per_page')}</span>
            <span className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
              {pageSizeOptions.map(n => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={n === pageSize}
                  onClick={() => onPageSizeChange(n)}
                  className={`rounded-sm px-1.5 py-0.5 tabular-nums transition-colors
                              focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    n === pageSize
                      ? 'bg-surface-0 text-primary'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {n}
                </button>
              ))}
            </span>
          </span>
        )}
        <span className="tabular-nums">{first}–{last} / {total}</span>
      </div>

      <div className="flex items-center gap-0.5">
        {!compact && (
          <button
            type="button" className={NAV_BTN} disabled={page <= 0}
            aria-label={`${tr('ui.dt_page')} 1`}
            onClick={() => onPageChange(0)}
          >
            <ChevronsLeft size={15} />
          </button>
        )}
        <button
          type="button" className={NAV_BTN} disabled={page <= 0}
          aria-label={tr('ui.dt_prev_page')}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={15} />
        </button>
        <span className="px-2 tabular-nums text-text-secondary">
          {page + 1} / {Math.max(1, pageCount)}
        </span>
        <button
          type="button" className={NAV_BTN} disabled={page >= pageCount - 1}
          aria-label={tr('ui.dt_next_page')}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={15} />
        </button>
        {!compact && (
          <button
            type="button" className={NAV_BTN} disabled={page >= pageCount - 1}
            aria-label={`${tr('ui.dt_page')} ${Math.max(1, pageCount)}`}
            onClick={() => onPageChange(pageCount - 1)}
          >
            <ChevronsRight size={15} />
          </button>
        )}
      </div>
    </div>
  )
}
