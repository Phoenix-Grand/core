/**
 * The parts of `CalendarDetail.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { CalendarDays, Plus } from "lucide-react"
import { Button, DataTable, EmptyState } from "@ui"
import { type Holiday } from "./api"
import type { CalendarDetail } from './CalendarDetail'

export function Part1({ setEditing, t }: { setEditing: NonNullable<CalendarDetail['setEditing']>; t: NonNullable<CalendarDetail['tr']> }) {
  return (
    <Button variant="secondary" onClick={() => setEditing('new')}>
                  <Plus size={16} /> {t('admin.hol_new_day')}
                </Button>
  )
}

export function Part2({ t, data, columns, isLoading, rowActions, isError, refetch }: { t: NonNullable<CalendarDetail['tr']>; data: CalendarDetail['data']; columns: NonNullable<CalendarDetail['columns']>; isLoading: NonNullable<CalendarDetail['isLoading']>; rowActions: NonNullable<CalendarDetail['rowActions']>; isError: NonNullable<CalendarDetail['isError']>; refetch: NonNullable<CalendarDetail['refetch']> }) {
  return (
    <DataTable<Holiday>
            t={t}
            rows={data?.holidays ?? []}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            rowActions={rowActions}
            error={isError ? t('admin.hol_load_failed') : undefined}
            onRetry={() => void refetch()}
            pageSize={0}
            emptyState={
              <EmptyState
                icon={<CalendarDays size={26} />}
                title={t('admin.hol_no_days_title')}
                description={t('admin.hol_no_days_desc')}
                t={t}
              />
            }
          />
  )
}
