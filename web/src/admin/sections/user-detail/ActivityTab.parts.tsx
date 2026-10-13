/**
 * The parts of `ActivityTab.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { History } from "lucide-react"
import { DataTable, EmptyState } from "@ui"
import type { ActivityTab } from './ActivityTab'

export function Part1({ t, rows, columns, isLoading, isError, asTarget, asActor }: { t: NonNullable<ActivityTab['tr']>; rows: NonNullable<ActivityTab['rows']>; columns: NonNullable<ActivityTab['columns']>; isLoading: NonNullable<ActivityTab['isLoading']>; isError: NonNullable<ActivityTab['isError']>; asTarget: NonNullable<ActivityTab['asTarget']>; asActor: NonNullable<ActivityTab['asActor']> }) {
  return (
    <DataTable
            t={t}
            rows={rows}
            columns={columns}
            rowKey={e => String(e.id)}
            loading={isLoading}
            error={isError ? t('admin.ud_act_error') : undefined}
            onRetry={() => { void asTarget.refetch(); void asActor.refetch() }}
            defaultSort={{ columnId: 'when', direction: 'desc' }}
            pageSize={25}
            pageSizeOptions={[10, 25, 50]}
            configurableColumns
            minTableWidth={760}
            className="p-3"
            emptyState={(
              <EmptyState
                t={t}
                compact
                variant="first-use"
                icon={<History size={22} />}
                title={t('admin.ud_act_empty')}
                description={t('admin.ud_act_empty_desc')}
              />
            )}
          />
  )
}
