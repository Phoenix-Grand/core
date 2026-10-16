import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Dropdown } from '@ui'
import { api } from '../../../../core/api/client'
import { PRIV } from '../../../../core/authz/types'
import { usePrivileges } from '../../../../core/authz/usePrivileges'
import type { OrgUnit, User } from '../../../../core/types'
import OrgUnitPicker from '../../../dialogs/OrgUnitPicker'
import EditableCard from '../../../inline-edit/EditableCard'
import { useDraft } from '../../../inline-edit/useDraft'
import { Field, orDash } from '../atoms'
import { accountError, useUpdateAccount } from '../useAccountEdit'
import RoleBadge from '../RoleBadge'
import StatusBadge from '../StatusBadge'

type SystemRole = 'user' | 'admin' | 'guest'

/**
 * Where the account sits, and what it is.
 *
 * The three rows do not share one privilege, and the card says so field by field
 * rather than as a whole:
 *
 * - **Role** is instance super-administration when it reads `admin`, so the
 *   server demands a super-user (`require_superuser`, `update_user`). Anyone
 *   else reads the badge.
 * - **Unit** needs `users.update` over both the unit the account is in *and* the
 *   one it is going to - the server checks both perimeters, and a delegated
 *   administrator must not be able to push accounts out of their own subtree.
 * - **Status** is a verb, not a field: it stays the confirmed action in the
 *   sheet header, where it cannot be flipped by a stray click inside a form.
 */
export default function OrganisationCard({ user }: { user: User }) {
  const { t } = useTranslation()
  const { can, isSuperuser } = usePrivileges()
  const [editing, setEditing] = useState(false)
  const [picker, setPicker]   = useState(false)

  const canMove = can(PRIV.USERS_UPDATE, user.org_unit_id) && can(PRIV.ORG_UNITS_READ)
  const canEdit = isSuperuser || canMove

  const { data: orgUnits } = useQuery({
    queryKey: ['admin-org-units'],
    queryFn:  () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
    enabled:  can(PRIV.ORG_UNITS_READ),
    staleTime: 60_000,
  })
  const unitName = (id: string | null) => orgUnits?.find(u => u.id === id)?.name ?? null

  const save  = useUpdateAccount(user.id)
  const draft = useDraft({
    role:        user.role as SystemRole,
    org_unit_id: user.org_unit_id,
  })

  const stop = () => { setEditing(false); setPicker(false); save.reset(); draft.reset() }

  const submit = () => {
    const body: Record<string, unknown> = {}
    if (draft.changed.role) body.role = draft.changed.role
    if ('org_unit_id' in draft.changed && draft.value.org_unit_id) {
      body.org_unit_id = draft.value.org_unit_id
    }
    save.mutate(body, { onSuccess: () => { setEditing(false); save.reset() } })
  }

  const shownUnit = editing ? draft.value.org_unit_id : user.org_unit_id

  return (
    <EditableCard
      title={t('admin.ud_card_organisation')}
      icon={<Building2 size={16} />}
      canEdit={canEdit}
      editing={editing}
      onEdit={() => { draft.reset(); save.reset(); setEditing(true) }}
      onCancel={stop}
      onSave={submit}
      dirty={draft.dirty}
      saving={save.isPending}
      error={save.isError ? (accountError(save.error) ?? t('admin.update_error')) : undefined}
    >
      <dl className="divide-y divide-border">
        <Field label={t('admin.u_role')}>
          {editing && isSuperuser ? (
            <Dropdown
              width="100%"
              focusable
              height={36}
              value={draft.value.role}
              onChange={v => draft.set('role', v as SystemRole)}
              options={[
                { value: 'user',  label: t('admin.role_user') },
                { value: 'admin', label: t('admin.role_admin') },
                { value: 'guest', label: t('admin.role_guest') },
              ]}
            />
          ) : (
            <RoleBadge role={user.role} label={t(`admin.role_${user.role}`, { defaultValue: user.role })} />
          )}
        </Field>

        <Field label={t('admin.th_status')}>
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge
              active={user.is_active}
              label={user.is_active ? t('admin.active') : t('admin.inactive')}
            />
            {editing && (
              <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {t('admin.ud_status_in_header')}
              </span>
            )}
          </span>
        </Field>

        <Field label={t('admin.ud_org_unit')}>
          <span className="flex flex-wrap items-center gap-2">
            <span>{orDash(unitName(shownUnit) ?? (shownUnit ? shownUnit : null))}</span>
            {editing && canMove && (
              <button
                type="button"
                onClick={() => setPicker(true)}
                className="text-primary hover:underline"
                style={{ fontSize: 'var(--kb-text-meta)' }}
              >
                {t('admin.u_ou_change')}
              </button>
            )}
          </span>
        </Field>
      </dl>

      {editing && !isSuperuser && (
        <p className="mt-3 border-t border-border pt-3 text-text-tertiary"
           style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.ud_role_superuser_only')}
        </p>
      )}

      {picker && (
        <OrgUnitPicker
          title={t('admin.ou_picker_title', { name: user.display_name ?? user.username })}
          currentId={draft.value.org_unit_id}
          onSelect={id => draft.set('org_unit_id', id)}
          onClose={() => setPicker(false)}
        />
      )}
    </EditableCard>
  )
}
