import { endOfMonth, formatDate, isValidDate, startOfMonth, toISODate, toISOMonth } from '../../core/intl/datetime'
import { useEffect, useState } from 'react'
import { ExtensionRegistry } from '../../core/registry/ExtensionRegistry'
import { CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '../../core/registry/calendarOverlay'
import { DATEPICKER_DAY_PANEL } from '../../core/registry/datepickerDayPanel'

/** True when a module (calendar) has registered a day-panel provider. */
export function hasDayPanel(): boolean {
  return ExtensionRegistry.getAll(DATEPICKER_DAY_PANEL).length > 0
}

function dayProviders(): CalendarOverlayProvider[] {
  // Calendar's own events + whatever overlays the calendar grid (tasks…): the
  // panel shows « events OR tasks » for the day.
  return [
    ...ExtensionRegistry.getAll<CalendarOverlayProvider>(DATEPICKER_DAY_PANEL),
    ...ExtensionRegistry.getAll<CalendarOverlayProvider>(CALENDAR_OVERLAY),
  ]
}

/**
 * Right-hand column of the picker (shown only when `hasDayPanel()`): the events
 * and tasks of the focused day (the hovered cell, else the selected value). The
 * items of the whole visible MONTH are fetched once and filtered per day on the
 * client, so hovering across days never re-hits the network.
 */
export function DayPanel({ date }: { date: Date }) {
  const valid    = isValidDate(date)
  const monthKey = valid ? toISOMonth(date) : ''
  const ymd      = valid ? toISODate(date) : ''

  const [cache, setCache] = useState<{ key: string; items: CalendarOverlayItem[] } | null>(null)

  useEffect(() => {
    if (!valid) return
    let alive = true
    const from = startOfMonth(date).toISOString()
    const to   = endOfMonth(date).toISOString()
    const providers = dayProviders()
    Promise.all(providers.map(p => p.fetch(from, to).catch(() => [] as CalendarOverlayItem[])))
      .then(lists => { if (alive) setCache({ key: monthKey, items: lists.flat() }) })
    return () => { alive = false }
    // Re-fetch only when the visible month changes; day hover just re-filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey])

  const loaded   = cache?.key === monthKey
  const dayItems = loaded ? cache!.items.filter(it => it.date === ymd) : []

  const dayNum   = valid ? String(date.getDate()) : ''
  const weekday  = valid ? formatDate(date, 'weekday') : ''
  const monthLbl = valid ? formatDate(date, 'monthYear') : ''

  return (
    <div className="flex flex-col" style={{ width: 240 }}>
      {/* Focused day header */}
      <div className="px-3 pt-3 pb-2 border-b border-border flex-shrink-0">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-text-primary leading-none">{dayNum}</span>
          <span className="text-sm text-text-secondary capitalize">{weekday}</span>
        </div>
        <div className="text-xs text-text-tertiary capitalize mt-0.5">{monthLbl}</div>
      </div>

      {/* Events / tasks of that day */}
      <div className="flex-1 overflow-y-auto p-2 min-h-0" style={{ maxHeight: 300 }}>
        {!loaded ? (
          <div className="text-xs text-text-tertiary px-1 py-3">Loading…</div>
        ) : dayItems.length === 0 ? (
          <div className="text-xs text-text-tertiary px-1 py-6 text-center">No events</div>
        ) : (
          <ul className="space-y-0.5">
            {dayItems.map(it => (
              <li key={it.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-2 transition-colors">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: it.color ?? '#5f6368' }} />
                <span className={`text-xs truncate ${it.done ? 'line-through text-text-tertiary' : 'text-text-primary'}`}>
                  {it.title}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
