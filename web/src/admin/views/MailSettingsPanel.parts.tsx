/**
 * The parts of `MailSettingsPanel.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Callout, Dropdown, Input } from "@ui"
import type { MailSettingsPanel } from './MailSettingsPanel'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-text-secondary">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>{hint}</p>}
    </label>
  )
}
export { Field }

export function Part1({ t, form, set }: { t: NonNullable<MailSettingsPanel['tr']>; form: NonNullable<MailSettingsPanel['form']>; set: MailSettingsPanel['set'] }) {
  return (
    <Field label={t('mailsetup.host')}>
                    <Input
                      value={form.host}
                      onChange={e => set('host', e.target.value)}
                      placeholder="smtp.exemple.com"
                      autoComplete="off"
                    />
                  </Field>
  )
}

export function Part2({ t, form, set }: { t: NonNullable<MailSettingsPanel['tr']>; form: NonNullable<MailSettingsPanel['form']>; set: MailSettingsPanel['set'] }) {
  return (
    <Field label={t('mailsetup.port')}>
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

export function Part3({ t, form, onSecurityChange, securityOptions }: { t: NonNullable<MailSettingsPanel['tr']>; form: NonNullable<MailSettingsPanel['form']>; onSecurityChange: MailSettingsPanel['onSecurityChange']; securityOptions: NonNullable<MailSettingsPanel['securityOptions']> }) {
  return (
    <Field label={t('mailsetup.security')}>
                <Dropdown
                  value={form.security}
                  onChange={onSecurityChange}
                  options={securityOptions}
                  width="100%"
                  height={36}
                  fontSize={14}
                  focusable
                />
              </Field>
  )
}

export function Part4({ t, form, set }: { t: NonNullable<MailSettingsPanel['tr']>; form: NonNullable<MailSettingsPanel['form']>; set: MailSettingsPanel['set'] }) {
  return (
    <Field label={t('mailsetup.username')} hint={t('mailsetup.username_hint')}>
                  <Input
                    value={form.username}
                    onChange={e => set('username', e.target.value)}
                    autoComplete="off"
                  />
                </Field>
  )
}

export function Part5({ t, settings, form, set }: { t: NonNullable<MailSettingsPanel['tr']>; settings: NonNullable<MailSettingsPanel['settings']>; form: NonNullable<MailSettingsPanel['form']>; set: MailSettingsPanel['set'] }) {
  return (
    <Field
                  label={t('mailsetup.password')}
                  hint={settings.has_password ? t('mailsetup.password_stored') : t('mailsetup.password_hint')}
                >
                  <Input
                    type="password"
                    value={form.password}
                    onChange={e => set('password', e.target.value)}
                    placeholder={settings.has_password ? '••••••••' : ''}
                    autoComplete="new-password"
                  />
                </Field>
  )
}

export function Part6({ t, form, set }: { t: NonNullable<MailSettingsPanel['tr']>; form: NonNullable<MailSettingsPanel['form']>; set: MailSettingsPanel['set'] }) {
  return (
    <Field label={t('mailsetup.from_address')}>
                  <Input
                    value={form.from_address}
                    onChange={e => set('from_address', e.target.value)}
                    placeholder="no-reply@exemple.com"
                    autoComplete="off"
                  />
                </Field>
  )
}

export function Part7({ t, form, set }: { t: NonNullable<MailSettingsPanel['tr']>; form: NonNullable<MailSettingsPanel['form']>; set: MailSettingsPanel['set'] }) {
  return (
    <Field label={t('mailsetup.from_name')}>
                  <Input value={form.from_name} onChange={e => set('from_name', e.target.value)} />
                </Field>
  )
}

export function Part8({ t, form, set }: { t: NonNullable<MailSettingsPanel['tr']>; form: NonNullable<MailSettingsPanel['form']>; set: MailSettingsPanel['set'] }) {
  return (
    <Field label={t('mailsetup.public_url')} hint={t('mailsetup.public_url_hint')}>
                <Input
                  value={form.public_url}
                  onChange={e => set('public_url', e.target.value)}
                  placeholder="https://cloud.exemple.com"
                  autoComplete="off"
                />
              </Field>
  )
}

export function Part9({ t, testRef, testTo, setTestTo, settings }: { t: NonNullable<MailSettingsPanel['tr']>; testRef: NonNullable<MailSettingsPanel['testRef']>; testTo: NonNullable<MailSettingsPanel['testTo']>; setTestTo: NonNullable<MailSettingsPanel['setTestTo']>; settings: NonNullable<MailSettingsPanel['settings']> }) {
  return (
    <Field label={t('mailsetup.test_to')}>
                    <Input
                      ref={testRef}
                      type="email"
                      value={testTo}
                      onChange={e => setTestTo(e.target.value)}
                      placeholder={settings.from_address || 'admin@exemple.com'}
                      autoComplete="off"
                    />
                  </Field>
  )
}

export function Part10({ result, t, result_detail, result_hint }: { result: NonNullable<MailSettingsPanel['result']>; t: NonNullable<MailSettingsPanel['tr']>; result_detail: string; result_hint: string }) {
  return (
    <Callout
                  variant={result.ok ? 'success' : 'danger'}
                  title={result.ok ? t('mailsetup.test_ok') : t('mailsetup.test_failed')}
                >
                  <p>
                    {result.to} · {result.host}:{result.port} · {result.security} ·{' '}
                    {t('mailsetup.test_elapsed', { ms: result.elapsed_ms })}
                  </p>
                  {result.detail && (
                    <>
                      <p className="mt-2 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                        {t('mailsetup.test_detail')}
                      </p>
                      {/* Raw relay answer, verbatim. It scrolls inside its own box:
                          an SMTP error is a single long line and must never make the
                          page scroll sideways. */}
                      <pre className="mt-1 max-w-full overflow-x-auto rounded-md border border-border bg-surface-1 px-2.5 py-2 font-mono text-text-primary"
                           style={{ fontSize: 'var(--kb-text-meta)' }}>
                        {result_detail}
                      </pre>
                    </>
                  )}
                  {result.hint && (
                    <p className="mt-2">
                      <span className="text-text-secondary">{t('mailsetup.test_advice')} — </span>
                      {result_hint}
                    </p>
                  )}
                </Callout>
  )
}
