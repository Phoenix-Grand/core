/**
 * The parts of `RulesSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ListChecks, Plus } from "lucide-react"
import { DataTable, EmptyState } from "@ui"
import { adminUrl } from "../adminAction"
import type { RulesSection } from './RulesSection'

export function Part1({ rows, columns, isLoading, isError, t, refetch, anyFilter, setQ, setModeFilter, setModuleFilter, toolbar, rowActions, navigate, canWrite }: { rows: NonNullable<RulesSection['rows']>; columns: NonNullable<RulesSection['columns']>; isLoading: NonNullable<RulesSection['isLoading']>; isError: NonNullable<RulesSection['isError']>; t: NonNullable<RulesSection['tr']>; refetch: NonNullable<RulesSection['refetch']>; anyFilter: NonNullable<RulesSection['anyFilter']>; setQ: NonNullable<RulesSection['setQ']>; setModeFilter: NonNullable<RulesSection['setModeFilter']>; setModuleFilter: NonNullable<RulesSection['setModuleFilter']>; toolbar: NonNullable<RulesSection['toolbar']>; rowActions: NonNullable<RulesSection['rowActions']>; navigate: NonNullable<RulesSection['props']['navigate']>; canWrite: NonNullable<RulesSection['canWrite']> }) {
  return (
    <DataTable
            rows={rows}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            error={isError ? t('admin.rl_list_error') : undefined}
            onRetry={() => void refetch()}
            filtered={anyFilter}
            onClearFilters={() => { setQ(''); setModeFilter(''); setModuleFilter('') }}
            toolbar={toolbar}
            rowActions={rowActions}
            onRowClick={r => navigate(adminUrl({ tab: 'rules', params: { rule: r.id } }))}
            configurableColumns
            pageSize={25}
            t={t}
            emptyState={
              <EmptyState
                icon={<ListChecks size={26} />}
                variant="first-use"
                title={t('admin.rl_empty_title')}
                description={t('admin.rl_empty_desc')}
                action={canWrite ? {
                  label: t('admin.rl_new'),
                  icon: <Plus size={14} />,
                  onClick: () => navigate(adminUrl({ tab: 'rules', params: { new: 1 } })),
                } : undefined}
              />
            }
          />
  )
}
