import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IdCard } from 'lucide-react'
import { Input } from '@ui'
import { PRIV } from '../../../../core/authz/types'
import { usePrivileges } from '../../../../core/authz/usePrivileges'
import type { User } from '../../../../core/types'
import EditableCard from '../../../inline-edit/EditableCard'
import { useDraft } from '../../../inline-edit/useDraft'
import { Field, orDash } from '../atoms'
import { accountError, useUpdateAccount } from '../useAccountEdit'

/**
 * Who the account is.
 *
 * Only the displayed name is writable: `PATCH /admin/users/:id` accepts no
 * username and no e-mail, and offering a field the server would ignore is worse
 * than offering none. The other rows stay values, with the hint saying where
 * they do change - which is what an operator otherwise spends a minute looking
 * for in a form that silently drops them.
 */
export default function IdentityCard({ user }: { user: User }) {
  const { t } = useTranslation()
  const { can } = usePrivileges()
  const [editing, setEditing] = useState(false)

  const canEdit = can(PRIV.USERS_UPDATE, user.org_unit_id)
  const save = useUpdateAccount(user.id)
  const draft = useDraft({
    display_name: user.display_name ?? '',
    first_name:   user.first_name ?? '',
    last_name:    user.last_name ?? '',
  })

  const stop = () => { setEditing(false); save.reset(); draft.reset() }

  const submit = () => {
    // An empty name is not the empty string: the column falls back to the
    // username, and the server COALESCEs an absent field.
    save.mutate(
      {
        display_name: draft.value.display_name.trim() || undefined,
        first_name:   draft.value.first_name.trim() || null,
        last_name:    draft.value.last_name.trim() || null,
      },
      { onSuccess: () => { setEditing(false); save.reset() } },
    )
  }

  return (
    <EditableCard
      title={t('admin.ud_card_identity')}
      icon={<IdCard size={16} />}
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
        <Field label={t('admin.u_display_name')}>
          {editing ? (
            <Input
              value={draft.value.display_name}
              onChange={e => draft.set('display_name', e.target.value)}
              placeholder={user.username}
              hint={t('admin.ud_display_name_hint')}
              autoFocus
            />
          ) : orDash(user.display_name)}
        </Field>
        <Field label={t('admin.ud_first_name', { defaultValue: 'Prénom' })}>
          {editing ? (
            <Input
              value={draft.value.first_name}
              onChange={e => draft.set('first_name', e.target.value)}
              maxLength={120}
            />
          ) : orDash(user.first_name)}
        </Field>
        <Field label={t('admin.ud_last_name', { defaultValue: 'Nom de famille' })}>
          {editing ? (
            <Input
              value={draft.value.last_name}
              onChange={e => draft.set('last_name', e.target.value)}
              maxLength={120}
            />
          ) : orDash(user.last_name)}
        </Field>
        <Field label={t('admin.ud_username')}>{user.username}</Field>
        <Field label={t('admin.u_email')}>
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all">{user.email}</span>
            <span
              className={user.email_verified ? 'text-success' : 'text-text-tertiary'}
              style={{ fontSize: 'var(--kb-text-meta)' }}
            >
              {user.email_verified ? t('admin.ud_email_verified') : t('admin.ud_email_unverified')}
            </span>
          </span>
        </Field>
        <Field label={t('admin.ud_auth_method')}>
          {user.oauth_provider
            ? t('admin.ud_auth_oauth', { provider: user.oauth_provider })
            : t('admin.ud_auth_password')}
        </Field>
        <Field label={t('admin.ud_user_id')}>
          {/* Default font and size, like every other value; break-all keeps the long UUID from overflowing. */}
          <span className="break-all">{user.id}</span>
        </Field>
      </dl>

      {editing && (
        <p className="mt-3 border-t border-border pt-3 text-text-tertiary"
           style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.ud_identity_readonly_note')}
        </p>
      )}
    </EditableCard>
  )
}
