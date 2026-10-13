/**
 * Code-behind of `RuleEditor.kbcontrol` (converted from `RuleEditor.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { Fragment } from 'react'
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { FlaskConical, Save, Sparkles } from "lucide-react"
import { Badge, Button, Callout, Card, Combobox, Input, Textarea, useIsMobile, useToast, type StepDef } from "@ui"
import { flatten, fromWire, toWire, wireDepth, wireLeaves, type UiGroup, type Verdict } from "./condition"
import { leafErrors, leafQuotas, type LeafContext } from "./leafKinds"
import ConditionTree from "./ConditionTree"
import ConditionTester from "./ConditionTester"
import ActionsEditor from "./ActionsEditor"
import ScopeEditor from "./ScopeEditor"
import ModePicker from "./ModePicker"
import ImpactPanel from "./ImpactPanel"
import { useCreateRule, useRule, useRuleCatalog, useUpdateRule } from "./api"
import { useDirectory, useScopePreview } from "./useDirectory"
import { SEVERITIES, severityLabel } from "./labels"
import { formatWhen } from "../sections/format"
import type { SummaryContext } from "./summary"
import { emptyRuleInput, ruleToInput, type RuleInput, type RuleLimits } from "./types"
import { useAdminCrumbs } from "../pages/AdminBreadcrumb"
import { apiErrorDetail } from "../../core/api/errorMessage"

import { ViewBase } from './RuleEditor.kbcontrol'
import * as __parts from './RuleEditor.parts'

export type Pane = 'basics' | 'conditions' | 'actions' | 'scope' | 'mode' | 'impact' | 'history'

const FALLBACK_LIMITS: RuleLimits = {
  condition_depth: 5, condition_leaves: 32, actions: 8, scope_refs: 64, detector_leaves: 8,
}

interface Props {
  /** `null` ⇒ creation. */
  ruleId:   string | null
  onClose:  () => void
  canWrite: boolean
  /** Deep link into one pane (`/admin/rules?rule=…&pane=impact`). */
  initialPane?: Pane
}

export type { Props }

