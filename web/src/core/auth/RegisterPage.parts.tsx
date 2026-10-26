/**
 * The parts of `RegisterPage.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Input } from "@ui"
import type { RegisterPage } from './RegisterPage'

export function Part1({ t, form, handleChange }: { t: NonNullable<RegisterPage['tr']>; form: NonNullable<RegisterPage['form']>; handleChange: RegisterPage['handleChange'] }) {
  return (
    <Input
                  label={t('register.name_label')}
                  type="text"
                  name="display_name"
                  value={form.display_name}
                  onChange={handleChange}
                  autoComplete="name"
                  placeholder="Jean Dupont"
                />
  )
}

export function Part2({ t, form, handleChange }: { t: NonNullable<RegisterPage['tr']>; form: NonNullable<RegisterPage['form']>; handleChange: RegisterPage['handleChange'] }) {
  return (
    <Input
                  label={<>{t('register.username_label')} <span className="text-danger">*</span></>}
                  type="text"
                  name="username"
                  value={form.username}
                  onChange={handleChange}
                  required
                  minLength={3}
                  autoComplete="username"
                  placeholder="jean_dupont"
                />
  )
}

export function Part3({ t, form, handleChange }: { t: NonNullable<RegisterPage['tr']>; form: NonNullable<RegisterPage['form']>; handleChange: RegisterPage['handleChange'] }) {
  return (
    <Input
                label={<>{t('register.email_label')} <span className="text-danger">*</span></>}
                type="email"
                name="email"
                value={form.email}
                onChange={handleChange}
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
  )
}

export function Part4({ t, showPassword, form, handleChange }: { t: NonNullable<RegisterPage['tr']>; showPassword: NonNullable<RegisterPage['showPassword']>; form: NonNullable<RegisterPage['form']>; handleChange: RegisterPage['handleChange'] }) {
  return (
    <Input
                  label={<>{t('register.password_label')} <span className="text-danger">*</span></>}
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  value={form.password}
                  onChange={handleChange}
                  required
                  autoComplete="new-password"
                  className="pr-10"
                  placeholder="••••••••"
                />
  )
}

export function Part5({ i, strength }: { i: NonNullable<RegisterPage['rows_items']>[number]['i']; strength: NonNullable<RegisterPage['strength']> }) {
  return (
    <div
                          key={i}
                          className="h-1 flex-1 rounded-full transition-all"
                          style={{ background: i < strength.score ? strength.color : '#e8eaed' }}
                        />
  )
}

export function Part6({ strength, t }: { strength: NonNullable<RegisterPage['strength']>; t: NonNullable<RegisterPage['tr']> }) {
  return (
    <span className="text-xs" style={{ color: strength.color }}>{t(strength.key)}</span>
  )
}

export function Part7({ t, form, handleChange }: { t: NonNullable<RegisterPage['tr']>; form: NonNullable<RegisterPage['form']>; handleChange: RegisterPage['handleChange'] }) {
  return (
    <Input
                label={<>{t('register.confirm_label')} <span className="text-danger">*</span></>}
                type="password"
                name="confirm"
                value={form.confirm}
                onChange={handleChange}
                required
                autoComplete="new-password"
                placeholder="••••••••"
              />
  )
}
