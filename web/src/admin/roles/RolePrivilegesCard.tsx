import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Callout } from '@ui'
import type { Privilege, Role } from '../../core/authz/types'
import EditableCard from '../inline-edit/EditableCard'
import PrivilegeList from './PrivilegeList'
import { errorMessage, useUpdateRole } from './api'

/**
 * What the role grants — picked where it is read.
 *
 * The delegability verdict is recomputed live while privileges are ticked, so an
 * operator finds out that a role has just become instance-only *while choosing*,
 * not two screens later when an assignment is refused. That live warning is the
 * reason the picker cannot simply be a read-only list with a pencil beside it.
 *
 * Two cases carry no pencil at all, and both are refusals the server would issue
 * anyway: a super-user role holds everything present and future — there is no
 * set to pick — and a system role's set is frozen (`PATCH /admin/roles/:id`
 * refuses a `privileges` field on one, even an identical set).
 */
export default function RolePrivilegesCard({
  role, catalogue, canEdit,
}: {
  role:      Role
  catalogue: Privilege[]
  canEdit:   boolean
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)

  const update = useUpdateRole(role.id, () => setEditing(false))
  const [selected, setSelected] = useState<Set<string>>(() => new Set(role.privileges))

  const keys  = useMemo(() => catalogue.map(p => p.key), [catalogue])
  const byKey = useMemo(() => new Map(catalogue.map(p => [p.key, p])), [catalogue])

  // Everything the role would carry that cannot be confined to a subtree.
  const blockers = useMemo(
    () => [...selected].filter(k => byKey.get(k) && !byKey.get(k)!.is_ou_scopable),
    [selected, byKey],
  )

  const stored = useMemo(() => new Set(role.privileges), [role.privileges])
  const dirty = selected.size !== stored.size || [...selected].some(k => !stored.has(k))

  const reset = () => setSelected(new Set(role.privileges))
  const stop  = () => { setEditing(false); update.reset(); reset() }

  const toggle = (key: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  const frozen = role.is_system || role.is_superuser

  return (
    <EditableCard
      title={t('admin.roles_privileges')}
      canEdit={canEdit && !frozen}
      editing={editing}
      onEdit={() => { reset(); update.reset(); setEditing(true) }}
      onCancel={stop}
      onSave={() => update.mutate({ privileges: [...selected] })}
      dirty={dirty}
      saving={update.isPending}
      error={update.isError ? errorMessage(update.error, t('admin.role_update_error')) : undefined}
      actions={
        <span className="text-sm text-text-secondary">
          {role.is_superuser
            ? t('admin.roles_all_privileges')
            : t('admin.priv_count', { count: editing ? selected.size : role.privileges.length })}
        </span>
      }
    >
      {role.is_superuser ? (
        <p className="text-sm text-text-primary">{t('admin.roles_all_privileges')}</p>
      ) : editing ? (
        <div className="flex flex-col gap-4">
          {blockers.length > 0 ? (
            <Callout variant="warning" title={t('admin.role_not_delegable_title')} t={t}>
              {t('admin.role_not_delegable_desc', { count: blockers.length })}
            </Callout>
          ) : selected.size > 0 && (
            <Callout variant="success" title={t('admin.role_delegable_title')} t={t}>
              {t('admin.role_delegable_desc')}
            </Callout>
          )}
          <div className="border border-border rounded-lg overflow-hidden">
            <PrivilegeList
              keys={keys}
              catalogue={catalogue}
              selected={selected}
              onToggle={toggle}
            />
          </div>
        </div>
      ) : (
        <>
          <PrivilegeList keys={role.privileges} catalogue={catalogue} bleed />
          {role.is_system && canEdit && (
            <Callout variant="info" t={t} className="mt-3">{t('admin.role_system_frozen')}</Callout>
          )}
        </>
      )}
    </EditableCard>
  )
}
