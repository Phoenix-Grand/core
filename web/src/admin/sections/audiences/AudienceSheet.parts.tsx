/**
 * The parts of `AudienceSheet.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Plus, Trash2, Users, User as UserIcon } from "lucide-react"
import { Button } from "@ui"
import { type AudienceMember } from "./api"
import type { AudienceSheet } from './AudienceSheet'

function MemberRow({
  m, canManage, onRemove,
}: {
  m: AudienceMember; canManage: boolean; onRemove: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="group flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
      {m.member_type === 'group'
        ? <Users size={14} className="shrink-0 text-text-tertiary" />
        : <UserIcon size={14} className="shrink-0 text-text-tertiary" />}
      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
        {m.is_dangling
          ? t('admin.aud_member_gone', { defaultValue: 'Membre supprimé' })
          : m.label}
      </span>
      {m.email && <span className="truncate text-xs text-text-tertiary">{m.email}</span>}
      {m.group_reach !== null && (
        <span className="shrink-0 text-xs text-text-secondary">
          {t('admin.aud_group_reach', {
            defaultValue_one: '{{count}} compte',
            defaultValue: '{{count}} comptes',
            count: m.group_reach,
          })}
        </span>
      )}
      {canManage && (
        <button onClick={onRemove}
                aria-label={t('admin.aud_remove_member', { defaultValue: 'Retirer ce membre' })}
                className="shrink-0 rounded-full p-1 opacity-0 transition-opacity hover:bg-surface-2 group-hover:opacity-100">
          <Trash2 size={13} className="text-text-secondary" />
        </button>
      )}
    </div>
  )
}
export { MemberRow }

export function Part1({ setAdding, t }: { setAdding: NonNullable<AudienceSheet['setAdding']>; t: NonNullable<AudienceSheet['tr']> }) {
  return (
    <Button variant="secondary" onClick={() => setAdding(true)}>
                  <Plus size={14} /> {t('common.add', { defaultValue: 'Ajouter' })}
                </Button>
  )
}
