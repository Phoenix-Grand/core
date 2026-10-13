import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { fmtBytes } from '../DashboardCharts'
import { bucketFullLabel, bucketLabel } from '../panels/bucketLabel'
import type { PanelDef, PanelPeriod } from '../panels/types'
import type { PanelDetail, ReportPanel } from './api'

/**
 * The report, as a described document — before anything is drawn.
 *
 * ## Why the model exists at all
 *
 * A report is rendered TWICE: once as a page (which is also what gets printed)
 * and once as a CSV file. Those two renderings must carry the same rows, the
 * same totals and the same labels, or an operator who exports what they printed
 * ends up with a spreadsheet that disagrees with the paper on their desk. Built
 * separately they would drift on the first detail — a share rounded here and
 * truncated there, a bucket named one way in a cell and another in a column.
 *
 * So the figures are assembled once, here, and the two renderers only decide how
 * to paint what this module already decided.
 *
 * ## What it refuses to compute
 *
 * A share of a total that is zero, a percentage against a previous window that
 * counted nothing, a variation for a panel whose past nobody recorded. Each of
 * those comes back `null` and the renderers print a sentence instead of a
 * number — the same rule the cards obey, for the same reason: "+100 %" and
 * "0 %" are both false readings of "there was nothing to compare against", and
 * on a printed page nobody is left to ask.
 */

/** One row of the chronological table. */
export interface SeriesRow {
  /** The instant, spelt in full — a report is read away from its window. */
  label: string
  /** The same instant, as short as the axis needs it. */
  axis:  string
  value: number
  /** The value, spelt in the panel's unit. */
  text:  string
}

/** One row of the breakdown table. */
export interface BreakdownRow {
  key:   string
  label: string
  value: number
  text:  string
  /** Share of the breakdown's own total, in percent. `null` when it is zero. */
  share: number | null
  /** This entry's own ceiling, when it has one (an account's quota). */
  capacity: number | null
  /** Share of THAT ceiling, in percent. `null` without one. */
  used: number | null
}

/**
 * The records behind the figure, ready to print.
 *
 * Cells are already spelt: an instant is formatted in the zone the document
 * names (never the reader's), everything else is printed exactly as the server
 * stored it. `null` survives as `null` — the page prints an em dash for it and
 * the CSV leaves the cell empty, which are two correct renderings of the same
 * "this record does not carry that".
 */
export interface DetailModel {
  /** Column headings, translated. */
  headers: string[]
  /** `kind` of each column, parallel to `headers`; drives alignment only. */
  kinds:   string[]
  rows:    (string | null)[][]
  /** The reading stopped at the server's ceiling rather than the window's end. */
  truncated: boolean
  /** That ceiling, so the page can name it. */
  limit:   number
}

export interface ReportModel {
  /** Formats a figure in the panel's unit — counts, or bytes. */
  fmt:   (v: number) => string
  bytes: boolean

  total:     number
  totalText: string
  /** The window of identical length before this one. `null` for a snapshot. */
  previous:     number | null
  previousText: string | null
  /** Variation in percent. `null` when there is nothing honest to state. */
  delta: number | null
  /** The panel describes the present, and nothing recorded its past. */
  snapshot: boolean

  series:   SeriesRow[]
  /** Sum of the series — stated only when it can be added up (see below). */
  seriesTotal: number | null

  breakdown:      BreakdownRow[]
  breakdownTotal: number
  /** The breakdown stopped at the server's ceiling rather than at its end. */
  truncated: boolean

  /** The records behind the figure. `null` when the source has none to give. */
  detail: DetailModel | null
  /**
   * Why there are none, as the server's own reason — `snapshot`, `distinct`,
   * `aggregated`, `breakdown`, `withheld`. `null` when the panel HAS records,
   * or when the server never said anything about them.
   */
  detailAbsent: string | null

  /** The window, spelt for a human: the two dates, and the zone they are in. */
  from:     string
  to:       string
  timezone: string
  /** The comparison window, same spelling. */
  previousFrom: string
  previousTo:   string
}

