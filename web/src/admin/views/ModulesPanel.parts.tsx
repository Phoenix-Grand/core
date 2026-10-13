/**
 * The parts of `ModulesPanel.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { CircleSlash, Search, TriangleAlert } from "lucide-react"
import { DataTable, Input } from "@ui"
import { type ModuleLiveState } from "../adminModules"
import type { ModulesPanel } from './ModulesPanel'
const STATUS_KEY: Record<ModuleLiveState, string> = {
  running:     'admin.m_on_everyone',
  unknown:     'admin.m_on_everyone',
  disabled:    'admin.m_off_everyone',
  unreachable: 'admin.m_on_unreachable',
}

function ServiceStatus({ state }: { state: ModuleLiveState }) {
  const { t } = useTranslation()
  const label = t(STATUS_KEY[state])
  const glyph = state === 'disabled'
    ? <CircleSlash size={14} className="shrink-0 text-text-tertiary" />
    : state === 'unreachable'
      ? <TriangleAlert size={14} className="shrink-0 text-warning" />
      : <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-success" />
  const tone = state === 'disabled'
    ? 'text-text-tertiary'
    : state === 'unreachable' ? 'text-warning' : 'text-text-secondary'
  return (
    <span className={`inline-flex items-center gap-2 text-sm ${tone}`}>
      {glyph}
      <span className="truncate">{label}</span>
    </span>
  )
}
export { ServiceStatus }

export function Part1({ rows, columns, isLoading, query, setQuery, rowActions, open, t }: { rows: NonNullable<ModulesPanel['rows']>; columns: NonNullable<ModulesPanel['columns']>; isLoading: NonNullable<ModulesPanel['isLoading']>; query: NonNullable<ModulesPanel['query']>; setQuery: NonNullable<ModulesPanel['setQuery']>; rowActions: NonNullable<ModulesPanel['rowActions']>; open: ModulesPanel['open']; t: NonNullable<ModulesPanel['tr']> }) {
  return (
    <DataTable
            rows={rows}
            columns={columns}
            rowKey={m => m.id}
            loading={isLoading}
            filtered={query.trim().length > 0}
            onClearFilters={() => setQuery('')}
            rowActions={rowActions}
            onRowClick={open}
            defaultSort={{ columnId: 'app', direction: 'asc' }}
            pageSize={0}
            t={t}
            toolbar={
              <Input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('admin.m_filter_ph')}
                aria-label={t('admin.m_filter_ph')}
                leftIcon={<Search size={16} />}
                className="w-64 max-w-full"
              />
            }
          />
  )
}
