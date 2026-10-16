/**
 * Dates and times, in house, on top of the platform's own `Intl`.
 *
 * WHY THIS EXISTS
 * Seventeen repositories depended on `date-fns`, and one file here imported
 * thirteen of its locale bundles so that month and weekday names came out in the
 * user's language. The browser already knows all of that: `Intl.DateTimeFormat`
 * and `Intl.RelativeTimeFormat` are localised for every language we ship, weigh
 * nothing, and are maintained by the platform rather than by us.
 *
 * WHAT CHANGES FOR CALLERS, AND WHY IT IS AN IMPROVEMENT
 * A hard-coded pattern is replaced by an INTENT - `formatDate(d, 'date')`.
 * A hard-coded pattern is a localisation bug in a product shipped in thirteen
 * languages: it prints 03/09/2026 to a reader who expects 2026/09/03 or
 * ٢٠٢٦/٩/٣. Saying *what* the date is for, and letting the platform decide how
 * to write it, is both shorter and correct.
 *
 * Anything the presets do not cover takes raw `Intl` options, so nothing is
 * locked away behind our own vocabulary.
 */

import i18n from '../i18n'

export type DateInput = Date | string | number

/** Named intents, resolved per language. Covers what the call sites actually did. */
export type DatePreset =
  | 'date'        // 3 sept. 2026
  | 'dateShort'   // 03/09/2026
  | 'dateLong'    // 3 septembre 2026
  | 'weekday'     // jeudi
  | 'weekdayDate' // jeudi 3 septembre
  | 'month'       // septembre
  | 'monthYear'   // septembre 2026
  | 'time'        // 14:05
  | 'timeSeconds' // 14:05:32
  | 'dateTime'    // 3 sept. 2026, 14:05
  | 'weekdayNarrow' // L, M, M…  (en-têtes de colonnes d'un calendrier)
  | 'weekdayShort'  // lun.
  | 'weekdayTime'   // jeudi 14:05
  | 'hour'          // 14 h - l'axe horaire d'une journée

const PRESETS: Record<DatePreset, Intl.DateTimeFormatOptions> = {
  date:        { day: 'numeric', month: 'short', year: 'numeric' },
  dateShort:   { day: '2-digit', month: '2-digit', year: 'numeric' },
  dateLong:    { day: 'numeric', month: 'long', year: 'numeric' },
  weekday:     { weekday: 'long' },
  weekdayDate: { weekday: 'long', day: 'numeric', month: 'long' },
  month:       { month: 'long' },
  monthYear:   { month: 'long', year: 'numeric' },
  time:        { hour: '2-digit', minute: '2-digit' },
  timeSeconds: { hour: '2-digit', minute: '2-digit', second: '2-digit' },
  dateTime:    { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' },
  weekdayNarrow: { weekday: 'narrow' },
  weekdayShort:  { weekday: 'short' },
  weekdayTime:   { weekday: 'long', hour: '2-digit', minute: '2-digit' },
  hour:          { hour: 'numeric' },
}

/** The language in force, as a BCP 47 tag `Intl` understands. */
function locale(): string {
  return i18n?.language || 'en'
}

// Building an Intl formatter is expensive - measurably so in a list of a
// thousand rows, where the same one is asked for over and over. They are
// immutable, so one per (language, shape) is kept.
const cache = new Map<string, Intl.DateTimeFormat>()

function formatter(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const lng = locale()
  const key = lng + '|' + JSON.stringify(opts)
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(lng, opts)
    cache.set(key, f)
  }
  return f
}

/** Dropped when the language changes, so nothing keeps printing in the old one. */
export function resetDateFormatters(): void {
  cache.clear()
  relativeCache.clear()
}

/**
 * Accepts what an API actually returns: an ISO string, a timestamp, a Date.
 *
 * An ISO string goes straight to `new Date`, which parses that format natively -
 * this is what `parseISO` was doing for us.
 */
export function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value)
}

/** True when the value cannot be read as a date - checked before printing it. */
export function isValidDate(value: DateInput): boolean {
  return !Number.isNaN(toDate(value).getTime())
}

