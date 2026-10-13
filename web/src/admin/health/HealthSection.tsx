/**
 * Code-behind of `HealthSection.kbview` (converted from `HealthSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useToast, type AccordionItemDef } from "@ui"
import { formatWhen } from "../sections/format"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { blockLabel } from "./labels"
import { useHealthChecks, useRefreshHealthChecks } from "./useHealthChecks"
import { BLOCK_ORDER, isFailing, SEVERITY_RANK, type HealthCheck } from "./types"

import { ViewBase } from './HealthSection.kbview'
import * as __parts from './HealthSection.parts'
import { CheckRow } from './HealthSection.parts'

export class HealthSection extends ViewBase {
  @bind accessor open: string[] | null = null
  tr!: HealthSectionStores['t']
  i18n!: HealthSectionStores['i18n']
  can!: HealthSectionStores['can']
  toast!: HealthSectionStores['toast']
  data!: HealthSectionStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: HealthSectionStores['refetch']
  refresh!: HealthSectionStores['refresh']
  byBlock!: Map<string, HealthCheck[]>
  defaultOpen!: HealthSectionStores['defaultOpen']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { can } = usePrivileges()
    const toast = useToast()
    const { data, isLoading, isError, refetch } = useHealthChecks()
    const refresh = useRefreshHealthChecks()
    const byBlock = useMemo(() => {
      const map = new Map<string, HealthCheck[]>()
      for (const c of data?.checks ?? []) {
        const list = map.get(c.block) ?? []
        list.push(c)
        map.set(c.block, list)
      }
      for (const list of map.values()) {
        list.sort((a, b) => {
          // Still to settle first, then by severity, then by title — so the row
          // that needs attention is never below a row that does not.
          const fa = isFailing(a.status) ? 0 : 1
          const fb = isFailing(b.status) ? 0 : 1
          if (fa !== fb) return fa - fb
          return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
        })
      }
      return map
    }, [data])
    const defaultOpen = useMemo(
      () => BLOCK_ORDER.filter(b => (byBlock.get(b) ?? []).some(c => isFailing(c.status))),
      [byBlock],
    )
    return { t, i18n, can, toast, data, isLoading, isError, refetch, refresh, byBlock, defaultOpen }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, can: s.can, toast: s.toast, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, refresh: s.refresh, byBlock: s.byBlock, defaultOpen: s.defaultOpen })
  }

  get canManage(): boolean {
    return this.can(PRIV.SETTINGS_MANAGE)
  }

  get counts() {
    return this.memo('counts', [this.data, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
      return (this.data).counts
    })
  }

  get score() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
    return (this.data).score
  }

  get scoreable(): number {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
    return this.counts.ok + this.counts.todo + this.counts.blocked
  }

  get items(): AccordionItemDef[] {
    return this.memo('items', [this.byBlock, this.tr, this.canManage, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
      return BLOCK_ORDER
    .filter(b => (this.byBlock.get(b) ?? []).length > 0)
    .map(b => {
      const rows = this.byBlock.get(b) ?? []
      const pending = rows.filter(c => isFailing(c.status)).length
      return {
        id: b,
        title: blockLabel(this.tr, b),
        badge: pending > 0 ? pending : undefined,
        content: (
          <ul className="-mx-4 -mb-3 min-w-0">
            {rows.map(c => <CheckRow key={c.id} check={c} canManage={this.canManage} />)}
          </ul>
        ),
      }
    })
    })
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.isError || !this.data)
  }

  get show_case_3() {
    return !(this.isLoading) && !(this.isError || !this.data) && !!(this.data.checks.length === 0)
  }

  get show_main() {
    return !(this.isLoading) && !(this.isError || !this.data) && !(this.data.checks.length === 0)
  }

  get hc_generated_when() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
    return formatWhen(this.data.generated_at, this.i18n.language)
  }

  get show_score() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
    return this.score !== null
  }

  get variant() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0)) || !(this.score !== null)) return undefined as never
    return this.counts.critical > 0 ? 'danger' : this.counts.warning > 0 ? 'warning' : 'success'
  }

  get p_text() {
    return this.memo('p_text', [this.tr, this.counts, this.scoreable, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
      return this.tr('admin.hc_summary', {
            ok: this.counts.ok,
            total: this.scoreable,
            pending: this.counts.todo + this.counts.blocked,
          }) + ((v: unknown) => (v == null || typeof v === 'boolean' ? '' : String(v)))(this.counts.ignored > 0 && ` · ${this.tr('admin.hc_summary_ignored', { count: this.counts.ignored })}`)
    })
  }

  get show_counts_critical() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
    return this.counts.critical > 0
  }

  get part1_props() {
    return this.memo('part1_props', [this.items, this.open, this.defaultOpen, this.memo, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
      return ({ items: this.items, open: this.open, defaultOpen: this.defaultOpen, setOpen: this.memo("setOpen:bound", [], () => this.setOpen.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Accordion> items, open, onOpenChange: no .kbview property). */
  get Part1() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
    return __parts.Part1
  }

  onRefreshAll() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(!(this.data.checks.length === 0))) return undefined as never
    return this.refresh.mutate(undefined, {
    onSuccess: () => this.toast.success(this.tr('admin.hc_toast_rechecked')),
    onError: () => this.toast.error(this.tr('admin.hc_toast_failed')),
  })
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(this.isError || !this.data)) return undefined as never
    void this.refetch()
  }

  /** `setOpen` of the TSX: a value, or an update of the previous one. */
  setOpen(value: string[] | null | ((prev: string[] | null) => string[] | null)) {
    this.open = typeof value === 'function' ? (value as (prev: string[] | null) => string[] | null)(this.open) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type HealthSectionStores = ReturnType<HealthSection['useStores']>

export default HealthSection.component()
