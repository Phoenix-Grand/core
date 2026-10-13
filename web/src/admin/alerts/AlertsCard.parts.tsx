/**
 * The parts of `AlertsCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Link } from "react-router-dom"
import { adminUrl } from "../adminAction"
import type { AlertsCard } from './AlertsCard'

export function Part1({ t }: { t: NonNullable<AlertsCard['tr']> }) {
  return (
    <Link to={adminUrl({ tab: 'alerts' })} className="shrink-0 text-primary hover:underline"
              style={{ fontSize: 'var(--kb-text-meta)' }}>
              {t('admin.card_manage')}
            </Link>
  )
}

export function Part2({ t, summary, top }: { t: NonNullable<AlertsCard['tr']>; summary: NonNullable<AlertsCard['summary']>; top: NonNullable<AlertsCard['top']> }) {
  return (
    <Link to={adminUrl({ tab: 'alerts' })} className="text-primary hover:underline"
                    style={{ fontSize: 'var(--kb-text-meta)' }}>
                    {t('admin.al_card_more', { count: summary.open - top.length })}
                  </Link>
  )
}
