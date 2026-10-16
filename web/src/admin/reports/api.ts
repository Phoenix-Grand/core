import { useQuery } from '@tanstack/react-query'
import { api } from '../../core/api/client'
import { PRIV } from '../../core/authz/types'
import { usePrivileges } from '../../core/authz/usePrivileges'
import type { PanelSource } from '../panels/report'
import type { DashboardPanel, PanelPeriod } from '../panels/types'
import { getPublicConfig } from '../../core/api/publicConfig'

/**
 * What a report reads - the SAME endpoints the dashboards read, narrowed.
 *
 * ## No second dialect
 *
 * A report is not a new measurement, it is the existing one printed in full: it
 * asks `/admin/dashboard` (or `/admin/security/dashboard`) for one panel, over
 * one window, with its breakdown untruncated. Every rule that governs a panel -
 * the closed list of periods, the comparison against the window of identical
 * length before it, the privilege checked at instance scope - therefore governs
 * the report by construction. A dedicated `/admin/reports` route would have been
 * a second place for those rules to be stated, and eventually a second answer.
 *
 * ## The two parameters a report adds
 *
 *   • `panel=<id>`  - compute this panel and no other. A document about one
 *     panel has no use for the other ten, and computing them is ten times the
 *     database work for figures nobody will read.
 *   • `full=true`   - read every slice of the breakdown, not the card's top-N.
 *     A ranking cut at six is what a card wants and exactly what a report must
 *     not be. The server still keeps a ceiling and SAYS when it was reached
 *     (`breakdown_truncated`), because a list that stopped is not a list that
 *     ended.
 *   • `detail=true` - list the RECORDS behind the figure, not only its count.
 *     A report of failed sign-ins that never names an account is a counter
 *     printed on paper. The rows name people, so the server checks the panel's
 *     own privilege at instance scope (plus, where the rows are a directory,
 *     the one that opens it) and AUDITS the consultation. A dashboard card
 *     never asks for them.
 */

/** Where a figure comes from, as facts rather than prose (`period.rs`). */
export interface PanelProvenance {
  /** Table the figure is read from. */
  table:   string
  /** Predicate narrowing it. `TRUE` means the whole table. */
  filter:  string
  /** How the rows become one number. A closed vocabulary, see `Provenance`. */
  measure: 'count' | 'count_distinct' | 'sum' | string
  /** The column `count_distinct` and `sum` apply to. */
  column?: string | null
}

/**
 * One column of the records behind a figure.
 *
 * `kind` is what the console formats on, and it is a CLOSED vocabulary the
 * server owns: `instant` is an ISO-8601 instant to be spelt in the zone the
 * document names, `code` an identifier printed exactly as stored, `text` a
 * human string. A kind this build does not know is printed as plain text -
 * ugly and true, rather than dropped.
 */
export interface PanelDetailColumn {
  /** Stable id: the translation key of the heading, and the CSV header. */
  id:   string
  kind: 'instant' | 'code' | 'text' | string
}

/** The records behind a figure, as a table nothing in the console interprets. */
export interface PanelDetail {
  columns: PanelDetailColumn[]
  /** One entry per column, `null` for a value the record does not carry. */
  rows:      (string | null)[][]
  /** The reading stopped at the server's ceiling rather than at the window's end. */
  truncated: boolean
  /** That ceiling, so the document can name it rather than allude to it. */
  limit:     number
}

/**
 * One panel as a report reads it: everything a card gets, plus the things only
 * a printed document needs.
 *
 * All of them are OPTIONAL on the wire. A console talking to a server that
 * predates them still renders a correct report - it simply cannot state the
 * method, cannot promise the list is complete and cannot list the records, so
 * it says none of the three.
 */
