import { useEffect, useRef } from 'react'
import { useWsStore } from '../store/wsStore'
import { getPublicConfig, invalidatePublicConfig, type PublicConfig } from '../api/publicConfig'
import { useMaintenanceStore, type MaintenanceNotice } from './maintenanceStore'

/** Extracts the active notices carried by `/api/v1/config`. */
function noticesFromConfig(config: PublicConfig): MaintenanceNotice[] {
  const raw = (config as Record<string, unknown>)['maintenance.notices']
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (n): n is MaintenanceNotice =>
      !!n && typeof n === 'object' && typeof (n as { scope?: unknown }).scope === 'string',
  )
}

/**
 * Keeps the maintenance banner state in sync from two sources:
 *
 *  - **`/api/v1/config`** - the snapshot read on mount and re-read whenever the
 *    WebSocket (re)connects, so a client that loads mid-operation, or that missed
 *    events while offline, shows the true state.
 *  - **the `maintenance` WebSocket channel** - real-time `start`/`end` events
 *    that add or remove a banner the instant an operation begins or ends.
 *
 * Mount it once, high in the shell.
 */
export function useMaintenanceNotices(): void {
  const messages = useWsStore((s) => s.messages)
  const connected = useWsStore((s) => s.connected)
  const seed = useMaintenanceStore((s) => s.seed)
  const start = useMaintenanceStore((s) => s.start)
  const end = useMaintenanceStore((s) => s.end)

  const cursor = useRef(0)
  const prevConnected = useRef(false)

  // Seed from /config on mount.
  useEffect(() => {
    let cancelled = false
    getPublicConfig()
      .then((c) => { if (!cancelled) seed(noticesFromConfig(c)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [seed])

  // Re-seed on every disconnected -> connected transition (recover missed events).
  useEffect(() => {
    if (connected && !prevConnected.current) {
      invalidatePublicConfig()
      getPublicConfig()
        .then((c) => seed(noticesFromConfig(c)))
        .catch(() => {})
    }
    prevConnected.current = connected
  }, [connected, seed])

  // Apply live start/end events from the WS buffer, using a cursor so each
  // message is processed once.
  useEffect(() => {
    for (let i = cursor.current; i < messages.length; i++) {
      const msg = messages[i] as { type?: string; payload?: unknown } | undefined
      if (msg?.type !== 'maintenance') continue
      const p = (msg.payload ?? {}) as {
        action?: string
        id?: string
        scope?: string
        message?: string
        kind?: string
        started_at?: string
      }
      if (p.action === 'start' && p.id && p.scope) {
        start({
          id: p.id,
          scope: p.scope,
          message: p.message ?? '',
          kind: p.kind ?? 'maintenance',
          started_at: p.started_at ?? new Date().toISOString(),
        })
      } else if (p.action === 'end') {
        end(p.id, p.scope)
      }
    }
    cursor.current = messages.length
  }, [messages, start, end])
}
