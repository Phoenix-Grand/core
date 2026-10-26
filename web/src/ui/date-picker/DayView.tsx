import { cn } from '../cn'
import { addMonths, formatDate, isSameDay, isSameMonth, isToday, subMonths } from '../../core/intl/datetime'
import type { Dispatch, SetStateAction } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { weekdayLabels, calendarGrid } from './helpers'
import { useUiLocale } from '../useUiLocale'
import type { PickerView } from './types'

/** Month grid: weekday headers + day cells (single date, or range highlight). */
export function DayView({
  viewDate, setViewDate, setView,
  selected, onSelect, setHoverDate,
  isRange, isDisabled, inRange, isEdge,
}: {
  viewDate:     Date
  setViewDate:  Dispatch<SetStateAction<Date>>
  setView:      Dispatch<SetStateAction<PickerView>>
  selected:     Date | null
  onSelect:     (d: Date) => void
  setHoverDate?: (d: Date | null) => void
  isRange:      boolean
  isDisabled:   (d: Date) => boolean
  inRange:      (d: Date) => boolean
  isEdge:       (d: Date) => boolean | null
}) {
  const weekdays = weekdayLabels(useUiLocale())
  const days = calendarGrid(viewDate)
  const mName = formatDate(viewDate, 'month')
  const mNameCap = mName.charAt(0).toUpperCase() + mName.slice(1)

  return (
    <div>
      {/* Navigation header */}
      <div className="flex items-center gap-1 mb-2">
        <button
          type="button"
          onClick={() => setViewDate(subMonths(viewDate, 1))}
          className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-2 text-text-secondary transition-colors"
        >
          <ChevronLeft size={14} />
        </button>
        <div className="flex-1 flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={() => setView('month')}
            className="text-sm font-semibold text-text-primary hover:text-primary transition-colors px-1 rounded hover:bg-surface-1"
          >
            {mNameCap}
          </button>
          <button
            type="button"
            onClick={() => setView('year')}
            className="text-sm font-semibold text-text-primary hover:text-primary transition-colors px-1 rounded hover:bg-surface-1"
          >
            {viewDate.getFullYear()}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setViewDate(addMonths(viewDate, 1))}
          className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-2 text-text-secondary transition-colors"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 mb-0.5">
        {weekdays.map((d, i) => (
          <div key={i} className="h-7 flex items-center justify-center text-[11px] font-medium text-text-tertiary">
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7" onMouseLeave={() => setHoverDate?.(null)}>
        {days.map((d, i) => {
          const inM  = isSameMonth(d, viewDate)
          const sel  = !isRange && selected && isSameDay(d, selected)
          const edge = isEdge(d)
          const inR  = inRange(d)
          const dis  = isDisabled(d)
          const tod  = isToday(d)

          return (
            <button
              key={i}
              type="button"
              disabled={dis}
              onClick={() => !dis && onSelect(d)}
              onMouseEnter={() => setHoverDate?.(d)}
              className={cn(
                'h-8 w-8 mx-auto flex items-center justify-center text-xs font-medium transition-colors',
                // Edges and selected: full circle
                (sel || edge) ? 'rounded-full bg-primary text-white' : '',
                // In range: square highlight (no rounding)
                !sel && !edge && inR ? 'bg-primary/10 text-primary' : '',
                // Regular states
                !sel && !edge && !inR && !dis && tod  ? 'rounded-full border border-primary text-primary hover:bg-primary-light' : '',
                !sel && !edge && !inR && !dis && !tod && inM  ? 'rounded-full text-text-primary hover:bg-surface-2' : '',
                !sel && !edge && !inR && !dis && !tod && !inM ? 'rounded-full text-text-tertiary hover:bg-surface-2' : '',
                dis ? 'opacity-30 cursor-not-allowed rounded-full' : '',
              )}
            >
              {String(d.getDate())}
            </button>
          )
        })}
      </div>
    </div>
  )
}
