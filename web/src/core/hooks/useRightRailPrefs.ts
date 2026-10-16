import { useCallback, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../api/client'
import { appIdFromPath } from '../store/panelPrefs'
import { useAuthStore } from '../store/authStore'
import { useRightPanelStore, type RailEntry } from '../store/rightPanelStore'
import type { User } from '../types'

/**
 * User customisation of the right rail: which module panels appear, and in which
 * order. Same storage contract as the waffle launcher's favourites - the user's
 * server-side `preferences`, with a localStorage cache so the rail is still right
 * on a cold start or offline.
 *
 * Shape is `{ order, hidden }` rather than a plain list of visible ids. With a
 * single list, a module INSTALLED LATER would be absent from it and therefore
 * invisible forever, with nothing in the interface explaining why. Here an unknown
 * entry is simply not hidden, so it shows up at the end and can then be moved.
 */
const LS_KEY = 'kubuno-right-rail'

export interface RightRailPrefs {
  order:  string[]
  hidden: string[]
}

const EMPTY: RightRailPrefs = { order: [], hidden: [] }

function fromUser(user: User | null): RightRailPrefs | null {
  const v = user?.preferences?.right_rail as RightRailPrefs | undefined
  if (!v || typeof v !== 'object') return null
  const arr = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
  return { order: arr(v.order), hidden: arr(v.hidden) }
}

function fromCache(): RightRailPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')
    return v && typeof v === 'object' ? { order: v.order ?? [], hidden: v.hidden ?? [] } : EMPTY
  } catch { return EMPTY }
}

/** Apply the saved order/visibility to the live entries. */
export function applyPrefs(entries: RailEntry[], prefs: RightRailPrefs): RailEntry[] {
  const rank = new Map(prefs.order.map((id, i) => [id, i]))
  const hidden = new Set(prefs.hidden)
  return entries
    .filter(e => !hidden.has(e.moduleId))
    // Unknown ids sort last, keeping their registration order between themselves.
    .sort((a, b) => (rank.get(a.moduleId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.moduleId) ?? Number.MAX_SAFE_INTEGER))
}

export function useRightRailPrefs() {
  const user       = useAuthStore(s => s.user)
  const updateUser = useAuthStore(s => s.updateUser)
  const entries    = useRightPanelStore(s => s.entries)
  const closePanel = useRightPanelStore(s => s.closePanel)
  const activeId   = useRightPanelStore(s => s.activeModuleId)

  const prefs = useMemo(() => fromUser(user) ?? fromCache(), [user])

  /* A module's own panel is hidden while you are IN that module: it would offer a
   * cramped copy of the page you are already looking at. The customisation dialog
   * still lists it - it is contextually irrelevant, not disabled. */
  const { pathname } = useLocation()
  const currentApp = appIdFromPath(pathname)

  const visible = useMemo(
    () => applyPrefs(entries, prefs).filter(e => e.moduleId !== currentApp),
    [entries, prefs, currentApp],
  )

  // Same rule for an already-open panel: walking into the module must close it,
  // otherwise the panel outlives the button that opened it.
  useEffect(() => {
    if (activeId && activeId === currentApp) closePanel()
  }, [activeId, currentApp, closePanel])

  const save = useCallback((next: RightRailPrefs) => {
    // Cache first so the rail is correct even if the request fails.
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch { /* best-effort */ }
    // A panel that has just been hidden must not stay open behind the rail.
    if (activeId && next.hidden.includes(activeId)) closePanel()
    // One atomic write of the whole object - no read-modify-write of a bag, which is
    // what made the module preferences race (see useModulePrefs).
    api.patch<{ user: User }>('/me', { preferences: { right_rail: next } })
      .then(({ data }) => { if (data?.user) updateUser({ preferences: data.user.preferences }) })
      .catch(() => { /* the localStorage cache is the fallback */ })
  }, [activeId, closePanel, updateUser])

  return { prefs, entries, visible, save }
}
