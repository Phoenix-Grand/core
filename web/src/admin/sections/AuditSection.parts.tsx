/**
 * The parts of `AuditSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, Download, Monitor, RotateCcw, Search, Server, ShieldAlert, Terminal, TriangleAlert } from "lucide-react"
import { Button, Dropdown, Input } from "@ui"
import { api } from "../../core/api/client"
import { AUDIT_OUTCOME_STYLE as OUTCOME_STYLE, type AuditEntry, type AuditDiffRow as DiffRow } from "./auditTypes"
import { formatWhen } from "./format"
import type { AuditSection } from './AuditSection'
const ORIGIN_ICON = {
  session:   Monitor,
  api_token: Terminal,
  internal:  Server,
  system:    Server,
} as const

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

function EntryDetail({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation()
  const { data } = useQuery({
    queryKey: ['admin-audit-entry', entry.id],
    queryFn:  () => api.get<{ entry: AuditEntry; diff: DiffRow[] }>(`/admin/audit/${entry.id}`).then(r => r.data),
    staleTime: 5 * 60_000,
  })
  const diff = data?.diff ?? []

  return (
    <div className="px-5 py-4 bg-surface-1 border-b border-border">
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          <h4 className="text-sm font-medium text-text-secondary mb-2">{t('admin.audit_diff_title')}</h4>
          {diff.length === 0 ? (
            <p className="text-sm text-text-tertiary">{t('admin.audit_diff_none')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-border rounded-lg overflow-hidden">
                <thead>
                  <tr className="text-left text-text-tertiary bg-white">
                    <th className="px-3 py-2 font-medium">{t('admin.audit_diff_field')}</th>
                    <th className="px-3 py-2 font-medium">{t('admin.audit_diff_before')}</th>
                    <th className="px-3 py-2 font-medium">{t('admin.audit_diff_after')}</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.map(d => (
                    <tr key={d.field} className="border-t border-border bg-white">
                      <td className="px-3 py-2 text-text-primary">{d.field}</td>
                      <td className="px-3 py-2 text-text-tertiary break-all">{renderValue(d.before)}</td>
                      <td className="px-3 py-2 text-text-primary break-all">{renderValue(d.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <dl className="text-sm space-y-1.5">
          {entry.detail && (
            <div className="flex gap-2">
              <dt className="text-text-tertiary shrink-0">{t('admin.audit_detail')}</dt>
              <dd className="text-text-primary break-all">{entry.detail}</dd>
            </div>
          )}
          {entry.user_agent && (
            <div className="flex gap-2">
              <dt className="text-text-tertiary shrink-0">{t('admin.audit_user_agent')}</dt>
              <dd className="text-text-secondary break-all">{entry.user_agent}</dd>
            </div>
          )}
          {entry.actor_token_id && (
            <div className="flex gap-2">
              <dt className="text-text-tertiary shrink-0">{t('admin.audit_token')}</dt>
              <dd className="text-text-secondary break-all font-mono">{entry.actor_token_id}</dd>
            </div>
          )}
          {entry.target_id && (
            <div className="flex gap-2">
              <dt className="text-text-tertiary shrink-0">{t('admin.audit_target_id')}</dt>
              <dd className="text-text-secondary break-all font-mono">{entry.target_id}</dd>
            </div>
          )}
          {entry.reversible && (
            <div className="flex items-center gap-1.5 text-text-secondary">
              <RotateCcw size={13} />
              <span>{t('admin.audit_reversible')}</span>
            </div>
          )}
          {entry.reverts_entry_id !== null && (
            <div className="text-text-secondary">{t('admin.audit_reverts', { id: entry.reverts_entry_id })}</div>
          )}
          {entry.reverted_by_entry_id !== null && (
            <div className="text-text-secondary">{t('admin.audit_reverted_by', { id: entry.reverted_by_entry_id })}</div>
          )}
        </dl>
      </div>
    </div>
  )
}
export { EntryDetail }

export function Part1({ exportCsv, t }: { exportCsv: AuditSection['exportCsv']; t: NonNullable<AuditSection['tr']> }) {
  return (
    <Button variant="secondary" onClick={exportCsv}>
                <Download size={15} className="mr-1.5" />
                {t('admin.audit_export')}
              </Button>
  )
}

export function Part2({ draft, setDraft, t }: { draft: NonNullable<AuditSection['draft']>; setDraft: NonNullable<AuditSection['setDraft']>; t: NonNullable<AuditSection['tr']> }) {
  return (
    <Input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                placeholder={t('admin.audit_search_ph')}
                leftIcon={<Search size={15} />}
                className="w-56 pl-9"
              />
  )
}

export function Part3({ filters, set, opt, facets, t }: { filters: NonNullable<AuditSection['filters']>; set: AuditSection['set']; opt: AuditSection['opt']; facets: AuditSection['facets']; t: NonNullable<AuditSection['tr']> }) {
  return (
    <Dropdown
              value={filters.action}
              onChange={v => set('action', v)}
              options={opt(facets?.actions ?? [], t('admin.audit_filter_all_actions'))}
              width={200}
              height={36}
              focusable
            />
  )
}

export function Part4({ filters, set, opt, facets, t }: { filters: NonNullable<AuditSection['filters']>; set: AuditSection['set']; opt: AuditSection['opt']; facets: AuditSection['facets']; t: NonNullable<AuditSection['tr']> }) {
  return (
    <Dropdown
              value={filters.target_type}
              onChange={v => set('target_type', v)}
              options={opt(facets?.target_types ?? [], t('admin.audit_filter_all_targets'),
                v => t(`admin.audit_target_${v}`, { defaultValue: v }))}
              width={160}
              height={36}
              focusable
            />
  )
}

export function Part5({ filters, set, opt, facets, t }: { filters: NonNullable<AuditSection['filters']>; set: AuditSection['set']; opt: AuditSection['opt']; facets: AuditSection['facets']; t: NonNullable<AuditSection['tr']> }) {
  return (
    <Dropdown
              value={filters.outcome}
              onChange={v => set('outcome', v)}
              options={opt(facets?.outcomes ?? [], t('admin.audit_filter_all_outcomes'),
                v => t(`admin.audit_outcome_${v}`, { defaultValue: v }))}
              width={140}
              height={36}
              focusable
            />
  )
}

export function Part6({ filters, set, t, facets }: { filters: NonNullable<AuditSection['filters']>; set: AuditSection['set']; t: NonNullable<AuditSection['tr']>; facets: AuditSection['facets'] }) {
  return (
    <Dropdown
              value={filters.actor_id}
              onChange={v => set('actor_id', v)}
              options={[
                { value: '', label: t('admin.audit_filter_all_actors') },
                ...(facets?.actors ?? []).map(a => ({ value: a.id, label: a.label })),
              ]}
              width={220}
              height={36}
              focusable
            />
  )
}

export function Part7({ t, filters, set }: { t: NonNullable<AuditSection['tr']>; filters: NonNullable<AuditSection['filters']>; set: AuditSection['set'] }) {
  return (
    <input
                type="date"
                aria-label={t('admin.audit_filter_from')}
                value={filters.from}
                onChange={e => set('from', e.target.value)}
                className="h-9 w-[8.5rem] rounded-md border border-border bg-white px-2 text-sm text-text-primary"
              />
  )
}

export function Part8({ t, filters, set }: { t: NonNullable<AuditSection['tr']>; filters: NonNullable<AuditSection['filters']>; set: AuditSection['set'] }) {
  return (
    <input
                type="date"
                aria-label={t('admin.audit_filter_to')}
                value={filters.to}
                onChange={e => set('to', e.target.value)}
                className="h-9 w-[8.5rem] rounded-md border border-border bg-white px-2 text-sm text-text-primary"
              />
  )
}

export function Part9({ t, rows, isLoading, open, setOpen, i18n }: { t: NonNullable<AuditSection['tr']>; rows: NonNullable<AuditSection['rows']>; isLoading: NonNullable<AuditSection['isLoading']>; open: AuditSection['open']; setOpen: NonNullable<AuditSection['setOpen']>; i18n: NonNullable<AuditSection['i18n']> }) {
  return (
    <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-tertiary border-b border-border">
                  <th className="w-8" />
                  <th className="px-3 py-2.5 font-medium whitespace-nowrap">{t('admin.audit_col_when')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('admin.audit_col_actor')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('admin.audit_col_action')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('admin.audit_col_target')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('admin.audit_col_outcome')}</th>
                  <th className="px-3 py-2.5 font-medium whitespace-nowrap">{t('admin.audit_col_ip')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !isLoading && (
                  <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-text-tertiary">{t('admin.audit_empty')}</td></tr>
                )}
                {rows.map(e => {
                  const OriginIcon = ORIGIN_ICON[e.actor_origin] ?? Monitor
                  const expanded = open === e.id
                  return [
                    <tr
                      key={e.id}
                      onClick={() => setOpen(expanded ? null : e.id)}
                      className="border-b border-border last:border-0 hover:bg-surface-1 transition-colors cursor-pointer"
                    >
                      <td className="pl-3 text-text-tertiary">
                        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </td>
                      <td className="px-3 py-2.5 text-text-secondary whitespace-nowrap tabular-nums">
                        {formatWhen(e.occurred_at, i18n.language)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1.5">
                          <OriginIcon size={13} className="text-text-tertiary shrink-0" />
                          <span className="text-text-primary">{e.actor_label}</span>
                          {e.actor_origin !== 'session' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-2 text-text-tertiary">
                              {t(`admin.audit_origin_${e.actor_origin}`)}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-text-primary font-mono">{e.action}</td>
                      <td className="px-3 py-2.5 text-text-secondary">{e.target_label || '—'}</td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full ${OUTCOME_STYLE[e.outcome]}`}>
                          {e.outcome === 'denied' && <ShieldAlert size={11} />}
                          {e.outcome === 'error' && <TriangleAlert size={11} />}
                          {t(`admin.audit_outcome_${e.outcome}`)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-text-tertiary whitespace-nowrap font-mono">{e.ip_address || '—'}</td>
                    </tr>,
                    expanded && (
                      <tr key={`${e.id}-detail`}>
                        <td colSpan={7} className="p-0"><EntryDetail entry={e} /></td>
                      </tr>
                    ),
                  ]
                })}
              </tbody>
            </table>
  )
}