/**
 * The date as the reader's language writes it.
 *
 * An unreadable value yields an empty string rather than "Invalid Date" in the
 * middle of an interface.
 */
export function formatDate(
  value: DateInput,
  shape: DatePreset | Intl.DateTimeFormatOptions = 'date',
): string {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return ''
  const opts = typeof shape === 'string' ? PRESETS[shape] : shape
  return formatter(opts).format(d)
}

const relativeCache = new Map<string, Intl.RelativeTimeFormat>()

function relativeFormatter(): Intl.RelativeTimeFormat {
  const lng = locale()
  let f = relativeCache.get(lng)
  if (!f) {
    f = new Intl.RelativeTimeFormat(lng, { numeric: 'auto' })
    relativeCache.set(lng, f)
  }
  return f
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000], ['month', 2592000], ['week', 604800],
  ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
]

/**
 * "il y a 3 heures", "dans 2 jours" - localised by the platform.
 *
 * `numeric: 'auto'` is what turns "il y a 1 jour" into "hier", which is the
 * whole point of using the platform rather than counting units ourselves.
 */
export function formatRelative(value: DateInput, now: DateInput = Date.now()): string {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return ''
  const seconds = (d.getTime() - toDate(now).getTime()) / 1000
  const abs = Math.abs(seconds)
  for (const [unit, size] of UNITS) {
    if (abs >= size || unit === 'second') {
      return relativeFormatter().format(Math.round(seconds / size), unit)
    }
  }
  return ''
}

// ── Arithmetic and comparisons ──────────────────────────────────────────────
// Deliberately calendar-based rather than millisecond-based: adding a day across
// a daylight-saving boundary must still land on the next day at the same hour,
// which `+ 86400000` does not do.

export function addDays(value: DateInput, days: number): Date {
  const d = toDate(value)
  const out = new Date(d)
  out.setDate(d.getDate() + days)
  return out
}

export function addMonths(value: DateInput, months: number): Date {
  const d = toDate(value)
  const out = new Date(d)
  out.setMonth(d.getMonth() + months)
  return out
}

export function addYears(value: DateInput, years: number): Date {
  const d = toDate(value)
  const out = new Date(d)
  out.setFullYear(d.getFullYear() + years)
  return out
}

export function addMinutes(value: DateInput, minutes: number): Date {
  // Minutes are a fixed wall-clock span, unlike days across a DST boundary, so
  // millisecond arithmetic is correct here.
  return new Date(toDate(value).getTime() + minutes * 60000)
}

export function startOfDay(value: DateInput): Date {
  const d = toDate(value)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function endOfDay(value: DateInput): Date {
  const d = toDate(value)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

export function startOfMonth(value: DateInput): Date {
  const d = toDate(value)
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function startOfYear(value: DateInput): Date {
  return new Date(toDate(value).getFullYear(), 0, 1)
}

export function endOfYear(value: DateInput): Date {
  return new Date(toDate(value).getFullYear(), 11, 31, 23, 59, 59, 999)
}

/**
 * The first day of the week, in the reader's calendar.
 *
 * Monday in France, Sunday in the United States: asking the platform which day
 * starts the week is exactly the kind of thing a hard-coded value gets wrong.
 */
export function startOfWeek(value: DateInput, weekStartsOn?: number): Date {
  const d = startOfDay(value)
  const first = weekStartsOn ?? firstWeekday()
  const shift = (d.getDay() - first + 7) % 7
  return addDays(d, -shift)
}

function firstWeekday(): number {
  // `getWeekInfo` is the standard way and is not everywhere yet; Monday is the
  // sane default for the languages we ship, and the caller can always say.
  const loc = new Intl.Locale(locale()) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number }
    weekInfo?: { firstDay: number }
  }
  const info = loc.getWeekInfo?.() ?? loc.weekInfo
  const first = info?.firstDay          // 1 = Monday … 7 = Sunday
  return first === undefined ? 1 : first % 7
}

export function isSameDay(a: DateInput, b: DateInput): boolean {
  const x = toDate(a), y = toDate(b)
  return x.getFullYear() === y.getFullYear()
      && x.getMonth() === y.getMonth()
      && x.getDate() === y.getDate()
}

export function isToday(value: DateInput): boolean      { return isSameDay(value, new Date()) }
export function isYesterday(value: DateInput): boolean   { return isSameDay(value, addDays(new Date(), -1)) }
export function isTomorrow(value: DateInput): boolean    { return isSameDay(value, addDays(new Date(), 1)) }
export function isAfter(a: DateInput, b: DateInput): boolean  { return toDate(a).getTime() > toDate(b).getTime() }
export function isBefore(a: DateInput, b: DateInput): boolean { return toDate(a).getTime() < toDate(b).getTime() }

/** Whole days between two dates, ignoring the time of day. */
export function differenceInDays(a: DateInput, b: DateInput): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000)
}

