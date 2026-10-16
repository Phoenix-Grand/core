/**
 * The parts of `UsersPanel.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import { Pencil, MonitorSmartphone, Building2 } from "lucide-react"
import type { OrgUnit } from "../../core/types"
import { FloatingWindow } from "@ui/FloatingWindow"
import { Toggle, Dropdown, Button, Input, Checkbox } from "@ui"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import OrgUnitPicker from "../dialogs/OrgUnitPicker"
import { formatBytes, formatAgo } from "../sections/format"
import type { UsersPanel } from './UsersPanel'
function errMessage(err: unknown): string | undefined {
  const e = err as { message?: string; response?: { data?: { message?: string } } }
  return e?.response?.data?.message ?? e?.message
}

interface CreateUserForm {
  email: string
  username: string
  display_name: string
  password: string
  role: 'user' | 'admin' | 'guest'
}

function CreateUserModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { can, orgUnitId } = usePrivileges()
  const [form, setForm] = useState<CreateUserForm>({
    email: '', username: '', display_name: '', password: '', role: 'user',
  })
  const [error, setError] = useState('')

  // Organisational unit. Without it the account lands outside the tree, where
  // NO org-unit-scoped privilege reaches it - a delegated administrator would
  // create someone they can no longer see. Defaults to the caller's own unit,
  // falling back to the root.
  const { data: units } = useQuery({
    queryKey: ['admin-org-units'],
    queryFn:  () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
    enabled:  can(PRIV.ORG_UNITS_READ),
    staleTime: 30_000,
  })
  const root = (units ?? []).find(u => u.parent_id === null)
  const [ouId, setOuId] = useState<string | null>(null)
  const [ouPicker, setOuPicker] = useState(false)
  const effectiveOu = ouId ?? orgUnitId ?? root?.id ?? null
  const ouName = (units ?? []).find(u => u.id === effectiveOu)?.name ?? '-'

  const create = useMutation({
    mutationFn: (data: CreateUserForm) =>
      api.post('/admin/users', {
        ...data,
        display_name: data.display_name || undefined,
        org_unit_id:  effectiveOu,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      onClose()
    },
    onError: (err: unknown) => setError(errMessage(err) ?? t('admin.create_error')),
  })

  const field = (label: string, key: keyof CreateUserForm, type = 'text', required = true) => (
    <div>
      <label className="block text-sm font-medium text-text-secondary mb-1">
        {label}{required && <span className="text-danger ml-0.5">*</span>}
      </label>
      <Input
        type={type}
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        required={required}
      />
    </div>
  )

  return (
    <FloatingWindow title={t('admin.new_user')} onClose={onClose} defaultWidth={440} backdrop>
      <form
        onSubmit={(e) => { e.preventDefault(); create.mutate(form) }}
        className="p-6 space-y-4"
      >
        {field(t('admin.u_email'), 'email', 'email')}
        {field(t('admin.u_username'), 'username')}
        {field(t('admin.u_display_name'), 'display_name', 'text', false)}
        {field(t('admin.u_password'), 'password', 'password')}

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-text-primary">{t('admin.u_role')} *</label>
          <Dropdown
            className="w-full"
            value={form.role}
            onChange={v => setForm(f => ({ ...f, role: v as CreateUserForm['role'] }))}
            options={[
              { value: 'user',  label: t('admin.role_user') },
              { value: 'admin', label: t('admin.role_admin') },
              { value: 'guest', label: t('admin.role_guest') },
            ]}
          />
        </div>

        {can(PRIV.ORG_UNITS_READ) && (
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-primary">{t('admin.ou_col')}</label>
            <button
              type="button"
              onClick={() => setOuPicker(true)}
              className="h-9 px-3 flex items-center gap-2 rounded-md border border-border bg-white
                         text-sm text-text-primary hover:bg-surface-1 transition-colors text-left"
            >
              <Building2 size={15} className="text-text-tertiary shrink-0" />
              <span className="flex-1 truncate">{ouName}</span>
              <span className="text-primary">{t('admin.u_ou_change')}</span>
            </button>
            <p className="text-sm text-text-tertiary">{t('admin.u_ou_hint')}</p>
          </div>
        )}

        {error && (
          <p className="text-sm text-danger bg-danger-light px-3 py-2 rounded-md">{error}</p>
        )}

        <div className="flex gap-3 pt-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" className="flex-1" loading={create.isPending}>
            {t('settings.create')}
          </Button>
        </div>
      </form>

      {ouPicker && (
        <OrgUnitPicker
          title={t('admin.ou_col')}
          currentId={effectiveOu}
          onSelect={setOuId}
          onClose={() => setOuPicker(false)}
        />
      )}
    </FloatingWindow>
  )
}
export { CreateUserModal }

function RegistrationToggle() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: settings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () =>
      api.get<{ settings: Array<{ key: string; value: unknown }> }>('/admin/settings')
        .then((r) => r.data.settings),
  })

  const registrationOpen: boolean = Boolean(
    settings?.find((s) => s.key === 'auth.registration_open')?.value ?? true
  )

  const toggle = useMutation({
    mutationFn: (open: boolean) => api.patch('/admin/settings', { 'auth.registration_open': open }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-settings'] }),
  })

  return (
    <div className="flex items-center justify-between bg-white border border-border rounded-xl px-4 py-3 mb-6">
      <div>
        <p className="text-sm font-medium text-text-primary">{t('admin.reg_public')}</p>
        <p className="text-sm text-text-secondary mt-0.5">
          {registrationOpen ? t('admin.reg_open_desc') : t('admin.reg_closed_desc')}
        </p>
      </div>
      <Toggle
        checked={registrationOpen}
        disabled={toggle.isPending}
        onChange={() => toggle.mutate(!registrationOpen)}
      />
    </div>
  )
}
export { RegistrationToggle }

export function Part1({ canBulk, allOnPage, togglePage, t, can, data, openUser, selected, toggleOne, unitName, ROLE_COLORS, toggleActive }: { canBulk: NonNullable<UsersPanel['canBulk']>; allOnPage: NonNullable<UsersPanel['allOnPage']>; togglePage: UsersPanel['togglePage']; t: NonNullable<UsersPanel['tr']>; can: NonNullable<UsersPanel['can']>; data: UsersPanel['data']; openUser: UsersPanel['openUser']; selected: NonNullable<UsersPanel['selected']>; toggleOne: UsersPanel['toggleOne']; unitName: UsersPanel['unitName']; ROLE_COLORS: NonNullable<UsersPanel['ROLE_COLORS']>; toggleActive: NonNullable<UsersPanel['toggleActive']> }) {
  return (
    <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-1">
                    {canBulk && (
                      <th className="pl-4 pr-1 py-3 w-9">
                        <Checkbox
                          checked={allOnPage}
                          onChange={togglePage}
                          className="align-middle"
                        />
                      </th>
                    )}
                    {[
                      t('admin.th_user'),
                      ...(can(PRIV.ORG_UNITS_READ) ? [t('admin.ou_col')] : []),
                      t('admin.th_role'), t('admin.th_quota'), t('admin.th_last_login'), t('admin.th_status'), '',
                    ].map((h, hi) => (
                      <th key={hi} className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wide">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data?.users.map((u) => (
                    // The whole row opens the account sheet - the list is an index,
                    // the sheet is where an account is actually looked at.
                    <tr
                      key={u.id}
                      onClick={() => openUser(u)}
                      className="hover:bg-surface-1 transition-colors cursor-pointer"
                    >
                      {canBulk && (
                        // Ticking a row must not also open its sheet.
                        <td className="pl-4 pr-1 py-3 w-9" onClick={e => e.stopPropagation()}>
                          <Checkbox
                            checked={selected.has(u.id)}
                            onChange={() => toggleOne(u.id)}
                            className="align-middle"
                          />
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <div>
                          <p className="font-medium text-text-primary">{u.display_name ?? u.username}</p>
                          <p className="text-sm text-text-tertiary">{u.email}</p>
                        </div>
                      </td>
                      {can(PRIV.ORG_UNITS_READ) && (
                        <td className="px-4 py-3 text-text-secondary text-sm whitespace-nowrap">
                          {unitName(u.org_unit_id) ?? (
                            // Not "-": an account outside the tree is a problem, and
                            // reads as one only if the list says so.
                            <span className="text-warning">{t('admin.ou_none')}</span>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ROLE_COLORS[u.role] ?? ''}`}>
                          {u.role}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-text-secondary text-sm">
                        {formatBytes(u.used_bytes)} / {formatBytes(u.quota_bytes)}
                      </td>
                      <td className="px-4 py-3 text-text-secondary text-sm">
                        {u.last_login_at
                          ? formatAgo(u.last_login_at)
                          : t('admin.never')
                        }
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${u.is_active ? 'bg-success-light text-success' : 'bg-surface-2 text-text-tertiary'}`}>
                          {u.is_active ? t('admin.active') : t('admin.inactive')}
                        </span>
                      </td>
                      {/* Row actions must not also trigger the row's own navigation. */}
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          {/* Opens the sheet, which is where an account is edited -
                              the pencil no longer has a form of its own. */}
                          <button
                            onClick={() => openUser(u)}
                            className="p-1.5 rounded hover:bg-surface-2 text-text-secondary hover:text-primary"
                            title={t('admin.edit')}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => openUser(u, 'security')}
                            className="p-1.5 rounded hover:bg-surface-2 text-text-secondary hover:text-primary"
                            title={t('admin.sessions_title')}
                          >
                            <MonitorSmartphone size={14} />
                          </button>
                          <button
                            onClick={() => toggleActive.mutate({ id: u.id, is_active: !u.is_active })}
                            className="text-sm text-text-secondary hover:text-text-primary whitespace-nowrap"
                          >
                            {u.is_active ? t('admin.disable') : t('admin.enable')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
  )
}
