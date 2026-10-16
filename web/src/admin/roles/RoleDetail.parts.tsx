/**
 * The parts of `RoleDetail.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Building2, Clock, Globe2, Trash2, UserPlus, Users } from "lucide-react"
import { DataTable, EmptyState } from "@ui"
import { type RoleAssignment } from "../../core/authz/types"
import type { RoleDetail } from './RoleDetail'

export function Part1({ assignments, isLoading, t, canGrant, setAssignOpen, when, askRevoke }: { assignments: RoleDetail['assignments']; isLoading: NonNullable<RoleDetail['isLoading']>; t: NonNullable<RoleDetail['tr']>; canGrant: NonNullable<RoleDetail['canGrant']>; setAssignOpen: NonNullable<RoleDetail['setAssignOpen']>; when: RoleDetail['when']; askRevoke: RoleDetail['askRevoke'] }) {
  return (
    <DataTable<RoleAssignment>
                  rows={assignments ?? []}
                  rowKey={a => a.id}
                  loading={isLoading}
                  pageSize={10}
                  emptyState={
                    <EmptyState
                      variant="first-use"
                      icon={<UserPlus />}
                      title={t('admin.assign_empty_title')}
                      description={t('admin.assign_empty_desc')}
                      action={canGrant ? { label: t('admin.assign_title'), onClick: () => setAssignOpen(true) } : undefined}
                      t={t}
                    />
                  }
                  columns={[
                    {
                      id: 'subject', header: t('admin.assign_subject'), primary: true, required: true,
                      sortValue: a => a.subject_label ?? '',
                      cell: a => (
                        <span className="flex items-center gap-2 min-w-0">
                          {a.subject_group_id
                            ? <Building2 size={15} className="text-text-tertiary shrink-0" />
                            : <Users size={15} className="text-text-tertiary shrink-0" />}
                          <span className="truncate text-text-primary">{a.subject_label ?? '-'}</span>
                        </span>
                      ),
                    },
                    {
                      id: 'scope', header: t('admin.assign_scope'),
                      sortValue: a => a.scope,
                      cell: a => (
                        a.scope === 'instance' ? (
                          <span className="inline-flex items-center gap-1 text-sm text-text-secondary">
                            <Globe2 size={13} />{t('admin.assign_scope_instance')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-sm text-text-secondary">
                            <Building2 size={13} />{a.scope_org_unit_name ?? '-'}
                          </span>
                        )
                      ),
                    },
                    {
                      id: 'expires', header: t('admin.assign_expiry'),
                      sortValue: a => a.expires_at ?? '',
                      cell: a => (
                        a.expires_at ? (
                          <span className="inline-flex items-center gap-1 text-sm text-text-secondary">
                            <Clock size={13} />{when(a.expires_at)}
                          </span>
                        ) : <span className="text-sm text-text-tertiary">{t('admin.assign_expiry_never')}</span>
                      ),
                    },
                    {
                      id: 'created', header: t('admin.assign_granted_on'), defaultHidden: true,
                      sortValue: a => a.created_at,
                      cell: a => <span className="text-sm text-text-secondary">{when(a.created_at)}</span>,
                    },
                  ]}
                  rowActions={[
                    {
                      id: 'revoke', label: t('admin.assign_revoke'), icon: <Trash2 size={15} />, danger: true,
                      hidden: () => !canGrant,
                      onClick: askRevoke,
                    },
                  ]}
                  configurableColumns
                  t={t}
                />
  )
}
