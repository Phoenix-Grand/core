import { adminUrl } from '../adminAction'

/**
 * The address of a REPORT — the printable document behind a dashboard panel.
 *
 * ## Why this is one module and not one per dashboard
 *
 * "Afficher le rapport" exists on both panelled pages, and the two must produce
 * the same kind of thing: one panel, one period, one document. Spelt separately
 * they would drift on the first detail (does the period ride along? which
 * parameter carries it?), and an operator would meet two links with the same
 * label that behave differently. It is written once, here, and both dashboards
 * call it.
 *
 * ## The shape
 *
 *     /admin/reports/<panel_id>?source=<dashboard|security>&period=<window>
 *
 * The panel is the PLACE — the document is about that panel and nothing else —
 * so it goes in the path, declared as the `reports` section's entity in
 * `adminNav.ts`. The period and the source identify no place: one is a window
 * the reader may change without leaving the document, the other says which
 * catalogue the id was taken from. Both stay in the query string, which is the
 * rule `adminRoute.ts` states.
 *
 * ## Why `source` is not optional in practice
 *
 * Panel ids are unique WITHIN a dashboard, not across the two: `signins` exists
 * on both, counted from the same table but titled and framed differently. A
 * report that guessed would print the general dashboard's wording over the
 * security overview's figures roughly half the time. The reader tolerates its
 * absence (an address typed by hand, an old bookmark) by looking the id up in
 * the general catalogue first, then in the security one — a fallback, never the
 * normal path.
 */

/** Which panelled page a report's panel was taken from. */
export type PanelSource = 'dashboard' | 'security'

/** The nav leaf that renders reports. Its URL shape is declared in `adminNav.ts`. */
export const REPORTS_TAB = 'reports'

/**
 * The report of one panel, over the window the operator is currently reading.
 *
 * The period travels with the link on purpose: a panel showing seven days whose
 * report opened on thirty would be a different document from the one the
 * operator asked for, and they would have no way of telling.
 */
export function reportUrl(source: PanelSource, panelId: string, period?: string): string {
  return adminUrl({ tab: REPORTS_TAB, params: { panel: panelId, source, period } })
}

/** The catalogue of reports, with no panel open. */
export function reportsIndexUrl(): string {
  return adminUrl({ tab: REPORTS_TAB })
}
