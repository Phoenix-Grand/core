import { useCallback, useMemo } from 'react'
import { api } from '../../core/api/client'
import { useAuthStore } from '../../core/store/authStore'
import type { User } from '../../core/types'

/**
 * Which panels an operator keeps, and in which order - for any panelled page.
 *
 * Same storage contract as the right rail and the launcher's favourites: the
 * account's server-side `preferences`, so the layout follows the person to
 * whatever machine they administer from, with a localStorage mirror so a cold
 * start or an offline reload still opens on their page rather than on the
 * factory one.
 *
 * ## Why `{ order, hidden }` and not a list of visible ids
 *
 * A single list of what to show freezes the page at the day it was saved: a
 * panel added by a later version would be absent from that list and therefore
 * invisible forever, with nothing on screen explaining why. Here an id nobody
 * has ever seen is simply *not hidden* - it appears at the end, where it can then
 * be moved or dismissed. The same reasoning applies in reverse: an id in `order`
 * that no longer exists is ignored rather than reserving a hole.
 *
 * ## One hook, several dashboards
 *
 * Each page passes its own preference key, its own mirror key and its own
 * factory order; everything else - the atomic write, the merge rules, the reset
 * - is identical, and identical is the point. Two dashboards that remembered
 * their layout by two different disciplines would eventually disagree about what
 * "reset" means.
 */

export interface PanelLayout {
  order:  string[]
  hidden: string[]
}

export interface PanelLayoutKeys {
  /** Key inside the account's `preferences` object. */
  pref:  string
  /** Key of the localStorage mirror. */
  cache: string
  /** The factory arrangement, restored by `reset`. */
  defaultOrder: string[]
}

const EMPTY: PanelLayout = { order: [], hidden: [] }

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []
}

function fromUser(user: User | null, key: string): PanelLayout | null {
  const v = user?.preferences?.[key] as Partial<PanelLayout> | undefined
  if (!v || typeof v !== 'object') return null
  return { order: strings(v.order), hidden: strings(v.hidden) }
}

function fromCache(key: string): PanelLayout {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!v || typeof v !== 'object') return EMPTY
    const o = v as Partial<PanelLayout>
    return { order: strings(o.order), hidden: strings(o.hidden) }
  } catch { return EMPTY }
}

/**
 * The saved layout applied to the ids that actually exist right now.
 *
 * `available` is what the catalogue AND the server both know about, so a panel
 * withheld for lack of a privilege never occupies a slot in the ordering an
 * operator is looking at.
 */
export function applyLayout(available: string[], layout: PanelLayout): string[] {
  const rank = new Map(layout.order.map((id, i) => [id, i]))
  const hidden = new Set(layout.hidden)
  return available
    .filter(id => !hidden.has(id))
    // An id the saved order never mentioned sorts last, keeping the catalogue's
    // own order between such ids - a new panel lands at the end, not at random.
    .sort((a, b) =>
      (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER))
}

export function usePanelLayout(keys: PanelLayoutKeys) {
  const user       = useAuthStore(s => s.user)
  const updateUser = useAuthStore(s => s.updateUser)
  const { pref, cache, defaultOrder } = keys

  const layout = useMemo(
    () => fromUser(user, pref) ?? fromCache(cache),
    [user, pref, cache],
  )

  const save = useCallback((next: PanelLayout) => {
    // Mirror first, so the page is right even if the request never lands.
    try { localStorage.setItem(cache, JSON.stringify(next)) } catch { /* best-effort */ }
    // ONE atomic write of the whole object - never a read-modify-write of a bag,
    // which is what made the module-preferences race.
    api.patch<{ user: User }>('/me', { preferences: { [pref]: next } })
      .then(({ data }) => { if (data?.user) updateUser({ preferences: data.user.preferences }) })
      .catch(() => { /* the mirror is the fallback */ })
  }, [updateUser, pref, cache])

  /** Removes a panel from the page, keeping its place in the ordering. */
  const hide = useCallback((id: string, visible: string[]) => {
    save({
      // The current arrangement is written down as it is seen, so hiding a panel
      // cannot silently reorder the rest by falling back to the catalogue order.
      order:  visible,
      hidden: [...new Set([...layout.hidden, id])],
    })
  }, [layout.hidden, save])

  const show = useCallback((id: string, visible: string[]) => {
    save({
      order:  [...visible, id],
      hidden: layout.hidden.filter(h => h !== id),
    })
  }, [layout.hidden, save])

  /** Moves a panel one slot earlier or later among the visible ones. */
  const move = useCallback((id: string, delta: -1 | 1, visible: string[]) => {
    const from = visible.indexOf(id)
    const to   = from + delta
    if (from < 0 || to < 0 || to >= visible.length) return
    const next = [...visible]
    next.splice(from, 1)
    next.splice(to, 0, id)
    save({ order: next, hidden: layout.hidden })
  }, [layout.hidden, save])

  const reset = useCallback(
    () => save({ order: defaultOrder, hidden: [] }),
    [save, defaultOrder],
  )

  return { layout, hide, show, move, reset }
}
