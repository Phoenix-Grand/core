// Shared @ui primitive. A composite answer: several labelled text sub-fields stacked under ONE shared
// icon (Google-Contacts style - a "Name" block, an "Organisation" block…). The
// icon sits on the left, centred on the first row; a chevron on the right
// reveals/hides the "advanced" sub-fields (Plus / Moins). Each sub-field is a
// plain Material field WITHOUT its own icon - the group owns the icon.
import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { OutlinedField } from './OutlinedField'

export interface GroupField {
  key: string
  label: string
  /** Hidden until the group is expanded (Plus). */
  advanced?: boolean
}

export interface FieldGroupProps {
  icon: ReactNode
  fields: GroupField[]
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
  primaryColor: string
  large?: boolean
}

export function FieldGroup({ icon, fields, value, onChange, primaryColor, large }: FieldGroupProps) {
  const [expanded, setExpanded] = useState(false)
  const hasAdvanced = fields.some(f => f.advanced)
  const shown = expanded ? fields : fields.filter(f => !f.advanced)

  // Icon and chevron are centred on the FIRST field's row; the field's own box
  // height (padding + line) is roughly this - kept as a constant so the two
  // gutters line up without measuring the DOM.
  const rowH = large ? 56 : 48
  const gutter: React.CSSProperties = {
    height: rowH, display: 'flex', alignItems: 'center', flexShrink: 0,
  }

  const set = (key: string, v: string) => onChange({ ...value, [key]: v })

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      {/* Shared icon, centred on the first row */}
      <span style={{ ...gutter, color: '#5f6368' }}>{icon}</span>

      {/* Stacked sub-fields */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {shown.map(f => (
          <OutlinedField
            key={f.key}
            label={f.label}
            value={value[f.key] ?? ''}
            onChange={v => set(f.key, v)}
            primaryColor={primaryColor}
            large={large}
          />
        ))}
      </div>

      {/* Expand / collapse the advanced sub-fields */}
      {hasAdvanced ? (
        <span style={gutter}>
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            title={expanded ? 'Moins' : 'Plus'}
            aria-label={expanded ? 'Moins' : 'Plus'}
            aria-expanded={expanded}
            style={{
              width: 32, height: 32, borderRadius: '50%', border: 'none',
              background: 'transparent', color: expanded ? primaryColor : '#5f6368',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', transition: 'background 120ms',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#f1f3f4' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            {expanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </button>
        </span>
      ) : (
        // Keep the field column aligned with single-field questions when there is
        // nothing to expand (no dangling gutter width).
        <span style={{ width: 0 }} />
      )}
    </div>
  )
}