export interface ReportPanel extends DashboardPanel {
  /** The breakdown stopped at the server's ceiling rather than at its end. */
  breakdown_truncated?: boolean
  source?:              PanelProvenance
  /** The records behind the figure, when the source has individual ones. */
  detail?:              PanelDetail
  /**
   * Why it has none. A closed vocabulary (`detail::absent`, server side) the
   * console turns into one sentence: `snapshot`, `distinct`, `aggregated`,
   * `breakdown`, `withheld`.
   */
  detail_absent?:       string
}

interface PanelPayload {
  period:   PanelPeriod
  /** The closed list of selectable windows, in display order. */
  periods:  string[]
  panels:   ReportPanel[]
  /** Panels the caller does not hold the privilege for, at instance scope. */
  withheld: string[]
}

/** What a report needs to render itself, once the panel has been picked out. */
export interface ReportData {
  period:   PanelPeriod
  periods:  string[]
  panel:    ReportPanel | null
  /** True when the panel exists but this administrator may not read it. */
  withheld: boolean
}

const ENDPOINT: Record<PanelSource, string> = {
  dashboard: '/admin/dashboard',
  security:  '/admin/security/dashboard',
}

/**
 * The privilege that opens the page a panel belongs to.
 *
 * Exported because the report page needs the SAME answer the query hook uses:
 * without it, a caller who may not open the endpoint would get a query that
 * never runs and a page that renders nothing - a blank sheet, which on a report
 * is the one thing that must never happen silently.
 */
export function reportPrivilege(source: PanelSource): string {
  return source === 'security' ? PRIV.AUDIT_READ : PRIV.STATS_READ
}

export const REPORT_KEY = ['admin-panel-report'] as const

/**
 * One panel, over one window, read in full.
 *
 * Skipped without the privilege that opens the underlying page: the endpoint
 * gates on it, and polling a 403 would be the only thing the page did.
 */
export function usePanelReport(source: PanelSource, panelId: string, period: string) {
  const { can } = usePrivileges()
  const allowed = can(reportPrivilege(source))

  return useQuery({
    queryKey: [...REPORT_KEY, source, panelId, period],
    enabled:  allowed && !!panelId,
    queryFn:  async (): Promise<ReportData> => {
      const { data } = await api.get<PanelPayload>(ENDPOINT[source], {
        // `detail` is what turns a counter into a report. It is also what the
        // server audits, so it is asked for once, here, and never as a default
        // the dashboards would inherit.
        params: { period, panel: panelId, full: true, detail: true },
      })
      return {
        period:   data.period,
        periods:  data.periods ?? [],
        panel:    data.panels?.find(p => p.id === panelId) ?? null,
        withheld: (data.withheld ?? []).includes(panelId),
      }
    },
    staleTime: 60_000,
    // A report is a DOCUMENT, not a live view. Two reasons not to re-read it
    // behind the reader's back: the figures would change between the moment
    // they check them and the moment the sheet leaves the printer - with a
    // "generated at" stamp that no longer matches - and the server audits every
    // reading of the records, so an operator switching windows would fill the
    // trail with consultations they did not make. Changing the period is an
    // explicit act and still refetches.
    refetchOnWindowFocus: false,
  })
}

/**
 * What this instance calls itself - the first line of every printed report.
 *
 * Read from the PUBLIC configuration rather than from the administration
 * settings: the name is public by declaration (`instance.name`, `is_public`),
 * every account may read it, and a report header must not be the one part of the
 * page a delegated administrator is refused. Same query key as the sign-in page,
 * so the two share one cached read.
 */
export function useInstanceName(): string | null {
  const { data } = useQuery({
    queryKey:  ['public-config'],
    queryFn:   getPublicConfig,
    staleTime: 60_000,
  })
  const name = data?.['instance.name']
  return typeof name === 'string' && name.trim() !== '' ? name : null
}

/** One implementation, shared: reading the failure of a request is the same
 *  problem everywhere. Re-exported under the name this section's callers
 *  already use. */
export { apiErrorMessage as errorMessage } from '../../core/api/errorMessage'
