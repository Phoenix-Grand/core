import type { ReportModel } from './model'

/**
 * The report as a spreadsheet.
 *
 * ## Why this is hand-rolled and not a library
 *
 * CSV has no specification anybody follows; what it has is a set of habits a
 * spreadsheet expects. Three of them decide whether the file opens correctly or
 * as one column of mojibake, and all three are two lines of code:
 *
 *   1. **A byte-order mark.** Excel reads a BOM-less file as the machine's
 *      legacy code page, which turns every accented character into rubbish. The
 *      file below starts with U+FEFF for that single reason — written as an
 *      escape, never as the character itself, which is invisible in source and
 *      is exactly the kind of thing a well-meaning editor strips.
 *   2. **The separator matches the decimal mark.** A locale that writes `12,5`
 *      cannot also use `,` between fields — the shares would split in half, one
 *      column per digit. So the separator is CHOSEN from the locale: `;` where
 *      the decimal mark is a comma, `,` everywhere else. This is why French
 *      spreadsheets expect semicolons, and it is not a preference.
 *   3. **Quoting.** A field containing the separator, a quote or a newline is
 *      wrapped and its quotes doubled. A module display name with a comma in it
 *      is not hypothetical.
 *
 * ## What the file contains
 *
 * The whole document, not just its tables: the instance, the report, the window,
 * who produced it and when, then the figures, then the tables — series,
 * breakdown, and the RECORDS behind them. A CSV detached from its header is a
 * column of numbers nobody can date — which is the failure this entire feature
 * exists to fix, and it would be odd to reintroduce it in the export.
 *
 * The export carries the same truncation notices as the page. A file that
 * stopped at two thousand rows and did not say so is the worst object this
 * feature could produce: it looks exhaustive, it sorts, it sums, and it is
 * wrong.
 */

/** A row of the file: cells, or `null` for a blank separating line. */
export type CsvRow = string[] | null

/** The decimal mark this locale writes — and therefore the separator to avoid. */
function decimalComma(locale: string): boolean {
  try {
    return (1.1).toLocaleString(locale).includes(',')
  } catch {
    // An unknown locale tag must not cost the operator their export.
    return false
  }
}

