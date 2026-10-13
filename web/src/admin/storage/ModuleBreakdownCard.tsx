/**
 * Code-behind of `ModuleBreakdownCard.kbcontrol` (converted from `ModuleBreakdownCard.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { Fragment } from 'react'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { formatAgo, formatBytes } from "../sections/format"
import { MAX_SERIES, NEUTRAL_SERIES, useSeriesScale, type Segment } from "./charts"
import { useCategoryReading, useCategoryRules } from "./categories"
import type { ModuleBreakdown, ModuleUsage } from "./api"

import { ViewBase } from './ModuleBreakdownCard.kbcontrol'
import * as __parts from './ModuleBreakdownCard.parts'

export type ModuleBreakdownCardProps = { data: ModuleBreakdown }

export class ModuleBreakdownCard extends ViewBase {
  @bind accessor open: string | null = null
  tr!: ModuleBreakdownCardStores['t']
  series!: readonly string[]
  rules!: ModuleBreakdownCardHooks['rules']
  reading!: ModuleBreakdownCardHooks['reading']
  declaring!: (ModuleUsage & { used_bytes: number; })[]
  silent!: ModuleUsage[]
  colorOf!: (id: string) => string

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const series = useSeriesScale()
    return { t, series }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const series = this.series
    const rules   = useCategoryRules(this.props.data.catalog)
    this.publish({ rules })
    const reading = useCategoryReading(this.props.data.categories, rules, t)
    this.publish({ reading })
    const declaring = useMemo(
      () => this.props.data.modules.filter((m): m is ModuleUsage & { used_bytes: number } =>
        m.declared && m.used_bytes !== null),
      [this.props.data.modules],
    )
    this.publish({ declaring })
    const silent = useMemo(() => this.props.data.modules.filter(m => !m.declared), [this.props.data.modules])
    this.publish({ silent })
    const colorOf = useMemo(() => {
      const ids = [...new Set(declaring.map(m => m.module_id))].sort()
      const map = new Map<string, string>()
      ids.forEach((id, i) => { if (i < MAX_SERIES) map.set(id, series[i]) })
      return (id: string) => map.get(id) ?? NEUTRAL_SERIES
    }, [declaring, series])
    this.publish({ colorOf })
    return { rules, reading, declaring, silent, colorOf }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, series: s.series })
    const h = this.useHooks()
    this.publish({ rules: h.rules, reading: h.reading, declaring: h.declaring, silent: h.silent, colorOf: h.colorOf })
  }

  get withBytes(): (ModuleUsage & { used_bytes: number; })[] {
    return this.memo('withBytes', [this.declaring], () => this.declaring.filter(m => m.used_bytes > 0))
  }

  get shown(): (ModuleUsage & { used_bytes: number; })[] {
    return this.memo('shown', [this.withBytes], () => this.withBytes.slice(0, MAX_SERIES))
  }

  get folded(): (ModuleUsage & { used_bytes: number; })[] {
    return this.memo('folded', [this.withBytes], () => this.withBytes.slice(MAX_SERIES))
  }

  get foldedBytes(): number {
    return this.folded.reduce((sum, m) => sum + m.used_bytes, 0)
  }

  get total(): number {
    return this.props.data.declared_bytes + this.props.data.unattributed_bytes
  }

  get segments(): Segment[] {
    return this.memo('segments', [this.shown, this.colorOf, this.folded, this.tr, this.foldedBytes, this.props], () => [
    ...this.shown.map(m => ({
      id:    m.module_id,
      label: m.display_name,
      value: m.used_bytes,
      color: this.colorOf(m.module_id),
    })),
    ...(this.folded.length > 0 ? [{
      id:    '__other',
      label: this.tr('admin.sto_mod_other', { count: this.folded.length }),
      value: this.foldedBytes,
      color: NEUTRAL_SERIES,
    }] : []),
    // Always present, even at zero: "everything is accounted for" is a result
    // worth stating, and a legend entry that appears and disappears is one the
    // reader stops trusting.
    {
      id:    '__unattributed',
      label: this.tr('admin.sto_mod_unattributed'),
      value: this.props.data.unattributed_bytes,
      color: 'var(--color-surface-2)',
      track: true,
    },
  ])
  }

  get nothingDeclared(): boolean {
    return this.declaring.length === 0
  }

  get show_not_nothing_declared() {
    return !(this.nothingDeclared)
  }

  get bar_total() {
    if (!(!(this.nothingDeclared))) return undefined as never
    return Math.max(this.total, 1)
  }

  get show_declaring() {
    return this.declaring.length > 0
  }

  /** A part of the screen still written in React (<button aria-expanded>: attribute(s) without a .kbview property). */
  get Part1() {
    if (!(this.declaring.length > 0)) return undefined as never
    return __parts.Part1
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  /** The rows of the Repeater over `declaring`. */
  get rows_declaring() {
    return this.memo('rows_declaring', [this.declaring, this.rules, this.open, this.tr, this.colorOf, this.memo], () => {
      if (!(this.declaring.length > 0)) return undefined as never
      return this.declaring.map((m) => {
      const cats = m.categories ?? []
      const expandable = cats.some(c => this.rules.held(c) && c.used_bytes > 0)
      const isOpen = this.open === m.module_id
      const meta = [
              m.accounts != null ? this.tr('admin.sto_mod_accounts', { count: m.accounts }) : null,
              m.held_bytes != null && m.held_bytes !== m.used_bytes
                ? this.tr('admin.sto_mod_held', { bytes: formatBytes(m.held_bytes) })
                : null,
              m.last_declared_at ? this.tr('admin.sto_mod_declared', { ago: formatAgo(m.last_declared_at) }) : null,
            ].filter(Boolean).join(' · ')
      const identity = (
              <>
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: this.colorOf(m.module_id) }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-text-primary"
                      style={{ fontSize: 'var(--kb-text-body)' }}>
                  {m.display_name}
                </span>
              </>
            )
      return { m, cats, expandable, isOpen, meta, identity, show_not_expandable: ((this.declaring.length > 0)) ? (!(expandable)) : undefined, part1_props: ((this.declaring.length > 0) && (expandable)) ? ({ isOpen: isOpen, setOpen: this.memo("setOpen:bound", [], () => this.setOpen.bind(this)), m: m, identity: identity }) : undefined, content_identity: ((this.declaring.length > 0) && (!(expandable))) ? ({ children: identity }) : undefined, span_text: ((this.declaring.length > 0)) ? (formatBytes(m.used_bytes)) : undefined, rules: this.rules, deleg_bytes: m.delegated_bytes ?? 0, deleg_objects: m.delegated_objects ?? 0,key: m.module_id }
    })
    })
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.props], () => ({ t: this.tr, data: this.props.data }))
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part2() {
    return __parts.Part2
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part3() {
    return __parts.Part3
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part4() {
    return __parts.Part4
  }

  get show_silent() {
    return this.silent.length > 0
  }

  /** The rows of the Repeater over `silent`. */
  get rows_silent() {
    return this.memo('rows_silent', [this.silent], () => {
      if (!(this.silent.length > 0)) return undefined as never
      return this.silent.map((m) => {
      return { m, key: m.module_id }
    })
    })
  }

  get show_data_over_declared() {
    return this.props.data.over_declared_bytes > 0
  }

  get sto_mod_over_bytes() {
    if (!(this.props.data.over_declared_bytes > 0)) return undefined as never
    return formatBytes(this.props.data.over_declared_bytes)
  }

  /** `setOpen` of the TSX: a value, or an update of the previous one. */
  setOpen(value: string | null | ((prev: string | null) => string | null)) {
    this.open = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.open) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ModuleBreakdownCardStores = ReturnType<ModuleBreakdownCard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ModuleBreakdownCardHooks = ReturnType<ModuleBreakdownCard['useHooks']>

export default ModuleBreakdownCard.component()
