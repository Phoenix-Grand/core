/**
 * The parts of `FeaturesTab.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Plus, Sparkles } from "lucide-react"
import { Button, DataTable, EmptyState } from "@ui"
import type { FeaturesTab } from './FeaturesTab'

export function Part1({ data, columns, isLoading, isError, t, refetch, rowActions, canManage, setEditing }: { data: FeaturesTab['data']; columns: NonNullable<FeaturesTab['columns']>; isLoading: NonNullable<FeaturesTab['isLoading']>; isError: NonNullable<FeaturesTab['isError']>; t: NonNullable<FeaturesTab['tr']>; refetch: NonNullable<FeaturesTab['refetch']>; rowActions: NonNullable<FeaturesTab['rowActions']>; canManage: NonNullable<FeaturesTab['props']['canManage']>; setEditing: NonNullable<FeaturesTab['setEditing']> }) {
  return (
    <DataTable
            rows={data?.features ?? []}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            error={isError ? t('admin.res_load_failed') : undefined}
            onRetry={() => void refetch()}
            rowActions={rowActions}
            onRowClick={canManage ? r => setEditing(r) : undefined}
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
                  {t('admin.res_feature_new')}
                </Button>
              )
              : undefined}
            emptyState={(
              <EmptyState
                icon={<Sparkles size={26} />}
                variant="first-use"
                title={t('admin.res_features_empty_title')}
                description={t('admin.res_features_empty_desc')}
                action={canManage
                  ? { label: t('admin.res_feature_new'), onClick: () => setEditing('new') }
                  : undefined}
                t={t}
              />
            )}
          />
  )
}
