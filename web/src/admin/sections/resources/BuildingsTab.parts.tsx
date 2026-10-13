/**
 * The parts of `BuildingsTab.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Building2, Plus } from "lucide-react"
import { Button, DataTable, EmptyState } from "@ui"
import type { BuildingsTab } from './BuildingsTab'

export function Part1({ rows, columns, isLoading, isError, t, refetch, rowActions, canManage, setEditing }: { rows: NonNullable<BuildingsTab['rows']>; columns: NonNullable<BuildingsTab['columns']>; isLoading: NonNullable<BuildingsTab['isLoading']>; isError: NonNullable<BuildingsTab['isError']>; t: NonNullable<BuildingsTab['tr']>; refetch: NonNullable<BuildingsTab['refetch']>; rowActions: NonNullable<BuildingsTab['rowActions']>; canManage: NonNullable<BuildingsTab['props']['canManage']>; setEditing: NonNullable<BuildingsTab['setEditing']> }) {
  return (
    <DataTable
            rows={rows}
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
                  {t('admin.res_building_new')}
                </Button>
              )
              : undefined}
            emptyState={(
              <EmptyState
                icon={<Building2 size={26} />}
                variant="first-use"
                title={t('admin.res_buildings_empty_title')}
                description={t('admin.res_buildings_empty_desc')}
                action={canManage
                  ? { label: t('admin.res_building_new'), onClick: () => setEditing('new') }
                  : undefined}
                t={t}
              />
            )}
          />
  )
}
