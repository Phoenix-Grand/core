/**
 * The parts of `DomainsSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Globe, Plus } from "lucide-react"
import { Button, DataTable, EmptyState } from "@ui"
import { type Domain } from "./api"
import type { DomainsSection } from './DomainsSection'

function Figure({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="flex min-w-24 flex-col">
      <span className="text-text-primary" style={{ fontSize: 'var(--kb-text-section)' }}>{value}</span>
      <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-small)' }}>{label}</span>
    </div>
  )
}
export { Figure }

export function Part1({ setAdding, t }: { setAdding: NonNullable<DomainsSection['setAdding']>; t: NonNullable<DomainsSection['tr']> }) {
  return (
    <Button variant="primary" onClick={() => setAdding(true)}>
                    <Plus size={16} /> {t('admin.dom_add')}
                  </Button>
  )
}

export function Part2({ t, domains, columns, isLoading, rowActions, open, isError, refetch, canManage, setAdding }: { t: NonNullable<DomainsSection['tr']>; domains: NonNullable<DomainsSection['domains']>; columns: NonNullable<DomainsSection['columns']>; isLoading: NonNullable<DomainsSection['isLoading']>; rowActions: NonNullable<DomainsSection['rowActions']>; open: DomainsSection['open']; isError: NonNullable<DomainsSection['isError']>; refetch: NonNullable<DomainsSection['refetch']>; canManage: NonNullable<DomainsSection['canManage']>; setAdding: NonNullable<DomainsSection['setAdding']> }) {
  return (
    <DataTable<Domain>
            t={t}
            rows={domains}
            columns={columns}
            rowKey={r => r.id}
            loading={isLoading}
            rowActions={rowActions}
            onRowClick={r => open(r.id)}
            pageSize={0}
            error={isError ? t('admin.dom_load_failed') : undefined}
            onRetry={() => void refetch()}
            emptyState={
              <EmptyState
                icon={<Globe size={26} />}
                title={t('admin.dom_empty_title')}
                description={t('admin.dom_empty_desc')}
                action={canManage ? { label: t('admin.dom_add'), onClick: () => setAdding(true), variant: 'primary' } : undefined}
                t={t}
              />
            }
          />
  )
}
