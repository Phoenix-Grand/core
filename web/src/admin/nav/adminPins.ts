import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '../../core/store/authStore'

/**
 * The handful of admin pages this operator keeps coming back to.
 *
 * An administration console has fifteen sections and something like sixty
 * pages, and any given operator works in four of them. The reference console
 * this one takes its shape from answers that with a short, hand-curated list at
 * the very top of the menu - the pages you chose, above the tree you have to
 * walk. This is that list.
 *
 * ── What is stored, and where ────────────────────────────────────────────────
 * Nothing but tab ids (`users`, `domains`) - the same ids `ADMIN_NAV` declares,
 * so a pin is re-resolved against the live tree on every render: a section that
 * is renamed follows, one that disappears simply stops being shown, and a pin
 * can never point at a page this administrator may not open (the tree is
 * pruned to their privileges before the pins are matched against it).
 *
 * Local only, like the search trail next to it: a preference, not a record.
 *
 * ── Scoped to the account, deliberately ─────────────────────────────────────
 * The key carries the signed-in user's id. A shared workstation is the norm in
 * administration, and an unscoped list would show the next operator - possibly
 * a delegate with far fewer privileges - the shortcuts of the previous one.
 */

const PREFIX = 'kb.admin.nav.pins'

/** How many pages may be pinned. Past five the list stops being a shortcut. */
export const PIN_LIMIT = 5

/** Storage key of one account's pins. Anonymous callers get none. */
const keyFor = (userId: string | null | undefined): string | null =>
  userId ? `${PREFIX}.${userId}` : null

function readPins(userId: string | null | undefined): string[] {
  const key = keyFor(userId)
  if (!key) return []
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, PIN_LIMIT)
  } catch {
    // Private mode, quota, corrupted entry: pins are optional by design.
    return []
  }
}

function writePins(userId: string | null | undefined, pins: string[]): void {
  const key = keyFor(userId)
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify(pins)) } catch { /* optional */ }
}

export interface AdminPins {
  /** Pinned tab ids, in the order they were pinned. */
  pins:     string[]
  isPinned: (tab: string) => boolean
  /** Pins an unpinned tab (unless the list is full) or unpins a pinned one. */
  toggle:   (tab: string) => void
  /** False once the list is full - the pin control is then offered on pinned rows only. */
  canPin:   boolean
}

/**
 * The pins of the signed-in account, as state.
 *
 * Meant for ONE mount (the navigation tree): the value is held in component
 * state rather than in a store, so nothing else can hold a stale copy of it.
 */
export function useAdminPins(): AdminPins {
  const userId = useAuthStore(s => s.user?.id ?? null)
  const [pins, setPins] = useState<string[]>(() => readPins(userId))

  // The list follows the account: signing in as somebody else must not inherit
  // the previous operator's shortcuts.
  useEffect(() => { setPins(readPins(userId)) }, [userId])

  // Computed OUTSIDE the state updater: writing to storage from inside one
  // would run twice per toggle under the double-invoked updaters of strict mode.
  const toggle = useCallback((tab: string) => {
    const next = pins.includes(tab)
      ? pins.filter(p => p !== tab)
      : pins.length >= PIN_LIMIT ? pins : [...pins, tab]
    if (next === pins) return
    writePins(userId, next)
    setPins(next)
  }, [pins, userId])

  const isPinned = useCallback((tab: string) => pins.includes(tab), [pins])

  return { pins, isPinned, toggle, canPin: pins.length < PIN_LIMIT }
}
