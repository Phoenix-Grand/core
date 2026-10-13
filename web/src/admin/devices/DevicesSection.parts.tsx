/**
 * The parts of `DevicesSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { MonitorSmartphone } from "lucide-react"
import { Button, Combobox, DataTable, EmptyState, MobileSheet, type ComboboxOption } from "@ui"
import { adminUrl } from "../adminAction"
import { approvalLabel, deviceTypeLabel } from "../../core/devices/labels"
import { EMPTY_DEVICE_FILTERS, type DeviceFilters } from "../../core/devices/types"
import type { DevicesSection } from './DevicesSection'

function FilterControls({ filters, set, facets, stacked }: {
  filters: DeviceFilters
  set:     <K extends keyof DeviceFilters>(k: K, v: DeviceFilters[K]) => void
  facets:  { platforms: string[]; countries: string[]; device_types: string[] } | undefined
  stacked: boolean
}) {
  const { t } = useTranslation()

  const types: ComboboxOption[] = [
    { value: '', label: t('devices.filter_all_types') },
    ...(facets?.device_types ?? []).map(v => ({ value: v, label: deviceTypeLabel(t, v) })),
  ]
  const platforms: ComboboxOption[] = [
    { value: '', label: t('devices.filter_all_platforms') },
    ...(facets?.platforms ?? []).map(v => ({ value: v, label: v })),
  ]
  const approvals: ComboboxOption[] = [
    { value: '', label: t('devices.filter_all_approvals') },
    { value: 'pending', label: approvalLabel(t, 'pending') },
    { value: 'approved', label: approvalLabel(t, 'approved') },
    { value: 'blocked', label: approvalLabel(t, 'blocked') },
  ]
  const countries: ComboboxOption[] = [
    { value: '', label: t('devices.filter_all_countries') },
    ...(facets?.countries ?? []).map(v => ({ value: v, label: v })),
  ]
  const seen: ComboboxOption[] = [
    { value: '', label: t('devices.filter_any_time') },
    { value: '1', label: t('devices.filter_seen_1') },
    { value: '7', label: t('devices.filter_seen_7') },
    { value: '30', label: t('devices.filter_seen_30') },
    { value: '90', label: t('devices.filter_seen_90') },
  ]

  const field = stacked ? 'w-full' : ''

  return (
    <>
      <Combobox value={filters.device_type} onChange={v => set('device_type', v)} options={types}
        width={stacked ? undefined : 150} className={field} aria-label={t('devices.col_type')} />
      <Combobox value={filters.platform} onChange={v => set('platform', v)} options={platforms}
        width={stacked ? undefined : 160} className={field} aria-label={t('devices.col_platform')} />
      <Combobox value={filters.approval} onChange={v => set('approval', v)} options={approvals}
        width={stacked ? undefined : 160} className={field} aria-label={t('devices.col_approval')} />
      <Combobox value={filters.country} onChange={v => set('country', v)} options={countries}
        width={stacked ? undefined : 130} className={field} aria-label={t('devices.col_country')} />
      <Combobox value={filters.seen_days} onChange={v => set('seen_days', v)} options={seen}
        width={stacked ? undefined : 170} className={field} aria-label={t('devices.col_last_seen')} />
    </>
  )
}
export { FilterControls }

export function Part1({ rows, columns, isLoading, isError, t, refetch, anyFilter, setFilters, setDraft, toolbar, rowActions, navigate }: { rows: NonNullable<DevicesSection['rows']>; columns: NonNullable<DevicesSection['columns']>; isLoading: NonNullable<DevicesSection['isLoading']>; isError: NonNullable<DevicesSection['isError']>; t: NonNullable<DevicesSection['tr']>; refetch: NonNullable<DevicesSection['refetch']>; anyFilter: NonNullable<DevicesSection['anyFilter']>; setFilters: NonNullable<DevicesSection['setFilters']>; setDraft: NonNullable<DevicesSection['setDraft']>; toolbar: NonNullable<DevicesSection['toolbar']>; rowActions: NonNullable<DevicesSection['rowActions']>; navigate: NonNullable<DevicesSection['props']['navigate']> }) {
  return (
    <DataTable
            rows={rows}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            error={isError ? t('devices.error') : undefined}
            onRetry={() => void refetch()}
            filtered={anyFilter}
            onClearFilters={() => { setFilters(EMPTY_DEVICE_FILTERS); setDraft('') }}
            toolbar={toolbar}
            rowActions={rowActions}
            onRowClick={r => navigate(adminUrl({ tab: 'device-sessions', params: { device: r.id } }))}
            configurableColumns
            pageSize={25}
            t={t}
            emptyState={
              <EmptyState
                icon={<MonitorSmartphone size={26} />}
                variant="first-use"
                title={t('devices.empty_title')}
                description={t('devices.empty_body')}
              />
            }
          />
  )
}

export function Part2({ sheet, setSheet, t, filters, set, facets }: { sheet: NonNullable<DevicesSection['sheet']>; setSheet: NonNullable<DevicesSection['setSheet']>; t: NonNullable<DevicesSection['tr']>; filters: NonNullable<DevicesSection['filters']>; set: DevicesSection['set']; facets: DevicesSection['facets'] }) {
  return (
    <MobileSheet open={sheet} onClose={() => setSheet(false)} title={t('devices.filters')}>
            <div className="flex flex-col gap-3 px-4 pb-2">
              <FilterControls filters={filters} set={set} facets={facets} stacked />
              <Button variant="secondary" onClick={() => setSheet(false)}>{t('devices.filters_apply')}</Button>
            </div>
          </MobileSheet>
  )
}
