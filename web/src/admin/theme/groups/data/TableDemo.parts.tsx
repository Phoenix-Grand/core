/**
 * The parts of `TableDemo.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { DataTable, Input } from "@ui"
import { Ban, Mail, Pencil, Search, Shield, Trash2, UserMinus } from "lucide-react"
import { type DemoMember } from "./fixtures"
import type { TableDemo } from './TableDemo'

export function Part1({ t, rows, columns, state, setState, query, setQuery, selected, setSelected }: { t: NonNullable<TableDemo['tr']>; rows: NonNullable<TableDemo['rows']>; columns: NonNullable<TableDemo['columns']>; state: NonNullable<TableDemo['state']>; setState: NonNullable<TableDemo['setState']>; query: NonNullable<TableDemo['query']>; setQuery: NonNullable<TableDemo['setQuery']>; selected: NonNullable<TableDemo['selected']>; setSelected: NonNullable<TableDemo['setSelected']> }) {
  return (
    <DataTable<DemoMember>
            t={t}
            rows={rows}
            columns={columns}
            rowKey={m => m.id}
            title={t('admin.t_prev_dt_title', { defaultValue: 'Membres de l’organisation' })}
            loading={state === 'loading'}
            error={state === 'error'
              ? t('admin.t_prev_dt_err', { defaultValue: 'Le service d’annuaire n’a pas répondu (504).' })
              : undefined}
            onRetry={() => setState('data')}
            filtered={query.trim().length > 0}
            onClearFilters={() => setQuery('')}
            defaultSort={{ columnId: 'name', direction: 'asc' }}
            pageSize={10}
            selectable
            selectedIds={selected}
            onSelectionChange={setSelected}
            configurableColumns
            toolbar={(
              <div className="max-w-64">
                <Input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  leftIcon={<Search size={14} />}
                  placeholder={t('admin.t_prev_dt_search', { defaultValue: 'Filtrer les membres…' })}
                  aria-label={t('admin.t_prev_dt_search', { defaultValue: 'Filtrer les membres…' })}
                />
              </div>
            )}
            bulkActions={[
              { id: 'mail',    label: t('admin.t_prev_dt_b_mail',    { defaultValue: 'Envoyer un message' }), icon: <Mail size={14} />,      onClick: () => setSelected([]) },
              { id: 'role',    label: t('admin.t_prev_dt_b_role',    { defaultValue: 'Changer de rôle' }),    icon: <Shield size={14} />,    onClick: () => setSelected([]) },
              { id: 'suspend', label: t('admin.t_prev_dt_b_suspend', { defaultValue: 'Suspendre' }),          icon: <Ban size={14} />,       onClick: () => setSelected([]) },
              { id: 'remove',  label: t('admin.t_prev_dt_b_remove',  { defaultValue: 'Retirer de l’unité' }), icon: <UserMinus size={14} />, onClick: () => setSelected([]) },
              { id: 'delete',  label: t('common.delete', { defaultValue: 'Supprimer' }), icon: <Trash2 size={14} />, danger: true, onClick: () => setSelected([]) },
            ]}
            rowActions={[
              { id: 'edit',   label: t('admin.t_prev_dt_a_edit',  { defaultValue: 'Modifier' }), icon: <Pencil size={14} />, onClick: () => {} },
              { id: 'mail',   label: t('admin.t_prev_dt_b_mail',  { defaultValue: 'Envoyer un message' }), icon: <Mail size={14} />, onClick: () => {} },
              { id: 'delete', label: t('common.delete', { defaultValue: 'Supprimer' }), icon: <Trash2 size={14} />, danger: true, onClick: () => {} },
            ]}
          />
  )
}