export function subDays(value: DateInput, days: number): Date   { return addDays(value, -days) }
export function subMonths(value: DateInput, n: number): Date    { return addMonths(value, -n) }
export function subYears(value: DateInput, n: number): Date     { return addYears(value, -n) }

export function endOfMonth(value: DateInput): Date {
  const d = toDate(value)
  // Day 0 of the NEXT month is the last day of this one - no month-length table.
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999)
}

export function endOfWeek(value: DateInput, weekStartsOn?: number): Date {
  return endOfDay(addDays(startOfWeek(value, weekStartsOn), 6))
}

export function isSameMonth(a: DateInput, b: DateInput): boolean {
  const x = toDate(a), y = toDate(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth()
}

/** Every day from `start` to `end` inclusive - what calendars grid over. */
export function eachDayOfInterval(start: DateInput, end: DateInput): Date[] {
  const out: Date[] = []
  let cur = startOfDay(start)
  const last = startOfDay(end)
  // Guard against an inverted range rather than looping forever.
  while (cur.getTime() <= last.getTime()) {
    out.push(cur)
    cur = addDays(cur, 1)
  }
  return out
}

// ── Machine formats ─────────────────────────────────────────────────────────
// Keys, sort values, `<input type="date">` values: these must NOT be localised -
// they are read by code, not by people.
//
// Built from the LOCAL calendar fields rather than `toISOString()`, which
// converts to UTC first: at 23:30 in Paris that returns tomorrow's date, and the
// day silently shifts. A classic, and hard to see in testing.

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** `YYYY-MM-DD` in the viewer's own day. */
export function toISODate(value: DateInput): string {
  const d = toDate(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `YYYY-MM` - month keys. */
export function toISOMonth(value: DateInput): string {
  const d = toDate(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** `HH:MM` on the 24-hour clock, whatever the reader's language prefers. */
export function toISOTime(value: DateInput): string {
  const d = toDate(value)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `YYYY-MM-DDTHH:MM` - the value an `<input type="datetime-local">` expects. */
export function toISODateTimeLocal(value: DateInput): string {
  return `${toISODate(value)}T${toISOTime(value)}`
}

/**
 * ISO 8601 week number - what `date-fns` wrote as `'I'`.
 *
 * The rule is not "the nth block of seven days": week 1 is the one holding the
 * first Thursday of the year, which is why the calculation moves to that
 * Thursday before counting. Getting this wrong shows up once a year, in the days
 * around New Year, on exactly the screens nobody re-checks.
 */
export function isoWeek(value: DateInput): number {
  const d = startOfDay(value)
  // Monday = 0 … Sunday = 6, then jump to this week's Thursday.
  const day = (d.getDay() + 6) % 7
  const thursday = addDays(d, 3 - day)
  const firstThursday = new Date(thursday.getFullYear(), 0, 4)
  const shift = (firstThursday.getDay() + 6) % 7
  const week1 = addDays(firstThursday, -shift)
  return 1 + Math.round((thursday.getTime() - week1.getTime()) / 604800000)
}

/** The ISO week-numbering year, which differs from the calendar year at the turn. */
export function isoWeekYear(value: DateInput): number {
  const d = startOfDay(value)
  const day = (d.getDay() + 6) % 7
  return addDays(d, 3 - day).getFullYear()
}
