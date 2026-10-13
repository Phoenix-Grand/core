/**
 * The parts of `LdapDirectoryForm.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { type ReactNode } from "react"
import { Combobox, Input, Textarea, Toggle, Stepper } from "@ui"
import type { LdapDirectoryForm } from './LdapDirectoryForm'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block text-sm">
      <span className="text-text-secondary">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && (
        <p className="mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {hint}
        </p>
      )}
    </label>
  )
}
export { Field }

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="font-medium text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {label}
        </p>
        {hint && (
          <p className="mt-0.5 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {hint}
          </p>
        )}
      </div>
      <Toggle checked={checked} onChange={e => onChange(e.target.checked)} />
    </div>
  )
}
export { SwitchRow }

export function Part1({ steps, step, setStep, t }: { steps: NonNullable<LdapDirectoryForm['steps']>; step: NonNullable<LdapDirectoryForm['step']>; setStep: NonNullable<LdapDirectoryForm['setStep']>; t: NonNullable<LdapDirectoryForm['tr']> }) {
  return (
    <Stepper steps={steps} current={step} onStepChange={id => setStep(id)} allowForward t={t} />
  )
}

export function Part2({ t, form, isEdit, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; isEdit: NonNullable<LdapDirectoryForm['props']['isEdit']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.slug')} hint={t('ldap.slug_hint')}>
                    <Input
                      value={form.slug}
                      disabled={isEdit}
                      onChange={e => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                      placeholder="annuaire"
                      autoComplete="off"
                    />
                  </Field>
  )
}

export function Part3({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.display_name')}>
                    <Input
                      value={form.display_name}
                      onChange={e => set('display_name', e.target.value)}
                      placeholder="Annuaire interne"
                      autoComplete="off"
                    />
                  </Field>
  )
}

export function Part4({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.host')} hint={t('ldap.host_hint')}>
                      <Input
                        value={form.host}
                        onChange={e => set('host', e.target.value.trim())}
                        placeholder="dc01.exemple.com"
                        autoComplete="off"
                      />
                    </Field>
  )
}

export function Part5({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.port')}>
                    <Input
                      type="number"
                      value={form.port}
                      onChange={e => set('port', e.target.value)}
                      min={1}
                      max={65535}
                    />
                  </Field>
  )
}

export function Part6({ t, form, onSecurityChange, securityOptions }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; onSecurityChange: LdapDirectoryForm['onSecurityChange']; securityOptions: NonNullable<LdapDirectoryForm['securityOptions']> }) {
  return (
    <Field label={t('ldap.security')}>
                  <Combobox
                    value={form.security}
                    onChange={onSecurityChange}
                    options={securityOptions}
                    width="100%"
                    t={t}
                  />
                </Field>
  )
}

export function Part7({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.ca_certificate')} hint={t('ldap.ca_certificate_hint')}>
                        <Textarea
                          value={form.ca_certificate}
                          onChange={e => set('ca_certificate', e.target.value)}
                          rows={5}
                          placeholder="-----BEGIN CERTIFICATE-----"
                          className="font-mono"
                          style={{ fontSize: 'var(--kb-text-meta)' }}
                          autoComplete="off"
                        />
                      </Field>
  )
}

export function Part8({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.timeout')} hint={t('ldap.timeout_hint')}>
                  <Input
                    type="number"
                    value={form.connect_timeout_s}
                    onChange={e => set('connect_timeout_s', e.target.value)}
                    min={1}
                    max={120}
                  />
                </Field>
  )
}

export function Part9({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.bind_dn')} hint={t('ldap.bind_dn_hint')}>
                  <Input
                    value={form.bind_dn}
                    onChange={e => set('bind_dn', e.target.value)}
                    placeholder="cn=kubuno,ou=services,dc=exemple,dc=com"
                    autoComplete="off"
                  />
                </Field>
  )
}

export function Part10({ t, hasStoredPassword, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; hasStoredPassword: NonNullable<LdapDirectoryForm['props']['hasStoredPassword']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field
                  label={t('ldap.bind_password')}
                  hint={hasStoredPassword ? t('ldap.bind_password_stored') : t('ldap.bind_password_hint')}
                >
                  <Input
                    type="password"
                    value={form.bind_password}
                    onChange={e => set('bind_password', e.target.value)}
                    placeholder={hasStoredPassword ? '••••••••' : ''}
                    autoComplete="new-password"
                  />
                </Field>
  )
}

export function Part11({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.base_dn')} hint={t('ldap.base_dn_hint')}>
                  <Input
                    value={form.base_dn}
                    onChange={e => set('base_dn', e.target.value)}
                    placeholder="dc=exemple,dc=com"
                    autoComplete="off"
                  />
                </Field>
  )
}

export function Part12({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.user_filter')} hint={t('ldap.user_filter_hint')}>
                  <Input
                    value={form.user_filter}
                    onChange={e => set('user_filter', e.target.value)}
                    className="font-mono"
                    autoComplete="off"
                  />
                </Field>
  )
}

export function Part13({ t, form, set, scopeOptions }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set']; scopeOptions: NonNullable<LdapDirectoryForm['scopeOptions']> }) {
  return (
    <Field label={t('ldap.user_scope')}>
                  <Combobox
                    value={form.user_scope}
                    onChange={v => set('user_scope', v)}
                    options={scopeOptions}
                    width="100%"
                    t={t}
                  />
                </Field>
  )
}

export function Part14({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.attr_username')} hint={t('ldap.attr_username_hint')}>
                    <Input
                      value={form.attr_username}
                      onChange={e => set('attr_username', e.target.value)}
                      className="font-mono"
                      autoComplete="off"
                    />
                  </Field>
  )
}

export function Part15({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.attr_email')} hint={t('ldap.attr_email_hint')}>
                    <Input
                      value={form.attr_email}
                      onChange={e => set('attr_email', e.target.value)}
                      className="font-mono"
                      autoComplete="off"
                    />
                  </Field>
  )
}

export function Part16({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.attr_display_name')}>
                    <Input
                      value={form.attr_display_name}
                      onChange={e => set('attr_display_name', e.target.value)}
                      className="font-mono"
                      autoComplete="off"
                    />
                  </Field>
  )
}

export function Part17({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.attr_unique_id')} hint={t('ldap.attr_unique_id_hint')}>
                    <Input
                      value={form.attr_unique_id}
                      onChange={e => set('attr_unique_id', e.target.value)}
                      className="font-mono"
                      autoComplete="off"
                    />
                  </Field>
  )
}

export function Part18({ t, form, set, unitOptions }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set']; unitOptions: NonNullable<LdapDirectoryForm['unitOptions']> }) {
  return (
    <Field label={t('ldap.default_org_unit')} hint={t('ldap.default_org_unit_hint')}>
                  <Combobox
                    value={form.default_org_unit_id ?? ''}
                    onChange={v => set('default_org_unit_id', v === '' ? null : v)}
                    options={unitOptions}
                    width="100%"
                    t={t}
                  />
                </Field>
  )
}

export function Part19({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.group_base_dn')} hint={t('ldap.group_base_dn_hint')}>
                      <Input
                        value={form.group_base_dn}
                        onChange={e => set('group_base_dn', e.target.value)}
                        placeholder="ou=groupes,dc=exemple,dc=com"
                        autoComplete="off"
                      />
                    </Field>
  )
}

export function Part20({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.group_filter')}>
                      <Input
                        value={form.group_filter}
                        onChange={e => set('group_filter', e.target.value)}
                        className="font-mono"
                        autoComplete="off"
                      />
                    </Field>
  )
}

export function Part21({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.attr_group_name')}>
                      <Input
                        value={form.attr_group_name}
                        onChange={e => set('attr_group_name', e.target.value)}
                        className="font-mono"
                        autoComplete="off"
                      />
                    </Field>
  )
}

export function Part22({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.attr_group_member')} hint={t('ldap.attr_group_member_hint')}>
                      <Input
                        value={form.attr_group_member}
                        onChange={e => set('attr_group_member', e.target.value)}
                        className="font-mono"
                        autoComplete="off"
                      />
                    </Field>
  )
}

export function Part23({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.attr_member_of')} hint={t('ldap.attr_member_of_hint')}>
                      <Input
                        value={form.attr_member_of}
                        onChange={e => set('attr_member_of', e.target.value)}
                        className="font-mono"
                        placeholder="memberOf"
                        autoComplete="off"
                      />
                    </Field>
  )
}

export function Part24({ t, form, set }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set'] }) {
  return (
    <Field label={t('ldap.sync_interval')} hint={t('ldap.sync_interval_hint')}>
                    <Input
                      type="number"
                      value={form.sync_interval_min}
                      onChange={e => set('sync_interval_min', e.target.value)}
                      min={5}
                      max={10080}
                    />
                  </Field>
  )
}

export function Part25({ t, form, set, missingOptions }: { t: NonNullable<LdapDirectoryForm['tr']>; form: NonNullable<LdapDirectoryForm['props']['form']>; set: LdapDirectoryForm['set']; missingOptions: NonNullable<LdapDirectoryForm['missingOptions']> }) {
  return (
    <Field label={t('ldap.on_missing')}>
                  <Combobox
                    value={form.on_missing}
                    onChange={v => set('on_missing', v)}
                    options={missingOptions}
                    width="100%"
                    t={t}
                  />
                </Field>
  )
}
