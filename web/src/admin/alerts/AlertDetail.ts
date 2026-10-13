/**
 * Code-behind of `AlertDetail.kbcontrol` (converted from `AlertDetail.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useToast, type ComboboxOption } from "@ui"
import { formatAgo } from "../sections/format"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { useAlert, useAlertFacets, useAlertVerb, useAssignAlert, useCommentAlert, useSetAlertStatus } from "./useAlerts"
import { alertSummary, alertTitle, severityLabel, skinOf, statusLabel } from "./labels"
import { isOpen, type AlertStatus } from "./types"
import { useAdminCrumbs } from "../pages/AdminBreadcrumb"

import { ViewBase } from './AlertDetail.kbcontrol'
import * as __parts from './AlertDetail.parts'

export type AlertDetailProps = { id: string; onBack: () => void }

export class AlertDetail extends ViewBase {
  @bind accessor draft = ''
  tr!: AlertDetailStores['t']
  i18n!: AlertDetailStores['i18n']
  can!: AlertDetailStores['can']
  toast!: AlertDetailStores['toast']
  data!: AlertDetailHooks['data']
  isLoading!: boolean
  isError!: boolean
  facets!: AlertDetailHooks['facets']
  setStatus!: AlertDetailStores['setStatus']
  assign!: AlertDetailStores['assign']
  comment!: AlertDetailStores['comment']
  verb!: AlertDetailStores['verb']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { can } = usePrivileges()
    const toast = useToast()
    const setStatus = useSetAlertStatus()
    const assign = useAssignAlert()
    const comment = useCommentAlert()
    const verb = useAlertVerb()
    return { t, i18n, can, toast, setStatus, assign, comment, verb }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data, isLoading, isError } = useAlert(this.props.id)
    this.publish({ data, isLoading, isError })
    const { data: facets } = useAlertFacets()
    this.publish({ facets })
    useAdminCrumbs(useMemo(
      () => (data ? [{ label: data.alert.title, title: data.alert.title }] : []),
      [data],
    ))
    return { data, isLoading, isError, facets }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, can: s.can, toast: s.toast, setStatus: s.setStatus, assign: s.assign, comment: s.comment, verb: s.verb })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, facets: h.facets })
  }

  get canManage(): boolean {
    return this.can(PRIV.ALERTS_MANAGE)
  }

  get alert() {
    return this.memo('alert', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return (this.data).alert
    })
  }

  get timeline() {
    return this.memo('timeline', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return (this.data).timeline
    })
  }

  get related() {
    return this.memo('related', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return (this.data).related
    })
  }

  get skin(): { dot: string; chip: string; } {
    return this.memo('skin', [this.alert, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return skinOf(this.alert)
    })
  }

  get assigneeOptions(): ComboboxOption[] {
    return this.memo('assigneeOptions', [this.facets, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return (this.facets?.assignees ?? []).map(a => ({ value: a.id, label: a.label }))
    })
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.isError || !this.data)
  }

  get show_main() {
    return !(this.isLoading) && !(this.isError || !this.data)
  }

  get span_class() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return `h-2 w-2 shrink-0 rounded-full ${this.skin.dot}`
  }

  get h1_text() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return alertTitle(this.tr, this.alert)
  }

  get span_class2() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return `rounded-full px-1.5 py-0.5 ${this.skin.chip}`
  }

  get span_text() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return severityLabel(this.tr, this.alert.severity)
  }

  get span_text2() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return statusLabel(this.tr, this.alert.status)
  }

  get p_text() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return alertSummary(this.tr, this.alert)
  }

  /** `<ActionButtons>`, rendered by a ReactHost. */
  get ActionButtons() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.ActionButtons
  }

  get action_buttons_props() {
    return this.memo('action_buttons_props', [this.alert, this.memo, this.isLoading, this.isError, this.data, this.verb, this.toast, this.tr], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ alert: this.alert, onExecute: this.memo("runVerb:bound", [], () => this.runVerb.bind(this)), busy: this.verb.isPending })
    })
  }

  get show_alert_status_acknowledged() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return this.alert.status !== 'acknowledged'
  }

  get show_alert_status_resolved() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return this.alert.status !== 'resolved'
  }

  get show_alert_status_ignored() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return this.alert.status !== 'ignored'
  }

  get show_is_open_alert_status() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return !isOpen(this.alert.status)
  }

  get part1_props() {
    return this.memo('part1_props', [this.alert, this.assign, this.toast, this.tr, this.assigneeOptions, this.isLoading, this.isError, this.data, this.canManage], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
      return ({ alert: this.alert, assign: this.assign, toast: this.toast, t: this.tr, assigneeOptions: this.assigneeOptions })
    })
  }

  /** A part of the screen still written in React (<ComboBox> searchPlaceholder, emptyLabel, clearable, onClear: no .kbview property). */
  get Part1() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return __parts.Part1
  }

  /** `<Timeline>`, rendered by a ReactHost. */
  get Timeline() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Timeline
  }

  get timeline_props() {
    return this.memo('timeline_props', [this.timeline, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ events: this.timeline })
    })
  }

  get part2_props() {
    return this.memo('part2_props', [this.draft, this.memo, this.tr, this.isLoading, this.isError, this.data, this.canManage], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
      return ({ draft: this.draft, setDraft: this.memo("setDraft:bound", [], () => this.setDraft.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<TextArea> rows: no .kbview property). */
  get Part2() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return __parts.Part2
  }

  get enabled_unless_draft_trim_comment() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage)) return undefined as never
    return !(!this.draft.trim() || this.comment.isPending)
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.alert, this.i18n, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ t: this.tr, alert: this.alert, i18n: this.i18n, alert_module_id: this.alert?.module_id, alert_subject_label: this.alert?.subject_label, alert_assignee_label: this.alert?.assignee_label, alert_closed_at: this.alert?.closed_at })
    })
  }

  /** A part of the screen still written in React (<dl> has no .kbview element yet). */
  get Part3() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Part3
  }

  get show_related() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.related.length > 0
  }

  /** A part of the screen still written in React (<Link style>). */
  get Part4() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.related.length > 0)) return undefined as never
    return __parts.Part4
  }

  /** The rows of the Repeater over `related`. */
  get rows_related() {
    return this.memo('rows_related', [this.related, this.isLoading, this.isError, this.data, this.tr], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.related.length > 0)) return undefined as never
      return this.related.map((r) => {
      return { r, part4_props: ((!(this.isLoading)) && (!(this.isError || !this.data)) && (this.related.length > 0)) ? ({ r: r, t: this.tr }) : undefined, span_text: ((!(this.isLoading)) && (!(this.isError || !this.data)) && (this.related.length > 0)) ? (String(statusLabel(this.tr, r.status)) + " · " + String(formatAgo(r.last_seen_at))) : undefined, key: r.id }
    })
    })
  }

  move(status: AlertStatus) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.setStatus.mutate(
    { id: this.alert.id, status },
    {
      onSuccess: () => this.toast.success(this.tr('admin.al_toast_moved', { status: statusLabel(this.tr, status) })),
      onError:   () => this.toast.error(this.tr('admin.al_toast_failed')),
    },
  )
  }

  runVerb(v: 'retry-jobs' | 'discard-jobs') {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.verb.mutate(
    { id: this.alert.id, verb: v },
    {
      onSuccess: () => this.toast.success(this.tr(v === 'retry-jobs' ? 'admin.al_toast_retried' : 'admin.al_toast_discarded')),
      onError:   () => this.toast.error(this.tr('admin.al_toast_failed')),
    },
  )
  }

  send() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    const body = this.draft.trim()
    if (!body) return
    this.comment.mutate({ id: this.alert.id, comment: body }, {
      onSuccess: () => { this.draft = ''; this.toast.success(this.tr('admin.al_toast_commented')) },
      onError:   () => this.toast.error(this.tr('admin.al_toast_failed')),
    })
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(this.isError || !this.data)) return undefined as never
    this.props.onBack?.()
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage) || !(this.alert.status !== 'acknowledged')) return undefined as never
    this.move('acknowledged')
  }

  button_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage) || !(this.alert.status !== 'resolved')) return undefined as never
    this.move('resolved')
  }

  button_click4(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage) || !(this.alert.status !== 'ignored')) return undefined as never
    this.move('ignored')
  }

  button_click5(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.canManage) || !(!isOpen(this.alert.status))) return undefined as never
    this.move('new')
  }

  /** `setDraft` of the TSX: a value, or an update of the previous one. */
  setDraft(value: AlertDetail['draft'] | ((prev: AlertDetail['draft']) => AlertDetail['draft'])) {
    this.draft = typeof value === 'function' ? (value as (prev: AlertDetail['draft']) => AlertDetail['draft'])(this.draft) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AlertDetailStores = ReturnType<AlertDetail['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AlertDetailHooks = ReturnType<AlertDetail['useHooks']>

export default AlertDetail.component()
