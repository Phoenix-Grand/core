/**
 * The parts of `AlertsSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { PartyPopper, RefreshCw } from "lucide-react"
import { Button, Combobox, DataTable, EmptyState, MobileSheet, type ComboboxOption } from "@ui"
import { formatWhen } from "../sections/format"
import { adminUrl } from "../adminAction"
import { kindLabel, severityLabel, statusLabel } from "./labels"
import { EMPTY_FILTERS, type AlertFilters } from "./types"
import type { AlertsSection } from './AlertsSection'

function FilterControls({ filters, set, facets, stacked }: {
  filters: AlertFilters
  set:     <K extends keyof AlertFilters>(k: K, v: AlertFilters[K]) => void
  facets:  { kinds: string[]; all_kinds: string[]; assignees: { id: string; label: string }[] } | undefined
  stacked: boolean
}) {
  const { t } = useTranslation()

  const statuses: ComboboxOption[] = [
    { value: '', label: t('admin.al_filter_open') },
    { value: 'new', label: statusLabel(t, 'new') },
    { value: 'acknowledged', label: statusLabel(t, 'acknowledged') },
    { value: 'resolved', label: statusLabel(t, 'resolved') },
    { value: 'ignored', label: statusLabel(t, 'ignored') },
    { value: 'new,acknowledged,resolved,ignored', label: t('admin.al_filter_all_statuses') },
  ]
  const severities: ComboboxOption[] = [
    { value: '', label: t('admin.al_filter_all_severities') },
    { value: 'critical', label: severityLabel(t, 'critical') },
    { value: 'warning', label: severityLabel(t, 'warning') },
    { value: 'info', label: severityLabel(t, 'info') },
  ]
  // The whole catalogue, not only what the instance has already produced: an
  // operator filtering on "module unavailable" wants to know it is empty.
  const kinds: ComboboxOption[] = [
    { value: '', label: t('admin.al_filter_all_kinds') },
    ...(facets?.all_kinds ?? facets?.kinds ?? []).map(k => ({ value: k, label: kindLabel(t, k) })),
  ]
  const assignees: ComboboxOption[] = [
    { value: '', label: t('admin.al_filter_all_assignees') },
    { value: 'me', label: t('admin.al_filter_mine') },
    { value: 'none', label: t('admin.al_filter_unassigned') },
    ...(facets?.assignees ?? []).map(a => ({ value: a.id, label: a.label })),
  ]

  const field = stacked ? 'w-full' : ''
  const dateField = `h-9 rounded-md border border-border bg-surface-0 px-2 text-text-primary ${stacked ? 'w-full' : 'w-[8.5rem]'}`

  return (
    <>
      <Combobox value={filters.status || ''} onChange={v => set('status', v)} options={statuses}
        width={stacked ? undefined : 180} className={field} aria-label={t('admin.al_col_status')} />
      <Combobox value={filters.severity || ''} onChange={v => set('severity', v)} options={severities}
        width={stacked ? undefined : 160} className={field} aria-label={t('admin.al_col_severity')} />
      <Combobox value={filters.kind || ''} onChange={v => set('kind', v)} options={kinds}
        width={stacked ? undefined : 220} className={field} aria-label={t('admin.al_col_kind')} />
      <Combobox value={filters.assignee || ''} onChange={v => set('assignee', v)} options={assignees}
        width={stacked ? undefined : 200} className={field} aria-label={t('admin.al_col_assignee')} />
      <div className={`flex items-center gap-1.5 ${stacked ? 'w-full' : ''}`}>
        <span className="shrink-0 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.al_filter_from')}
        </span>
        <input type="date" aria-label={t('admin.al_filter_from')} value={filters.from}
          onChange={e => set('from', e.target.value)} className={dateField}
          style={{ fontSize: 'var(--kb-text-meta)' }} />
        <span className="shrink-0 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.al_filter_to')}
        </span>
        <input type="date" aria-label={t('admin.al_filter_to')} value={filters.to}
          onChange={e => set('to', e.target.value)} className={dateField}
          style={{ fontSize: 'var(--kb-text-meta)' }} />
      </div>
    </>
  )
}
export { FilterControls }

export function Part1({ rows, columns, isLoading, isError, t, refetch, anyFilter, setFilters, setDraft, toolbar, canManage, selected, setSelected, bulkActions, rowActions, navigate, summary, summary_last_scan_at, i18n, scan, toast }: { rows: NonNullable<AlertsSection['rows']>; columns: NonNullable<AlertsSection['columns']>; isLoading: NonNullable<AlertsSection['isLoading']>; isError: NonNullable<AlertsSection['isError']>; t: NonNullable<AlertsSection['tr']>; refetch: NonNullable<AlertsSection['refetch']>; anyFilter: NonNullable<AlertsSection['anyFilter']>; setFilters: NonNullable<AlertsSection['setFilters']>; setDraft: NonNullable<AlertsSection['setDraft']>; toolbar: NonNullable<AlertsSection['toolbar']>; canManage: NonNullable<AlertsSection['canManage']>; selected: NonNullable<AlertsSection['selected']>; setSelected: NonNullable<AlertsSection['setSelected']>; bulkActions: NonNullable<AlertsSection['bulkActions']>; rowActions: NonNullable<AlertsSection['rowActions']>; navigate: NonNullable<AlertsSection['props']['navigate']>; summary: AlertsSection['summary']; summary_last_scan_at: string; i18n: NonNullable<AlertsSection['i18n']>; scan: NonNullable<AlertsSection['scan']>; toast: NonNullable<AlertsSection['toast']> }) {
  return (
    <DataTable
            rows={rows}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            error={isError ? t('admin.al_error') : undefined}
            onRetry={() => void refetch()}
            filtered={anyFilter}
            onClearFilters={() => { setFilters(EMPTY_FILTERS); setDraft('') }}
            toolbar={toolbar}
            selectable={canManage}
            selectedIds={selected}
            onSelectionChange={setSelected}
            bulkActions={bulkActions}
            rowActions={rowActions}
            onRowClick={r => navigate(adminUrl({ tab: 'alerts', params: { alert: r.id } }))}
            configurableColumns
            pageSize={0}
            t={t}
            emptyState={
              // The ONE empty state worth celebrating — and it says when the
              // instance was last looked at, because silence is only good news
              // when something has been listening.
              <EmptyState
                icon={<PartyPopper size={26} />}
                variant="first-use"
                title={t('admin.al_empty_title')}
                description={
                  summary?.last_scan_at
                    ? t('admin.al_empty_checked', { when: formatWhen(summary_last_scan_at, i18n.language) })
                    : t('admin.al_empty_never_checked')
                }
                action={canManage ? {
                  label: t('admin.al_scan_now'),
                  variant: 'secondary',
                  icon: <RefreshCw size={14} />,
                  onClick: () => scan.mutate(undefined, {
                    onSuccess: () => toast.success(t('admin.al_toast_scanned')),
                    onError:   () => toast.error(t('admin.al_toast_failed')),
                  }),
                } : undefined}
              />
            }
          />
  )
}

export function Part2({ sheet, setSheet, t, filters, set, facets }: { sheet: NonNullable<AlertsSection['sheet']>; setSheet: NonNullable<AlertsSection['setSheet']>; t: NonNullable<AlertsSection['tr']>; filters: NonNullable<AlertsSection['filters']>; set: AlertsSection['set']; facets: AlertsSection['facets'] }) {
  return (
    <MobileSheet open={sheet} onClose={() => setSheet(false)} title={t('admin.al_filters')}>
            <div className="flex flex-col gap-3 px-4 pb-2">
              <FilterControls filters={filters} set={set} facets={facets} stacked />
              <Button variant="secondary" onClick={() => setSheet(false)}>{t('admin.al_filters_apply')}</Button>
            </div>
          </MobileSheet>
  )
}
