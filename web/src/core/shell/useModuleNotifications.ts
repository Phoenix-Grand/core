import { useEffect, useRef } from 'react'
import { useWsStore } from '../store/wsStore'
import { useNotificationStore } from '../store/notificationStore'
import { useAuthStore } from '../store/authStore'

/**
 * Feeds the header bell from every module's real-time notifications.
 *
 * ── Why this hook exists ─────────────────────────────────────────────────────
 * The bell is the ONE shared place a signed-in user learns something happened,
 * across all modules. A module must not grow its own bell: it emits a WebSocket
 * `Custom` event whose `event_type` ends in `.notification`, and this hook turns
 * any such event addressed to the current user into a bell entry. Adding a
 * module needs no change here.
 *
 * ── The contract a module emits ──────────────────────────────────────────────
 * A module POSTs an `AppEvent::Custom` to `/internal/events/publish`; the core
 * targets it to `recipient_user_ids` and forwards it, so the browser receives:
 *   `{ type: "event", payload: { type: "Custom", payload: {
 *       event_type: "<module>.notification", module_id,
 *       payload: { recipient_user_ids, notification_id|id, title, body, link?, icon? }
 *   } } }`
 * The core has already restricted delivery to the recipients; the extra check
 * below is defence-in-depth (and picks the browser's active account).
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 * * **Only mine.** An event not listing the active user is ignored - a broadcast
 *   is not a personal notification.
 * * **Announced once.** `pushKeyed` is keyed on `<module>:<id>`, so a module that
 *   folds several events into one id (an aggregated "5 replies") lands as a
 *   single, non-repeating entry, and a WS replay after a reconnect never re-cries
 *   the same news.
 */
export function useModuleNotifications(): void {
  const messages = useWsStore(s => s.messages)
  const pushKeyed = useNotificationStore(s => s.pushKeyed)
  const meId = useAuthStore(s => s.user?.id)
  const cursor = useRef(0)

  useEffect(() => {
    if (!meId) { cursor.current = messages.length; return }
    for (let i = cursor.current; i < messages.length; i++) {
      const msg = messages[i] as { type?: string; payload?: unknown }
      if (msg?.type !== 'event') continue
      const appEvent = msg.payload as { type?: string; payload?: unknown } | undefined
      if (appEvent?.type !== 'Custom') continue
      const outer = appEvent.payload as { event_type?: string; module_id?: string; payload?: Record<string, unknown> } | undefined
      if (typeof outer?.event_type !== 'string' || !outer.event_type.endsWith('.notification')) continue

      const p = outer.payload ?? {}
      const recipients = (p.recipient_user_ids as string[] | undefined) ?? []
      if (!recipients.includes(meId)) continue
      const id = (p.notification_id as string | undefined) ?? (p.id as string | undefined)
      if (!id) continue

      const moduleId = outer.module_id ?? 'core'
      pushKeyed(`${moduleId}:${id}`, {
        title:    (p.title as string | undefined) ?? 'Notification',
        body:     (p.body as string | undefined) ?? '',
        moduleId,
        icon:     (p.icon as string | undefined) ?? 'Bell',
        link:     p.link as string | undefined,
      })
    }
    cursor.current = messages.length
  }, [messages, meId, pushKeyed])
}
