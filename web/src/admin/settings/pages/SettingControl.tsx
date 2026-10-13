import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Toggle, Checkbox, Input, Combobox, type ComboboxOption } from '@ui'
import { CAUTION_KEYS, ENUM_OPTIONS, TIMEZONE_KEYS, flatKey } from '../settingsMap'
import type { ResolvedSetting } from '../scopeTypes'

/**
 * One setting, painted as the control its value type calls for, with its
 * provenance line underneath.
 *
 * Extracted from the old monolithic settings page so that every page which now
 * carries a settings block paints its rows identically — including the
 * inheritance affordances, which are the part that must not diverge.
 *
 * `Dropdown` is deliberately absent: it does not follow the dark theme. Closed
 * value sets use `Combobox`, which does, and which filters — mandatory for the
 * ~400-entry IANA zone list a calendar module declares.
 */

const ALL_ROLES = ['user', 'admin', 'guest'] as const

/** IANA zones, resolved once from the platform (with a small static fallback). */
const TIMEZONE_OPTIONS: ComboboxOption[] = (
  typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl
    ? (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone')
    : ['UTC', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']
).map(tz => ({ value: tz, label: tz }))

export interface SettingControlProps {
  setting:  ResolvedSetting
  /** Pending edit if any, otherwise the resolved value. */
  value:    unknown
  /** A level above locked the key, or the caller may read but not write. */
  readOnly: boolean
  /** Instant write — toggles, checkboxes and closed value sets. */
  onCommit: (value: unknown) => void
  /** Buffered edit — free text and numbers, saved from the action bar. */
  onDraft:  (value: unknown) => void
  /** The provenance line (inherited / overridden / locked) painted under it. */
  children: ReactNode
  /** Deep link target: outlines the row the admin search asked for. */
  highlighted?: boolean
  innerRef?:    React.Ref<HTMLDivElement>
}

/**
 * Label and description: the catalogue first, the server's own text as the
 * fallback. `core.settings` stores one French string per key, so a key with a
 * catalogue entry reads in the operator's language and every other one keeps
 * exactly what it showed before.
 */
export function settingLabel(t: TFunction, s: ResolvedSetting): string {
  return t(`admin.setlabel_${flatKey(s.key)}`, { defaultValue: s.label ?? s.key })
}
export function settingDescription(t: TFunction, s: ResolvedSetting): string {
  return t(`admin.setdesc_${flatKey(s.key)}`, { defaultValue: s.description ?? '' })
}

export default function SettingControl({
  setting: s, value, readOnly, onCommit, onDraft, children, highlighted, innerRef,
}: SettingControlProps) {
  const { t } = useTranslation()

  const label = settingLabel(t, s)
  const desc  = settingDescription(t, s)

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm font-medium text-text-primary">{label}</p>
      {s.is_public && (
        <span className="flex-shrink-0 rounded bg-primary-light px-1.5 py-0.5 text-xs text-primary">
          {t('admin.public_badge')}
        </span>
      )}
    </div>
  )

  const description = desc
    ? <p className="mt-0.5 text-sm text-text-tertiary">{desc}</p>
    : null

  /* Stated BEFORE the control, never after the click. The tinted surface carries
     the severity: `text-warning` on the card's own background sits around 2:1,
     which this project documents as a legibility failure. */
  const caution = CAUTION_KEYS.has(s.key) ? (
    <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning-light px-2.5 py-1.5 text-xs leading-5 text-text-primary">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
      <span>{t(`admin.setwarn_${flatKey(s.key)}`, { defaultValue: '' })}</span>
    </p>
  ) : null

  const shell = (body: ReactNode) => (
    <div
      ref={innerRef}
      // Names the key the row edits: the deep link, and any check that the
      // reorganisation lost nothing, both need to see it from the outside.
      data-setting-key={s.key}
      className={`rounded-xl border border-border bg-surface-0 px-4 py-3${
        highlighted ? ' ring-2 ring-primary' : ''
      }`}
    >
      {body}
      {children}
    </div>
  )

  // ── Boolean → Toggle, label and control on one line ───────────────────────
  if (typeof s.value === 'boolean') {
    return shell(
      <>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            {header}
            {description}
          </div>
          <Toggle
            checked={Boolean(value)}
            disabled={readOnly}
            onChange={e => onCommit(e.target.checked)}
          />
        </div>
        {caution}
      </>
    )
  }

  // ── Role array → checkboxes ───────────────────────────────────────────────
  if (s.key === 'auth.api_token_allowed_roles') {
    const current = Array.isArray(value) ? (value as string[]) : ((s.value as string[]) ?? [])
    return shell(
      <>
        {header}
        {description}
        {caution}
        <div className="mt-3 flex flex-wrap gap-4">
          {ALL_ROLES.map(role => {
            const checked = current.includes(role)
            return (
              <Checkbox
                key={role}
                label={t(`admin.role_${role}`, { defaultValue: role })}
                checked={checked}
                disabled={readOnly}
                onChange={() => onCommit(
                  checked ? current.filter(r => r !== role) : [...current, role]
                )}
              />
            )
          })}
        </div>
      </>
    )
  }

  // ── Closed value set → Combobox ───────────────────────────────────────────
  const enumOpts = ENUM_OPTIONS[s.key]
  const options  = TIMEZONE_KEYS.has(s.key)
    ? TIMEZONE_OPTIONS
    : enumOpts?.map(o => ({ ...o, label: t(o.label, { defaultValue: o.label }) }))

  if (options) {
    return shell(
      <>
        {header}
        {description}
        {caution}
        <div className="mt-2">
          <Combobox
            value={value == null ? null : String(value)}
            onChange={v => onCommit(v)}
            options={options}
            disabled={readOnly}
            aria-label={label}
            t={t}
          />
        </div>
      </>
    )
  }

  // ── Free text / number → Input, saved from the action bar ─────────────────
  const isNumeric = typeof s.value === 'number'
  return shell(
    <>
      {header}
      {description}
      {caution}
      <div className="mt-2">
        <Input
          type={isNumeric ? 'number' : 'text'}
          value={value == null ? '' : String(value)}
          readOnly={readOnly}
          disabled={readOnly}
          onChange={e => onDraft(isNumeric ? Number(e.target.value) : e.target.value)}
          className="bg-surface-1 font-mono"
        />
      </div>
    </>
  )
}
