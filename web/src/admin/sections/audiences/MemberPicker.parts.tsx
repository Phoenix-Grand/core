/**
 * The parts of `MemberPicker.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Users, User as UserIcon } from "lucide-react"
import { Callout, Checkbox, EmptyState, Input } from "@ui"
import { FloatingWindow } from "@ui/FloatingWindow"
import type { MemberPicker } from './MemberPicker'

export function Part1({ t, onCancel, chosen, addedReach, onAdd, busy, q, setQ, shown, picked, toggle, error }: { t: NonNullable<MemberPicker['tr']>; onCancel: NonNullable<MemberPicker['props']['onCancel']>; chosen: NonNullable<MemberPicker['chosen']>; addedReach: NonNullable<MemberPicker['addedReach']>; onAdd: NonNullable<MemberPicker['props']['onAdd']>; busy: NonNullable<MemberPicker['props']['busy']>; q: NonNullable<MemberPicker['q']>; setQ: NonNullable<MemberPicker['setQ']>; shown: NonNullable<MemberPicker['shown']>; picked: NonNullable<MemberPicker['picked']>; toggle: MemberPicker['toggle']; error: NonNullable<MemberPicker['props']['error']> }) {
  return (
    <FloatingWindow
            title={t('admin.aud_add_members', { defaultValue: 'Ajouter des membres' })}
            onClose={onCancel}
            defaultWidth={600}
            backdrop
            t={t}
            actions={{
              extra: (
                <span className="text-sm text-text-secondary">
                  {chosen.length > 0
                    ? t('admin.aud_picked_summary', {
                        defaultValue_one: '{{count}} sélectionné · comptes atteints : {{reach}} au plus',
                        defaultValue: '{{count}} sélectionnés · comptes atteints : {{reach}} au plus',
                        count: chosen.length, reach: addedReach,
                      })
                    : ''}
                </span>
              ),
              confirm: {
                label:    t('common.add', { defaultValue: 'Ajouter' }),
                onClick:  () => onAdd(chosen.map(c => ({ member_type: c.member_type, member_id: c.member_id }))),
                disabled: chosen.length === 0 || busy,
              },
              cancel: { label: t('common.cancel', { defaultValue: 'Annuler' }), disabled: busy },
            }}
          >
            <div className="flex max-h-[65vh] flex-col gap-3 overflow-hidden p-4">
              <Input
                value={q}
                autoFocus
                onChange={e => setQ(e.target.value)}
                placeholder={t('admin.aud_search_ph', { defaultValue: 'Rechercher un groupe ou un compte…' })}
                hint={t('admin.aud_prefer_groups', {
                  defaultValue: 'Préférez un groupe : l’audience suivra l’organisation sans être rééditée.',
                })}
              />
    
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
                {shown.length === 0 ? (
                  <EmptyState
                    icon={<Users size={20} />}
                    title={t('admin.aud_no_candidate', { defaultValue: 'Aucun groupe ni compte à ajouter' })}
                  />
                ) : shown.map(c => {
                  const k = `${c.member_type}:${c.member_id}`
                  return (
                    <label key={k}
                           className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surface-1">
                      <Checkbox checked={!!picked[k]} onChange={() => toggle(c)} />
                      {c.member_type === 'group'
                        ? <Users size={14} className="shrink-0 text-text-tertiary" />
                        : <UserIcon size={14} className="shrink-0 text-text-tertiary" />}
                      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{c.label}</span>
                      {c.sub && <span className="truncate text-xs text-text-tertiary">{c.sub}</span>}
                      {c.reach !== null && (
                        <span className="shrink-0 text-xs text-text-secondary">
                          {t('admin.aud_group_reach', {
                            defaultValue_one: '{{count}} compte',
                            defaultValue: '{{count}} comptes',
                            count: c.reach,
                          })}
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
    
              {error && <Callout variant="danger">{error}</Callout>}
            </div>
          </FloatingWindow>
  )
}
