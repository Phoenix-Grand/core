import type { PanelBucket } from './types'

/**
 * How a bucket boundary is spelt.
 *
 * Shared by the cards and by the reports, because the two must agree: a bar an
 * operator hovered on screen and the row they printed have to name the same
 * instant, in the same words.
 *
 * ## The `Z` that is not there
 *
 * `iso` is a LOCAL wall-clock instant — the server already stated it in the
 * instance's zone (`to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS')` in `period.rs`), so
 * it is read as local. Appending a `Z` would shift the whole axis by the offset,
 * silently, and only in some time zones.
 */
function parse(iso: string): Date | null {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The AXIS label: as short as it can be while still being unambiguous inside
 * one window. Ten of these sit side by side under a chart.
 */
export function bucketLabel(iso: string, bucket: PanelBucket, locale: string): string {
  const d = parse(iso)
  if (!d) return iso
  if (bucket === 'hour') {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d)
  }
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(d)
}

/**
 * The TABLE label: the whole instant, spelt out.
 *
 * A report is read away from the page that produced it — months later, on paper,
 * by somebody who did not choose the window. "03/03" is enough under a chart
 * whose period is stated above it and useless in a column somebody photocopied,
 * so the row carries the year and, for a week, says that it is a week.
 *
 * `weekOf` is the caller's translated "semaine du {{date}}"; it is passed in
 * rather than looked up here so this module stays free of the i18n runtime.
 */
export function bucketFullLabel(
  iso:    string,
  bucket: PanelBucket,
  locale: string,
  weekOf: (date: string) => string,
): string {
  const d = parse(iso)
  if (!d) return iso
  if (bucket === 'hour') {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d)
  }
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(d)
  return bucket === 'week' ? weekOf(day) : day
}
