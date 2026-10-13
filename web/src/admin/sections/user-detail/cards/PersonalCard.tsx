import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UserCog } from 'lucide-react'
import { Input, Textarea } from '@ui'
import { PRIV } from '../../../../core/authz/types'
import { usePrivileges } from '../../../../core/authz/usePrivileges'
import type { User } from '../../../../core/types'
import EditableCard from '../../../inline-edit/EditableCard'
import { useDraft } from '../../../inline-edit/useDraft'
import { Field, orDash } from '../atoms'
import { accountError, useUpdateAccount } from '../useAccountEdit'

/**
 * The six personal columns of migration `000114`.
 *
 * They were readable here and writable nowhere in the console — the edit window
 * knew five fields, none of them these — which made this the exact card the rule
 * exists for: an operator read a wrong pronunciation on the sheet and had no way
 * to fix it. `PATCH /admin/users/:id` has always accepted them (`tidy_profile`
 * normalises the administrative path through the same rules as `PATCH /me`), so
 * nothing server-side had to move.
 *
 * The three-state convention matters here and only here: an emptied field is
 * sent as an explicit `null` (erase), an untouched one is absent (leave alone).
 * Sending `""` would store an empty string, which is not the same thing as "not
 * filled in" and reads as a blank on every profile that shows it.
 */

/** A date with no time of day. `formatDay` would append 00:00 to a birthday. */
function formatBirthday(iso: string, locale: string): string {
  // Parsed as UTC midnight rather than local, so a `YYYY-MM-DD` never slides to
  // the previous day for a viewer west of Greenwich.
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(locale, {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

/** `""` → `null` (erase the column), anything else trimmed. */
function orNull(v: string): string | null {
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

export default function PersonalCard({ user }: { user: User }) {
  const { t, i18n } = useTranslation()
  const { can } = usePrivileges()
  const [editing, setEditing] = useState(false)

  const canEdit = can(PRIV.USERS_UPDATE, user.org_unit_id)
  const save  = useUpdateAccount(user.id)
  const draft = useDraft({
    name_pronunciation: user.name_pronunciation ?? '',
    pronouns:           user.pronouns ?? '',
    work_location:      user.work_location ?? '',
    gender:             user.gender ?? '',
    birthday:           user.birthday ?? '',
    introduction:       user.introduction ?? '',
  })

  const stop = () => { setEditing(false); save.reset(); draft.reset() }

  const submit = () => {
    const body: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(draft.changed)) {
      body[key] = orNull(value as string)
    }
    save.mutate(body, { onSuccess: () => { setEditing(false); save.reset() } })
  }

  const text = (key: 'name_pronunciation' | 'pronouns' | 'work_location' | 'gender', hint?: string) => (
    <Input
      value={draft.value[key]}
      onChange={e => draft.set(key, e.target.value)}
      hint={hint}
    />
  )

  return (
    <EditableCard
      title={t('admin.ud_card_personal')}
      subtitle={t('admin.ud_card_personal_desc')}
      icon={<UserCog size={16} />}
      className="lg:col-span-2"
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
        <Field label={t('admin.ud_name_pronunciation')}>
          {editing ? text('name_pronunciation') : orDash(user.name_pronunciation)}
        </Field>
        <Field label={t('admin.ud_pronouns')}>
          {editing ? text('pronouns') : orDash(user.pronouns)}
        </Field>
        <Field label={t('admin.ud_work_location')}>
          {editing ? text('work_location') : orDash(user.work_location)}
        </Field>
        <Field label={t('admin.ud_gender')}>
          {editing
            ? text('gender', t('admin.ud_gender_hint'))
            : orDash(user.gender)}
        </Field>
        <Field label={t('admin.ud_birthday')}>
          {editing ? (
            <Input
              type="date"
              value={draft.value.birthday}
              onChange={e => draft.set('birthday', e.target.value)}
            />
          ) : orDash(user.birthday ? formatBirthday(user.birthday, i18n.language) : null)}
        </Field>
        <Field label={t('admin.ud_introduction')}>
          {editing ? (
            <Textarea
              value={draft.value.introduction}
              rows={4}
              onChange={e => draft.set('introduction', e.target.value)}
            />
          ) : (
            /* `whitespace-pre-line` keeps the paragraphs somebody typed; the
               container already breaks long words. */
            orDash(user.introduction
              ? <span className="whitespace-pre-line">{user.introduction}</span>
              : null)
          )}
        </Field>
      </dl>

      <p className="mt-3 border-t border-border pt-3 text-text-tertiary"
         style={{ fontSize: 'var(--kb-text-meta)' }}>
        {editing ? t('admin.ud_personal_edit_note') : t('admin.ud_personal_note')}
      </p>
    </EditableCard>
  )
}
