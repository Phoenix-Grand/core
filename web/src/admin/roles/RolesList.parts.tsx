/**
 * The parts of `RolesList.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Pencil, Plus, Trash2, UserCog, UserPlus } from "lucide-react"
import { Button, DataTable, EmptyState, Input } from "@ui"
import { type Role } from "../../core/authz/types"
import { adminUrl } from "../adminAction"
import RoleIcon from "./RoleIcon"
import DelegabilityChip from "./DelegabilityChip"
import type { RolesList } from './RolesList'

function TypeBadge({ role }: { role: Role }) {
  const { t } = useTranslation()
  const [label, cls] = role.is_superuser
    ? [t('admin.role_type_superuser'), 'bg-danger-light text-danger']
    : role.is_system
      ? [t('admin.roles_system'), 'bg-surface-2 text-text-secondary']
      : [t('admin.role_type_custom'), 'bg-primary-light text-primary']
  return <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>{label}</span>
}
export { TypeBadge }

export function Part1({ rows, loading, error, onRetry, q, setQ, t, isSuperuser, setCreating, roleName, roleDescription, canGrant, setAssign, openRole, askDelete }: { rows: NonNullable<RolesList['rows']>; loading: NonNullable<RolesList['props']['loading']>; error: RolesList['props']['error']; onRetry: RolesList['props']['onRetry']; q: NonNullable<RolesList['q']>; setQ: NonNullable<RolesList['setQ']>; t: NonNullable<RolesList['tr']>; isSuperuser: NonNullable<RolesList['isSuperuser']>; setCreating: NonNullable<RolesList['setCreating']>; roleName: NonNullable<RolesList['roleName']>; roleDescription: NonNullable<RolesList['roleDescription']>; canGrant: NonNullable<RolesList['canGrant']>; setAssign: NonNullable<RolesList['setAssign']>; openRole: RolesList['openRole']; askDelete: RolesList['askDelete'] }) {
  return (
    <DataTable<Role>
            rows={rows}
            rowKey={r => r.id}
            loading={loading}
            error={error}
            onRetry={onRetry}
            filtered={!!q.trim()}
            onClearFilters={() => setQ('')}
            title={t('admin.roles_title')}
            toolbar={
              <div className="flex items-center gap-3 flex-wrap">
                <Input
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder={t('admin.roles_search_ph')}
                  className="w-56"
                />
                {isSuperuser && (
                  <Button size="sm" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
                    {t('admin.roles_create')}
                  </Button>
                )}
              </div>
            }
            emptyState={
              <EmptyState
                variant="first-use"
                icon={<UserCog />}
                title={t('admin.roles_empty_title')}
                description={t('admin.roles_empty_desc')}
                action={isSuperuser ? { label: t('admin.roles_create'), onClick: () => setCreating(true) } : undefined}
                t={t}
              />
            }
            columns={[
              {
                id: 'name', header: t('admin.roles_col_role'), primary: true, required: true,
                sortValue: r => roleName(r),
                cell: r => (
                  <Link to={adminUrl({ tab: 'admin-roles', params: { role: r.id } })} className="flex items-center gap-2 text-primary hover:underline">
                    <RoleIcon role={r} />
                    <span className="truncate">{roleName(r)}</span>
                  </Link>
                ),
              },
              {
                id: 'description', header: t('admin.roles_col_desc'), minWidth: 220,
                cell: r => <span className="text-text-secondary">{roleDescription(r) ?? '-'}</span>,
              },
              { id: 'type', header: t('admin.roles_col_type'), sortValue: r => r.slug, cell: r => <TypeBadge role={r} /> },
              { id: 'scope', header: t('admin.roles_col_scope'), cell: r => <DelegabilityChip role={r} /> },
              {
                id: 'privileges', header: t('admin.roles_privileges'), align: 'right',
                sortValue: r => (r.is_superuser ? Number.MAX_SAFE_INTEGER : r.privileges.length),
                cell: r => (
                  <span className="tabular-nums text-text-secondary">
                    {r.is_superuser ? t('admin.roles_all_privileges_short') : r.privileges.length}
                  </span>
                ),
              },
              {
                id: 'assignments', header: t('admin.roles_col_assignments'), align: 'right',
                sortValue: r => r.assignment_count,
                cell: r => <span className="tabular-nums text-text-secondary">{r.assignment_count}</span>,
              },
            ]}
            rowActions={[
              {
                id: 'assign', label: t('admin.assign_title'), icon: <UserPlus size={15} />,
                hidden: () => !canGrant,
                onClick: setAssign,
              },
              {
                id: 'edit', label: t('admin.role_edit'), icon: <Pencil size={15} />,
                hidden: () => !isSuperuser,
                // Opens the sheet: the role's name, description and privileges are
                // edited in the cards that show them, not in a form of their own.
                onClick: openRole,
              },
              {
                id: 'delete', label: t('common.delete'), icon: <Trash2 size={15} />, danger: true,
                hidden: r => !isSuperuser || r.is_system,
                onClick: askDelete,
              },
            ]}
            t={t}
          />
  )
}