export class RuleEditor extends ViewBase {
  @bind accessor verdicts: Record<string, Verdict> | null = null
  @bind accessor loaded = false
  @bind accessor error: string | null = null
  tr!: RuleEditorStores['t']
  i18n!: RuleEditorStores['i18n']
  toast!: RuleEditorStores['toast']
  isMobile!: boolean
  catalog!: RuleEditorStores['catalog']
  detail!: RuleEditorHooks['detail']
  create!: RuleEditorStores['create']
  update!: RuleEditorStores['update']
  dir!: RuleEditorStores['dir']
  pane!: Pane
  setPane!: RuleEditorHooks['setPane']
  input!: RuleInput
  setInput!: RuleEditorStores['setInput']
  tree!: UiGroup
  setTree!: RuleEditorStores['setTree']
  leafCtx!: LeafContext
  summaryCtx!: SummaryContext
  preview!: RuleEditorStores['preview']
  wire!: RuleEditorStores['wire']
  leafNodes!: RuleEditorStores['leafNodes']
  leafProblems!: string[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const toast = useToast()
    const isMobile = useIsMobile()
    const catalog = useRuleCatalog()
    const create  = useCreateRule()
    const update  = useUpdateRule()
    const dir     = useDirectory()
    const [input, setInput] = useState<RuleInput>(emptyRuleInput)
    const [tree, setTree] = useState<UiGroup>(() => fromWire({ type: 'all', of: [] }))
    const preview = useScopePreview(input.scope, dir)
    const wire = useMemo(() => toWire(tree), [tree])
    const leafNodes = useMemo(
      () => flatten(tree).flatMap(n => (n.kind === 'leaf' ? [n.node] : [])), [tree])
    return { t, i18n, toast, isMobile, catalog, create, update, dir, input, setInput, tree, setTree, preview, wire, leafNodes }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const catalog = this.catalog
    const dir = this.dir
    const input = this.input
    const setInput = this.setInput
    const setTree = this.setTree
    const leafNodes = this.leafNodes
    const detail  = useRule(this.props.ruleId)
    this.publish({ detail })
    const [pane, setPane] = useState<Pane>(this.props.initialPane ?? 'basics')
    this.publish({ pane, setPane })
    useEffect(() => {
      if (this.isNew || this.loaded || !detail.data) return
      setInput(ruleToInput(detail.data.rule))
      setTree(fromWire(detail.data.rule.conditions))
      this.loaded = true
    }, [this.isNew, this.loaded, detail.data])
    const trigger = this.trigger
    const leafCtx: LeafContext = useMemo(() => ({ trigger, catalog: catalog.data, t }),
      [trigger, catalog.data, t])
    this.publish({ leafCtx })
    const summaryCtx: SummaryContext = useMemo(() => ({
      trigger,
      catalog:   catalog.data,
      t,
      actions:   catalog.data?.actions ?? [],
      unitName:  dir.unitName,
      groupName: dir.groupName,
      userName:  dir.userName,
    }), [trigger, t, catalog.data, dir])
    this.publish({ summaryCtx })
    const leafProblems = useMemo(() => {
      const messages = leafErrors(leafNodes, leafCtx, t)
      for (const q of leafQuotas(leafNodes, leafCtx, t)) {
        if (q.used > q.max) messages.push(q.over)
      }
      return messages
    }, [leafNodes, leafCtx, t])
    this.publish({ leafProblems })
    useAdminCrumbs(useMemo(
      () => [{ label: this.isNew ? t('admin.rl_new_title') : (input.name || t('admin.rl_edit_title')) }],
      [this.isNew, input.name, t],
    ))
    return { detail, pane, setPane, leafCtx, summaryCtx, leafProblems }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, toast: s.toast, isMobile: s.isMobile, catalog: s.catalog, create: s.create, update: s.update, dir: s.dir, input: s.input, setInput: s.setInput, tree: s.tree, setTree: s.setTree, preview: s.preview, wire: s.wire, leafNodes: s.leafNodes })
    const h = this.useHooks()
    this.publish({ detail: h.detail, pane: h.pane, setPane: h.setPane, leafCtx: h.leafCtx, summaryCtx: h.summaryCtx, leafProblems: h.leafProblems })
  }

  get isNew(): boolean {
    return this.props.ruleId === null
  }

  get limits(): RuleLimits {
    return this.memo('limits', [this.catalog], () => this.catalog.data?.limits ?? FALLBACK_LIMITS)
  }

  get trigger() {
    return this.memo('trigger', [this.catalog, this.input], () => this.catalog.data?.triggers.find(x => x.key === this.input.trigger))
  }

  get readOnly(): boolean {
    return !this.props.canWrite
  }

  get overDepth(): boolean {
    return wireDepth(this.wire) > this.limits.condition_depth
  }

  get overLeaves(): boolean {
    return wireLeaves(this.wire) > this.limits.condition_leaves
  }

  get nameOk(): boolean {
    return this.input.name.trim().length > 0
  }

  get triggerOk(): boolean {
    return this.input.trigger.length > 0
  }

  get canSave(): boolean {
    return this.nameOk && this.triggerOk && !this.overDepth && !this.overLeaves
    && this.leafProblems.length === 0 && this.props.canWrite
  }

  get triggerOptions(): { value: string; label: string; description: string; group: string; disabled: boolean; keywords: string; }[] {
    return this.memo('triggerOptions', [this.catalog], () => (this.catalog.data?.triggers ?? []).map(x => ({
    value: x.key,
    label: x.label,
    description: x.description ?? x.key,
    group: x.module_id,
    disabled: x.is_orphan,
    keywords: `${x.key} ${x.event_type}`,
  })))
  }

  get basics() {
    return this.memo('basics', [this.tr, this.input, this.readOnly, this.setInput, this.memo, this.setTree, this.verdicts, this.triggerOptions, this.trigger], () => (
    <div className="flex min-w-0 flex-col gap-4">
      <Input label={this.tr('admin.rl_name')} value={this.input.name} disabled={this.readOnly}
        onChange={e => this.set('name', e.target.value)} placeholder={this.tr('admin.rl_name_ph')} />
      <Textarea label={this.tr('admin.rl_description')} value={this.input.description ?? ''} rows={3}
        disabled={this.readOnly} onChange={e => this.set('description', e.target.value || null)}
        hint={this.tr('admin.rl_description_hint')} />
      <div>
        <label className="mb-1 block text-sm font-medium text-text-primary">{this.tr('admin.rl_trigger')}</label>
        <Combobox value={this.input.trigger || null} onChange={this.memo("setTrigger:bound", [], () => this.setTrigger.bind(this))} options={this.triggerOptions}
          disabled={this.readOnly} placeholder={this.tr('admin.rl_trigger_ph')}
          aria-label={this.tr('admin.rl_trigger')} />
        {this.trigger && (
          <p className="mt-1.5 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {this.trigger.description} · <span className="font-mono">{this.trigger.event_type}</span>
          </p>
        )}
        {!this.trigger && (
          <p className="mt-1.5 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {this.tr('admin.rl_trigger_hint')}
          </p>
        )}
      </div>
    </div>
  ))
  }

  get conditions() {
    return this.memo('conditions', [this.triggerOk, this.tr, this.isMobile, this.tree, this.setTree, this.leafCtx, this.verdicts, this.readOnly, this.trigger, this.memo, this.limits, this.wire], () => {
      const limits = this.limits
      const overDepth = wireDepth(this.wire) > limits.condition_depth
      const overLeaves = wireLeaves(this.wire) > limits.condition_leaves
      return (
    <div className="flex min-w-0 flex-col gap-4">
      {!this.triggerOk && <Callout variant="info">{this.tr('admin.rl_conditions_need_trigger')}</Callout>}
      {(overDepth || overLeaves) && (
        <Callout variant="danger" title={this.tr('admin.rl_over_limit_title')}>
          {overDepth
            ? this.tr('admin.rl_over_depth', { max: limits.condition_depth })
            : this.tr('admin.rl_over_leaves', { max: limits.condition_leaves })}
        </Callout>
      )}
      {this.isMobile ? (
        // The tree builder is disabled on a phone, deliberately.
        <Callout variant="info" title={this.tr('admin.rl_mobile_tree_title')}>
          {this.tr('admin.rl_mobile_tree_body')}
        </Callout>
      ) : (
        this.triggerOk && (
          <>
            <ConditionTree root={this.tree} onChange={this.setTree} ctx={this.leafCtx} limits={limits}
              verdicts={this.verdicts ?? undefined} disabled={this.readOnly} />
            <Card title={this.tr('admin.rl_test_title')} icon={<FlaskConical size={15} />} dense>
              <ConditionTester root={this.tree} ctx={this.leafCtx} trigger={this.trigger} onVerdicts={this.memo("setVerdicts:bound", [], () => this.setVerdicts.bind(this))} />
            </Card>
          </>
        )
      )}
    </div>
  )
    })
  }

  get actionsPane() {
    return this.memo('actionsPane', [this.input, this.setInput, this.catalog, this.limits, this.readOnly, this.tr], () => (
    <div className="flex min-w-0 flex-col gap-4">
      <ActionsEditor value={this.input.actions} onChange={v => this.set('actions', v)}
        catalogue={this.catalog.data?.actions ?? []} maxActions={this.limits.actions} disabled={this.readOnly} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-text-primary">{this.tr('admin.rl_severity')}</label>
          <Combobox value={this.input.severity} onChange={v => this.set('severity', v as typeof this.input.severity)}
            options={SEVERITIES.map(s => ({ value: s, label: severityLabel(this.tr, s) }))}
            disabled={this.readOnly} aria-label={this.tr('admin.rl_severity')} />
          <p className="mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {this.tr('admin.rl_severity_hint')}
          </p>
        </div>
        <Input label={this.tr('admin.rl_priority')} type="number" value={String(this.input.priority)}
          disabled={this.readOnly} onChange={e => this.set('priority', Number(e.target.value) || 0)}
          hint={this.tr('admin.rl_priority_hint')} />
      </div>
    </div>
  ))
  }

  get scopePane() {
    return this.memo('scopePane', [this.input, this.setInput, this.dir, this.limits, this.readOnly, this.tr], () => (
    <div className="flex min-w-0 flex-col gap-5">
      <ScopeEditor value={this.input.scope} onChange={v => this.set('scope', v)} dir={this.dir}
        maxRefs={this.limits.scope_refs} disabled={this.readOnly} />

      <Card title={this.tr('admin.rl_threshold_title')} dense>
        <p className="mb-3 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {this.tr('admin.rl_threshold_hint')}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={this.tr('admin.rl_threshold_count')} type="number" min={2} disabled={this.readOnly}
            value={this.input.threshold_count === null ? '' : String(this.input.threshold_count)}
            onChange={e => this.set('threshold_count', e.target.value === '' ? null : Number(e.target.value))} />
          <Input label={this.tr('admin.rl_threshold_window')} type="number" min={10} max={604800} disabled={this.readOnly}
            value={this.input.threshold_window_s === null ? '' : String(this.input.threshold_window_s)}
            onChange={e => this.set('threshold_window_s', e.target.value === '' ? null : Number(e.target.value))}
            hint={this.tr('admin.rl_threshold_window_hint')} />
        </div>
      </Card>

      <Card title={this.tr('admin.rl_rollout_title')} dense>
        <p className="mb-3 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {this.tr('admin.rl_rollout_hint')}
        </p>
        <Input type="number" min={0} max={100} disabled={this.readOnly}
          value={String(this.input.rollout_percent)} className="max-w-[8rem]"
          onChange={e => this.set('rollout_percent', Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
          aria-label={this.tr('admin.rl_rollout_title')} />
      </Card>
    </div>
  ))
  }

  get modePane() {
    return this.memo('modePane', [this.input, this.setInput, this.catalog, this.readOnly], () => (
    <div className="flex min-w-0 flex-col gap-4">
      <ModePicker value={this.input.mode} onChange={v => this.set('mode', v)}
        modes={this.catalog.data?.modes ?? ['inactive', 'simulate', 'monitor', 'enforce']}
        hasActions={this.input.actions.length > 0} disabled={this.readOnly} />
    </div>
  ))
  }

  get impactPane() {
    return this.memo('impactPane', [this.props, this.detail], () => (
    <ImpactPanel ruleId={this.props.ruleId} previous={this.detail.data?.backtests ?? []} />
  ))
  }

  get historyPane() {
    return this.memo('historyPane', [this.detail, this.tr, this.i18n], () => (
    <div className="flex min-w-0 flex-col gap-2">
      {(this.detail.data?.versions ?? []).length === 0 && (
        <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {this.tr('admin.rl_history_empty')}
        </p>
      )}
      {(this.detail.data?.versions ?? []).map(v => (
        <div key={v.version} className="rounded-lg border border-border bg-surface-0 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="default" size="sm">v{v.version}</Badge>
            <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {formatWhen(v.created_at, this.i18n.language)}
            </span>
            <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {v.changed_by_label ?? this.tr('admin.rl_history_unknown_author')}
            </span>
          </div>
          {v.change_note && (
            <p className="mt-1 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>{v.change_note}</p>
          )}
        </div>
      ))}
    </div>
  ))
  }

  get PANES(): Record<Pane, React.ReactNode> {
    return this.memo('PANES', [this.basics, this.conditions, this.actionsPane, this.scopePane, this.modePane, this.impactPane, this.historyPane], () => ({
    basics: this.basics, conditions: this.conditions, actions: this.actionsPane, scope: this.scopePane,
    mode: this.modePane, impact: this.impactPane, history: this.historyPane,
  }))
  }

  get wizardSteps(): Pane[] {
    return this.memo('wizardSteps', [], () => ['basics', 'conditions', 'actions', 'scope', 'mode'])
  }

  get steps(): StepDef[] {
    return this.memo('steps', [this.wizardSteps, this.tr, this.nameOk, this.pane], () => this.wizardSteps.map(id => ({
    id,
    label: this.tr(`admin.rl_pane_${id}`),
    status: id === 'basics' && !this.nameOk && this.pane !== 'basics' ? 'error' : undefined,
  })))
  }

  get tabs(): { id: Pane; label: string; }[] {
    return this.memo('tabs', [this.tr], () => (['basics', 'conditions', 'actions', 'scope', 'mode', 'impact', 'history'] as Pane[])
    .map(id => ({ id, label: this.tr(`admin.rl_pane_${id}`) })))
  }

  get stepIndex(): number {
    return Math.max(0, this.wizardSteps.indexOf(this.pane))
  }

  get busy(): boolean {
    return this.create.isPending || this.update.isPending
  }

  get header() {
    return this.memo('header', [this.isNew, this.tr, this.input, this.detail, this.busy, this.memo, this.error, this.wire, this.toast, this.create, this.props, this.update, this.nameOk, this.triggerOk, this.overDepth, this.overLeaves, this.leafProblems], () => {
      const canWrite = this.props.canWrite
      const canSave = this.nameOk && this.triggerOk && !this.overDepth && !this.overLeaves
    && this.leafProblems.length === 0 && canWrite
      return (
    <div className="mb-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="min-w-0 text-text-primary" style={{ fontSize: 'var(--kb-text-page)' }}>
        {this.isNew ? this.tr('admin.rl_new_title') : (this.input.name || this.tr('admin.rl_edit_title'))}
      </h1>
      {!this.isNew && this.detail.data && (
        <Badge variant="default" size="sm">v{this.detail.data.rule.version}</Badge>
      )}
      <div className="ms-auto flex items-center gap-2">
        {canWrite && (
          <Button variant="primary" size="sm" icon={this.isNew ? <Sparkles size={14} /> : <Save size={14} />}
            disabled={!canSave} loading={this.busy} onClick={this.memo("save:bound", [], () => this.save.bind(this))}>
            {this.isNew ? this.tr('admin.rl_create') : this.tr('admin.rl_save')}
          </Button>
        )}
      </div>
    </div>
  )
    })
  }

  get show_case_1() {
    return !!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))
  }

  get show_case_2() {
    return !(this.catalog.isLoading || (!this.isNew && this.detail.isLoading)) && !!(this.catalog.isError)
  }

  get show_main() {
    return !(this.catalog.isLoading || (!this.isNew && this.detail.isLoading)) && !(this.catalog.isError)
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_header() {
    return this.memo('content_header', [this.header, this.catalog, this.isNew, this.detail], () => {
      if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError))) return undefined as never
      return ({ children: this.header })
    })
  }

  get show_error() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError))) return undefined as never
    return !!(this.error)
  }

  get show_leaf_problems() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError))) return undefined as never
    return this.leafProblems.length > 0
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.leafProblems, this.catalog, this.isNew, this.detail], () => {
      if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.leafProblems.length > 0)) return undefined as never
      return ({ t: this.tr, leafProblems: this.leafProblems })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part1() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.leafProblems.length > 0)) return undefined as never
    return __parts.Part1
  }

  get show_not_is_new() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError))) return undefined as never
    return !(this.isNew)
  }

  get part2_props() {
    return this.memo('part2_props', [this.steps, this.stepIndex, this.setPane, this.tr, this.PANES, this.pane, this.catalog, this.isNew, this.detail], () => {
      if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.isNew)) return undefined as never
      return ({ steps: this.steps, stepIndex: this.stepIndex, setPane: this.setPane, t: this.tr, PANES: this.PANES, pane: this.pane })
    })
  }

  /** A part of the screen still written in React (<Stepper> steps: no .kbview property). */
  get Part2() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.isNew)) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tabs, this.pane, this.setPane, this.tr, this.catalog, this.isNew, this.detail], () => {
      if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(!(this.isNew))) return undefined as never
      return ({ tabs: this.tabs, pane: this.pane, setPane: this.setPane, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Tabs> tabs: no .kbview property). */
  get Part3() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(!(this.isNew))) return undefined as never
    return __parts.Part3
  }

  get content_panes_pane() {
    return this.memo('content_panes_pane', [this.PANES, this.pane, this.catalog, this.isNew, this.detail], () => {
      if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(!(this.isNew))) return undefined as never
      return ({ children: this.PANES[this.pane] })
    })
  }

  get enabled_unless_step_index() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.isNew)) return undefined as never
    return !(this.stepIndex === 0)
  }

  get show_step_index_wizard_steps() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.isNew)) return undefined as never
    return this.stepIndex < this.wizardSteps.length - 1
  }

  get show_not_step_index_wizard_steps() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.isNew)) return undefined as never
    return !(this.stepIndex < this.wizardSteps.length - 1)
  }

  get enabled_unless_can_save() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.isNew) || !(!(this.stepIndex < this.wizardSteps.length - 1))) return undefined as never
    return !(!this.canSave)
  }

  /** `<RuleSummaryPanel Input>`: the rule input with its live conditions. */
  get ruleSummaryInput() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError))) return undefined as never
    return { ...this.input, conditions: this.wire }
  }

  get show_is_mobile_pane_conditions() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError))) return undefined as never
    return this.isMobile && this.pane === 'conditions'
  }

  /** `<RuleSentence Input>`: the rule input with its live conditions. */
  get ruleSentenceInput() {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.isMobile && this.pane === 'conditions')) return undefined as never
    return { ...this.input, conditions: this.wire }
  }

  set<K extends keyof RuleInput>(key: K, value: RuleInput[K]) {
    return this.setInput(prev => ({ ...prev, [key]: value }))
  }

  setTrigger(key: string) {
    this.setInput(prev => ({ ...prev, trigger: key }))
    this.setTree(fromWire({ type: 'all', of: [] }))
    this.verdicts = null
  }

  payload(): RuleInput {
    return ({ ...this.input, conditions: this.wire })
  }

  save() {
    this.error = null
    const body = this.payload()
    const onError = (e: unknown) => {
      const message = (e as { response?: { data?: { error?: string; message?: string } } })
        ?.response?.data?.error
        ?? apiErrorDetail(e)
        ?? this.tr('admin.rl_save_failed')
      this.error = message
      this.toast.error(this.tr('admin.rl_save_failed'))
    }
    if (this.isNew) {
      this.create.mutate(body, {
        onSuccess: () => { this.toast.success(this.tr('admin.rl_toast_created')); this.props.onClose() },
        onError,
      })
    } else if (this.props.ruleId) {
      this.update.mutate({ id: this.props.ruleId, input: body }, {
        onSuccess: () => { this.toast.success(this.tr('admin.rl_toast_saved')); this.props.onClose() },
        onError,
      })
    }
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.isNew)) return undefined as never
    this.setPane(this.wizardSteps[Math.max(0, this.stepIndex - 1)])
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.catalog.isLoading || (!this.isNew && this.detail.isLoading))) || !(!(this.catalog.isError)) || !(this.isNew) || !(this.stepIndex < this.wizardSteps.length - 1)) return undefined as never
    this.setPane(this.wizardSteps[this.stepIndex + 1])
  }

  /** `setVerdicts` of the TSX: a value, or an update of the previous one. */
  setVerdicts(value: Record<string, Verdict> | null | ((prev: Record<string, Verdict> | null) => Record<string, Verdict> | null)) {
    this.verdicts = typeof value === 'function' ? (value as (prev: Record<string, Verdict> | null) => Record<string, Verdict> | null)(this.verdicts) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type RuleEditorStores = ReturnType<RuleEditor['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type RuleEditorHooks = ReturnType<RuleEditor['useHooks']>

export default RuleEditor.component()
