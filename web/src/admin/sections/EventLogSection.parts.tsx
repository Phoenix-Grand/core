/**
 * The parts of `EventLogSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Activity } from "lucide-react"
import { Combobox, DataTable, EmptyState } from "@ui"
import type { EventLogSection } from './EventLogSection'

export function Part1({ t, type, setType, typeOptions }: { t: NonNullable<EventLogSection['tr']>; type: NonNullable<EventLogSection['type']>; setType: NonNullable<EventLogSection['setType']>; typeOptions: NonNullable<EventLogSection['typeOptions']> }) {
  return (
    <Combobox
                  t={t}
                  value={type || ''}
                  onChange={setType}
                  options={typeOptions}
                  width={260}
                  aria-label={t('admin.el_filter_type')}
                  placeholder={t('admin.el_filter_all_types')}
                  searchPlaceholder={t('admin.el_filter_type')}
                />
  )
}

export function Part2({ t, rows, columns, isLoading, isError, refetch, type, setType }: { t: NonNullable<EventLogSection['tr']>; rows: NonNullable<EventLogSection['rows']>; columns: NonNullable<EventLogSection['columns']>; isLoading: NonNullable<EventLogSection['isLoading']>; isError: NonNullable<EventLogSection['isError']>; refetch: NonNullable<EventLogSection['refetch']>; type: NonNullable<EventLogSection['type']>; setType: NonNullable<EventLogSection['setType']> }) {
  return (
    <DataTable
                t={t}
                rows={rows}
                columns={columns}
                rowKey={e => String(e.id)}
                loading={isLoading}
                skeletonRows={8}
                error={isError ? t('admin.el_error') : undefined}
                onRetry={() => void refetch()}
                filtered={Boolean(type)}
                onClearFilters={() => setType('')}
                // The server already returns newest-first and paginates; sorting or
                // paging locally would only reorder the window that happens to be
                // loaded and would silently contradict the "load more" below.
                manualSort
                pageSize={0}
                configurableColumns
                minTableWidth={820}
                emptyState={(
                  <EmptyState
                    t={t}
                    variant="first-use"
                    icon={<Activity size={24} />}
                    title={t('admin.el_empty')}
                    description={t('admin.el_empty_desc')}
                  />
                )}
              />
  )
}
