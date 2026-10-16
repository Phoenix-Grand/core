import { formatRelative } from '../../core/intl/datetime'

/**
 * Formatting helpers shared by the admin sections.
 *
 * They used to be copy-pasted per panel (three different byte formatters, two
 * different timestamp renderings). One implementation means a quota reads the
 * same in the user list, the user sheet and the dashboard.
 */

/** Human-readable size. Below 1 GiB the megabyte is the useful unit. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} Ko`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} Mo`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} Go`
  return `${(bytes / 1024 ** 4).toFixed(2)} To`
}

/**
 * Compact ABSOLUTE timestamp. A log is read by date, never by "3 hours ago":
 * the operator correlates it with an incident whose time they already know.
 */
export function formatWhen(iso: string, locale: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

/** Date without the clock - for lifecycle fields (creation, last sign-in). */
export function formatDay(iso: string, locale: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(locale, {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/**
 * How long something took, from milliseconds.
 *
 * Deliberately unit-suffixed rather than localised through `Intl`: the value is
 * an engineering measurement read next to a byte count, and "1 minute et
 * 4 secondes" in a table column is noise where "1 min 4 s" is a number.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min`
}

/** "3 days ago" - only ever a COMPLEMENT to an absolute date, never a replacement. */
export function formatAgo(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return formatRelative(d)
}
