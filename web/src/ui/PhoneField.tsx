// Shared @ui primitive: a phone-number field, Google-Contacts style. A leading
// handset icon, a country dial-code selector (flag + searchable dropdown), the
// Material number field, and - optionally - an editable "Libellé" combobox
// (free text + preset suggestions like Domicile / Professionnel / Mobile). The
// value is structured: { country (ISO-2), number (local), label? }; the full
// international number is `+<dial><number>`.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Phone as PhoneIcon, ChevronDown, ChevronUp } from 'lucide-react'
import { OutlinedField } from './OutlinedField'
import { LabelCombobox } from './LabelCombobox'
import { localizedCountries, flagEmoji } from './countries'
import { useUiLocale } from './useUiLocale'

export interface PhoneValue {
  /** ISO-3166 alpha-2, e.g. "FR". */
  country: string
  /** Local number as typed (no dial code). */
  number: string
  /** Free-text label / type (Domicile, Professionnel, a custom one…). */
  label?: string
}

export interface PhoneFieldProps {
  value: PhoneValue
  onChange: (v: PhoneValue) => void
  primaryColor: string
  /** Leading icon; defaults to a handset. Pass `null` to omit it - e.g. when the
   * consumer already provides its own icon gutter (a contact editor), otherwise
   * two icons stack. */
  icon?: ReactNode
  /** Show the editable "Libellé" combobox (contacts use it; a plain form may not). */
  withLabel?: boolean
  /** Suggestions offered in the Libellé dropdown (free text stays allowed). */
  labelPresets?: string[]
  large?: boolean
}

const DEFAULT_LABEL_PRESETS = [
  "Home", "Work", 'Mobile', "Main", "Other",
  "Fax (home)", "Fax (work)",
]

// ── Country dial-code selector ───────────────────────────────────────────────
function CountrySelect({ value, onChange, primaryColor, large }: {
  value: string; onChange: (iso2: string) => void; primaryColor: string; large?: boolean
}) {
  const countries = localizedCountries(useUiLocale())
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const country = countries.find(c => c.iso2 === value) ?? countries[0]

  useEffect(() => {
    if (!open) { setQuery(''); return }
    // Focus the search the moment the list opens (type-to-filter, 188 entries).
    searchRef.current?.focus()
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey) }
  }, [open])

  const q = query.trim().toLowerCase()
  const list = q
    ? countries.filter(c => c.name.toLowerCase().includes(q) || c.dial.includes(q.replace('+', '')))
    : countries

  const boxH = large ? 56 : 48
  return (
    <div ref={boxRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Calling code: ${country.name} (+${country.dial})`}
        style={{
          height: boxH, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 6,
          padding: '0 8px', borderRadius: 6, cursor: 'pointer',
          border: `${open ? 2 : 1}px solid ${open ? primaryColor : '#9aa0a6'}`,
          background: '#fff', fontSize: large ? 20 : 16, lineHeight: 1,
        }}
      >
        <span aria-hidden style={{ fontSize: large ? 22 : 18 }}>{flagEmoji(country.iso2)}</span>
        {open ? <ChevronUp size={16} color={primaryColor} /> : <ChevronDown size={16} color="#5f6368" />}
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: boxH + 4, left: 0, zIndex: 9999,
            width: 300, maxHeight: 320, overflowY: 'auto',
            background: '#fff', borderRadius: 8, border: '1px solid #dadce0',
            boxShadow: '0 4px 8px 3px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.3)',
          }}
        >
          <div style={{ position: 'sticky', top: 0, background: '#fff', padding: 8, borderBottom: '1px solid #f1f3f4' }}>
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search countries"
              style={{
                width: '100%', height: 34, padding: '0 10px', fontSize: 13.5,
                border: '1px solid #dadce0', borderRadius: 6, outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
          {list.map(c => {
            const active = c.iso2 === value
            return (
              <button
                key={c.iso2}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onChange(c.iso2); setOpen(false) }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 14px', border: 'none', cursor: 'pointer', textAlign: 'left',
                  background: active ? 'var(--color-primary-light, #e8f0fe)' : 'transparent',
                  fontSize: 13.5, color: '#202124',
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = '#f1f3f4' }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <span aria-hidden style={{ fontSize: 18 }}>{flagEmoji(c.iso2)}</span>
                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                <span style={{ color: '#5f6368' }}>(+{c.dial})</span>
              </button>
            )
          })}
          {list.length === 0 && (
            <div style={{ padding: '14px', color: '#80868b', fontSize: 13, textAlign: 'center' }}>No countries found</div>
          )}
        </div>
      )}
    </div>
  )
}

export function PhoneField({ value, onChange, primaryColor, icon, withLabel, labelPresets, large }: PhoneFieldProps) {
  const country = value.country || 'FR'
  const lead = icon === undefined ? <PhoneIcon size={24} strokeWidth={1.8} /> : icon
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {lead && <span style={{ color: '#5f6368', flexShrink: 0, display: 'flex' }}>{lead}</span>}
      <CountrySelect
        value={country}
        onChange={iso2 => onChange({ ...value, country: iso2 })}
        primaryColor={primaryColor}
        large={large}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <OutlinedField
          label="Phone"
          value={value.number}
          // A phone number can only contain digits and usual separators.
          onChange={n => onChange({ ...value, number: n.replace(/[^0-9 ().\-\/]/g, '').slice(0, 20) })}
          type="tel"
          inputMode="tel"
          primaryColor={primaryColor}
          large={large}
        />
      </div>
      {withLabel && (
        <LabelCombobox
          value={value.label ?? ''}
          onChange={l => onChange({ ...value, label: l })}
          primaryColor={primaryColor}
          presets={labelPresets ?? DEFAULT_LABEL_PRESETS}
          large={large}
        />
      )}
    </div>
  )
}
