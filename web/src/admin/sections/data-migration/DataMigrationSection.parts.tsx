/**
 * The parts of `DataMigrationSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Plus, ServerCog } from "lucide-react"
import { Button, DataTable, EmptyState } from "@ui"
import { type Campaign } from "./api"
import type { DataMigrationSection } from './DataMigrationSection'

export function Part1({ noService, setComposing, t }: { noService: NonNullable<DataMigrationSection['noService']>; setComposing: NonNullable<DataMigrationSection['setComposing']>; t: NonNullable<DataMigrationSection['tr']> }) {
  return (
    <Button variant="primary" disabled={noService} onClick={() => setComposing(true)}>
                <Plus size={16} /> {t('admin.migr_new')}
              </Button>
  )
}

export function Part2({ t, campaigns, columns, isLoading, rowActions, open, isError, refetch, canManage, noService, setComposing }: { t: NonNullable<DataMigrationSection['tr']>; campaigns: NonNullable<DataMigrationSection['campaigns']>; columns: NonNullable<DataMigrationSection['columns']>; isLoading: NonNullable<DataMigrationSection['isLoading']>; rowActions: NonNullable<DataMigrationSection['rowActions']>; open: DataMigrationSection['open']; isError: NonNullable<DataMigrationSection['isError']>; refetch: NonNullable<DataMigrationSection['refetch']>; canManage: NonNullable<DataMigrationSection['canManage']>; noService: NonNullable<DataMigrationSection['noService']>; setComposing: NonNullable<DataMigrationSection['setComposing']> }) {
  return (
    <DataTable<Campaign>
            t={t}
            rows={campaigns}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            rowActions={rowActions}
            onRowClick={r => open(r.id)}
            pageSize={0}
            error={isError ? t('admin.migr_load_failed') : undefined}
            onRetry={() => void refetch()}
            emptyState={
              <EmptyState
                icon={<ServerCog size={26} />}
                title={t('admin.migr_empty_title')}
                description={t('admin.migr_empty_desc')}
                action={canManage && !noService
                  ? { label: t('admin.migr_new'), onClick: () => setComposing(true), variant: 'primary' }
                  : undefined}
                t={t}
              />
            }
          />
  )
}
