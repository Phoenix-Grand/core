/**
 * Code-behind of `ActivityTab.kbcontrol` (converted from `ActivityTab.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, ShieldAlert, TriangleAlert } from "lucide-react"
import { type DataTableColumn } from "@ui"
import { api } from "../../../core/api/client"
import type { User } from "../../../core/types"
import { AUDIT_OUTCOME_STYLE, type AuditEntry } from "../auditTypes"
import { formatWhen } from "../format"

import { ViewBase } from './ActivityTab.kbcontrol'
import * as __parts from './ActivityTab.parts'

const SCOPE_LIMIT = 100

interface AuditPage { entries: AuditEntry[]; next_cursor: string | null }

export type ActivityTabProps = { user: User }

export class ActivityTab extends ViewBase {
  @bind accessor open: number | null = null
  tr!: ActivityTabStores['t']
  i18n!: ActivityTabStores['i18n']
  asTarget!: ActivityTabHooks['asTarget']
  asActor!: ActivityTabHooks['asActor']
  rows!: AuditEntry[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    return { t, i18n }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const asTarget = useQuery({
      queryKey: ['admin-audit-user-target', this.props.user.id],
      queryFn: () => api
        .get<AuditPage>('/admin/audit', {
          params: { target_type: 'user', q: this.props.user.email, limit: SCOPE_LIMIT },
        })
        .then(r => r.data),
    })
    this.publish({ asTarget })
    const asActor = useQuery({
      queryKey: ['admin-audit-user-actor', this.props.user.id],
      queryFn: () => api
        .get<AuditPage>('/admin/audit', { params: { actor_id: this.props.user.id, limit: SCOPE_LIMIT } })
        .then(r => r.data),
    })
    this.publish({ asActor })
    const rows = useMemo(() => {
      const merged = new Map<number, AuditEntry>()
      for (const e of [...(asTarget.data?.entries ?? []), ...(asActor.data?.entries ?? [])]) {
        // Exact ownership test — `q` above is only a pre-filter.
        if (e.target_id === this.props.user.id || e.actor_id === this.props.user.id) merged.set(e.id, e)
      }
      return [...merged.values()].sort(
        (a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id - a.id,
      )
    }, [asTarget.data, asActor.data, this.props.user.id])
    this.publish({ rows })
    return { asTarget, asActor, rows }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n })
    const h = this.useHooks()
    this.publish({ asTarget: h.asTarget, asActor: h.asActor, rows: h.rows })
  }

  get isLoading(): boolean {
    return this.asTarget.isLoading || this.asActor.isLoading
  }

  get isError(): boolean {
    return this.asTarget.isError || this.asActor.isError
  }

  get truncated(): boolean {
    return (this.asTarget.data?.entries.length ?? 0) >= SCOPE_LIMIT ||
    (this.asActor.data?.entries.length ?? 0) >= SCOPE_LIMIT
  }

  get columns(): DataTableColumn<AuditEntry>[] {
    return this.memo('columns', [this.tr, this.i18n, this.props, this.open], () => {
      const open = this.open
      return [
    {
      id: 'when',
      header: this.tr('admin.audit_col_when'),
      headerText: this.tr('admin.audit_col_when'),
      minWidth: 170,
      sortValue: e => new Date(e.occurred_at),
      cell: e => <span className="whitespace-nowrap tabular-nums text-text-secondary">{formatWhen(e.occurred_at, this.i18n.language)}</span>,
    },
    {
      id: 'action',
      header: this.tr('admin.audit_col_action'),
      headerText: this.tr('admin.audit_col_action'),
      primary: true,
      minWidth: 180,
      sortValue: e => e.action,
      cell: e => <span className="font-mono">{e.action}</span>,
    },
    {
      id: 'role',
      header: this.tr('admin.ud_act_col_role'),
      headerText: this.tr('admin.ud_act_col_role'),
      minWidth: 110,
      sortValue: e => (e.actor_id === this.props.user.id ? 'actor' : 'target'),
      cell: e => (
        <span className="text-text-secondary">
          {e.actor_id === this.props.user.id ? this.tr('admin.ud_act_role_actor') : this.tr('admin.ud_act_role_target')}
        </span>
      ),
    },
    {
      id: 'actor',
      header: this.tr('admin.audit_col_actor'),
      headerText: this.tr('admin.audit_col_actor'),
      minWidth: 180,
      defaultHidden: true,
      sortValue: e => e.actor_label,
      cell: e => <span className="text-text-secondary">{e.actor_label}</span>,
    },
    {
      id: 'outcome',
      header: this.tr('admin.audit_col_outcome'),
      headerText: this.tr('admin.audit_col_outcome'),
      minWidth: 110,
      sortValue: e => e.outcome,
      cell: e => (
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${AUDIT_OUTCOME_STYLE[e.outcome]}`}
          style={{ fontSize: 'var(--kb-text-meta)' }}
        >
          {e.outcome === 'denied' && <ShieldAlert size={11} />}
          {e.outcome === 'error' && <TriangleAlert size={11} />}
          {this.tr(`admin.audit_outcome_${e.outcome}`)}
        </span>
      ),
    },
    {
      id: 'ip',
      header: this.tr('admin.audit_col_ip'),
      headerText: this.tr('admin.audit_col_ip'),
      minWidth: 120,
      defaultHidden: true,
      sortValue: e => e.ip_address ?? '',
      cell: e => <span className="whitespace-nowrap font-mono text-text-tertiary">{e.ip_address ?? '—'}</span>,
    },
    {
      id: 'detail',
      header: this.tr('admin.ud_act_col_detail'),
      headerText: this.tr('admin.ud_act_col_detail'),
      minWidth: 220,
      // Disclosure inside the cell: the table has no row-expansion API, and a
      // side panel would hide the row the operator is comparing against.
      cell: (e) => {
        const expanded = open === e.id
        const hasBody = e.detail != null || e.before != null || e.after != null
        if (!hasBody) return <span className="text-text-tertiary">—</span>
        return (
          // Capped: a cell is sized by its content, so an unbounded <pre> would
          // widen the table and push the other columns out of view.
          <div className="min-w-0" style={{ maxWidth: 460 }}>
            <button
              type="button"
              onClick={(ev) => { ev.stopPropagation(); this.open = expanded ? null : e.id }}
              aria-expanded={expanded}
              className="flex items-center gap-1 rounded-sm text-text-secondary transition-colors
                         hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              style={{ fontSize: 'var(--kb-text-meta)' }}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {expanded ? this.tr('admin.ud_act_hide') : (e.detail ?? this.tr('admin.ud_act_show'))}
            </button>
            {expanded && (
              <pre className="mt-1.5 max-h-56 overflow-auto rounded-md border border-border bg-surface-1 p-2
                              font-mono text-text-primary"
                   style={{ fontSize: 'var(--kb-text-meta)' }}>
                {JSON.stringify({ detail: e.detail, before: e.before, after: e.after }, null, 2)}
              </pre>
            )}
          </div>
        )
      },
    },
  ]
    })
  }

  get subtitle() {
    return this.truncated ? this.tr('admin.ud_act_truncated', { total: SCOPE_LIMIT }) : this.tr('admin.ud_act_desc')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.rows, this.columns, this.isLoading, this.isError, this.asTarget, this.asActor], () => ({ t: this.tr, rows: this.rows, columns: this.columns, isLoading: this.isLoading, isError: this.isError, asTarget: this.asTarget, asActor: this.asActor }))
  }

  /** A part of the screen still written in React (<DataTable> t, columns, rowKey, onRetry, defaultSort, pageSizeOptions, configurableColumns, minTableWidth, emptyState: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ActivityTabStores = ReturnType<ActivityTab['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ActivityTabHooks = ReturnType<ActivityTab['useHooks']>

export default ActivityTab.component()
