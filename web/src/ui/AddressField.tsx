// Shared @ui primitive: a postal-address block, Google-Contacts style. A
// location-pin icon on the left, the street on its own line, postal code + city
// on a row, a searchable country selector, and - behind a Plus/Moins chevron -
// the less-common lines (PO box, extra line, region). An optional editable
// "Libellé" closes the block. The value is structured; nothing is parsed.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MapPin, ChevronDown, ChevronUp } from 'lucide-react'
import { OutlinedField } from './OutlinedField'
import { LabelCombobox } from './LabelCombobox'
import { localizedCountries, flagEmoji } from './countries'
import { useUiLocale } from './useUiLocale'

export interface AddressValue {
  street: string
  postal: string
  city: string
  /** ISO-3166 alpha-2, e.g. "FR", or "" when unset. */
  country: string
  poBox?: string
  complement?: string
  region?: string
  label?: string
}

export interface AddressFieldProps {
  value: AddressValue
  onChange: (v: AddressValue) => void
  primaryColor: string
  /** Leading icon; defaults to a map pin. Pass `null` to omit it when the
   * consumer already has its own icon gutter. */
  icon?: ReactNode
  withLabel?: boolean
  labelPresets?: string[]
  large?: boolean
}

const DEFAULT_ADDRESS_PRESETS = ["Home", "Work", "Other"]

// ── Country NAME selector (searchable Material select) ───────────────────────
function CountryNameSelect({ value, onChange, primaryColor, large }: {
  value: string; onChange: (iso2: string) => void; primaryColor: string; large?: boolean
}) {
  const countries = localizedCountries(useUiLocale())
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const country = countries.find(c => c.iso2 === value)

  useEffect(() => {
    if (!open) { setQuery(''); return }
    searchRef.current?.focus()
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey) }
  }, [open])

  const q = query.trim().toLowerCase()
  const list = q ? countries.filter(c => c.name.toLowerCase().includes(q)) : countries
  const boxH = large ? 56 : 48

  return (
    <div ref={wrapRef} style={{ position: 'relative' }} onFocus={() => setOpen(true)}>
      <OutlinedField
        label="Country"
        value={country ? `${flagEmoji(country.iso2)}  ${country.name}` : ''}
        onChange={() => {}}
        readOnly
        trailing={open ? <ChevronUp size={18} color={primaryColor} /> : <ChevronDown size={18} />}
        primaryColor={primaryColor}
        large={large}
      />
      {open && (
        <div role="listbox" style={{
          position: 'absolute', top: boxH + 4, left: 0, zIndex: 9999, width: '100%',
          maxHeight: 300, overflowY: 'auto', background: '#fff', borderRadius: 8,
          border: '1px solid #dadce0', boxShadow: '0 4px 8px 3px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.3)',
        }}>
          <div style={{ position: 'sticky', top: 0, background: '#fff', padding: 8, borderBottom: '1px solid #f1f3f4' }}>
            <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search countries"
              style={{ width: '100%', height: 34, padding: '0 10px', fontSize: 13.5, border: '1px solid #dadce0', borderRadius: 6, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          {list.map(c => {
            const active = c.iso2 === value
            return (
              <button key={c.iso2} type="button" role="option" aria-selected={active}
                onMouseDown={e => { e.preventDefault(); onChange(c.iso2); setOpen(false) }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', border: 'none', cursor: 'pointer', textAlign: 'left', background: active ? 'var(--color-primary-light, #e8f0fe)' : 'transparent', fontSize: 13.5, color: '#202124' }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = '#f1f3f4' }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                <span aria-hidden style={{ fontSize: 18 }}>{flagEmoji(c.iso2)}</span>
                <span style={{ flex: 1 }}>{c.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function AddressField({ value, onChange, primaryColor, icon, withLabel, labelPresets, large }: AddressFieldProps) {
  const [expanded, setExpanded] = useState(false)
  const lead = icon === undefined ? <MapPin size={24} strokeWidth={1.8} /> : icon
  const set = (patch: Partial<AddressValue>) => onChange({ ...value, ...patch })
  const rowH = large ? 56 : 48

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <span style={{ height: rowH, display: 'flex', alignItems: 'center', flexShrink: 0, color: '#5f6368' }}>{lead}</span>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <OutlinedField label="Street" value={value.street} onChange={v => set({ street: v })} primaryColor={primaryColor} large={large} />
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ width: large ? 150 : 130, flexShrink: 0 }}>
            <OutlinedField label="Postal code" value={value.postal} onChange={v => set({ postal: v })} primaryColor={primaryColor} large={large} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <OutlinedField label="City" value={value.city} onChange={v => set({ city: v })} primaryColor={primaryColor} large={large} />
          </div>
        </div>
        {expanded && (
          <>
            <OutlinedField label="PO box" value={value.poBox ?? ''} onChange={v => set({ poBox: v })} primaryColor={primaryColor} large={large} />
            <OutlinedField label="Address line 2" value={value.complement ?? ''} onChange={v => set({ complement: v })} primaryColor={primaryColor} large={large} />
            <OutlinedField label="State / Region" value={value.region ?? ''} onChange={v => set({ region: v })} primaryColor={primaryColor} large={large} />
          </>
        )}
        <CountryNameSelect value={value.country} onChange={iso2 => set({ country: iso2 })} primaryColor={primaryColor} large={large} />
        {withLabel && (
          <LabelCombobox value={value.label ?? ''} onChange={l => set({ label: l })} primaryColor={primaryColor} presets={labelPresets ?? DEFAULT_ADDRESS_PRESETS} large={large} />
        )}
      </div>

      <span style={{ height: rowH, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <button type="button" onClick={() => setExpanded(e => !e)} title={expanded ? "Less" : "More"}
          aria-label={expanded ? "Less" : "More"} aria-expanded={expanded}
          style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', color: expanded ? primaryColor : '#5f6368', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'background 120ms' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#f1f3f4' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
          {expanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>
      </span>
    </div>
  )
}
