import { cn } from '../cn'
import { isBefore } from '../../core/intl/datetime'
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, Clock, X } from 'lucide-react'
import { PickerPopover } from './PickerPopover'
import { DayPanel, hasDayPanel } from './DayPanel'
import { computePos, formatDisplay, parseDateValue, popoverSize, toISOValue } from './helpers'
import type { DatePickerProps, PickerView } from './types'
import { useModulesStore } from '../../core/store/modulesStore'

// Extra width taken by the day panel column (matches DayPanel + its 1px border).
const DAY_PANEL_W = 241

export function DatePicker({
  mode = 'date',
  value,
  onChange,
  startValue,
  endValue,
  onRangeChange,
  label,
  placeholder,
  disabled = false,
  readOnly = false,
  clearable = false,
  required,
  error,
  hint,
  minDate,
  maxDate,
  disabledDate,
  minuteStep = 5,
  size = 'md',
  className,
  id,
  name,
}: DatePickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef     = useRef<HTMLDivElement>(null)

  const [open,     setOpen]     = useState(false)
  const [view,     setView]     = useState<PickerView>('day')
  const [viewDate, setViewDate] = useState<Date>(new Date)

  // Parsed values
  const selectedDate = useMemo(() => parseDateValue(value, mode), [value, mode])
  const rangeStart   = useMemo(() => parseDateValue(startValue, 'date'), [startValue])
  const rangeEnd     = useMemo(() => parseDateValue(endValue,   'date'), [endValue])

  // Time state (hours / minutes - kept in local state, committed on every change)
  const [hours,   setHoursLocal]   = useState(() => selectedDate?.getHours()   ?? 0)
  const [minutes, setMinutesLocal] = useState(() => selectedDate?.getMinutes() ?? 0)

  // Range picking state
  const [rangePhase,  setRangePhase]  = useState<'first' | 'second'>('first')
  const [localRangeS, setLocalRangeS] = useState<Date | null>(null)
  const [hoverDate,   setHoverDate]   = useState<Date | null>(null)
  const [pos,         setPos]         = useState({ top: 0, left: 0 })

  // Calendar module extension: a right-hand column listing the focused day's
  // events/tasks. Single-day date modes only. `loadedVersion` re-evaluates it when
  // a module bundle registers late (the registry itself is not reactive).
  const loadedVersion = useModulesStore(s => s.loadedVersion)
  const panelActive = useMemo(
    () => (mode === 'date' || mode === 'datetime') && hasDayPanel(),
    [mode, loadedVersion],
  )

  const inputId = id ?? (typeof label === 'string' ? label.toLowerCase().replace(/\s+/g, '-') : undefined)

  // ── Display text ───────────────────────────────────────────────────────────
  const displayText = useMemo(() => {
    if (mode === 'daterange') {
      const s = rangeStart
      const e = rangeEnd
      if (!s) return ''
      if (!e) return formatDisplay(s, 'date')
      return `${formatDisplay(s, 'date')} – ${formatDisplay(e, 'date')}`
    }
    return formatDisplay(selectedDate, mode)
  }, [mode, selectedDate, rangeStart, rangeEnd])

  // ── Open ───────────────────────────────────────────────────────────────────
  const openPicker = useCallback(() => {
    if (disabled || readOnly) return
    const trigger = triggerRef.current
    if (!trigger) return

    const base = popoverSize(mode)
    const popW = base.w + (panelActive ? DAY_PANEL_W : 0)
    setPos(computePos(trigger, base.h, popW))

    // Sync viewDate
    const anchor = mode === 'daterange'
      ? (rangeStart ?? new Date())
      : (selectedDate ?? new Date())
    setViewDate(anchor)
    setView('day')

    // Sync time
    if (selectedDate && (mode === 'time' || mode === 'datetime')) {
      setHoursLocal(selectedDate.getHours())
      setMinutesLocal(selectedDate.getMinutes())
    }

    // Range phase
    if (mode === 'daterange') {
      setRangePhase('first')
      setLocalRangeS(null)
      setHoverDate(null)
    }

    setOpen(true)
  }, [disabled, readOnly, mode, selectedDate, rangeStart, panelActive])

  // ── Close on outside click / Escape ───────────────────────────────────────
  //
  // ⚠️ In the CAPTURE phase, and that is not a detail. React attaches its
  // listeners at the root container, so a `stopPropagation()` in any ancestor's
  // `onMouseDown` - a floating window stops one, to decide which window a press
  // raises - kills the native event before `document` ever sees it. Listening in
  // the bubble phase meant the panel simply never closed inside a window: it
  // stayed open, and the field stayed lit, which reads as a field that will not
  // let go. Capture runs from the document down, so nothing below can silence it.
  useEffect(() => {
    if (!open) return
    const onMouse = (e: MouseEvent) => {
      if (
        popRef.current     && !popRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onMouse, true)
    document.addEventListener('keydown',   onKey)
    return () => {
      document.removeEventListener('mousedown', onMouse, true)
      document.removeEventListener('keydown',   onKey)
    }
  }, [open])

  // ── Date selection handler ─────────────────────────────────────────────────
  const handleSelectDate = useCallback((d: Date) => {
    if (mode === 'daterange') {
      if (rangePhase === 'first') {
        setLocalRangeS(d)
        setRangePhase('second')
        onRangeChange?.(toISOValue(d, 'date'), null)
      } else {
        const anchor = localRangeS ?? d
        const [lo, hi] = isBefore(anchor, d) ? [anchor, d] : [d, anchor]
        onRangeChange?.(toISOValue(lo, 'date'), toISOValue(hi, 'date'))
        setOpen(false)
      }
      return
    }

    if (mode === 'date') {
      onChange?.(toISOValue(d, 'date'))
      setOpen(false)
      return
    }

    if (mode === 'datetime') {
      const result = new Date(d)
      result.setHours(hours, minutes, 0, 0)
      onChange?.(toISOValue(result, 'datetime'))
      // Stay open for time adjustment
    }
  }, [mode, rangePhase, localRangeS, hours, minutes, onChange, onRangeChange])

  // ── Time commit helpers ────────────────────────────────────────────────────
  const commitTime = useCallback((h: number, m: number) => {
    const base = mode === 'datetime'
      ? (selectedDate ? new Date(selectedDate) : new Date())
      : new Date()
    base.setHours(h, m, 0, 0)
    onChange?.(toISOValue(base, mode))
  }, [mode, selectedDate, onChange])

  const handleHours = useCallback((h: number) => {
    setHoursLocal(h)
    commitTime(h, minutes)
  }, [minutes, commitTime])

  const handleMinutes = useCallback((m: number) => {
    setMinutesLocal(m)
    commitTime(hours, m)
  }, [hours, commitTime])

  // ── Clear ──────────────────────────────────────────────────────────────────
  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (mode === 'daterange') onRangeChange?.(null, null)
    else onChange?.(null)
  }

  // Footer of the time modes: guarantee a value even if no day was clicked.
  const handleConfirm = () => {
    if (!value) {
      const base = (mode === 'datetime' && selectedDate) ? new Date(selectedDate) : new Date()
      base.setHours(hours, minutes, 0, 0)
      onChange?.(toISOValue(base, mode))
    }
    setOpen(false)
  }

  // ── Render helpers ─────────────────────────────────────────────────────────
  const hasValue    = mode === 'daterange' ? !!(startValue || endValue) : !!value
  const showClear   = clearable && hasValue && !disabled && !readOnly
  const triggerH    = size === 'sm' ? 'h-7 text-sm' : 'h-9 text-sm'
  const triggerIcon = mode === 'time' ? <Clock size={14} /> : <Calendar size={14} />

  const defaultPH = {
    date:      'jj/mm/aaaa',
    time:      'hh:mm',
    datetime:  'jj/mm/aaaa hh:mm',
    daterange: 'jj/mm/aaaa – jj/mm/aaaa',
  }[mode]

  const hourValues   = Array.from({ length: 24 }, (_, i) => i)
  const minuteValues = Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep)

  const showCalendar = mode !== 'time'
  const showTime     = mode === 'time' || mode === 'datetime'
  const popW         = popoverSize(mode).w + (panelActive ? DAY_PANEL_W : 0)
  // Day the panel describes: the hovered cell, else the selected value, else the
  // month being viewed.
  const focusedDate  = hoverDate ?? selectedDate ?? viewDate

  const effectiveRangeStart = localRangeS ?? rangeStart
  const effectiveRangeEnd   = localRangeS ? null : rangeEnd

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
          {label}{required && <span className="text-danger ml-0.5">*</span>}
        </label>
      )}

      <div className="relative">
        {name && <input type="hidden" name={name} value={value ?? ''} readOnly />}

        <button
          ref={triggerRef}
          id={inputId}
          type="button"
          onClick={openPicker}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            'w-full flex items-center gap-2 px-3 rounded border bg-white text-left',
            'transition-colors kb-field-focus',
            /* Open by mouse: the trigger has the focus but not `:focus-visible`,
               so the stroke has to be asked for explicitly - the panel below is
               this field's, and the field must say so. */
            open && 'kb-field-focus--on',
            error ? 'border-danger kb-field-focus-danger' : 'border-border',
            disabled && 'bg-surface-2 cursor-not-allowed opacity-60',
            readOnly && 'cursor-default',
            triggerH,
          )}
        >
          <span className="text-text-tertiary shrink-0">{triggerIcon}</span>
          <span className={cn('flex-1 truncate', displayText ? 'text-text-primary' : 'text-text-tertiary')}>
            {displayText || (placeholder ?? defaultPH)}
          </span>
          {showClear ? (
            <button
              type="button"
              onClick={handleClear}
              className="shrink-0 text-text-tertiary hover:text-text-primary transition-colors"
              tabIndex={-1}
            >
              <X size={13} />
            </button>
          ) : null}
        </button>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}
      {hint && !error && <p className="text-xs text-text-secondary">{hint}</p>}

      {open && createPortal(
        <PickerPopover
          popRef={popRef}
          pos={pos}
          width={popW}
          showCalendar={showCalendar}
          showTime={showTime}
          viewDate={viewDate}
          setViewDate={setViewDate}
          view={view}
          setView={setView}
          selected={selectedDate}
          onSelectDate={handleSelectDate}
          rangeStart={effectiveRangeStart}
          rangeEnd={effectiveRangeEnd}
          hoverDate={hoverDate}
          setHoverDate={setHoverDate}
          isRange={mode === 'daterange'}
          minDate={minDate}
          maxDate={maxDate}
          disabledDate={disabledDate}
          hourValues={hourValues}
          minuteValues={minuteValues}
          hours={hours}
          minutes={minutes}
          onHours={handleHours}
          onMinutes={handleMinutes}
          showClear={showClear}
          onClear={(e) => { handleClear(e); setOpen(false) }}
          onConfirm={handleConfirm}
          dayPanel={panelActive ? <DayPanel date={focusedDate} /> : undefined}
        />,
        document.body,
      )}
    </div>
  )
}
