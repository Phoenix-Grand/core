/**
 * The parts of `ResetPasswordDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Input } from "@ui"
import type { ResetPasswordDialog } from './ResetPasswordDialog'

export function Part1({ password, setPassword, setError, t }: { password: NonNullable<ResetPasswordDialog['password']>; setPassword: NonNullable<ResetPasswordDialog['setPassword']>; setError: NonNullable<ResetPasswordDialog['setError']>; t: NonNullable<ResetPasswordDialog['tr']> }) {
  return (
    <Input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); setError(null) }}
                placeholder={t('pwreset.password')}
                hint={t('pwreset.password_hint')}
                autoComplete="new-password"
                autoFocus
              />
  )
}
