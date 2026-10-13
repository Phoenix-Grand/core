import type { TFunction } from 'i18next'
import { formatBytes } from '../sections/format'
import type { Alert, AlertAction, AlertEventKind, AlertSeverity, AlertStatus } from './types'

/**
 * Localisation of a server-produced queue.
 *
 * Same bridge as the health report: the server ships an English rendering of
 * every string and the console owns the wording in thirteen languages, keyed on
 * the alert `kind`. Every lookup falls back to the server's own text, so an
 * alert type added before its catalogue entry lands still reads as a sentence
 * rather than as `admin.al_security_login_burst_title`.
 */

const keyBase = (kind: string) => `admin.al_${kind.replace(/\./g, '_')}`

/**
 * A health-derived alert borrows the health catalogue.
 *
 * `admin.hc_<check_id>_*` already exists in all thirteen languages, next to the
 * check it describes. Duplicating those sentences under an alert key would be
 * thirteen more copies to keep in step with a wording that lives elsewhere —
 * and the copy that drifts is the one an operator reads at 3 a.m.
 */
const healthKey = (a: Alert): string | null => {
  const id = a.payload.check_id
  return typeof id === 'string' ? `admin.hc_${id.replace(/\./g, '_')}` : null
}

export const alertTitle = (t: TFunction, a: Alert): string => {
  const hc = healthKey(a)
  if (hc) return t(`${hc}_title`, { defaultValue: a.title })
  return t(`${keyBase(a.kind)}_title`, { ...interpolation(a), defaultValue: a.title })
}

export const alertSummary = (t: TFunction, a: Alert): string => {
  const hc = healthKey(a)
  if (hc) return t(`${hc}_why`, { defaultValue: a.summary ?? '' })
  return t(`${keyBase(a.kind)}_sum`, { ...interpolation(a), defaultValue: a.summary ?? '' })
}

export const kindLabel = (t: TFunction, kind: string): string =>
  t(`${keyBase(kind)}_name`, { defaultValue: kind })

/**
 * The wording of a button. A health alert's "fix this" action reuses the
 * check's own label for the same reason its title does.
 */
export const actionLabel = (t: TFunction, a: AlertAction, alert?: Alert): string => {
  if (a.id === 'fix-health-check' && alert) {
    const hc = healthKey(alert)
    if (hc) return t(`${hc}_action`, { defaultValue: a.label })
  }
  return t(`admin.alact_${a.id.replace(/-/g, '_')}`, { defaultValue: a.label })
}

export const severityLabel = (t: TFunction, s: AlertSeverity): string =>
  t(`admin.al_sev_${s}`, { defaultValue: s })

export const statusLabel = (t: TFunction, s: AlertStatus): string =>
  t(`admin.al_status_${s}`, { defaultValue: s })

export const sourceLabel = (t: TFunction, s: string): string =>
  t(`admin.al_source_${s}`, { defaultValue: s })

export const eventLabel = (t: TFunction, k: AlertEventKind): string =>
  t(`admin.al_ev_${k}`, { defaultValue: k })

/**
 * Interpolation arguments taken from the payload.
 *
 * Byte counts are pre-formatted here rather than in thirteen catalogues — no
 * i18n string should have to know that 1 073 741 824 reads as "1 Go". `count`
 * is set from the payload field that governs the sentence's agreement, because
 * i18next only ever selects a plural form on an option by that exact name.
 */
function interpolation(a: Alert): Record<string, unknown> {
  const args: Record<string, unknown> = { ...a.payload }
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue
    if (k.endsWith('_bytes') && typeof v === 'number') args[k] = formatBytes(v)
    else if (Array.isArray(v)) args[k] = v.join(', ')
  }
  const governing = a.payload[PLURAL_FIELD[a.kind] ?? 'count']
  if (typeof governing === 'number') args.count = governing
  else delete args.count
  return args
}

/**
 * The payload field each alert kind counts on.
 *
 * A login burst is worded around the number of source addresses, not the
 * number of attempts: pointing i18next at the wrong one would decline the
 * sentence against a number the reader is not looking at.
 */
const PLURAL_FIELD: Record<string, string> = {
  'jobs.dead_letter':     'failures',
  'security.login_burst': 'sources',
}

/**
 * Colour skin of a severity pill.
 *
 * Every class resolves through a theme variable, and **no opacity modifier** is
 * applied to any of them: Tailwind bakes a static light-theme hex next to the
 * `color-mix()` of `/85` and friends, which is exactly the hard-coded colour a
 * dark theme cannot remap.
 */
export const SEVERITY_SKIN: Record<AlertSeverity, { dot: string; chip: string }> = {
  critical: { dot: 'bg-danger',  chip: 'bg-danger-light text-text-primary' },
  warning:  { dot: 'bg-warning', chip: 'bg-warning-light text-text-primary' },
  info:     { dot: 'bg-primary', chip: 'bg-primary-light text-text-primary' },
}

/** A closed alert is painted by its outcome, an open one by its severity. */
export const STATUS_SKIN: Record<AlertStatus, string> = {
  new:          'bg-primary-light text-text-primary',
  acknowledged: 'bg-warning-light text-text-primary',
  resolved:     'bg-success-light text-text-primary',
  ignored:      'bg-surface-2 text-text-secondary',
}

export function skinOf(a: Alert): { dot: string; chip: string } {
  if (a.status === 'resolved' || a.status === 'ignored') {
    return { dot: 'bg-text-tertiary', chip: STATUS_SKIN[a.status] }
  }
  return SEVERITY_SKIN[a.severity]
}
