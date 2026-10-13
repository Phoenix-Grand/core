/**
 * The parts of `SessionsCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { LogOut, MonitorSmartphone } from "lucide-react"
import { DataTable, EmptyState } from "@ui"
import type { SessionsCard } from './SessionsCard'

export function Part1({ t, sessions, columns, isLoading, isError, refetch, askRevoke }: { t: NonNullable<SessionsCard['tr']>; sessions: NonNullable<SessionsCard['sessions']>; columns: NonNullable<SessionsCard['columns']>; isLoading: NonNullable<SessionsCard['isLoading']>; isError: NonNullable<SessionsCard['isError']>; refetch: NonNullable<SessionsCard['refetch']>; askRevoke: SessionsCard['askRevoke'] }) {
  return (
    <DataTable
            t={t}
            rows={sessions}
            columns={columns}
            rowKey={s => s.id}
            loading={isLoading}
            skeletonRows={3}
            error={isError ? t('admin.ud_ses_error') : undefined}
            onRetry={() => void refetch()}
            pageSize={0}
            configurableColumns
            minTableWidth={520}
            className="p-3"
            rowActions={[{
              id:      'revoke',
              label:   t('admin.ud_ses_revoke'),
              icon:    <LogOut size={14} />,
              danger:  true,
              onClick: (s) => void askRevoke(s),
            }]}
            emptyState={(
              <EmptyState
                t={t}
                compact
                variant="first-use"
                icon={<MonitorSmartphone size={22} />}
                title={t('admin.ud_ses_empty')}
                description={t('admin.ud_ses_empty_desc')}
              />
            )}
          />
  )
}
