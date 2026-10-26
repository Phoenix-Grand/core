// Shared @ui primitive: a split date field, Google-Contacts style - a leading
// icon, then Day / Month (dropdown) / Year(optional), and an optional editable
// "Libellé" combobox. Used both for a birthday (cake icon) and a generic date
// (calendar icon). The month is stored 1–12; day and year are free numeric
// strings; the year is optional. Nothing here parses into a real Date - the
// consumer decides how to interpret a partial date.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Calendar, ChevronDown, ChevronUp } from 'lucide-react'
import { OutlinedField } from './OutlinedField'
import { LabelCombobox } from './LabelCombobox'
import { monthLabels } from './date-picker/helpers'
import { useUiLocale } from './useUiLocale'

export interface DateValue {
  day: string
  /** Month as "1".."12", or "" when unset. */
  month: string
  /** Optional year. */
  year: string
  label?: string
}

export interface DateFieldProps {
  value: DateValue
  onChange: (v: DateValue) => void
  primaryColor: string
  /** Leading icon; defaults to a calendar (pass a cake for a birthday). Pass
   * `null` to omit it when the consumer already has its own icon gutter. */
  icon?: ReactNode
  withLabel?: boolean
  labelPresets?: string[]
  large?: boolean
  /** Accepted year range. A birthday passes maxYear = current year. */
  minYear?: number
  maxYear?: number
}

/** Days in a month; leap-friendly 29 for February while the year is unknown. */
function daysInMonth(month: string, year: string): number {
  const m = Number(month)
  if (!m) return 31
  if (m === 2) {
    if (year.length === 4) {
      const y = Number(year)
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
      return leap ? 29 : 28
    }
    return 29
  }
  return [4, 6, 9, 11].includes(m) ? 30 : 31
}

/** Is `typed` a prefix of at least one integer in [min, max]? Blocks impossible
 * values AT THE KEYSTROKE: for a birthday (1900–today) even a leading "9"
 * is refused, since no acceptable year starts with it. */
function isYearPrefix(typed: string, min: number, max: number): boolean {
  if (typed.length === 0) return true
  if (typed.length >= 4) { const y = Number(typed); return y >= min && y <= max }
  for (let y = min; y <= max; y++) {
    if (String(y).startsWith(typed)) return true
  }
  return false
}

const DEFAULT_DATE_PRESETS = ["Birthday", "Anniversary", "Other"]

// ── Month dropdown (Material outlined select) ────────────────────────────────
function MonthSelect({ value, onChange, primaryColor, large }: {
  value: string; onChange: (m: string) => void; primaryColor: string; large?: boolean
}) {
  const months = monthLabels(useUiLocale(), 'long')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc, true)
    return () => document.removeEventListener('mousedown', onDoc, true)
  }, [open])

  const idx = value ? Number(value) - 1 : -1
  const monthName = idx >= 0 && idx < 12 ? months[idx] : ''
  const boxH = large ? 56 : 48

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: large ? 210 : 190 }}
      onFocus={() => setOpen(true)}>
      <OutlinedField
        label="Month"
        value={monthName}
        onChange={() => {}}
        readOnly
        trailing={open ? <ChevronUp size={18} color={primaryColor} /> : <ChevronDown size={18} />}
        primaryColor={primaryColor}
        large={large}
      />
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: boxH + 4, left: 0, zIndex: 9999,
            width: '100%', maxHeight: 300, overflowY: 'auto',
            background: '#fff', borderRadius: 8, border: '1px solid #dadce0',
            boxShadow: '0 4px 8px 3px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.3)',
          }}
        >
          {months.map((m, i) => {
            const active = i === idx
            return (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={e => { e.preventDefault(); onChange(String(i + 1)); setOpen(false) }}
                style={{
                  width: '100%', textAlign: 'left', padding: '10px 16px', border: 'none',
                  background: active ? 'var(--color-primary-light, #e8f0fe)' : 'transparent',
                  cursor: 'pointer', fontSize: 13.5, color: '#202124',
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = '#f1f3f4' }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                {m}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function DateField({ value, onChange, primaryColor, icon, withLabel, labelPresets, large, minYear = 1900, maxYear = 2200 }: DateFieldProps) {
  const lead = icon === undefined ? <Calendar size={24} strokeWidth={1.8} /> : icon
  const maxDay = daysInMonth(value.month, value.year)

  // A keystroke producing an impossible day is REFUSED (the previous value
  // stays); "0" is allowed as an intermediate state ("07").
  const setDay = (d: string) => {
    const digits = d.replace(/\D/g, '').slice(0, 2)
    if (digits !== '' && Number(digits) > maxDay) return
    onChange({ ...value, day: digits })
  }
  // Changing the month (or year) re-clamps a day that no longer exists
  // (31 → Février ⇒ 28/29).
  const setMonth = (m: string) => {
    const cap = daysInMonth(m, value.year)
    const day = value.day !== '' && Number(value.day) > cap ? String(cap) : value.day
    onChange({ ...value, month: m, day })
  }
  const setYear = (yRaw: string) => {
    const y = yRaw.replace(/\D/g, '').slice(0, 4)
    if (!isYearPrefix(y, minYear, maxYear)) return
    const cap = daysInMonth(value.month, y)
    const day = value.day !== '' && Number(value.day) > cap ? String(cap) : value.day
    onChange({ ...value, year: y, day })
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {lead && <span style={{ color: '#5f6368', flexShrink: 0, display: 'flex' }}>{lead}</span>}
      <div style={{ width: large ? 110 : 96, flexShrink: 0 }}>
        <OutlinedField
          label="Day" placeholder="DD"
          value={value.day}
          onChange={setDay}
          inputMode="numeric"
          primaryColor={primaryColor}
          large={large}
        />
      </div>
      <MonthSelect
        value={value.month}
        onChange={setMonth}
        primaryColor={primaryColor}
        large={large}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <OutlinedField
          label="Year (optional)" placeholder="YYYY"
          value={value.year}
          onChange={setYear}
          inputMode="numeric"
          primaryColor={primaryColor}
          large={large}
        />
      </div>
      {withLabel && (
        <LabelCombobox
          value={value.label ?? ''}
          onChange={l => onChange({ ...value, label: l })}
          primaryColor={primaryColor}
          presets={labelPresets ?? DEFAULT_DATE_PRESETS}
          large={large}
        />
      )}
    </div>
  )
}
