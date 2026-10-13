import type { LucideIcon } from 'lucide-react'

/**
 * What a dashboard panel IS — the vocabulary shared by every panelled page of
 * the console.
 *
 * The console has more than one dashboard (the security overview, the general
 * one) and they are built from the same parts: a window the operator picks, a
 * figure, a variation against the window of identical length before it, a chart,
 * and a way through to the report that owns the records. Written once here, so
 * that two pages cannot end up meaning two different things by "−12 %".
 *
 * The server sends the numbers; the tables below say what those numbers are
 * called, which report answers them in full, and how they should be read. That
 * half stays in the browser deliberately: the wording is translated, the report
 * link is an address this build knows how to spell, and neither belongs in an
 * API another client may consume.
 */

/** One bucket of a series. `bucket` is a LOCAL wall-clock instant. */
export interface PanelPoint {
  bucket: string
  value:  number
}

export interface PanelSlice {
  key:   string
  value: number
  /**
   * This slice's own ceiling, when it has one — an account's quota against the
   * volume it holds. Absent for a slice that is simply a share of a whole, which
   * is then drawn against the largest slice.
   */
  capacity?: number
}

/**
 * One panel, as the server computed it.
 *
 * `previous_total` covers the window of identical length immediately before the
 * reading — including for a period still running, which is read up to now on
 * both sides so three days of a month are never compared against a whole one.
 * It is **null** for a panel that describes the present and whose past nobody
 * recorded (how accounts are spread between active and suspended, which modules
 * are healthy): the card then says "état actuel" instead of inventing an arrow.
 */
export interface DashboardPanel {
  id:             string
  total:          number
  previous_total: number | null
  /** Read as a top-N list rather than as parts of a whole. */
  ranking:        boolean
  /** How the figure is to be spelt. Absent means `count`. */
  unit?:          'count' | 'bytes'
  /** The ceiling `total` is a share of, when it is a fraction of anything. */
  capacity?:      number | null
  series:         PanelPoint[]
  breakdown:      PanelSlice[]
  /**
   * A limit of the MEASUREMENT, printed under the chart. Not a warning about the
   * instance — a statement about what the number can and cannot mean.
   */
  caveat:         string | null
}

export type PanelBucket = 'hour' | 'day' | 'week'

export interface PanelPeriod {
  id:            string
  from:          string
  to:            string
  previous_from: string
  previous_to:   string
  bucket:        PanelBucket
  timezone:      string
}

/** How the panel is drawn. */
export type PanelShape =
  /** A series over time, as bars. Counts of discrete events. */
  | 'bars'
  /** A series over time, as a filled curve. Continuous activity. */
  | 'area'
  /** Parts of a whole, as a ring with a named legend. */
  | 'donut'
  /** Top N, as horizontal bars. No time axis. */
  | 'ranking'
  /** A share of a stated ceiling, as a gauge. Needs `capacity`. */
  | 'gauge'

/**
 * What an increase MEANS.
 *
 * Readings are not "up is good". More failed sign-ins, more disowned devices and
 * more alerts are worse; more sign-ins is neither. Colouring every rise green —
 * the default of every generic dashboard — would make a breach look like growth.
 */
export type PanelPolarity = 'neutral' | 'bad-up'

export interface PanelDef {
  id:        string
  Icon:      LucideIcon
  /** Translation key of the title. */
  titleKey:  string
  /** Translation key of the one-line explanation of what is counted. */
  aboutKey:  string
  shape:     PanelShape
  polarity:  PanelPolarity
  /** Privilege the server requires at instance scope. */
  privilege: string
  /**
   * Nav leaf that owns the RECORDS behind this panel — the session inventory,
   * the audit trail, the alert queue.
   *
   * It is no longer what "afficher le rapport" opens: that action now opens the
   * printable report (`./report.ts`), which is the document the label always
   * promised. This is the link the report itself offers under its tables, for
   * the reader who wants the rows rather than the figures.
   */
  reportTab: string
  /**
   * Colour of ONE breakdown slice, when the slice means something.
   *
   * Slices are otherwise coloured by rank in the series palette, which is right
   * for a list of modules and wrong for a list of states: the largest share took
   * the accent colour, so an instance whose accounts are mostly SUSPENDED drew
   * its biggest arc in the same blue as everything healthy. Returning `undefined`
   * keeps the palette for that slice.
   */
  sliceTone?: (key: string) => string | undefined
  /** Parameters the report is opened with, when it takes any. */
  reportParams?: Record<string, string>
  /**
   * Translation key of one breakdown entry.
   *
   * A function rather than a prefix, because the vocabularies these pages show
   * are ALREADY translated elsewhere and their key shapes differ — an
   * authentication strength is `devices.auth_<x>`, an alert kind is
   * `admin.al_<x_with_underscores>_name`. Reusing them is not a shortcut: it is
   * what stops the same thing being called two different names on two screens.
   *
   * Absent when the key is already text an operator reads: a rule's name, a
   * country code, an action identifier the audit trail prints verbatim.
   */
  legendKey?: (key: string) => string
  /**
   * Translation key of a caveat id. Defaults to the `admin.sec_caveat_<id>`
   * namespace, which is where the first panelled page put them.
   */
  caveatKey?: (id: string) => string
}