function quote(value: string, sep: string): string {
  const v = value ?? ''
  return /["\n\r]/.test(v) || v.includes(sep) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * Rows → the text of a CSV file, BOM included.
 *
 * CRLF line endings: the one habit every spreadsheet on every system agrees on.
 */
export function toCsv(rows: CsvRow[], locale: string): string {
  const sep = decimalComma(locale) ? ';' : ','
  const body = rows
    .map(row => (row === null ? '' : row.map(cell => quote(cell, sep)).join(sep)))
    .join('\r\n')
  return `\uFEFF${body}\r\n`
}

/** A number for a spreadsheet CELL: no grouping, the locale's decimal mark. */
export function csvNumber(value: number, locale: string, decimals = 0): string {
  try {
    return new Intl.NumberFormat(locale, {
      useGrouping:           false,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value)
  } catch {
    return String(value)
  }
}

/** What the header of the file states, before any table. */
export interface CsvHeading {
  instance:    string
  title:       string
  about:       string
  periodLabel: string
  generatedAt: string
  generatedBy: string
}

/** The words the file uses for its own structure, already translated. */
export interface CsvWords {
  instance:  string
  report:    string
  about:     string
  period:    string
  from:      string
  to:        string
  timezone:  string
  generated: string
  by:        string
  total:     string
  previous:  string
  variation: string
  series:    string
  bucket:    string
  value:     string
  breakdown: string
  entry:     string
  share:     string
  quota:     string
  used:      string
  truncated: string
  none:      string
  /** Heading of the records section. */
  detail:          string
  /** Why there are no records, already spelt. Empty when there are. */
  detailNone:      string
  /** "listed / total", already spelt. Empty when there is no table. */
  detailCount:     string
  /** The ceiling sentence, already spelt. Empty when the list is complete. */
  detailTruncated: string
}

/**
 * The whole document as rows.
 *
 * Values are written TWICE where the two readings differ: the spelt figure
 * (`1,2 Go`) is what the page shows, and the raw number is what a spreadsheet
 * can sum. A file carrying only the first is a picture of a table; one carrying
 * only the second loses the unit.
 */
export function reportRows(
  model:   ReportModel,
  heading: CsvHeading,
  words:   CsvWords,
  locale:  string,
): CsvRow[] {
  const n = (v: number, d = 0) => csvNumber(v, locale, d)
  const rows: CsvRow[] = [
    [words.instance,  heading.instance],
    [words.report,    heading.title],
    [words.about,     heading.about],
    [words.period,    heading.periodLabel],
    [words.from,      model.from],
    [words.to,        model.to],
    [words.timezone,  model.timezone],
    [words.generated, heading.generatedAt],
    [words.by,        heading.generatedBy],
    null,
    [words.total, model.totalText, n(model.total)],
  ]

  if (model.previousText !== null && model.previous !== null) {
    rows.push([words.previous, model.previousText, n(model.previous)])
  }
  if (model.delta !== null) {
    rows.push([words.variation, `${model.delta > 0 ? '+' : ''}${n(model.delta)} %`])
  }

  rows.push(null, [words.series])
  if (model.series.length === 0) {
    rows.push([words.none])
  } else {
    rows.push([words.bucket, words.value, ''])
    for (const r of model.series) rows.push([r.label, r.text, n(r.value)])
    if (model.seriesTotal !== null) {
      rows.push([words.total, model.fmt(model.seriesTotal), n(model.seriesTotal)])
    }
  }

  rows.push(null, [words.breakdown])
  if (model.breakdown.length === 0) {
    rows.push([words.none])
  } else {
    const quotas = model.breakdown.some(r => r.capacity !== null)
    rows.push(
      quotas
        ? [words.entry, words.value, '', words.share, words.quota, words.used]
        : [words.entry, words.value, '', words.share],
    )
    for (const r of model.breakdown) {
      const base = [r.label, r.text, n(r.value), r.share === null ? '' : `${n(r.share, 1)} %`]
      rows.push(
        quotas
          ? [...base,
             r.capacity === null ? '' : model.fmt(r.capacity),
             r.used === null ? '' : `${n(r.used, 1)} %`]
          : base,
      )
    }
    rows.push([words.total, model.fmt(model.breakdownTotal), n(model.breakdownTotal)])
    if (model.truncated) rows.push([words.truncated])
  }

  // ── The records ────────────────────────────────────────────────────────────
  //
  // The export carries them for the same reason the page does: a spreadsheet of
  // aggregates is a spreadsheet nobody can sort by account. Cells go out
  // exactly as the page prints them — the instants already spelt in the
  // document's zone — except that a missing value is an EMPTY cell rather than
  // an em dash: a spreadsheet filters on empty, and "—" is a value.
  if (model.detail !== null) {
    rows.push(null, [words.detail])
    if (model.detail.rows.length === 0) {
      rows.push([words.none])
    } else {
      rows.push(model.detail.headers)
      for (const row of model.detail.rows) rows.push(row.map(cell => cell ?? ''))
      if (words.detailCount) rows.push([words.detailCount])
      if (model.detail.truncated && words.detailTruncated) {
        rows.push([words.detailTruncated])
      }
    }
  } else if (words.detailNone) {
    // No table, but a stated reason — which belongs in the file too: a reader
    // who finds no records must be able to tell "none were listed" from "none
    // exist", and the answer is the same sentence the page prints.
    rows.push(null, [words.detail], [words.detailNone])
  }

  return rows
}

/**
 * Hands the file to the browser.
 *
 * An object URL rather than a `data:` one: a `data:` URL of a few hundred
 * kilobytes is refused outright by more than one browser, and a report of a
 * thousand accounts reaches that easily. Revoked on the next frame — kept alive
 * only as long as the click needs it.
 */
export function downloadCsv(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** A file name a directory can be sorted by: subject, window, day. */
export function csvFilename(panelId: string, periodId: string): string {
  const day = new Date().toISOString().slice(0, 10)
  const safe = (s: string) => s.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()
  return `rapport-${safe(panelId)}-${safe(periodId)}-${day}.csv`
}
