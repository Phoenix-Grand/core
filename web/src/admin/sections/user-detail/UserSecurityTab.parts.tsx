/**
 * The parts of `UserSecurityTab.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Field } from "./atoms"
import type { UserSecurityTab } from './UserSecurityTab'

export function Part1({ t, user, user_oauth_provider }: { t: NonNullable<UserSecurityTab['tr']>; user: NonNullable<UserSecurityTab['props']['user']>; user_oauth_provider: string }) {
  return (
    <dl className="divide-y divide-border">
              <Field label={t('admin.ud_must_change_pw')}>
                {user.must_change_password ? t('admin.ud_flag_yes') : t('admin.ud_flag_no')}
              </Field>
              <Field label={t('admin.ud_auth_method')}>
                {user.oauth_provider
                  ? t('admin.ud_auth_oauth', { provider: user_oauth_provider })
                  : t('admin.ud_auth_password')}
              </Field>
            </dl>
  )
}
