/**
 * Code-behind of `RequestStatus.kbcontrol` (converted from `RequestStatus.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { formatBytes, formatDay } from "../../../../admin/sections/format"
import { downloadUrl, type MyExportOverview, type MyExportRun } from "./api"
import { signedUrl } from "../../../api/signedUrl"

import { ViewBase } from './RequestStatus.kbcontrol'
import * as __parts from './RequestStatus.parts'

export interface RequestStatusProps {
  data:     MyExportOverview
  locale:   string
  /** Start a new request: shown once nothing is under way. */
  onRestart: () => void
}

export class RequestStatus extends ViewBase {
  tr!: RequestStatusStores['t']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
  }

  get active(): MyExportRun | null {
    return this.memo('active', [this.props], () => this.props.data.active)
  }

  get latest(): MyExportRun | undefined {
    return this.memo('latest', [this.props], () => this.props.data.history.find(r => r.status === 'ready' && r.downloadable))
  }

  get past(): MyExportRun[] {
    return this.memo('past', [this.props, this.active, this.latest], () => {
      const active = this.active
      const latest = this.latest
      return this.props.data.history.filter(r => r.id !== active?.id && r.id !== latest?.id)
    })
  }

  get show_active() {
    return this.memo('show_active', [this.active], () => !!(this.active))
  }

  get value() {
    if (!(this.active)) return undefined as never
    return this.props.data.progress?.percent ?? 0
  }

  get indeterminate() {
    if (!(this.active)) return undefined as never
    return !this.props.data.progress || this.props.data.progress.subjects_total === 0
  }

  get show_latest() {
    return this.memo('show_latest', [this.latest], () => !!(this.latest))
  }

  /** `<StatusBadge>`, rendered by a ReactHost. */
  get StatusBadge() {
    if (!(this.latest)) return undefined as never
    return __parts.StatusBadge
  }

  get status_badge_props() {
    return this.memo('status_badge_props', [this.latest], () => {
      if (!(this.latest)) return undefined as never
      return ({ run: this.latest })
    })
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.latest, this.props], () => {
      if (!(this.latest)) return undefined as never
      return ({ t: this.tr, latest: this.latest, locale: this.props.locale })
    })
  }

  /** A part of the screen still written in React (<dl> has no .kbview element yet). */
  get Part1() {
    if (!(this.latest)) return undefined as never
    return __parts.Part1
  }

  get show_active2() {
    if (!(this.latest)) return undefined as never
    return !this.active
  }

  get show_active_latest() {
    return !this.active && !this.latest
  }

  get show_past() {
    return this.past.length > 0
  }

  /** `<StatusBadge>`, rendered by a ReactHost. */
  get StatusBadge2() {
    if (!(this.past.length > 0)) return undefined as never
    return __parts.StatusBadge
  }

  /** The rows of the Repeater over `past`. */
  get rows_past() {
    return this.memo('rows_past', [this.past, this.props], () => {
      if (!(this.past.length > 0)) return undefined as never
      return this.past.map((run) => {
      return { run, span_text: ((this.past.length > 0)) ? (formatDay(run.requested_at, this.props.locale)) : undefined, status_badge_props: ((this.past.length > 0)) ? ({ run: run }) : undefined, span_text2: ((this.past.length > 0)) ? (run.size_bytes ? formatBytes(run.size_bytes) : '—') : undefined, key: run.id }
    })
    })
  }

  get show_data_history_status() {
    return this.props.data.history[0]?.status === 'failed'
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.props], () => {
      if (!(this.props.data.history[0]?.status === 'failed')) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Callout> icon: a value the property converts (null-when-false)). */
  get Part2() {
    if (!(this.props.data.history[0]?.status === 'failed')) return undefined as never
    return __parts.Part2
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.latest)) return undefined as never
 void signedUrl(downloadUrl(this.latest.id), { purpose: 'download' }).then(u => { window.location.href = u }) }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.latest) || !(!this.active)) return undefined as never
    this.props.onRestart?.()
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!this.active && !this.latest)) return undefined as never
    this.props.onRestart?.()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type RequestStatusStores = ReturnType<RequestStatus['useStores']>

export default RequestStatus.component()
