import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, ShieldQuestion } from 'lucide-react'
import { Callout } from '@ui'
import { formatAgo, formatWhen } from '../../admin/sections/format'
import {
  authStrengthLabel, clientKindLabel, deviceTypeLabel, eventKindLabel,
  sessionName, signalLevelLabel, triLabel, triSkin,
} from './labels'
import type { Device, DeviceEvent, DeviceSession } from './types'

/**
 * The panels of a device sheet, shared by the administration screen and the
 * personal one.
 *
 * ── Why they are shared, rather than duplicated ──────────────────────────────
 * The product promise is that a user sees EXACTLY what an operator sees of
 * their own machines. A promise kept by two similar components is a promise
 * that survives until the first one-line change to one of them. Keeping a
 * single implementation makes the symmetry structural rather than aspirational.
 *
 * ── The labelling rule ───────────────────────────────────────────────────────
 * {@link DeviceFacts} renders what the SERVER OBSERVED. {@link DeclaredSignals}
 * renders what the DEVICE STATED, under a banner that says so, and its
 * tri-states show "unknown" as a neutral chip — because "nobody asked" is not a
 * finding, and must never be rendered like a passing check.
 */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 py-1.5">
      <span className="shrink-0 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
        {label}
      </span>
      <span className="min-w-0 break-words text-end text-text-primary"
        style={{ fontSize: 'var(--kb-text-meta)' }}>
        {children}
      </span>
    </div>
  )
}

/** Everything the server read off the requests. Verifiable. */
export function DeviceFacts({ device }: { device: Device }) {
  const { t, i18n } = useTranslation()
  const platform = [device.platform, device.platform_version].filter(Boolean).join(' ')
  const browser = [device.browser, device.browser_version].filter(Boolean).join(' ')

  return (
    <div className="divide-y divide-border">
      <Row label={t('devices.col_type')}>{deviceTypeLabel(t, device.device_type)}</Row>
      <Row label={t('devices.col_platform')}>{platform || t('devices.unknown_value')}</Row>
      <Row label={t('devices.field_browser')}>{browser || t('devices.unknown_value')}</Row>
      <Row label={t('devices.field_client')}>{clientKindLabel(t, device.client_kind)}</Row>
      <Row label={t('devices.field_last_ip')}>{device.last_ip ?? t('devices.unknown_value')}</Row>
      <Row label={t('devices.col_country')}>{device.last_country ?? t('devices.country_unknown')}</Row>
      <Row label={t('devices.col_signal')}>{signalLevelLabel(t, device.signal_level)}</Row>
      {/* How the device was recognised. A fingerprint is honestly weaker than a
          key, and saying so is the difference between an inventory and a claim. */}
      <Row label={t('devices.field_correlation')}>
        {t(`devices.correlation_${device.correlation_kind}`)}
      </Row>
      <Row label={t('devices.field_first_seen')}>
        {formatWhen(device.first_seen_at, i18n.language)}
      </Row>
      <Row label={t('devices.col_last_seen')}>{formatAgo(device.last_seen_at)}</Row>
    </div>
  )
}

/**
 * What a native application stated about itself.
 *
 * Never labelled "verified", anywhere, under any setting. The banner is not
 * dismissible and not conditional: it is the frame the values must be read in.
 */
export function DeclaredSignals({ device }: { device: Device }) {
  const { t, i18n } = useTranslation()
  const nothing = device.declared_at === null

  return (
    <div>
      <Callout variant="info" icon={<Info size={16} />} className="mb-3">
        {t('devices.declared_banner')}
      </Callout>

      {nothing ? (
        <p className="flex items-start gap-2 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          <ShieldQuestion size={16} className="mt-0.5 shrink-0" aria-hidden />
          {t('devices.declared_none')}
        </p>
      ) : (
        <div className="divide-y divide-border">
          <Row label={t('devices.field_disk')}>
            <span className={`inline-block rounded-full px-1.5 py-0.5 ${triSkin(device.disk_encrypted)}`}
              style={{ fontSize: 'var(--kb-text-micro)' }}>
              {triLabel(t, device.disk_encrypted)}
            </span>
          </Row>
          <Row label={t('devices.field_lock')}>
            <span className={`inline-block rounded-full px-1.5 py-0.5 ${triSkin(device.screen_lock)}`}
              style={{ fontSize: 'var(--kb-text-micro)' }}>
              {triLabel(t, device.screen_lock)}
            </span>
          </Row>
          <Row label={t('devices.field_declared_platform')}>
            {[device.declared_platform, device.declared_version].filter(Boolean).join(' ')
              || t('devices.unknown_value')}
          </Row>
          <Row label={t('devices.field_app_version')}>
            {device.declared_app_version ?? t('devices.unknown_value')}
          </Row>
          <Row label={t('devices.field_declared_at')}>
            {device.declared_at ? formatWhen(device.declared_at, i18n.language) : '—'}
          </Row>
        </div>
      )}
    </div>
  )
}

/** Live sessions of a device. Same rendering for both audiences. */
export function SessionList({ sessions, actions }: {
  sessions: DeviceSession[]
  /** Optional per-row control (the personal screen offers "sign out"). */
  actions?: (session: DeviceSession) => ReactNode
}) {
  const { t, i18n } = useTranslation()

  if (sessions.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
        {t('devices.sessions_none')}
      </p>
    )
  }

  return (
    <ul className="divide-y divide-border">
      {sessions.map(session => (
        <li key={session.id} className="flex min-w-0 items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-text-primary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {sessionName(t, session)}
            </p>
            <p className="break-words text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>
              {[
                session.ip_address ?? t('devices.unknown_value'),
                session.country ?? t('devices.country_unknown'),
                clientKindLabel(t, session.client_type),
                // "Which of these sessions never passed a second factor" is the
                // question a session list exists to answer.
                authStrengthLabel(t, session.auth_strength),
              ].join(' · ')}
            </p>
            <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>
              {t('devices.session_active', { ago: formatAgo(session.last_used_at) })}
              {' · '}
              {t('devices.session_opened', { when: formatWhen(session.created_at, i18n.language) })}
            </p>
          </div>
          {actions?.(session)}
        </li>
      ))}
    </ul>
  )
}

/** What has happened to a device. */
export function DeviceTimeline({ events }: { events: DeviceEvent[] }) {
  const { t, i18n } = useTranslation()

  if (events.length === 0) {
    return (
      <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
        {t('devices.timeline_none')}
      </p>
    )
  }

  return (
    <ol className="space-y-2.5">
      {events.map(event => (
        <li key={event.id} className="flex min-w-0 gap-2.5">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong" aria-hidden />
          <div className="min-w-0">
            <p className="break-words text-text-primary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {eventKindLabel(t, event.kind)}
              {event.actor_label ? ` — ${event.actor_label}` : ''}
            </p>
            {event.detail && (
              <p className="break-words text-text-secondary" style={{ fontSize: 'var(--kb-text-micro)' }}>
                {event.detail}
              </p>
            )}
            <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>
              {formatWhen(event.occurred_at, i18n.language)}
              {event.ip_address ? ` · ${event.ip_address}` : ''}
              {event.country ? ` · ${event.country}` : ''}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}
