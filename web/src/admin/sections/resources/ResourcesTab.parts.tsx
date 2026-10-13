/**
 * The parts of `ResourcesTab.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { CalendarRange, Plus } from "lucide-react"
import { Button, DataTable, EmptyState } from "@ui"
import type { ResourcesTab } from './ResourcesTab'

export function Part1({ data, columns, isLoading, isError, t, refetch, rowActions, canManage, setEditing }: { data: ResourcesTab['data']; columns: NonNullable<ResourcesTab['columns']>; isLoading: NonNullable<ResourcesTab['isLoading']>; isError: NonNullable<ResourcesTab['isError']>; t: NonNullable<ResourcesTab['tr']>; refetch: NonNullable<ResourcesTab['refetch']>; rowActions: NonNullable<ResourcesTab['rowActions']>; canManage: NonNullable<ResourcesTab['props']['canManage']>; setEditing: NonNullable<ResourcesTab['setEditing']> }) {
  return (
    <DataTable
            rows={data?.resources ?? []}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            error={isError ? t('admin.res_load_failed') : undefined}
            onRetry={() => void refetch()}
            rowActions={rowActions}
            onRowClick={canManage ? r => setEditing(r) : undefined}
            configurableColumns
            pageSize={0}
            t={t}
            toolbar={canManage
              ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus size={14} />}
                  onClick={() => setEditing('new')}
                >
                  {t('admin.res_resource_new')}
                </Button>
              )
              : undefined}
            emptyState={(
              <EmptyState
                icon={<CalendarRange size={26} />}
                variant="first-use"
                title={t('admin.res_resources_empty_title')}
                description={t('admin.res_resources_empty_desc')}
                action={canManage
                  ? { label: t('admin.res_resource_new'), onClick: () => setEditing('new') }
                  : undefined}
                t={t}
              />
            )}
          />
  )
}
