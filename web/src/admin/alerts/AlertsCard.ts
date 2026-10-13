/**
 * Code-behind of `AlertsCard.kbcontrol` (converted from `AlertsCard.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from "react-i18next"
import { formatAgo, formatWhen } from "../sections/format"
import { alertTitle, severityLabel, skinOf } from "./labels"
import { useAlerts, useAlertSummary } from "./useAlerts"
import { EMPTY_FILTERS } from "./types"
import { adminUrl } from "../adminAction"

import { ViewBase } from './AlertsCard.kbcontrol'
import * as __parts from './AlertsCard.parts'

export class AlertsCard extends ViewBase {
  tr!: AlertsCardStores['t']
  i18n!: AlertsCardStores['i18n']
  summary!: AlertsCardStores['summary']
  data!: AlertsCardStores['data']
  isLoading!: boolean
  navigate!: ReturnType<typeof useNavigate>

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { data: summary } = useAlertSummary()
    const { data, isLoading } = useAlerts({ ...EMPTY_FILTERS, severity: '' })
    return { t, i18n, summary, data, isLoading }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, summary: s.summary, data: s.data, isLoading: s.isLoading })
    this.navigate = useNavigate()
  }

  get top() {
    return this.memo('top', [this.data], () => (this.data?.pages?.[0]?.alerts ?? []).slice(0, 3))
  }

  get show_summary_summary_open() {
    return !!(this.summary && this.summary.open > 0)
  }

  get span_text() {
    if (!(this.summary && this.summary.open > 0)) return undefined as never
    return this.summary.open
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<Link style>). */
  get Part1() {
    return __parts.Part1
  }

  get show_not_is_loading() {
    return !(this.isLoading)
  }

  get show_top() {
    if (!(!(this.isLoading))) return undefined as never
    return this.top.length === 0
  }

  get show_not_top() {
    if (!(!(this.isLoading))) return undefined as never
    return !(this.top.length === 0)
  }

  get p_text() {
    if (!(!(this.isLoading)) || !(this.top.length === 0)) return undefined as never
    return this.summary?.last_scan_at
              ? this.tr('admin.al_empty_checked', { when: formatWhen(this.summary.last_scan_at, this.i18n.language) })
              : this.tr('admin.al_empty_never_checked')
  }

  /** The rows of the Repeater over `top`. */
  get rows_top() {
    return this.memo('rows_top', [this.top, this.isLoading, this.tr], () => {
      if (!(!(this.isLoading)) || !(!(this.top.length === 0))) return undefined as never
      return this.top.map((a) => {
      const skin = skinOf(a)
      return { a, skin, href: ((!(this.isLoading)) && (!(this.top.length === 0))) ? (adminUrl({ tab: 'alerts', params: { alert: a.id } })) : undefined, span_class: ((!(this.isLoading)) && (!(this.top.length === 0))) ? (`mt-1.5 h-2 w-2 shrink-0 rounded-full ${skin.dot}`) : undefined, span_text: ((!(this.isLoading)) && (!(this.top.length === 0))) ? (alertTitle(this.tr, a)) : undefined, span_text2: ((!(this.isLoading)) && (!(this.top.length === 0))) ? (String(severityLabel(this.tr, a.severity)) + " · " + String(formatAgo(a.last_seen_at)) + ((v: unknown) => (v == null || typeof v === 'boolean' ? '' : String(v)))(a.occurrences > 1 && ` · ×${a.occurrences}`)) : undefined, key: a.id }
    })
    })
  }

  get show_summary_summary_open2() {
    if (!(!(this.isLoading)) || !(!(this.top.length === 0))) return undefined as never
    return !!(this.summary && this.summary.open > this.top.length)
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.summary, this.top, this.isLoading], () => {
      if (!(!(this.isLoading)) || !(!(this.top.length === 0)) || !(this.summary && this.summary.open > this.top.length)) return undefined as never
      return ({ t: this.tr, summary: this.summary, top: this.top })
    })
  }

  /** A part of the screen still written in React (<Link style>). */
  get Part2() {
    if (!(!(this.isLoading)) || !(!(this.top.length === 0)) || !(this.summary && this.summary.open > this.top.length)) return undefined as never
    return __parts.Part2
  }

  get visible() {
    return this.memo('visible', [this.show_top, this.show_not_is_loading], () => this.show_top && this.show_not_is_loading)
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_top, this.show_not_is_loading], () => this.show_not_top && this.show_not_is_loading)
  }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { a } = args.row as RowOf_rows_top
    this.navigate(adminUrl({ tab: 'alerts', params: { alert: a.id } }))
  }

}

type RowOf_rows_top = AlertsCard['rows_top'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type AlertsCardStores = ReturnType<AlertsCard['useStores']>

export default AlertsCard.component()