/**
 * An instant, spelt in full — the window bounds, and the moment of generation.
 *
 * ## Read in the INSTANCE's zone, not the reader's
 *
 * These are true instants (the server sends them with their offset), so a
 * browser in Montréal would otherwise print a window an administrator in Paris
 * had never asked for — while the line right beside it says "Europe/Paris". A
 * document that names a zone and then states its dates in another one is worse
 * than one that names none, because it looks checked.
 *
 * The zone is a name the server chose, so it is tried and not trusted: an
 * identifier this browser's ICU does not know throws, and the reader's own zone
 * is a far better fallback than a blank line.
 */
function formatWith(
  iso:      string,
  locale:   string,
  opts:     Intl.DateTimeFormatOptions,
  timeZone?: string,
): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat(locale, { ...opts, timeZone }).format(d)
    } catch {
      // Unknown zone identifier: fall through to the reader's own.
    }
  }
  return new Intl.DateTimeFormat(locale, opts).format(d)
}

export function formatInstant(iso: string, locale: string, timeZone?: string): string {
  return formatWith(iso, locale, { dateStyle: 'long', timeStyle: 'short' }, timeZone)
}

/**
 * The instant of ONE RECORD, in a table of them.
 *
 * Short date and seconds, where the window bounds get a long date and no
 * seconds — because the two answer different questions. A header states a
 * stretch of time somebody has to be able to check; a detail row states when
 * one event happened, next to two thousand others, and a burst of failed
 * sign-ins inside the same minute is exactly what the reader is looking for.
 * Same zone as everything else on the page: the one the document names.
 */
export function formatStamp(iso: string, locale: string, timeZone?: string): string {
  return formatWith(iso, locale, { dateStyle: 'short', timeStyle: 'medium' }, timeZone)
}

/**
 * The heading of a detail column.
 *
 * Most columns are concepts the console already names elsewhere — an actor, an
 * outcome, a severity — and they take THAT wording rather than a second one:
 * two headings for one concept is how a console starts to read as two products.
 * Everything with no existing home gets its own `rep_col_*` key, and an id this
 * build has never heard of is printed verbatim, which is ugly and true.
 */
const SHARED_COLUMN_KEY: Record<string, string> = {
  action:   'admin.audit_col_action',
  actor:    'admin.audit_col_actor',
  target:   'admin.audit_col_target',
  outcome:  'admin.audit_col_outcome',
  ip:       'admin.audit_col_ip',
  detail:   'admin.audit_detail',
  module:   'admin.audit_target_module',
  kind:     'admin.al_col_kind',
  severity: 'admin.al_col_severity',
  status:   'admin.al_col_status',
}

export function detailColumnKey(id: string): string {
  return SHARED_COLUMN_KEY[id] ?? `admin.rep_col_${id}`
}

/**
 * The served records, spelt.
 *
 * The only cell this touches is the instant: everything else is printed as the
 * server stored it, deliberately. A report that translated `bad_credentials`
 * into a friendly sentence would be stating something the trail does not say,
 * and the trail is the thing being reported on.
 */
function buildDetail(
  raw:      PanelDetail,
  locale:   string,
  timeZone: string,
  heading:  (id: string) => string,
): DetailModel {
  const kinds = raw.columns.map(c => c.kind)
  return {
    headers: raw.columns.map(c => heading(c.id)),
    kinds,
    rows: (raw.rows ?? []).map(row =>
      row.map((cell, i) =>
        cell === null || cell === ''
          ? null
          : kinds[i] === 'instant'
            ? formatStamp(cell, locale, timeZone)
            : cell,
      ),
    ),
    truncated: raw.truncated === true,
    limit:     typeof raw.limit === 'number' ? raw.limit : 0,
  }
}

/**
 * Assembles the document.
 *
 * `def` says what the panel is called and how its keys are spelt; `panel` is
 * what the server counted; `period` is the window both were read over.
 * `labelSlice` overrides the wording of one breakdown key when the name is a
 * fact this build has to look up rather than a translation — a module's display
 * name, say. It is the same hook the cards take, so a legend printed on paper
 * and the legend on screen cannot end up naming things differently.
 */
