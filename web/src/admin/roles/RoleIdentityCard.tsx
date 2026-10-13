import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input, Textarea } from '@ui'
import type { Role } from '../../core/authz/types'
import { useAuthzLabels } from '../../core/authz/labels'
import EditableCard from '../inline-edit/EditableCard'
import Field, { orDash } from '../inline-edit/InlineEditField'
import { useDraft } from '../inline-edit/useDraft'
import { errorMessage, useUpdateRole } from './api'
import DelegabilityChip from './DelegabilityChip'
import RoleIcon from './RoleIcon'

/**
 * What the role is called and what it says it does.
 *
 * The wording shown is the operator's own — `useAuthzLabels` translates the
 * built-in roles — and that is exactly why only a touched field is sent: opening
 * this card in English and saving a description must not freeze a system role's
 * name into English for every other reader. `useDraft` compares against the
 * label currently displayed, so an untouched name is simply absent from the
 * `PATCH` and the stored row goes on being translated.
 *
 * The slug is shown and never editable: it is the identifier assignments and
 * policies are written against, and the server refuses to change it after
 * creation.
 */
export default function RoleIdentityCard({
  role, canEdit, actions,
}: {
  role:     Role
  /** Defining a role is super-user-only server-side (guard 1). */
  canEdit:  boolean
  /** The sheet's own verbs, kept in the header in both states. */
  actions?: React.ReactNode
}) {
  const { t } = useTranslation()
  const { roleName, roleDescription } = useAuthzLabels()
  const [editing, setEditing] = useState(false)

  const update = useUpdateRole(role.id, () => setEditing(false))
  const draft  = useDraft({
    name:        roleName(role),
    description: roleDescription(role) ?? '',
  })

  const stop = () => { setEditing(false); update.reset(); draft.reset() }

  const submit = () => {
    if (!draft.value.name.trim()) return
    const body: { name?: string; description?: string | null } = {}
    if (draft.changed.name !== undefined) body.name = draft.value.name.trim()
    if (draft.changed.description !== undefined) {
      body.description = draft.value.description.trim() || null
    }
    update.mutate(body)
  }

  return (
    <EditableCard
      title={
        <span className="flex items-center gap-2.5">
          <RoleIcon role={role} size={20} />
          <span className="truncate">{roleName(role)}</span>
        </span>
      }
      subtitle={<span className="font-mono">{role.slug}</span>}
      canEdit={canEdit}
      editing={editing}
      onEdit={() => { draft.reset(); update.reset(); setEditing(true) }}
      onCancel={stop}
      onSave={submit}
      dirty={draft.dirty && !!draft.value.name.trim()}
      saving={update.isPending}
      error={update.isError ? errorMessage(update.error, t('admin.role_update_error')) : undefined}
      actions={actions}
    >
      {editing ? (
        <div className="flex flex-col gap-4">
          <Input
            label={t('admin.role_name')}
            value={draft.value.name}
            autoFocus
            onChange={e => draft.set('name', e.target.value)}
            placeholder={t('admin.role_name_ph')}
            error={draft.value.name.trim() ? undefined : t('admin.role_name_required')}
          />
          <Textarea
            label={t('admin.roles_col_desc')}
            value={draft.value.description}
            rows={3}
            onChange={e => draft.set('description', e.target.value)}
            placeholder={t('admin.role_desc_ph')}
          />
        </div>
      ) : (
        <dl className="divide-y divide-border">
          <Field label={t('admin.roles_col_desc')}>{orDash(roleDescription(role))}</Field>
        </dl>
      )}

      <div className="flex flex-wrap gap-2 mt-4">
        <DelegabilityChip role={role} />
        {role.is_system && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-surface-2 text-text-secondary whitespace-nowrap">
            {t('admin.roles_system')}
          </span>
        )}
      </div>
    </EditableCard>
  )
}
