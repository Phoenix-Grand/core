/**
 * The parts of `NetworksSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Globe2 } from "lucide-react"
import { DataTable, EmptyState } from "@ui"
import { EMPTY_SESSION_FILTERS } from "../../core/devices/types"
import type { NetworksSection } from './NetworksSection'

export function Part1({ origins, set, t }: { origins: NonNullable<NetworksSection['origins']>; set: NetworksSection['set']; t: NonNullable<NetworksSection['tr']> }) {
  return (
    <>{origins.map(([code, count]) => (
                <button key={code || 'unknown'} type="button"
                  onClick={() => set('country', code)}
                  className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-0.5
                             text-text-secondary hover:text-text-primary
                             focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  style={{ fontSize: 'var(--kb-text-meta)' }}>
                  {code || t('devices.country_unknown')}
                  <span className="tabular-nums text-text-tertiary">{count}</span>
                </button>
              ))}</>
  )
}

export function Part2({ rows, columns, isLoading, isError, t, refetch, anyFilter, setFilters, setDraft, toolbar, toast }: { rows: NonNullable<NetworksSection['rows']>; columns: NonNullable<NetworksSection['columns']>; isLoading: NonNullable<NetworksSection['isLoading']>; isError: NonNullable<NetworksSection['isError']>; t: NonNullable<NetworksSection['tr']>; refetch: NonNullable<NetworksSection['refetch']>; anyFilter: NonNullable<NetworksSection['anyFilter']>; setFilters: NonNullable<NetworksSection['setFilters']>; setDraft: NonNullable<NetworksSection['setDraft']>; toolbar: NonNullable<NetworksSection['toolbar']>; toast: NonNullable<NetworksSection['toast']> }) {
  return (
    <DataTable
            rows={rows}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            error={isError ? t('devices.error') : undefined}
            onRetry={() => void refetch()}
            filtered={anyFilter}
            onClearFilters={() => { setFilters(EMPTY_SESSION_FILTERS); setDraft('') }}
            toolbar={toolbar}
            configurableColumns
            pageSize={25}
            t={t}
            emptyState={
              <EmptyState
                icon={<Globe2 size={26} />}
                variant="first-use"
                title={t('devices.sessions_empty_title')}
                description={t('devices.sessions_empty_body')}
                action={{
                  label: t('devices.retry'),
                  variant: 'secondary',
                  onClick: () => {
                    void refetch()
                    toast.success(t('devices.sessions_refreshed'))
                  },
                }}
              />
            }
          />
  )
}
