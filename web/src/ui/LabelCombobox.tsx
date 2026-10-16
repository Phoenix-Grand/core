// Editable "Libellé" combobox shared by the composite fields (PhoneField,
// DateField…): a Material outlined field whose value is FREE TEXT, plus a
// dropdown of preset suggestions that narrow as you type. A combobox, not a
// closed select - a custom label is always kept.
import { useEffect, useRef, useState } from 'react'
import { OutlinedField } from './OutlinedField'

export interface LabelComboboxProps {
  value: string
  onChange: (v: string) => void
  primaryColor: string
  presets: string[]
  /** Field label; defaults to "Libellé". */
  label?: string
  large?: boolean
}

export function LabelCombobox({ value, onChange, primaryColor, presets, label = 'Libellé', large }: LabelComboboxProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc, true)
    return () => document.removeEventListener('mousedown', onDoc, true)
  }, [open])

  const q = value.trim().toLowerCase()
  const shown = q ? presets.filter(p => p.toLowerCase().includes(q)) : presets

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0, width: large ? 200 : 170 }}
      onFocus={() => setOpen(true)}>
      <OutlinedField label={label} value={value} onChange={onChange} primaryColor={primaryColor} large={large} />
      {open && shown.length > 0 && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: (large ? 56 : 48) + 4, left: 0, zIndex: 9999,
            width: '100%', maxHeight: 260, overflowY: 'auto',
            background: '#fff', borderRadius: 8, border: '1px solid #dadce0',
            boxShadow: '0 4px 8px 3px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.3)',
          }}
        >
          {shown.map(p => (
            <button
              key={p}
              type="button"
              // mousedown, not click: fire before the field's blur closes us.
              onMouseDown={e => { e.preventDefault(); onChange(p); setOpen(false) }}
              style={{
                width: '100%', textAlign: 'left', padding: '10px 16px', border: 'none',
                background: 'transparent', cursor: 'pointer', fontSize: 13.5, color: '#202124',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#f1f3f4' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
