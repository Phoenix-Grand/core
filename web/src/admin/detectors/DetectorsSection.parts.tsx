/**
 * The parts of `DetectorsSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Plus, SearchCheck } from "lucide-react"
import { Button, DataTable, EmptyState } from "@ui"
import type { DetectorsSection } from './DetectorsSection'

export function Part1({ rows, columns, isLoading, isError, t, refetch, rowActions, setEditing, canManage }: { rows: NonNullable<DetectorsSection['rows']>; columns: NonNullable<DetectorsSection['columns']>; isLoading: NonNullable<DetectorsSection['isLoading']>; isError: NonNullable<DetectorsSection['isError']>; t: NonNullable<DetectorsSection['tr']>; refetch: NonNullable<DetectorsSection['refetch']>; rowActions: NonNullable<DetectorsSection['rowActions']>; setEditing: NonNullable<DetectorsSection['setEditing']>; canManage: NonNullable<DetectorsSection['canManage']> }) {
  return (
    <DataTable
              rows={rows}
              columns={columns}
              rowKey={r => r.id}
              loading={isLoading}
              error={isError ? t('admin.det_load_failed') : undefined}
              onRetry={() => void refetch()}
              rowActions={rowActions}
              onRowClick={r => setEditing(r.id)}
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
                    {t('admin.det_new')}
                  </Button>
                )
                : undefined}
              emptyState={(
                <EmptyState
                  icon={<SearchCheck size={26} />}
                  variant="first-use"
                  title={t('admin.det_empty_title')}
                  description={t('admin.det_empty_desc')}
                  action={canManage
                    ? { label: t('admin.det_new'), onClick: () => setEditing('new') }
                    : undefined}
                  t={t}
                />
              )}
            />
  )
}
