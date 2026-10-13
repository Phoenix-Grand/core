/**
 * The parts of `SettingsMovedNotice.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Link } from "react-router-dom"
import { Callout } from "@ui"
import { NAV_INDEX } from "../../adminNav"
import { adminUrl } from "../../adminAction"
import type { SettingsMovedNotice } from './SettingsMovedNotice'

export function Part1({ t, targets }: { t: NonNullable<SettingsMovedNotice['tr']>; targets: NonNullable<SettingsMovedNotice['targets']> }) {
  return (
    <Callout variant="info" title={t('admin.moved_title')}>
            <p>{t('admin.moved_body')}</p>
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {targets.map(tab => (
                <Link
                  key={tab}
                  to={adminUrl({ tab })}
                  className="text-primary underline decoration-dotted underline-offset-2"
                >
                  {t(NAV_INDEX.get(tab)!.item.labelKey)}
                </Link>
              ))}
            </p>
          </Callout>
  )
}
