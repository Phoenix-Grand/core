/**
 * The parts of `AssignRoleDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Callout, Combobox, DatePicker } from "@ui"
import type { User } from "../../core/types"
import type { AssignRoleDialog } from './AssignRoleDialog'
import { groupName, groupDescription } from '../../core/directory/labels'

function Avatar({ user, size = 28 }: { user: User; size?: number }) {
  const initial = (user.display_name || user.username || user.email || '?').trim().charAt(0).toUpperCase()
  if (user.avatar_url) {
    return <img src={user.avatar_url} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />
  }
  return (
    <span
      className="rounded-full bg-primary-light text-primary flex items-center justify-center font-medium shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.45 }}
    >
      {initial}
    </span>
  )
}
export { Avatar }

export function Part1({ groupId, setGroupId, groups, t }: { groupId: AssignRoleDialog['groupId']; setGroupId: NonNullable<AssignRoleDialog['setGroupId']>; groups: AssignRoleDialog['groups']; t: NonNullable<AssignRoleDialog['tr']> }) {
  return (
    <Combobox
                    value={groupId}
                    onChange={setGroupId}
                    options={(groups ?? []).map(g => ({ value: g.id, label: groupName(t, g), description: groupDescription(t, g) ?? undefined }))}
                    placeholder={t('admin.assign_pick_group')}
                    width="100%"
                    t={t}
                  />
  )
}

export function Part2({ t, role, blockers }: { t: NonNullable<AssignRoleDialog['tr']>; role: NonNullable<AssignRoleDialog['props']['role']>; blockers: NonNullable<AssignRoleDialog['blockers']> }) {
  return (
    <Callout variant="warning" title={t('admin.assign_scope_ou_blocked_title')} t={t}>
                    <span className="block">
                      {role.is_superuser
                        ? t('admin.assign_scope_ou_blocked_superuser')
                        : t('admin.assign_scope_ou_blocked_desc', { count: blockers.length })}
                    </span>
                    {blockers.length > 0 && (
                      <span className="mt-1.5 flex flex-wrap gap-1.5">
                        {blockers.map(p => (
                          <span key={p.key} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface-2 text-text-secondary">
                            {p.key}
                          </span>
                        ))}
                      </span>
                    )}
                  </Callout>
  )
}

export function Part3({ expiresAt, setExpiresAt, t }: { expiresAt: AssignRoleDialog['expiresAt']; setExpiresAt: NonNullable<AssignRoleDialog['setExpiresAt']>; t: NonNullable<AssignRoleDialog['tr']> }) {
  return (
    <DatePicker
                  value={expiresAt}
                  onChange={setExpiresAt}
                  clearable
                  minDate={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
                  placeholder={t('admin.assign_expiry_never')}
                  hint={t('admin.assign_expiry_hint')}
                />
  )
}
