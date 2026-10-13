/**
 * Code-behind of `TableDemo.kbcontrol` (converted from `TableDemo.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Badge, ProgressBar, type DataTableColumn } from "@ui"
import { DEMO_MEMBERS, formatBytes, formatDate, type DemoMember } from "./fixtures"

import { ViewBase } from './TableDemo.kbcontrol'
import * as __parts from './TableDemo.parts'

export class TableDemo extends ViewBase {
  @bind accessor query = ''
  @bind accessor selected: string[] = []
  @bind accessor state: 'data' | 'loading' | 'error' | 'empty' = 'data'
  tr!: TableDemoStores['t']
  rows!: DemoMember[]
  columns!: DataTableColumn<DemoMember>[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const columns = useMemo<DataTableColumn<DemoMember>[]>(() => [
      {
        id: 'name',
        header: t('admin.t_prev_dt_col_member', { defaultValue: 'Membre' }),
        primary: true,
        required: true,
        minWidth: 200,
        sortValue: m => m.name,
        cell: m => (
          <div className="min-w-0">
            <div className="truncate text-text-primary">{m.name}</div>
            <div className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>{m.email}</div>
          </div>
        ),
      },
      {
        id: 'unit',
        header: t('admin.t_prev_dt_col_unit', { defaultValue: 'Unité' }),
        sortValue: m => m.unit,
        cell: m => <span className="truncate">{m.unit}</span>,
      },
      {
        id: 'role',
        header: t('admin.t_prev_dt_col_role', { defaultValue: 'Rôle' }),
        sortValue: m => m.role,
        cell: m => (
          <Badge variant={m.role === 'admin' ? 'primary' : m.role === 'guest' ? 'default' : 'neutral'}>
            {m.role}
          </Badge>
        ),
      },
      {
        id: 'quota',
        header: t('admin.t_prev_dt_col_quota', { defaultValue: 'Quota' }),
        minWidth: 150,
        sortValue: m => m.quota / m.max,
        cell: m => (
          <ProgressBar
            t={t}
            size="sm"
            value={m.quota}
            max={m.max}
            label={formatBytes(m.quota)}
            showValue
          />
        ),
      },
      {
        id: 'lastSeen',
        header: t('admin.t_prev_dt_col_seen', { defaultValue: 'Dernière activité' }),
        align: 'right',
        sortValue: m => m.lastSeen,
        cell: m => <span className="tabular-nums text-text-secondary">{formatDate(m.lastSeen)}</span>,
      },
      {
        id: 'status',
        header: t('admin.t_prev_dt_col_status', { defaultValue: 'Statut' }),
        defaultHidden: true,
        sortValue: m => m.active,
        cell: m => (
          <Badge dot variant={m.active ? 'success' : 'default'}>
            {m.active
              ? t('admin.t_prev_dt_active', { defaultValue: 'Actif' })
              : t('admin.t_prev_dt_suspended', { defaultValue: 'Suspendu' })}
          </Badge>
        ),
      },
    ], [t])
    return { t, columns }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const rows = useMemo(() => {
      if (this.state === 'empty') return []
      const q = this.query.trim().toLowerCase()
      if (!q) return DEMO_MEMBERS
      return DEMO_MEMBERS.filter(m =>
        m.name.toLowerCase().includes(q) || m.email.includes(q) || m.unit.toLowerCase().includes(q))
    }, [this.query, this.state])
    this.publish({ rows })
    return { rows }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, columns: s.columns })
    const h = this.useHooks()
    this.publish({ rows: h.rows })
  }

  get STATES(): Array<{ id: TableDemo['state']; label: string }> {
    return this.memo('STATES', [this.tr], () => [
    { id: 'data',    label: this.tr('admin.t_prev_dt_s_data',    { defaultValue: 'Données' }) },
    { id: 'loading', label: this.tr('admin.t_prev_dt_s_loading', { defaultValue: 'Chargement' }) },
    { id: 'error',   label: this.tr('admin.t_prev_dt_s_error',   { defaultValue: 'Erreur' }) },
    { id: 'empty',   label: this.tr('admin.t_prev_dt_s_empty',   { defaultValue: 'Vide' }) },
  ])
  }

  /** The rows of the Repeater over `STATES`. */
  get rows_states() {
    return this.memo('rows_states', [this.STATES, this.state], () => this.STATES.map((s) => {
      return { s, button_class: `rounded-md px-2.5 py-1 transition-colors ${
              this.state === s.id ? 'bg-primary-light text-primary' : 'bg-surface-2 text-text-secondary hover:bg-surface-3'
            }`, key: s.id }
    }))
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.rows, this.columns, this.state, this.memo, this.query, this.selected], () => ({ t: this.tr, rows: this.rows, columns: this.columns, state: this.state, setState: this.memo("setState:bound", [], () => this.setState.bind(this)), query: this.query, setQuery: this.memo("setQuery:bound", [], () => this.setQuery.bind(this)), selected: this.selected, setSelected: this.memo("setSelected:bound", [], () => this.setSelected.bind(this)) }))
  }

  /** A part of the screen still written in React (<DataTable> t, columns, rowKey, onRetry, filtered, onClearFilters, defaultSort, selectedIds, onSelectionChange, configurableColumns, toolbar, bulkActions, rowActions: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { s } = args.row as RowOf_rows_states
    this.state = s.id
  }

  /** `setState` of the TSX: a value, or an update of the previous one. */
  setState(value: 'data' | 'loading' | 'error' | 'empty' | ((prev: 'data' | 'loading' | 'error' | 'empty') => 'data' | 'loading' | 'error' | 'empty')) {
    this.state = typeof value === 'function' ? (value as (prev: 'data' | 'loading' | 'error' | 'empty') => 'data' | 'loading' | 'error' | 'empty')(this.state) : value
  }

  /** `setQuery` of the TSX: a value, or an update of the previous one. */
  setQuery(value: TableDemo['query'] | ((prev: TableDemo['query']) => TableDemo['query'])) {
    this.query = typeof value === 'function' ? (value as (prev: TableDemo['query']) => TableDemo['query'])(this.query) : value
  }

  /** `setSelected` of the TSX: a value, or an update of the previous one. */
  setSelected(value: string[] | ((prev: string[]) => string[])) {
    this.selected = typeof value === 'function' ? (value as (prev: string[]) => string[])(this.selected) : value
  }

}

type RowOf_rows_states = TableDemo['rows_states'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type TableDemoStores = ReturnType<TableDemo['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type TableDemoHooks = ReturnType<TableDemo['useHooks']>

export default TableDemo.component()
