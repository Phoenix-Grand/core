/**
 * The parts of `ModuleSettingRow.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Input, Radio, Textarea, Toggle } from "@ui"
import { AlertCircle, AlertTriangle } from "lucide-react"
import { countEntries, normOptions, type Risk, type SettingItem } from "../moduleSettingSchema"
const RISK_SKIN: Record<Risk, { box: string; icon: string }> = {
  info:    { box: 'bg-primary-light', icon: 'text-primary' },
  warning: { box: 'bg-warning-light', icon: 'text-warning' },
  danger:  { box: 'bg-danger-light',  icon: 'text-danger'  },
}

interface ControlProps {
  item:     SettingItem
  value:    unknown
  invalid:  boolean
  readOnly: boolean
  onChange: (v: unknown) => void
}

function RiskPill({ risk }: { risk: Risk }) {
  const { t } = useTranslation()
  // `info` earns no pill: a badge that never means "be careful" trains the eye
  // to skip every badge, including the two that matter.
  if (risk === 'info') return null
  const skin = RISK_SKIN[risk]
  const Glyph = risk === 'danger' ? AlertCircle : AlertTriangle
  const text = risk === 'danger'
    ? t('admin.m_risk_danger', { defaultValue: 'Sensible' })
    : t('admin.m_risk_warning', { defaultValue: 'Prudence' })
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${skin.box} text-text-primary`}
      style={{ fontSize: 'var(--kb-text-micro)' }}
      title={risk === 'danger'
        ? t('admin.m_risk_danger_hint', { defaultValue: 'Une mauvaise valeur peut rendre le service injoignable ou faire perdre des messages.' })
        : t('admin.m_risk_warning_hint', { defaultValue: 'Réglage à modifier en connaissance de cause.' })}
    >
      <Glyph size={11} className={skin.icon} />
      {text}
    </span>
  )
}
export { RiskPill }

function Control({ item, value, invalid, readOnly, onChange }: ControlProps) {
  const { t } = useTranslation()
  const placeholder = item.placeholder ?? undefined

  if (item.type === 'bool') {
    return <Toggle checked={!!value} disabled={readOnly} onChange={() => onChange(!value)} />
  }

  if (item.type === 'enum') {
    return (
      <div className="flex flex-col items-start gap-2">
        {normOptions(item.values).map(opt => (
          <Radio key={String(opt.value)} checked={String(value) === String(opt.value)}
            disabled={readOnly}
            onChange={() => onChange(opt.value)} label={opt.label} />
        ))}
      </div>
    )
  }

  // A list setting (one entry per line): the count is what tells an
  // administrator the paste landed whole, without counting lines by eye.
  if (item.type === 'string' && item.multiline) {
    const entries = countEntries(value)
    return (
      <div className="max-w-lg">
        <Textarea
          value={value === null || value === undefined ? '' : String(value)}
          disabled={readOnly}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-28 font-mono"
        />
        <p className="mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>
          {t('admin.m_entries_count', {
            count: entries,
            defaultValue: `${entries} entrée(s) — une par ligne`,
          })}
        </p>
      </div>
    )
  }

  if (item.type === 'int') {
    const bounds = [
      item.min !== null && item.min !== undefined ? `≥ ${item.min}` : null,
      item.max !== null && item.max !== undefined ? `≤ ${item.max}` : null,
    ].filter(Boolean).join(' · ')
    return (
      <div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={item.min ?? undefined}
            max={item.max ?? undefined}
            disabled={readOnly}
            value={value === null || value === undefined ? '' : String(value)}
            onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            placeholder={placeholder}
            className={`max-w-40 ${invalid ? 'border-danger focus:ring-danger' : ''}`}
          />
          {item.unit && (
            <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {item.unit}
            </span>
          )}
        </div>
        {invalid ? (
          <p className="mt-1 text-danger" style={{ fontSize: 'var(--kb-text-micro)' }}>
            {t('admin.m_out_of_range', {
              defaultValue: `Valeur attendue : un entier ${bounds || 'valide'}`,
            })}
          </p>
        ) : bounds ? (
          <p className="mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>
            {bounds}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        type="text"
        disabled={readOnly}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="max-w-xs"
      />
      {item.unit && (
        <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {item.unit}
        </span>
      )}
    </div>
  )
}
export { Control }
