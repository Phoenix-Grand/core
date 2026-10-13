import type { ReactNode } from 'react'

/**
 * What the paginator is given: the document as a list of items, in reading
 * order, each one either indivisible or splittable at row boundaries.
 *
 * The distinction is the whole of it. A heading over three figures that gets
 * cut in half is a defect; a table of two thousand records that refuses to be
 * cut is a worse one — it would start on a fresh sheet and leave the previous
 * one half empty, and it still would not fit. So blocks are atoms unless they
 * carry rows, and blocks that carry rows are cut between them, never through
 * one.
 */

/** An indivisible block: it lands whole on a sheet, or it opens the next one. */
export interface AtomItem {
  kind: 'atom'
  id:   string
  node: ReactNode
}

/**
 * A block built around a table, cuttable between rows.
 *
 * `head` and `foot` are `<tr>` elements, `rows` an array of them. A fragment
 * repeats `head` (a column heading that appears once, on the sheet before, is
 * a table of unlabelled numbers) and carries `foot` only on the last fragment
 * (a total restated on every sheet would read as a subtotal).
 */
export interface TableItem {
  kind:  'table'
  id:    string
  title: string
  /** Sentence under the table — a truncation notice, a count. Last fragment only. */
  note?: ReactNode
  /** `--kb-text-body` for the aggregates, `--kb-text-meta` for the records. */
  fontSize: string
  head:  ReactNode
  rows:  ReactNode[]
  foot?: ReactNode
}

export type FlowItem = AtomItem | TableItem

/** One item as PLACED on a sheet: an atom, or a slice of a table. */
export type Placement =
  | { kind: 'atom'; id: string }
  | {
      kind:      'table'
      id:        string
      /** Half-open row range of this fragment. */
      from:      number
      to:        number
      /** Not the first fragment: the title says so, the reader is not lost. */
      continued: boolean
      /** Last fragment: it carries the total row and the note. */
      last:      boolean
    }

export interface Sheet {
  placements: Placement[]
}
