/**
 * The parts of `AudiencesSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Users } from "lucide-react"
import { DataTable, EmptyState } from "@ui"
import type { AudiencesSection } from './AudiencesSection'

export function Part1({ rows, columns, isLoading, isError, t, refetch, q, setQ, toolbar, rowActions, go }: { rows: NonNullable<AudiencesSection['rows']>; columns: NonNullable<AudiencesSection['columns']>; isLoading: NonNullable<AudiencesSection['isLoading']>; isError: NonNullable<AudiencesSection['isError']>; t: NonNullable<AudiencesSection['tr']>; refetch: NonNullable<AudiencesSection['refetch']>; q: NonNullable<AudiencesSection['q']>; setQ: NonNullable<AudiencesSection['setQ']>; toolbar: NonNullable<AudiencesSection['toolbar']>; rowActions: NonNullable<AudiencesSection['rowActions']>; go: AudiencesSection['go'] }) {
  return (
    <DataTable
            rows={rows}
            columns={columns}
            rowKey={a => a.id}
            loading={isLoading}
            error={isError ? t('admin.aud_load_failed', { defaultValue: 'Impossible de charger les audiences.' }) : undefined}
            onRetry={() => void refetch()}
            filtered={!!q.trim()}
            onClearFilters={() => setQ('')}
            toolbar={toolbar}
            rowActions={rowActions}
            onRowClick={a => go(a.id)}
            pageSize={25}
            // Without this the table's own chrome — "Rows per page", its empty and
            // error states — stays in English while the rest of the page is not.
            t={t}
            emptyState={
              <EmptyState
                icon={<Users size={26} />}
                variant="first-use"
                title={t('admin.aud_empty', { defaultValue: 'Aucune audience' })}
                description={t('admin.aud_empty_desc', {
                  defaultValue: 'Créez une audience par service ou par site, puis appliquez-la à un module pour qu’elle soit proposée.',
                })}
              />
            }
          />
  )
}
