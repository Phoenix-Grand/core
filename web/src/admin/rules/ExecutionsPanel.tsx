/**
 * Code-behind of `ExecutionsPanel.kbcontrol` (converted from `ExecutionsPanel.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { Fragment } from 'react'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, FlaskConical, RefreshCw, ScrollText } from "lucide-react"
import { Badge, Button, Combobox, EmptyState, Spinner, useIsMobile } from "@ui"
import { useExecutions, useRules } from "./api"
import { isSimulated, modeLabel, modeVariant, outcomeLabel, outcomeVariant, severityLabel, severityVariant } from "./labels"
import { formatWhen } from "../sections/format"
import type { Outcome } from "./types"

import { ViewBase } from './ExecutionsPanel.kbcontrol'
import * as __parts from './ExecutionsPanel.parts'
import { Detail } from './ExecutionsPanel.parts'

const OUTCOMES: Outcome[] = [
  'acted', 'matched', 'no_match', 'out_of_scope', 'out_of_rollout',
  'below_threshold', 'depth_exceeded', 'error',
]

interface Props {
  /** Pre-filter on one rule (the rule sheet's own log). */
  ruleId?: string | null
  /** Hide the page header — the section already painted one. */
  embedded?: boolean
}

export type { Props }

export class ExecutionsPanel extends ViewBase {
  @bind accessor mode = ''
  @bind accessor outcome = ''
  tr!: ExecutionsPanelStores['t']
  i18n!: ExecutionsPanelStores['i18n']
  isMobile!: boolean
  rule!: ExecutionsPanelHooks['rule']
  setRule!: ExecutionsPanelHooks['setRule']
  expanded!: Set<number>
  setExpanded!: ExecutionsPanelStores['setExpanded']
  rules!: ExecutionsPanelStores['rules']
  data!: ExecutionsPanelHooks['data']
  isLoading!: boolean
  isFetching!: boolean
  refetch!: ExecutionsPanelHooks['refetch']
  severityOf!: Map<string, string>

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const isMobile = useIsMobile()
    const [expanded, setExpanded] = useState<Set<number>>(new Set())
    const rules = useRules()
    const severityOf = useMemo(() => {
      const m = new Map<string, string>()
      for (const r of rules.data?.rules ?? []) m.set(r.id, r.severity)
      return m
    }, [rules.data])
    return { t, i18n, isMobile, expanded, setExpanded, rules, severityOf }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [rule, setRule] = useState<string>(this.props.ruleId ?? '')
    this.publish({ rule, setRule })
    const { data, isLoading, isFetching, refetch } = useExecutions({
      rule_id: rule || undefined,
      mode: this.mode || undefined,
      outcome: this.outcome || undefined,
      limit: 200,
    })
    this.publish({ data, isLoading, isFetching, refetch })
    return { rule, setRule, data, isLoading, isFetching, refetch }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, isMobile: s.isMobile, expanded: s.expanded, setExpanded: s.setExpanded, rules: s.rules, severityOf: s.severityOf })
    const h = this.useHooks()
    this.publish({ rule: h.rule, setRule: h.setRule, data: h.data, isLoading: h.isLoading, isFetching: h.isFetching, refetch: h.refetch })
  }

  get rows() {
    return this.memo('rows', [this.data], () => this.data ?? [])
  }

  get filters() {
    return this.memo('filters', [this.props, this.rule, this.setRule, this.tr, this.rules, this.mode, this.memo, this.outcome, this.isFetching, this.refetch], () => (
    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
      {!this.props.ruleId && (
        <Combobox
          value={this.rule || ''}
          onChange={this.setRule}
          options={[
            { value: '', label: this.tr('admin.rl_log_all_rules') },
            ...(this.rules.data?.rules ?? []).map(r => ({ value: r.id, label: r.name })),
          ]}
          width={220}
          aria-label={this.tr('admin.rl_log_all_rules')}
        />
      )}
      <Combobox
        value={this.mode}
        onChange={this.memo("setMode:bound", [], () => this.setMode.bind(this))}
        options={[
          { value: '', label: this.tr('admin.rl_log_all_modes') },
          ...(['simulate', 'monitor', 'enforce', 'backtest'] as const)
            .map(m => ({ value: m, label: modeLabel(this.tr, m) })),
        ]}
        width={190}
        aria-label={this.tr('admin.rl_log_all_modes')}
      />
      <Combobox
        value={this.outcome}
        onChange={this.memo("setOutcome:bound", [], () => this.setOutcome.bind(this))}
        options={[
          { value: '', label: this.tr('admin.rl_log_all_outcomes') },
          ...OUTCOMES.map(o => ({ value: o, label: outcomeLabel(this.tr, o) })),
        ]}
        width={200}
        aria-label={this.tr('admin.rl_log_all_outcomes')}
      />
      <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} loading={this.isFetching}
        onClick={() => void this.refetch()}>
        {this.tr('admin.rl_log_refresh')}
      </Button>
    </div>
  ))
  }

  get show_embedded() {
    return !this.props.embedded
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_filters() {
    return this.memo('content_filters', [this.filters], () => ({ children: this.filters }))
  }

  get content_body() {
    return this.memo('content_body', [this.isLoading, this.rows, this.mode, this.outcome, this.rule, this.tr, this.isMobile, this.setExpanded, this.expanded, this.i18n, this.severityOf], () => ({ children: this.body() }))
  }

  toggle(id: number) {
    return this.setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  }

  body() {
    if (this.isLoading) return <div className="py-10 text-center"><Spinner /></div>
    if (this.rows.length === 0) {
      return (
        <EmptyState
          icon={<ScrollText size={26} />}
          variant={this.mode || this.outcome || this.rule ? 'no-results' : 'first-use'}
          title={this.tr('admin.rl_log_empty_title')}
          description={this.tr('admin.rl_log_empty_desc')}
        />
      )
    }

    if (this.isMobile) {
      // A phone gets cards: the row's identity is the rule and the outcome, the
      // rest lives behind the same expansion.
      return (
        <div className="flex flex-col gap-2">
          {this.rows.map(r => (
            <div key={r.id} className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-0">
              <button type="button" onClick={() => this.toggle(r.id)}
                className="flex w-full min-w-0 flex-col gap-1 px-3 py-2 text-start hover:bg-surface-1">
                <span className="flex min-w-0 items-center gap-2">
                  {this.expanded.has(r.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="min-w-0 truncate text-text-primary">{r.rule_name ?? '—'}</span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={modeVariant(r.mode)} size="sm">
                    {isSimulated(r.mode) && <FlaskConical size={10} />}{modeLabel(this.tr, r.mode)}
                  </Badge>
                  <Badge variant={outcomeVariant(r.outcome)} size="sm">{outcomeLabel(this.tr, r.outcome)}</Badge>
                  <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>
                    {formatWhen(r.occurred_at, this.i18n.language)}
                  </span>
                </span>
              </button>
              {this.expanded.has(r.id) && <Detail row={r} ruleSeverity={this.severityOf.get(r.rule_id)} />}
            </div>
          ))}
        </div>
      )
    }

    return (
      <div className="min-w-0 overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[56rem] border-collapse">
          <thead>
            <tr className="border-b border-border bg-surface-1 text-start text-text-secondary">
              <th className="w-8" />
              <th className="px-3 py-2 text-start font-medium">{this.tr('admin.rl_log_col_when')}</th>
              <th className="px-3 py-2 text-start font-medium">{this.tr('admin.rl_log_col_rule')}</th>
              <th className="px-3 py-2 text-start font-medium">{this.tr('admin.rl_log_col_mode')}</th>
              <th className="px-3 py-2 text-start font-medium">{this.tr('admin.rl_log_col_outcome')}</th>
              <th className="px-3 py-2 text-start font-medium">{this.tr('admin.rl_log_col_actor')}</th>
              <th className="px-3 py-2 text-start font-medium">{this.tr('admin.rl_log_col_resource')}</th>
              <th className="px-3 py-2 text-start font-medium">{this.tr('admin.rl_log_col_severity')}</th>
            </tr>
          </thead>
          <tbody>
            {this.rows.map(r => {
              const open = this.expanded.has(r.id)
              const sim = isSimulated(r.mode)
              const severity = this.severityOf.get(r.rule_id)
              return [
                <tr key={r.id}
                  className={`cursor-pointer border-b border-border hover:bg-surface-1 ${sim ? 'bg-surface-1' : ''}`}
                  onClick={() => this.toggle(r.id)}>
                  <td className="ps-2 text-text-tertiary">
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-text-secondary">
                    {formatWhen(r.occurred_at, this.i18n.language)}
                  </td>
                  <td className="max-w-[16rem] truncate px-3 py-2 text-text-primary">{r.rule_name ?? '—'}</td>
                  <td className="px-3 py-2">
                    <Badge variant={modeVariant(r.mode)} size="sm">
                      {sim && <FlaskConical size={10} />}{modeLabel(this.tr, r.mode)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={outcomeVariant(r.outcome)} size="sm">{outcomeLabel(this.tr, r.outcome)}</Badge>
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-2 font-mono text-text-secondary"
                    style={{ fontSize: 'var(--kb-text-meta)' }}>
                    {r.actor_user_id ?? '—'}
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-text-secondary"
                    style={{ fontSize: 'var(--kb-text-meta)' }}>
                    {r.resource_type ? `${r.resource_type}: ${r.resource_id ?? '—'}` : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {severity
                      ? <Badge variant={severityVariant(severity)} size="sm">{severityLabel(this.tr, severity)}</Badge>
                      : <span className="text-text-tertiary">—</span>}
                  </td>
                </tr>,
                open && (
                  <tr key={`${r.id}-detail`} className="border-b border-border">
                    <td colSpan={8} className="p-0">
                      <Detail row={r} ruleSeverity={severity} />
                    </td>
                  </tr>
                ),
              ]
            })}
          </tbody>
        </table>
      </div>
    )
  }

  /** `setMode` of the TSX: a value, or an update of the previous one. */
  setMode(value: ExecutionsPanel['mode'] | ((prev: ExecutionsPanel['mode']) => ExecutionsPanel['mode'])) {
    this.mode = typeof value === 'function' ? (value as (prev: ExecutionsPanel['mode']) => ExecutionsPanel['mode'])(this.mode) : value
  }

  /** `setOutcome` of the TSX: a value, or an update of the previous one. */
  setOutcome(value: ExecutionsPanel['outcome'] | ((prev: ExecutionsPanel['outcome']) => ExecutionsPanel['outcome'])) {
    this.outcome = typeof value === 'function' ? (value as (prev: ExecutionsPanel['outcome']) => ExecutionsPanel['outcome'])(this.outcome) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ExecutionsPanelStores = ReturnType<ExecutionsPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ExecutionsPanelHooks = ReturnType<ExecutionsPanel['useHooks']>

export default ExecutionsPanel.component()
