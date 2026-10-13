import type { AdminResult, AdminResultKind } from './adminSearchIndex'
import { ADMIN_HOME, tabFromPath } from '../adminRoute'

/**
 * The five targets this operator reached last, per browser.
 *
 * An admin console is used in bursts on the same handful of screens: an empty
 * field that offers nothing is a dead end, while one that offers "where you were
 * a minute ago" removes a navigation entirely. Local only — it is a convenience,
 * not a record, and it must never leave the machine.
 *
 * ── Scoped to the account, deliberately ──────────────────────────────────────
 * The key carries the signed-in user's id. A shared workstation is the norm in
 * administration, and an unscoped list would show the next operator — possibly a
 * delegate with far fewer privileges — the trail of the previous one: "Reset a
 * password", "Admin roles"… Naming a target is already telling someone it
 * exists, so the trail follows the account, not the browser.
 *
 * Stored data is deliberately minimal and inert: a label, a subtitle, a category
 * and an in-app URL. No identifier is kept beyond what the URL already carries,
 * and nothing is rendered as markup.
 */

const PREFIX = 'kb.admin.search.recents'
const LIMIT  = 5

export interface RecentTarget {
  kind:      AdminResultKind
  label:     string
  sublabel?: string
  url:       string
}

/** Storage key of one account's trail. Anonymous callers get none. */
const keyFor = (userId: string | null | undefined): string | null =>
  userId ? `${PREFIX}.${userId}` : null

const isRecent = (v: unknown): v is RecentTarget => {
  const r = v as RecentTarget
  return !!r && typeof r.label === 'string' && typeof r.url === 'string'
    // Only in-app admin destinations: a stored absolute URL would turn the
    // recents list into an open redirect the next time it is clicked.
    && r.url.startsWith('/admin')
}

export function readRecents(userId: string | null | undefined): RecentTarget[] {
  const key = keyFor(userId)
  if (!key) return []
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, LIMIT) : []
  } catch {
    // Private mode, quota, corrupted entry: recents are optional by design.
    return []
  }
}

/** Records a visit, most recent first, de-duplicated on the destination URL. */
export function pushRecent(userId: string | null | undefined, result: AdminResult): RecentTarget[] {
  const key = keyFor(userId)
  if (!key) return []
  const entry: RecentTarget = {
    kind: result.kind, label: result.label, sublabel: result.sublabel, url: result.url,
  }
  if (!isRecent(entry)) return readRecents(userId)
  const next = [entry, ...readRecents(userId).filter(r => r.url !== entry.url)].slice(0, LIMIT)
  try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* optional */ }
  return next
}

/**
 * The section a stored URL points at, or null when it addresses the landing page.
 *
 * Reads the path first (`/admin/users`) and falls back to the historic `?tab=`
 * form, because the list is persisted in localStorage: an operator's recents
 * were minted by the previous build and must not all resolve to the landing.
 */
export function recentTab(url: string): string | null {
  const q    = url.indexOf('?')
  const path = q < 0 ? url : url.slice(0, q)
  const tab  = tabFromPath(path)
  if (tab !== ADMIN_HOME) return tab
  if (q < 0) return null
  return new URLSearchParams(url.slice(q + 1)).get('tab')
}
