/**
 * The parts of `ConsumersCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { cn } from "../../ui/cn"
import { Download, HardDrive, SlidersHorizontal } from "lucide-react"
import { Button, DataTable, EmptyState } from "@ui"
import { type Consumer, type ConsumerFilter, type ConsumerSort } from "./api"
import type { ConsumersCard } from './ConsumersCard'
const FILTERS: { id: ConsumerFilter; key: string }[] = [
  { id: 'all',  key: 'admin.sto_filter_all' },
  { id: 'near', key: 'admin.sto_filter_near' },
  { id: 'full', key: 'admin.sto_filter_full' },
]

const SORTS: { id: ConsumerSort; key: string }[] = [
  { id: 'used',    key: 'admin.sto_sort_used' },
  { id: 'percent', key: 'admin.sto_sort_percent' },
]

function exportCsv(rows: Consumer[], headers: string[]) {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const body = rows.map(r => [
    r.display_name?.trim() || r.username,
    r.email,
    r.unit_name ?? '',
    r.used_bytes,
    r.quota_bytes,
    r.quota_bytes > 0 ? Math.round((r.used_bytes / r.quota_bytes) * 100) : '',
  ].map(esc).join(','))
  const csv = [headers.map(esc).join(','), ...body].join('\n')
  // A BOM so a spreadsheet opens the accented names correctly rather than
  // showing mojibake the operator then blames on the export.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `kubuno-stockage-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function Part1({ rows, columns, isLoading, isError, t, refetch, rowActions, setInspecting, filter, setFilter, sort, setSort }: { rows: NonNullable<ConsumersCard['rows']>; columns: NonNullable<ConsumersCard['columns']>; isLoading: NonNullable<ConsumersCard['isLoading']>; isError: NonNullable<ConsumersCard['isError']>; t: NonNullable<ConsumersCard['tr']>; refetch: NonNullable<ConsumersCard['refetch']>; rowActions: NonNullable<ConsumersCard['rowActions']>; setInspecting: NonNullable<ConsumersCard['setInspecting']>; filter: NonNullable<ConsumersCard['filter']>; setFilter: NonNullable<ConsumersCard['setFilter']>; sort: NonNullable<ConsumersCard['sort']>; setSort: NonNullable<ConsumersCard['setSort']> }) {
  return (
    <DataTable
            rows={rows}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            error={isError ? t('admin.sto_load_failed') : undefined}
            onRetry={() => void refetch()}
            rowActions={rowActions}
            onRowClick={r => setInspecting(r)}
            filtered={filter !== 'all'}
            onClearFilters={() => setFilter('all')}
            defaultSort={null}
            pageSize={0}
            minTableWidth={720}
            t={t}
            title={t('admin.sto_consumers_title')}
            toolbar={
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex overflow-hidden rounded-md border border-border" role="group">
                  {FILTERS.map(f => (
                    <button
                      key={f.id}
                      type="button"
                      aria-pressed={filter === f.id}
                      onClick={() => setFilter(f.id)}
                      className={cn(
                        'px-3 py-1.5 transition-colors',
                        filter === f.id ? 'bg-primary-light text-primary' : 'text-text-secondary hover:bg-surface-2',
                      )}
                      style={{ fontSize: 'var(--kb-text-body)' }}
                    >
                      {t(f.key)}
                    </button>
                  ))}
                </div>
    
                <div className="flex overflow-hidden rounded-md border border-border" role="group">
                  {SORTS.map(s => (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={sort === s.id}
                      onClick={() => setSort(s.id)}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 transition-colors',
                        sort === s.id ? 'bg-primary-light text-primary' : 'text-text-secondary hover:bg-surface-2',
                      )}
                      style={{ fontSize: 'var(--kb-text-body)' }}
                    >
                      {s.id === 'used' && <SlidersHorizontal size={13} aria-hidden />}
                      {t(s.key)}
                    </button>
                  ))}
                </div>
    
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Download size={14} />}
                  disabled={rows.length === 0}
                  onClick={() => exportCsv(rows, [
                    t('admin.sto_col_account'), t('admin.sto_csv_email'), t('admin.sto_col_unit'),
                    t('admin.sto_csv_used_bytes'), t('admin.sto_csv_quota_bytes'), t('admin.sto_csv_fill'),
                  ])}
                >
                  {t('admin.sto_export')}
                </Button>
              </div>
            }
            emptyState={(
              <EmptyState
                icon={<HardDrive size={26} />}
                variant={filter === 'all' ? 'first-use' : 'no-results'}
                title={filter === 'all' ? t('admin.sto_empty_title') : t('admin.sto_empty_filter_title')}
                description={filter === 'all' ? t('admin.sto_empty_desc') : t('admin.sto_empty_filter_desc')}
                action={filter === 'all' ? undefined : {
                  label: t('admin.sto_filter_all'), onClick: () => setFilter('all'), variant: 'secondary',
                }}
                t={t}
              />
            )}
          />
  )
}