export function useReportModel(
  def:        PanelDef,
  panel:      ReportPanel,
  period:     PanelPeriod,
  labelSlice?: (key: string) => string,
): ReportModel {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const bytes = panel.unit === 'bytes'

  const fmt = useCallback(
    (v: number) => (bytes ? fmtBytes(v) : v.toLocaleString(locale)),
    [bytes, locale],
  )

  /**
   * The breakdown key, spelt for a human.
   *
   * The fallback is the key ITSELF, never a placeholder — exactly as on the
   * card. An id this build has no wording for is printed verbatim, which is ugly
   * and true, rather than folded into "autre", which is tidy and false.
   */
  const sliceLabel = useCallback(
    (key: string) => {
      if (labelSlice) return labelSlice(key)
      return def.legendKey ? t(def.legendKey(key), { defaultValue: key }) : key
    },
    [def, t, labelSlice],
  )

  const weekOf = useCallback(
    (date: string) => t('admin.rep_week_of', { date, defaultValue: date }),
    [t],
  )

  const columnHeading = useCallback(
    (id: string) => t(detailColumnKey(id), { defaultValue: id }),
    [t],
  )

  return useMemo(() => {
    const series: SeriesRow[] = panel.series.map(p => ({
      label: bucketFullLabel(p.bucket, period.bucket, locale, weekOf),
      axis:  bucketLabel(p.bucket, period.bucket, locale),
      value: p.value,
      text:  fmt(p.value),
    }))

    const breakdownTotal = panel.breakdown.reduce((s, x) => s + x.value, 0)
    const breakdown: BreakdownRow[] = panel.breakdown.map(s => ({
      key:      s.key,
      label:    sliceLabel(s.key),
      value:    s.value,
      text:     fmt(s.value),
      share:    breakdownTotal > 0 ? (s.value / breakdownTotal) * 100 : null,
      capacity: s.capacity && s.capacity > 0 ? s.capacity : null,
      used:     s.capacity && s.capacity > 0 ? (s.value / s.capacity) * 100 : null,
    }))

    const previous = panel.previous_total ?? null
    const snapshot = previous === null

    /**
     * The sum of the buckets, and when it may be printed.
     *
     * A series of counts adds up to the period's total; a series of DISTINCT
     * values does not — the same person signing in on Monday and on Tuesday is
     * counted in both buckets and once in the total. Adding those columns would
     * print a number larger than the total right above it, with no explanation
     * on the page. So the sum is stated only when the two agree, which is
     * exactly the case where it means something.
     */
    const summed = series.reduce((s, r) => s + r.value, 0)
    const seriesTotal = series.length > 0 && summed === panel.total ? summed : null

    return {
      fmt,
      bytes,
      total:     panel.total,
      totalText: fmt(panel.total),
      previous,
      previousText: previous === null ? null : fmt(previous),
      // No percentage against an empty window, and none at all for a snapshot:
      // the rule the cards obey (`PanelCard`), stated once more where the number
      // is about to be printed on paper.
      delta: !snapshot && previous > 0
        ? Math.round(((panel.total - previous) / previous) * 100)
        : null,
      snapshot,
      series,
      seriesTotal,
      breakdown,
      breakdownTotal,
      truncated: panel.breakdown_truncated === true,
      detail: panel.detail
        ? buildDetail(panel.detail, locale, period.timezone, columnHeading)
        : null,
      // Stated only when the server said something. A server that never heard
      // of records says nothing, and the document prints no section at all
      // rather than a sentence explaining an absence it cannot account for.
      detailAbsent: panel.detail ? null : panel.detail_absent ?? null,
      // Stated in the zone the header names, never in the reader's own.
      from:         formatInstant(period.from, locale, period.timezone),
      to:           formatInstant(period.to, locale, period.timezone),
      timezone:     period.timezone,
      previousFrom: formatInstant(period.previous_from, locale, period.timezone),
      previousTo:   formatInstant(period.previous_to, locale, period.timezone),
    }
  }, [panel, period, locale, fmt, bytes, sliceLabel, weekOf, columnHeading])
}
