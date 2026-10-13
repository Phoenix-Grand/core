import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { PRIV } from '../authz/types'
import { usePrivileges } from '../authz/usePrivileges'
import { useAlerts, useAlertSummary } from '../../admin/alerts/useAlerts'
import { alertSummary, alertTitle } from '../../admin/alerts/labels'
import { EMPTY_FILTERS } from '../../admin/alerts/types'
import { adminUrl } from '../../admin/adminAction'
import { useNotificationStore } from '../store/notificationStore'

/**
 * Feeds the header bell from the alert centre.
 *
 * ── Why this hook exists ─────────────────────────────────────────────────────
 * `notificationStore` was purely client-side: a `push()` API with **no backend
 * and no producer**, so the bell had been empty since it was written. This is
 * its first producer, and it is the one that matters — the bell is where an
 * operator learns something is wrong without opening the console.
 *
 * ── The rules it respects ────────────────────────────────────────────────────
 * * **Only holders of `core.alerts.read` ask.** The bell renders for every
 *   signed-in user; firing a 403 per page load for everybody else is the exact
 *   pattern this codebase already removed once from the privileges resolution.
 * * **Announced once.** `pushKeyed` is keyed on the alert id, so a queue polled
 *   every minute does not re-cry the same news — including after the reader
 *   dismissed it.
 * * **Only what is new.** An acknowledged alert has an owner; telling everybody
 *   again is how a bell becomes noise.
 * * **The store's cap is untouched** (50, newest first): the feed pushes, it
 *   does not manage the list.
 */
export function useAlertFeed(): void {
  const { t } = useTranslation()
  const { can } = usePrivileges()
  const pushKeyed = useNotificationStore(s => s.pushKeyed)

  const enabled = can(PRIV.ALERTS_READ)
  // The summary shares its cache entry with the landing card and the queue, so
  // this costs nothing on a page that already asked.
  useAlertSummary(enabled)
  const { data } = useAlerts(EMPTY_FILTERS, enabled)

  useEffect(() => {
    if (!enabled) return
    const rows = data?.pages?.[0]?.alerts ?? []
    // Oldest first, so the newest alert ends up on top of the list.
    for (const alert of [...rows].reverse()) {
      if (alert.status !== 'new') continue
      pushKeyed(`alert:${alert.id}`, {
        title:    alertTitle(t, alert),
        body:     alertSummary(t, alert),
        moduleId: 'core',
        icon:     'Bell',
        link:     adminUrl({ tab: 'alerts', params: { alert: alert.id } }),
      })
    }
  }, [enabled, data, pushKeyed, t])
}
