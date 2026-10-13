/**
 * Code-behind of `SecurityDashboardSection.kbview` (converted from `SecurityDashboardSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import type { AdminSectionProps } from "../sections/registry"
import { errorMessage, useSecurityDashboard, type SecurityPanel } from "./api"
import { reportUrl } from "../panels/report"
import { panelDef } from "./panels"
import { applyLayout, usePanelLayout } from "./usePanelLayout"

import { ViewBase } from './SecurityDashboardSection.kbview'
import * as __parts from './SecurityDashboardSection.parts'

export type { AdminSectionProps }

export class SecurityDashboardSection extends ViewBase {
  @bind accessor period = 'last_30_days'
  @bind accessor editing = false
  tr!: SecurityDashboardSectionStores['t']
  can!: SecurityDashboardSectionStores['can']
  data!: SecurityDashboardSectionHooks['data']
  isLoading!: boolean
  isError!: boolean
  error!: Error | null
  layout!: SecurityDashboardSectionStores['layout']
  hide!: (id: string, visible: string[]) => void
  show!: (id: string, visible: string[]) => void
  move!: (id: string, delta: -1 | 1, visible: string[]) => void
  reset!: () => void
  received!: SecurityDashboardSectionHooks['received']
  visible!: string[]
  hiddenAvailable!: string[]
  periodOptions!: { value: string; label: string; }[]
  openReport!: (id: string) => void

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { can } = usePrivileges()
    const { layout, hide, show, move, reset } = usePanelLayout()
    return { t, can, layout, hide, show, move, reset }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const layout = this.layout
    const { data, isLoading, isError, error } = useSecurityDashboard(this.period)
    this.publish({ data, isLoading, isError, error })
    const received = useMemo(() => {
      const map = new Map<string, SecurityPanel>()
      for (const p of data?.panels ?? []) if (panelDef(p.id)) map.set(p.id, p)
      return map
    }, [data])
    this.publish({ received })
    const visible = useMemo(
      () => applyLayout([...received.keys()], layout),
      [received, layout],
    )
    this.publish({ visible })
    const hiddenAvailable = useMemo(
      () => [...received.keys()].filter(id => !visible.includes(id)),
      [received, visible],
    )
    this.publish({ hiddenAvailable })
    const periodOptions = useMemo(
      () => (data?.periods ?? [this.period]).map(id => ({
        value: id, label: t(`admin.sec_period_${id}`, { defaultValue: id }),
      })),
      [data?.periods, this.period, t],
    )
    this.publish({ periodOptions })
    const openReport = useCallback((id: string) => {
      if (!panelDef(id)) return
      this.props.navigate(reportUrl('security', id, this.period))
    }, [this.props.navigate, this.period])
    this.publish({ openReport })
    return { data, isLoading, isError, error, received, visible, hiddenAvailable, periodOptions, openReport }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, layout: s.layout, hide: s.hide, show: s.show, move: s.move, reset: s.reset })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, error: h.error, received: h.received, visible: h.visible, hiddenAvailable: h.hiddenAvailable, periodOptions: h.periodOptions, openReport: h.openReport })
  }

  get bucket() {
    if (!(!(!this.can(PRIV.AUDIT_READ)))) return undefined as never
    return this.data?.period.bucket ?? 'day'
  }

  get withheldCount(): number {
    if (!(!(!this.can(PRIV.AUDIT_READ)))) return undefined as never
    return this.data?.withheld.length ?? 0
  }

  get show_case_1() {
    return !!(!this.can(PRIV.AUDIT_READ))
  }

  get show_main() {
    return !(!this.can(PRIV.AUDIT_READ))
  }

  get part1_props() {
    return this.memo('part1_props', [this.period, this.memo, this.periodOptions, this.can], () => {
      if (!(!(!this.can(PRIV.AUDIT_READ)))) return undefined as never
      return ({ period: this.period, setPeriod: this.memo("setPeriod:bound", [], () => this.setPeriod.bind(this)), periodOptions: this.periodOptions })
    })
  }

  /** A part of the screen still written in React (<Dropdown> width, focusable: no .kbview property). */
  get Part1() {
    if (!(!(!this.can(PRIV.AUDIT_READ)))) return undefined as never
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.editing, this.memo, this.tr, this.can], () => {
      if (!(!(!this.can(PRIV.AUDIT_READ)))) return undefined as never
      return ({ editing: this.editing, setEditing: this.memo("setEditing:bound", [], () => this.setEditing.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button Icon>: an icon that is not a Lucide icon). */
  get Part2() {
    if (!(!(!this.can(PRIV.AUDIT_READ)))) return undefined as never
    return __parts.Part2
  }

  get callout_text() {
    if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.isError)) return undefined as never
    return errorMessage(this.error, this.tr('admin.sec_load_failed'))
  }

  get show_data() {
    return this.memo('show_data', [this.data, this.can], () => {
      if (!(!(!this.can(PRIV.AUDIT_READ)))) return undefined as never
      return !!(this.data)
    })
  }

  /** `<RetentionNotice>`, rendered by a ReactHost. */
  get RetentionNotice() {
    if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.data)) return undefined as never
    return __parts.RetentionNotice
  }

  get retention_notice_props() {
    return this.memo('retention_notice_props', [this.data, this.can], () => {
      if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.data)) return undefined as never
      return ({ periodId: this.data.period.id, retention: this.data.retention })
    })
  }

  get show_data_visible() {
    if (!(!(!this.can(PRIV.AUDIT_READ)))) return undefined as never
    return !!(this.data && this.visible.length > 0)
  }

  get part3_props() {
    return this.memo('part3_props', [this.visible, this.received, this.bucket, this.editing, this.hide, this.move, this.openReport, this.can, this.data], () => {
      if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.data && this.visible.length > 0)) return undefined as never
      return ({ visible: this.visible, received: this.received, bucket: this.bucket, editing: this.editing, hide: this.hide, move: this.move, openReport: this.openReport })
    })
  }

  /** A part of the screen still written in React (a list whose item is not a single element). */
  get Part3() {
    if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.data && this.visible.length > 0)) return undefined as never
    return __parts.Part3
  }

  get show_data_visible2() {
    if (!(!(!this.can(PRIV.AUDIT_READ)))) return undefined as never
    return !!(this.data && this.visible.length === 0)
  }

  get part4_props() {
    return this.memo('part4_props', [this.tr, this.reset, this.can, this.data, this.visible], () => {
      if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.data && this.visible.length === 0)) return undefined as never
      return ({ t: this.tr, reset: this.reset })
    })
  }

  /** A part of the screen still written in React (<EmptyState> action.variant: no .kbview property). */
  get Part4() {
    if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.data && this.visible.length === 0)) return undefined as never
    return __parts.Part4
  }

  get show_editing_data() {
    return this.memo('show_editing_data', [this.editing, this.data, this.can], () => {
      if (!(!(!this.can(PRIV.AUDIT_READ)))) return undefined as never
      return !!(this.editing && this.data)
    })
  }

  get show_hidden_available() {
    if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.editing && this.data)) return undefined as never
    return this.hiddenAvailable.length === 0
  }

  get show_not_hidden_available() {
    if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.editing && this.data)) return undefined as never
    return !(this.hiddenAvailable.length === 0)
  }

  get part5_props() {
    return this.memo('part5_props', [this.hiddenAvailable, this.show, this.visible, this.tr, this.can, this.editing, this.data], () => {
      if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.editing && this.data) || !(!(this.hiddenAvailable.length === 0))) return undefined as never
      return ({ hiddenAvailable: this.hiddenAvailable, show: this.show, visible: this.visible, t: this.tr })
    })
  }

  /** A part of the screen still written in React (a list whose item is not a single element). */
  get Part5() {
    if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.editing && this.data) || !(!(this.hiddenAvailable.length === 0))) return undefined as never
    return __parts.Part5
  }

  get show_withheld_count() {
    if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.data)) return undefined as never
    return this.withheldCount > 0
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(!this.can(PRIV.AUDIT_READ))) || !(this.editing && this.data)) return undefined as never
    this.reset()
  }

  /** `setPeriod` of the TSX: a value, or an update of the previous one. */
  setPeriod(value: SecurityDashboardSection['period'] | ((prev: SecurityDashboardSection['period']) => SecurityDashboardSection['period'])) {
    this.period = typeof value === 'function' ? (value as (prev: SecurityDashboardSection['period']) => SecurityDashboardSection['period'])(this.period) : value
  }

  /** `setEditing` of the TSX: a value, or an update of the previous one. */
  setEditing(value: SecurityDashboardSection['editing'] | ((prev: SecurityDashboardSection['editing']) => SecurityDashboardSection['editing'])) {
    this.editing = typeof value === 'function' ? (value as (prev: SecurityDashboardSection['editing']) => SecurityDashboardSection['editing'])(this.editing) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SecurityDashboardSectionStores = ReturnType<SecurityDashboardSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type SecurityDashboardSectionHooks = ReturnType<SecurityDashboardSection['useHooks']>

export default SecurityDashboardSection.component()
