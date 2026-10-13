import { MM } from './geometry'
import type { FlowItem, Placement, Sheet } from './types'

/**
 * Cutting a document into sheets.
 *
 * A pure function of heights: it never touches the DOM, which is what makes it
 * testable and what makes the preview and the printout agree — both are drawn
 * from the same array of `Sheet`.
 *
 * ## The three rules it enforces
 *
 *  1. **An atom is never cut.** It fits on the remaining space or it opens the
 *     next sheet.
 *  2. **A table is cut between rows, never through one**, its column heading is
 *     repeated on every fragment, and its total row travels with the LAST
 *     fragment — a total restated at the foot of each sheet reads as a subtotal
 *     and is a lie about the figure above it.
 *  3. **No orphan start.** A table that can only fit its heading and one row at
 *     the bottom of a sheet starts on the next one instead: two lines under a
 *     heading, then a page turn, is worse than a little white space.
 */

/**
 * Space between two blocks.
 *
 * ⚠ Coupled to `index.css`: `[data-admin-report] [data-report-card]` sets
 * `margin: 4mm 0 0 0`. The two must agree — the paginator adds this to its
 * running total, the browser adds it to the sheet, and a millimetre of
 * disagreement per block becomes a centimetre by the tenth one.
 */
export const GAP = 4 * MM

/** Fewest rows worth starting a table with at the bottom of a sheet. */
const MIN_ROWS = 2

/** What the measuring pass hands over, per item. */
export interface AtomMetrics { height: number }

export interface TableMetrics {
  /** Title + the block's top padding: repeated on every fragment. */
  chromeTop:    number
  /** The block's bottom padding, without the note. */
  chromeBottom: number
  head:   number
  rows:   number[]
  /** Total row, on the last fragment only. 0 when the table has none. */
  foot:   number
  /** Sentence under the table, on the last fragment only. */
  note:   number
}

export type Metrics = Record<string, AtomMetrics | TableMetrics>

function isTable(m: AtomMetrics | TableMetrics): m is TableMetrics {
  return 'rows' in m
}

/** What one sheet offers: how tall it is, and the measurements taken at ITS width. */
export interface SheetSpec {
  height:  number
  metrics: Metrics
}

/**
 * @param items the document, in reading order
 * @param spec  called with a sheet's index (0-based, excluding any cover), and
 *              returning that sheet's usable height and the measurements taken
 *              at its own content width.
 *
 * The indirection is what makes ORIENTATION PER SHEET possible: sheet 3 can be
 * landscape while its neighbours are portrait, and it is not merely drawn wider
 * — it is filled with the row heights the document actually has at that width,
 * which are not the portrait ones. A single set of measurements would put the
 * portrait cut on a landscape sheet and leave it either short or overflowing.
 */
export function paginate(items: FlowItem[], spec: (index: number) => SheetSpec): Sheet[] {
  const sheets: Sheet[] = []
  let current: Placement[] = []
  let sheet = spec(0)
  let left = sheet.height

  const flush = () => {
    if (current.length > 0) sheets.push({ placements: current })
    current = []
    sheet = spec(sheets.length)
    left = sheet.height
  }
  /** Height a block costs on the sheet it lands on, gap included when not first. */
  const cost = (h: number) => (current.length > 0 ? h + GAP : h)

  for (const item of items) {
    if (!sheet.metrics[item.id]) continue

    if (item.kind === 'atom') {
      const first = sheet.metrics[item.id]
      const h0 = isTable(first) ? 0 : first.height
      if (current.length > 0 && cost(h0) > left) flush()
      // Re-read after a possible flush: the new sheet may be a different width,
      // and this block is a different height on it.
      const m2 = sheet.metrics[item.id]
      const h = !m2 || isTable(m2) ? 0 : m2.height
      current.push({ kind: 'atom', id: item.id })
      left -= cost(h)
      continue
    }

    let i = 0
    let done = false

    while (!done) {
      let m = sheet.metrics[item.id] as TableMetrics
      if (!m || !isTable(m)) break
      let tail = m.foot + m.note + m.chromeBottom
      // What it takes to be worth opening a fragment here: the heading, the
      // column row, and enough body rows not to be an orphan.
      const probe = m.rows.slice(i, i + MIN_ROWS).reduce((a, b) => a + b, 0)
      const minimum = m.chromeTop + m.head + (i < m.rows.length ? probe : tail)
      if (current.length > 0 && cost(minimum) > left) {
        flush()
        m = sheet.metrics[item.id] as TableMetrics
        if (!m || !isTable(m)) break
        tail = m.foot + m.note + m.chromeBottom
      }

      const overhead = cost(m.chromeTop + m.head)
      const room = left - overhead
      let j = i
      let used = 0
      while (j < m.rows.length && used + m.rows[j] <= room) {
        used += m.rows[j]
        j++
      }
      if (j === i && i < m.rows.length) {
        // Not one row fits. On a sheet that already carries something, start
        // over on a fresh one rather than emit a heading with no rows under it.
        if (current.length > 0) {
          flush()
          continue
        }
        // On an empty sheet it means the row is taller than the sheet: let it
        // overflow rather than hang. The preview shows the overflow, which is
        // the honest outcome and the operator's cue to print landscape.
        used += m.rows[i]
        j = i + 1
      }

      let last = j >= m.rows.length
      if (last && used + tail > room) {
        // The body ends here but the total row does not fit under it. Give rows
        // back until it does; if even that fails, the tail opens a fragment of
        // its own on the next sheet.
        while (j > i + 1 && used + tail > room) {
          j--
          used -= m.rows[j]
        }
        if (used + tail > room) last = false
      }

      current.push({ kind: 'table', id: item.id, from: i, to: j, continued: i > 0, last })
      left -= overhead + used + (last ? tail : m.chromeBottom)
      i = j
      done = last
      if (!done) flush()
    }
  }

  flush()
  return sheets
}
