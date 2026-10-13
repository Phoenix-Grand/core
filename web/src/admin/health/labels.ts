import type { TFunction } from 'i18next'
import { formatBytes, formatDay } from '../sections/format'
import type { HealthCheck, HealthSeverity, HealthStatus } from './types'

/**
 * Localisation of a server-computed report.
 *
 * The server owns the verdicts and ships an English rendering of each string;
 * the console owns the wording in thirteen languages. The bridge is the check
 * id: `security.admin_count` translates against `admin.hc_security_admin_count_*`,
 * and every lookup falls back to the server's own text.
 *
 * That fallback is the point. A check added to the server before its catalogue
 * entry lands — or a locale that has not caught up — must still render a
 * sentence, not a raw key. A health page that displays
 * `admin.hc_exposure_https_title` to an operator has failed at the one thing it
 * exists to do.
 */

const keyBase = (id: string) => `admin.hc_${id.replace(/\./g, '_')}`

export const checkTitle = (t: TFunction, c: HealthCheck): string =>
  t(`${keyBase(c.id)}_title`, { defaultValue: c.title })

export const checkWhy = (t: TFunction, c: HealthCheck): string =>
  t(`${keyBase(c.id)}_why`, { defaultValue: c.why })

export const checkActionLabel = (t: TFunction, c: HealthCheck): string =>
  c.action ? t(`${keyBase(c.id)}_action`, { defaultValue: c.action.label }) : ''

/**
 * Value keys whose plural is governed by a field other than `count`.
 *
 * i18next only ever selects a plural form on an option literally named
 * `count`. A check that counts days rather than rows therefore has to point it
 * at the right number, or "1 day ago" comes out as "1 days ago".
 */
const PLURAL_FIELD: Record<string, string> = {
  backup_recent: 'age_days',
  backup_stale:  'age_days',
}

/**
 * The observed value, in the reader's language.
 *
 * Numeric arguments are pre-formatted here rather than in thirteen catalogues:
 * a byte count must read as "12,4 Go" and a timestamp as a local date, and no
 * i18n string should have to know that.
 */
export function checkValue(t: TFunction, c: HealthCheck, locale: string): string {
  const args: Record<string, unknown> = { ...c.value.args }

  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue
    if (k.endsWith('_bytes') && typeof v === 'number') {
      args[k] = formatBytes(v)
    } else if (k === 'at' && typeof v === 'string') {
      args[k] = formatDay(v, locale)
    } else if (Array.isArray(v)) {
      args[k] = v.join(', ')
    }
  }

  // `count` is the reserved option i18next reads to pick a plural form, so it
  // is passed through rather than renamed away: "1 administrator" and "5
  // administrators" are two sentences, not one with a parenthesis. An entry
  // that has no suffixed variants still resolves — i18next falls back to the
  // base key — so single-form values are unaffected.
  const governing = PLURAL_FIELD[c.value.key] ?? 'count'
  const observed = c.value.args?.[governing]
  if (typeof observed === 'number') args.count = observed
  else delete args.count

  return t(`admin.hc_val_${c.value.key}`, { ...args, defaultValue: c.value.summary })
}

export const statusLabel = (t: TFunction, s: HealthStatus): string =>
  t(`admin.hc_status_${s}`, { defaultValue: s })

export const severityLabel = (t: TFunction, s: HealthSeverity): string =>
  t(`admin.hc_sev_${s}`, { defaultValue: s })

export const blockLabel = (t: TFunction, b: string): string =>
  t(`admin.hc_block_${b}`, { defaultValue: b })

/**
 * Colour skin of a status pill.
 *
 * Every class resolves through a theme variable, and no opacity modifier is
 * applied to any of them: Tailwind bakes a STATIC light-theme hex next to the
 * `color-mix()` of `/85` and friends, which is exactly the hard-coded colour a
 * dark theme cannot remap.
 */
export const STATUS_SKIN: Record<HealthStatus, { dot: string; chip: string }> = {
  ok:             { dot: 'bg-success', chip: 'bg-success-light text-text-primary' },
  todo:           { dot: 'bg-warning', chip: 'bg-warning-light text-text-primary' },
  blocked:        { dot: 'bg-danger',  chip: 'bg-danger-light text-text-primary' },
  ignored:        { dot: 'bg-text-tertiary', chip: 'bg-surface-2 text-text-secondary' },
  not_applicable: { dot: 'bg-text-tertiary', chip: 'bg-surface-2 text-text-secondary' },
}

/** A failing check is painted by its SEVERITY, not by the fact that it failed. */
export const SEVERITY_SKIN: Record<HealthSeverity, { dot: string; chip: string }> = {
  critical: { dot: 'bg-danger',  chip: 'bg-danger-light text-text-primary' },
  warning:  { dot: 'bg-warning', chip: 'bg-warning-light text-text-primary' },
  info:     { dot: 'bg-primary', chip: 'bg-primary-light text-text-primary' },
}

/** Pill skin for one check: severity while it is failing, status otherwise. */
export function skinOf(c: HealthCheck): { dot: string; chip: string } {
  if (c.status === 'todo' || c.status === 'blocked') return SEVERITY_SKIN[c.severity]
  return STATUS_SKIN[c.status]
}
