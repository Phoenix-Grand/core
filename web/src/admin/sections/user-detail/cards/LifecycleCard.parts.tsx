/**
 * The parts of `LifecycleCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { formatAgo, formatDay } from "../../format"
import { Field } from "../atoms"
import type { LifecycleCard } from './LifecycleCard'

export function Part1({ t, user, i18n, user_last_login_at }: { t: NonNullable<LifecycleCard['tr']>; user: NonNullable<LifecycleCard['props']['user']>; i18n: NonNullable<LifecycleCard['i18n']>; user_last_login_at: string }) {
  return (
    <dl className="divide-y divide-border">
            <Field label={t('admin.ud_created')}>{formatDay(user.created_at, i18n.language)}</Field>
            <Field label={t('admin.ud_updated')}>{formatDay(user.updated_at, i18n.language)}</Field>
            <Field label={t('admin.ud_last_login')}>
              {user.last_login_at ? (
                <span className="flex flex-wrap items-baseline gap-2">
                  <span>{formatDay(user_last_login_at, i18n.language)}</span>
                  <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                    {formatAgo(user_last_login_at)}
                  </span>
                </span>
              ) : (
                <span className="text-text-tertiary">{t('admin.never')}</span>
              )}
            </Field>
          </dl>
  )
}
