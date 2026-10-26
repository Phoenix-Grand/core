import type React from 'react'
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react'
import { CalendarView } from './CalendarView'
import { TimeScroll } from './TimeScroll'
import type { PickerView } from './types'

/**
 * Floating panel of the picker: calendar, time columns and the footer used by
 * the time-bearing modes. Purely presentational - every value and handler is
 * owned by `DatePicker`.
 */
export function PickerPopover({
  popRef, pos, width,
  showCalendar, showTime,
  viewDate, setViewDate, view, setView,
  selected, onSelectDate,
  rangeStart, rangeEnd, hoverDate, setHoverDate,
  isRange, minDate, maxDate, disabledDate,
  hourValues, minuteValues, hours, minutes, onHours, onMinutes,
  showClear, onClear, onConfirm, dayPanel,
}: {
  popRef:        RefObject<HTMLDivElement | null>
  pos:           { top: number; left: number }
  width:         number
  showCalendar:  boolean
  showTime:      boolean

  viewDate:      Date
  setViewDate:   Dispatch<SetStateAction<Date>>
  view:          PickerView
  setView:       Dispatch<SetStateAction<PickerView>>
  selected:      Date | null
  onSelectDate:  (d: Date) => void
  rangeStart?:   Date | null
  rangeEnd?:     Date | null
  hoverDate?:    Date | null
  setHoverDate?: (d: Date | null) => void
  isRange:       boolean
  minDate?:      string
  maxDate?:      string
  disabledDate?: (d: Date) => boolean

  hourValues:    number[]
  minuteValues:  number[]
  hours:         number
  minutes:       number
  onHours:       (h: number) => void
  onMinutes:     (m: number) => void

  showClear:     boolean
  onClear:       (e: React.MouseEvent) => void
  onConfirm:     () => void
  /** Optional right-hand column (calendar module: the focused day's events/tasks). */
  dayPanel?:     ReactNode
}) {
  return (
    <div
      ref={popRef}
      role="dialog"
      style={{ position: 'absolute', top: pos.top, left: pos.left, width, zIndex: 9999 }}
      className="bg-white rounded-xl shadow-2xl border border-border flex items-stretch"
    >
      {/* Calendar (+ time) column - fixed width when a day panel sits beside it. */}
      <div className="p-3 select-none flex-shrink-0" style={dayPanel ? { width: 284 } : undefined}>
        {showCalendar && (
          <CalendarView
            viewDate={viewDate}
            setViewDate={setViewDate}
            view={view}
            setView={setView}
            selected={selected}
            onSelect={onSelectDate}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            hoverDate={hoverDate}
            setHoverDate={setHoverDate}
            isRange={isRange}
            minDate={minDate}
            maxDate={maxDate}
            disabledDate={disabledDate}
          />
        )}

        {showCalendar && showTime && (
          <div className="my-3 h-px bg-border" />
        )}

        {showTime && (
          <div className="flex items-start justify-center gap-1">
            <TimeScroll
              values={hourValues}
              selected={hours}
              onSelect={onHours}
              label="Hour"
            />
            <span className="mt-8 text-text-tertiary text-base font-semibold">:</span>
            <TimeScroll
              values={minuteValues}
              selected={minuteValues.includes(minutes) ? minutes : minuteValues.reduce((a, b) => Math.abs(b - minutes) < Math.abs(a - minutes) ? b : a)}
              onSelect={onMinutes}
              label="Min"
            />
          </div>
        )}

        {/* Footer: explicit confirmation for the modes carrying a time.
            The value is already applied continuously; these buttons only
            confirm/close (and guarantee a value when the user touched the
            time only, or nothing at all). */}
        {showTime && (
          <div className="flex items-center justify-between gap-2 pt-3 mt-1 border-t border-border">
            {showClear ? (
              <button
                type="button"
                onClick={onClear}
                className="text-xs text-text-secondary hover:text-danger transition-colors"
              >
                Clear
              </button>
            ) : <span />}
            <button
              type="button"
              onClick={onConfirm}
              className="text-xs font-medium px-4 py-1.5 rounded bg-primary text-white hover:bg-primary-hover transition-colors"
            >
              OK
            </button>
          </div>
        )}
      </div>

      {/* Right column: the calendar module's events/tasks for the focused day. */}
      {dayPanel && (
        <div className="border-l border-border flex-shrink-0 self-stretch">{dayPanel}</div>
      )}
    </div>
  )
}
