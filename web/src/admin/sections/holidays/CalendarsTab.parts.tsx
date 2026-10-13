/**
 * The parts of `CalendarsTab.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Globe, Plus, Search } from "lucide-react"
import { Button, DataTable, EmptyState, Input } from "@ui"
import { type CalendarSummary } from "./api"
import type { CalendarsTab } from './CalendarsTab'

export function Part1({ search, setSearch, t }: { search: NonNullable<CalendarsTab['search']>; setSearch: NonNullable<CalendarsTab['setSearch']>; t: NonNullable<CalendarsTab['tr']> }) {
  return (
    <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('admin.hol_search_ph')}
              leftIcon={<Search size={16} />}
              className="w-full sm:w-80"
            />
  )
}

export function Part2({ setCreating, t }: { setCreating: NonNullable<CalendarsTab['setCreating']>; t: NonNullable<CalendarsTab['tr']> }) {
  return (
    <Button variant="secondary" onClick={() => setCreating(true)}>
                  <Plus size={16} /> {t('admin.hol_new_calendar')}
                </Button>
  )
}

export function Part3({ t, data, columns, isLoading, rowActions, onOpen, isError, refetch, search, countriesOnly, setSearch, setCountriesOnly }: { t: NonNullable<CalendarsTab['tr']>; data: CalendarsTab['data']; columns: NonNullable<CalendarsTab['columns']>; isLoading: NonNullable<CalendarsTab['isLoading']>; rowActions: NonNullable<CalendarsTab['rowActions']>; onOpen: NonNullable<CalendarsTab['props']['onOpen']>; isError: NonNullable<CalendarsTab['isError']>; refetch: NonNullable<CalendarsTab['refetch']>; search: NonNullable<CalendarsTab['search']>; countriesOnly: NonNullable<CalendarsTab['countriesOnly']>; setSearch: NonNullable<CalendarsTab['setSearch']>; setCountriesOnly: NonNullable<CalendarsTab['setCountriesOnly']> }) {
  return (
    <DataTable<CalendarSummary>
            t={t}
            rows={data ?? []}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            rowActions={rowActions}
            onRowClick={r => onOpen(r.id)}
            error={isError ? t('admin.hol_load_failed') : undefined}
            onRetry={() => void refetch()}
            filtered={search !== '' || countriesOnly}
            onClearFilters={() => { setSearch(''); setCountriesOnly(false) }}
            emptyState={
              <EmptyState
                icon={<Globe size={26} />}
                title={t('admin.hol_empty_title')}
                description={t('admin.hol_empty_desc')}
                t={t}
              />
            }
          />
  )
}
