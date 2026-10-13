import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tag } from 'lucide-react'
import { Input, Textarea } from '@ui'
import EditableCard from '../../inline-edit/EditableCard'
import Field, { orDash } from '../../inline-edit/InlineEditField'
import { useDraft } from '../../inline-edit/useDraft'
import { useAudienceMutations, type Audience } from './api'

/** Same ceilings as `core.target_audiences` and the handler that guards it. */
const NAME_MAX = 40
const DESC_MAX = 150

function errMessage(err: unknown): string | undefined {
  const e = err as { message?: string; response?: { data?: { message?: string } } }
  return e?.response?.data?.message ?? e?.message
}

/**
 * What the audience is called and what it says it is — edited on the sheet.
 *
 * The counters live in each field's `hint` rather than in a message after a
 * refusal: 40 and 150 characters are short enough to reach by accident, and a
 * name typed in full only to be rejected is a name typed twice. Counted in
 * characters, like the server: a byte count would refuse a French name of forty
 * accented letters.
 *
 * The seeded "everyone" audience never gets a pencil — the server refuses to
 * rename it, and a button whose only outcome is an error is worse than none.
 */
export default function IdentityCard({
  audience, canManage,
}: {
  audience: Audience
  canManage: boolean
}) {
  const { t } = useTranslation()
  const { update } = useAudienceMutations(audience.id)
  const [editing, setEditing] = useState(false)

  const draft = useDraft({
    name:        audience.name,
    description: audience.description ?? '',
  })

  const nameLen = [...draft.value.name].length
  const descLen = [...draft.value.description].length
  const nameError = draft.value.name.trim().length === 0
    ? t('admin.aud_name_required')
    : nameLen > NAME_MAX
      ? t('admin.aud_name_too_long', { count: nameLen - NAME_MAX })
      : undefined
  const descError = descLen > DESC_MAX
    ? t('admin.aud_desc_too_long', { count: descLen - DESC_MAX })
    : undefined

  const stop = () => { setEditing(false); update.reset(); draft.reset() }

  const submit = () => {
    if (nameError || descError) return
    // `PATCH /admin/audiences/:id` takes both fields together, so the unchanged
    // one is echoed — but only ever when the other actually moved.
    update.mutate(
      {
        id:          audience.id,
        name:        draft.value.name.trim(),
        description: draft.value.description.trim() || null,
      },
      { onSuccess: () => { setEditing(false); update.reset() } },
    )
  }

  return (
    <EditableCard
      className="mb-4"
      title={t('admin.aud_card_identity')}
      icon={<Tag size={16} />}
      canEdit={canManage && !audience.is_everyone}
      editing={editing}
      onEdit={() => { draft.reset(); update.reset(); setEditing(true) }}
      onCancel={stop}
      onSave={submit}
      dirty={draft.dirty && !nameError && !descError}
      saving={update.isPending}
      error={update.isError ? (errMessage(update.error) ?? t('admin.aud_save_failed')) : undefined}
    >
      {editing ? (
        <div className="flex flex-col gap-4">
          <Input
            label={t('admin.aud_name')}
            value={draft.value.name}
            autoFocus
            onChange={e => draft.set('name', e.target.value)}
            placeholder={t('admin.aud_name_ph')}
            error={nameError}
            hint={t('admin.aud_name_hint', { n: nameLen, max: NAME_MAX })}
          />
          <Textarea
            label={t('admin.aud_description')}
            value={draft.value.description}
            rows={3}
            onChange={e => draft.set('description', e.target.value)}
            placeholder={t('admin.aud_desc_ph')}
            error={descError}
            hint={t('admin.aud_desc_hint', { n: descLen, max: DESC_MAX })}
          />
        </div>
      ) : (
        <dl className="divide-y divide-border">
          <Field label={t('admin.aud_name')}>{audience.name}</Field>
          <Field label={t('admin.aud_description')}>{orDash(audience.description)}</Field>
        </dl>
      )}
    </EditableCard>
  )
}
