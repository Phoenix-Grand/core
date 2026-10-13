/**
 * The parts of `RequestStatus.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { AlertTriangle } from "lucide-react"
import { Badge, Callout } from "@ui"
import { formatBytes, formatDay } from "../../../../admin/sections/format"
import { type MyExportRun } from "./api"
import type { RequestStatus } from './RequestStatus'

function StatusBadge({ run }: { run: MyExportRun }) {
  const { t } = useTranslation()
  switch (run.status) {
    case 'pending':
    case 'running':
      return <Badge variant="primary">{t('settings.mde_st_running', { defaultValue: 'En cours' })}</Badge>
    case 'ready':
      return run.downloadable
        ? <Badge variant="success">{t('settings.mde_st_ready', { defaultValue: 'Prête' })}</Badge>
        : <Badge variant="neutral">{t('settings.mde_st_over', { defaultValue: 'Terminée' })}</Badge>
    case 'expired':
      return <Badge variant="neutral">{t('settings.mde_st_expired', { defaultValue: 'Expirée' })}</Badge>
    case 'cancelled':
      return <Badge variant="neutral">{t('settings.mde_st_cancelled', { defaultValue: 'Annulée' })}</Badge>
    default:
      return <Badge variant="danger">{t('settings.mde_st_failed', { defaultValue: 'Échec' })}</Badge>
  }
}
export { StatusBadge }

export function Part1({ t, latest, locale }: { t: NonNullable<RequestStatus['tr']>; latest: NonNullable<RequestStatus['latest']>; locale: NonNullable<RequestStatus['props']['locale']> }) {
  return (
    <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2"
                  style={{ fontSize: 'var(--kb-text-meta)' }}>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">
                    {t('settings.mde_size', { defaultValue: 'Taille' })}
                  </dt>
                  <dd className="text-text-primary">{formatBytes(latest.size_bytes ?? 0)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">
                    {t('settings.mde_expires', { defaultValue: 'Expire le' })}
                  </dt>
                  <dd className="text-text-primary">{formatDay(latest.expires_at, locale)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">
                    {t('settings.mde_left', { defaultValue: 'Téléchargements restants' })}
                  </dt>
                  <dd className="text-text-primary">
                    {latest.downloads_left ?? t('settings.mde_unlimited', { defaultValue: 'illimité' })}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">
                    {t('settings.mde_requested', { defaultValue: 'Demandée le' })}
                  </dt>
                  <dd className="text-text-primary">{formatDay(latest.requested_at, locale)}</dd>
                </div>
              </dl>
  )
}

export function Part2({ t }: { t: NonNullable<RequestStatus['tr']> }) {
  return (
    <Callout variant="warning" icon={<AlertTriangle size={18} />}>
              {t('settings.mde_failed_desc', {
                defaultValue:
                  'La dernière préparation n’a pas abouti. Vous pouvez en relancer une ; si cela se reproduit, signalez-le à l’administrateur de votre instance.',
              })}
            </Callout>
  )
}
