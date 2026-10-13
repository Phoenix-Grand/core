/**
 * Code-behind of `RulesSection.kbview` (converted from `RulesSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, Copy, FlaskConical, Pencil, Play, Power, ScrollText, Trash2 } from "lucide-react"
import { Badge, Button, ConfirmDialog, Combobox, Input, useToast, type DataTableColumn, type DataTableRowAction } from "@ui"
import { Search, X } from "lucide-react"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { useConfirm } from "../../core/hooks/useConfirm"
import { adminUrl, useAdminAction } from "../adminAction"
import type { AdminSectionProps } from "../sections/registry"
import { formatAgo, formatWhen } from "../sections/format"
import { type Pane } from "./RuleEditor"
import { useCreateRule, useDeleteRule, useExecutions, useRuleCatalog, useRules, useSetRuleMode } from "./api"
import { MODE_ORDER, modeLabel, modeVariant, severityLabel, severityVariant } from "./labels"
import { ruleToInput, type Mode, type Rule } from "./types"

import { ViewBase } from './RulesSection.kbview'
import * as __parts from './RulesSection.parts'

const RECENT_WINDOW = 200

export type { AdminSectionProps }

export class RulesSection extends ViewBase {
  @bind accessor q = ''
  @bind accessor modeFilter = ''
  @bind accessor moduleFilter = ''
  tr!: RulesSectionStores['t']
  i18n!: RulesSectionStores['i18n']
  can!: RulesSectionStores['can']
  toast!: RulesSectionStores['toast']
  confirm!: RulesSectionStores['confirm']
  confirmState!: RulesSectionStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: RulesSectionHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: RulesSectionHooks['refetch']
  recent!: RulesSectionHooks['recent']
  setMode!: RulesSectionStores['setMode']
  remove!: RulesSectionStores['remove']
  create!: RulesSectionStores['create']
  recentCount!: Map<string, number>
  triggerLabel!: Map<string, string>
  modules!: string[]
  rows!: Rule[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { can } = usePrivileges()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const catalog = useRuleCatalog()
    const setMode = useSetRuleMode()
    const remove = useDeleteRule()
    const create = useCreateRule()
    const triggerLabel = useMemo(() => {
      const m = new Map<string, string>()
      for (const x of catalog.data?.triggers ?? []) m.set(x.key, x.label)
      return m
    }, [catalog.data])
    return { t, i18n, can, toast, confirm, confirmState, handleConfirm, handleCancel, catalog, setMode, remove, create, triggerLabel }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data, isLoading, isError, refetch } = useRules(!this.openId && !this.creating)
    this.publish({ data, isLoading, isError, refetch })
    const recent = useExecutions({ limit: RECENT_WINDOW }, !this.openId && !this.creating)
    this.publish({ recent })
    useAdminAction('create', () => this.props.navigate(adminUrl({ tab: 'rules', params: { new: 1 } })))
    useAdminAction('simulate', id => { if (id) this.armSimulation(id) })
    useAdminAction('impact', id => { if (id) this.props.navigate(adminUrl({ tab: 'rules', params: { rule: id, pane: 'impact' } })) })
    const recentCount = useMemo(() => {
      const m = new Map<string, number>()
      for (const e of recent.data ?? []) m.set(e.rule_id, (m.get(e.rule_id) ?? 0) + 1)
      return m
    }, [recent.data])
    this.publish({ recentCount })
    const modules = useMemo(
      () => [...new Set(this.rules.map(r => r.trigger.split('.')[0]))].sort(),
      [this.rules],
    )
    this.publish({ modules })
    const rows = useMemo(() => {
      const needle = this.q.trim().toLowerCase()
      return this.rules.filter(r => {
        if (this.modeFilter && r.mode !== this.modeFilter) return false
        if (this.moduleFilter && !r.trigger.startsWith(`${this.moduleFilter}.`)) return false
        if (!needle) return true
        return r.name.toLowerCase().includes(needle)
          || (r.description ?? '').toLowerCase().includes(needle)
          || r.trigger.toLowerCase().includes(needle)
      })
    }, [this.rules, this.q, this.modeFilter, this.moduleFilter])
    this.publish({ rows })
    return { data, isLoading, isError, refetch, recent, recentCount, modules, rows }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, can: s.can, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, setMode: s.setMode, remove: s.remove, create: s.create, triggerLabel: s.triggerLabel })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch, recent: h.recent, recentCount: h.recentCount, modules: h.modules, rows: h.rows })
  }

  get canWrite(): boolean {
    return this.can(PRIV.RULES_MANAGE)
  }

  get openId(): string | null {
    return this.props.params.get('rule')
  }

  get creating(): boolean {
    return this.props.params.get('new') === '1'
  }

  get pane(): Pane | undefined {
    return (this.props.params.get('pane') as Pane | null) ?? undefined
  }

  get rules(): Rule[] {
    return this.memo('rules', [this.data], () => this.data?.rules ?? [])
  }

  get columns(): DataTableColumn<Rule>[] {
    return this.memo('columns', [this.tr, this.triggerLabel, this.recentCount, this.i18n, this.creating, this.openId], () => {
      if (!(!(this.creating || this.openId))) return undefined as never
      return [
    {
      id: 'name',
      header: this.tr('admin.rl_col_name'),
      primary: true,
      required: true,
      minWidth: 220,
      cell: r => (
        <div className="min-w-0">
          <div className="line-clamp-2 whitespace-normal break-words text-text-primary">{r.name}</div>
          {r.description && (
            <div className="line-clamp-2 whitespace-normal break-words text-text-tertiary"
              style={{ fontSize: 'var(--kb-text-meta)' }}>
              {r.description}
            </div>
          )}
        </div>
      ),
      sortValue: r => r.name,
    },
    {
      id: 'mode',
      header: this.tr('admin.rl_col_mode'),
      width: 150,
      cell: r => (
        <Badge variant={modeVariant(r.mode)} size="sm">
          {r.mode === 'simulate' && <FlaskConical size={10} />}
          {r.mode === 'enforce' && <AlertTriangle size={10} />}
          {modeLabel(this.tr, r.mode)}
        </Badge>
      ),
      sortValue: r => MODE_ORDER.indexOf(r.mode),
    },
    {
      id: 'trigger',
      header: this.tr('admin.rl_col_trigger'),
      width: 190,
      cell: r => (
        <span className="truncate text-text-secondary">{this.triggerLabel.get(r.trigger) ?? r.trigger}</span>
      ),
      sortValue: r => this.triggerLabel.get(r.trigger) ?? r.trigger,
    },
    {
      id: 'module',
      header: this.tr('admin.rl_col_module'),
      width: 110,
      cell: r => <Badge variant="default" size="sm">{r.trigger.split('.')[0]}</Badge>,
      sortValue: r => r.trigger.split('.')[0],
    },
    {
      id: 'actions',
      header: this.tr('admin.rl_col_actions'),
      width: 90,
      align: 'right',
      cell: r => <span className="tabular-nums text-text-secondary">{r.actions.length}</span>,
      sortValue: r => r.actions.length,
    },
    {
      id: 'severity',
      header: this.tr('admin.rl_col_severity'),
      width: 110,
      cell: r => (
        <Badge variant={severityVariant(r.severity)} size="sm">{severityLabel(this.tr, r.severity)}</Badge>
      ),
      sortValue: r => ({ critical: 0, warning: 1, info: 2 } as Record<string, number>)[r.severity] ?? 3,
    },
    {
      id: 'recent',
      header: this.tr('admin.rl_col_recent'),
      headerText: this.tr('admin.rl_col_recent'),
      width: 110,
      align: 'right',
      cell: r => (
        <span className="tabular-nums text-text-secondary" title={this.tr('admin.rl_col_recent_hint', { n: RECENT_WINDOW })}>
          {this.recentCount.get(r.id) ?? 0}
        </span>
      ),
      sortValue: r => this.recentCount.get(r.id) ?? 0,
    },
    {
      id: 'updated',
      header: this.tr('admin.rl_col_updated'),
      width: 150,
      cell: r => (
        <span className="whitespace-nowrap text-text-secondary" title={formatWhen(r.updated_at, this.i18n.language)}>
          {formatAgo(r.updated_at)}
        </span>
      ),
      sortValue: r => new Date(r.updated_at),
    },
  ]
    })
  }

  get rowActions(): DataTableRowAction<Rule>[] {
    return this.memo('rowActions', [this.canWrite, this.tr, this.props, this.setMode, this.toast, this.create, this.confirm, this.remove, this.creating, this.openId], () => {
      if (!(!(this.creating || this.openId))) return undefined as never
      return [
    {
      id: 'edit',
      label: this.canWrite ? this.tr('admin.rl_action_edit') : this.tr('admin.rl_action_open'),
      icon: <Pencil size={15} />,
      onClick: r => this.props.navigate(adminUrl({ tab: 'rules', params: { rule: r.id } })),
    },
    {
      id: 'impact',
      label: this.tr('admin.rl_action_impact'),
      icon: <Play size={15} />,
      onClick: r => this.props.navigate(adminUrl({ tab: 'rules', params: { rule: r.id, pane: 'impact' } })),
    },
    {
      id: 'log',
      label: this.tr('admin.rl_action_log'),
      icon: <ScrollText size={15} />,
      onClick: r => this.props.navigate(adminUrl({ tab: 'rules-log', params: { rule: r.id } })),
    },
    ...(this.canWrite ? [
      {
        id: 'simulate',
        label: this.tr('admin.rl_action_simulate'),
        icon: <FlaskConical size={15} />,
        onClick: (r: Rule) => this.armSimulation(r.id),
        hidden: (r: Rule) => r.mode === 'simulate',
      },
      {
        id: 'toggle',
        label: this.tr('admin.rl_action_toggle'),
        icon: <Power size={15} />,
        onClick: (r: Rule) => this.toggleMode(r),
      },
      {
        id: 'duplicate',
        label: this.tr('admin.rl_action_duplicate'),
        icon: <Copy size={15} />,
        onClick: (r: Rule) => this.duplicate(r),
      },
      {
        id: 'delete',
        label: this.tr('common.delete'),
        icon: <Trash2 size={15} />,
        danger: true,
        onClick: (r: Rule) => void this.askDelete(r),
      },
    ] : []),
  ]
    })
  }

  get anyFilter(): boolean {
    if (!(!(this.creating || this.openId))) return undefined as never
    return !!(this.q || this.modeFilter || this.moduleFilter)
  }

  get toolbar() {
    return this.memo('toolbar', [this.q, this.tr, this.memo, this.modeFilter, this.moduleFilter, this.modules, this.creating, this.openId], () => {
      if (!(!(this.creating || this.openId))) return undefined as never
      const q = this.q
      const modeFilter = this.modeFilter
      const moduleFilter = this.moduleFilter
      const anyFilter = !!(q || modeFilter || moduleFilter)
      return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Input value={q} onChange={e => this.q = e.target.value} placeholder={this.tr('admin.rl_search_ph')}
        leftIcon={<Search size={15} />} className="w-52 pl-9" />
      <Combobox
        value={modeFilter}
        onChange={this.memo("setModeFilter:bound", [], () => this.setModeFilter.bind(this))}
        options={[
          { value: '', label: this.tr('admin.rl_filter_all_modes') },
          ...MODE_ORDER.map(m => ({ value: m, label: modeLabel(this.tr, m) })),
        ]}
        width={170}
        aria-label={this.tr('admin.rl_filter_all_modes')}
      />
      <Combobox
        value={moduleFilter}
        onChange={this.memo("setModuleFilter:bound", [], () => this.setModuleFilter.bind(this))}
        options={[
          { value: '', label: this.tr('admin.rl_filter_all_modules') },
          ...this.modules.map(m => ({ value: m, label: m })),
        ]}
        width={160}
        aria-label={this.tr('admin.rl_filter_all_modules')}
      />
      {anyFilter && (
        <Button variant="ghost" size="sm" icon={<X size={14} />}
          onClick={() => { this.q = ''; this.modeFilter = ''; this.moduleFilter = '' }}>
          {this.tr('admin.rl_reset_filters')}
        </Button>
      )}
    </div>
  )
    })
  }

  get armed(): number {
    if (!(!(this.creating || this.openId))) return undefined as never
    return this.rules.filter(r => r.mode === 'enforce').length
  }

  get simulating(): number {
    if (!(!(this.creating || this.openId))) return undefined as never
    return this.rules.filter(r => r.mode === 'simulate').length
  }

  get show_case_1() {
    return !!(this.creating || this.openId)
  }

  /** `<RuleEditor RuleId>`: the edited rule's id, `null` while creating. */
  get ruleEditorRuleId() {
    if (!(this.creating || this.openId)) return undefined as never
    return this.creating ? null : this.openId
  }

  get show_main() {
    return !(this.creating || this.openId)
  }

  get show_data() {
    return this.memo('show_data', [this.data, this.creating, this.openId], () => {
      if (!(!(this.creating || this.openId))) return undefined as never
      return !!(this.data)
    })
  }

  get show_data_data_engine() {
    if (!(!(this.creating || this.openId))) return undefined as never
    return !!(this.data && !this.data.engine_enabled)
  }

  get show_data_data_indexed() {
    if (!(!(this.creating || this.openId))) return undefined as never
    return !!(this.data && this.data.indexed < this.rules.filter(r => r.mode !== 'inactive').length)
  }

  get rl_indexed_note_count() {
    if (!(!(this.creating || this.openId)) || !(this.data && this.data.indexed < this.rules.filter(r => r.mode !== 'inactive').length)) return undefined as never
    return this.data.indexed
  }

  get rl_indexed_note_active() {
    if (!(!(this.creating || this.openId)) || !(this.data && this.data.indexed < this.rules.filter(r => r.mode !== 'inactive').length)) return undefined as never
    return this.rules.filter(r => r.mode !== 'inactive').length
  }

  get show_can_write() {
    if (!(!(this.creating || this.openId))) return undefined as never
    return !this.canWrite
  }

  get part1_props() {
    return this.memo('part1_props', [this.rows, this.columns, this.isLoading, this.isError, this.tr, this.refetch, this.anyFilter, this.memo, this.q, this.modeFilter, this.moduleFilter, this.toolbar, this.rowActions, this.props, this.canWrite, this.creating, this.openId], () => {
      if (!(!(this.creating || this.openId))) return undefined as never
      return ({ rows: this.rows, columns: this.columns, isLoading: this.isLoading, isError: this.isError, t: this.tr, refetch: this.refetch, anyFilter: this.anyFilter, setQ: this.memo("setQ:bound", [], () => this.setQ.bind(this)), setModeFilter: this.memo("setModeFilter:bound", [], () => this.setModeFilter.bind(this)), setModuleFilter: this.memo("setModuleFilter:bound", [], () => this.setModuleFilter.bind(this)), toolbar: this.toolbar, rowActions: this.rowActions, navigate: this.props.navigate, canWrite: this.canWrite })
    })
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, onRetry, filtered, onClearFilters, toolbar, rowActions, onRowClick, configurableColumns, t, emptyState: no .kbview property). */
  get Part1() {
    if (!(!(this.creating || this.openId))) return undefined as never
    return __parts.Part1
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.creating, this.openId], () => {
      if (!(!(this.creating || this.openId))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.creating || this.openId)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.creating, this.openId], () => {
      if (!(!(this.creating || this.openId)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  armSimulation(id: string) {
    this.setMode.mutate({ id, mode: 'simulate', change_note: 'Passage en simulation depuis la console' }, {
      onSuccess: () => this.toast.success(this.tr('admin.rl_toast_simulating')),
      onError:   () => this.toast.error(this.tr('admin.rl_toast_mode_failed')),
    })
  }

  toggleMode(rule: Rule) {
    // Never straight to `enforce` from a menu: re-arming a rule that acts is a
    // decision taken in the editor, in front of the mode descriptions.
    const next: Mode = rule.mode === 'inactive' ? 'simulate' : 'inactive'
    this.setMode.mutate({ id: rule.id, mode: next }, {
      onSuccess: () => this.toast.success(this.tr(next === 'inactive' ? 'admin.rl_toast_disabled' : 'admin.rl_toast_simulating')),
      onError:   () => this.toast.error(this.tr('admin.rl_toast_mode_failed')),
    })
  }

  duplicate(rule: Rule) {
    const input = ruleToInput(rule)
    this.create.mutate(
      // A copy is born inactive whatever the original was doing: duplicating a
      // rule must never be a way to arm a second one by accident.
      { ...input, name: this.tr('admin.rl_copy_name', { name: rule.name }), mode: 'inactive' },
      {
        onSuccess: () => this.toast.success(this.tr('admin.rl_toast_duplicated')),
        onError:   () => this.toast.error(this.tr('admin.rl_toast_duplicate_failed')),
      },
    )
  }

  async askDelete(rule: Rule) {
    const ok = await this.confirm({
      title: this.tr('admin.rl_delete_title'),
      message: this.tr('admin.rl_delete_body', { name: rule.name }),
      confirmLabel: this.tr('common.delete'),
      variant: 'danger',
    })
    if (!ok) return
    this.remove.mutate(rule.id, {
      onSuccess: () => this.toast.success(this.tr('admin.rl_toast_deleted')),
      onError:   () => this.toast.error(this.tr('admin.rl_toast_delete_failed')),
    })
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.creating || this.openId))) return undefined as never
    this.props.navigate(adminUrl({ tab: 'rules-log' }))
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.creating || this.openId)) || !(this.canWrite)) return undefined as never
    this.props.navigate(adminUrl({ tab: 'rules', params: { new: 1 } }))
  }

  /** `<RuleEditor OnClose>`: leaves the editor, back to the rules list. */
  rule_editor_close(_sender: unknown, _e: EventArgs) {
    if (!(this.creating || this.openId)) return undefined as never
    this.props.navigate(adminUrl({ tab: 'rules' }))
  }

  /** `setModeFilter` of the TSX: a value, or an update of the previous one. */
  setModeFilter(value: RulesSection['modeFilter'] | ((prev: RulesSection['modeFilter']) => RulesSection['modeFilter'])) {
    this.modeFilter = typeof value === 'function' ? (value as (prev: RulesSection['modeFilter']) => RulesSection['modeFilter'])(this.modeFilter) : value
  }

  /** `setModuleFilter` of the TSX: a value, or an update of the previous one. */
  setModuleFilter(value: RulesSection['moduleFilter'] | ((prev: RulesSection['moduleFilter']) => RulesSection['moduleFilter'])) {
    this.moduleFilter = typeof value === 'function' ? (value as (prev: RulesSection['moduleFilter']) => RulesSection['moduleFilter'])(this.moduleFilter) : value
  }

  /** `setQ` of the TSX: a value, or an update of the previous one. */
  setQ(value: RulesSection['q'] | ((prev: RulesSection['q']) => RulesSection['q'])) {
    this.q = typeof value === 'function' ? (value as (prev: RulesSection['q']) => RulesSection['q'])(this.q) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type RulesSectionStores = ReturnType<RulesSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type RulesSectionHooks = ReturnType<RulesSection['useHooks']>

export default RulesSection.component()
