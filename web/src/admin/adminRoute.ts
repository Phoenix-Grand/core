import { useMemo } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { NAV_INDEX, type AdminUrlShape } from './adminNav'

/**
 * ── The shape of an administration address ───────────────────────────────────
 *
 * A PLACE goes in the path; everything else goes in the query string:
 *
 *     /admin                                  the landing
 *     /admin/users                            a section (an `id` of ADMIN_NAV)
 *     /admin/users/<id>                       that section, one record open
 *     /admin/users/<id>/security              …on one of the record's panes
 *     /admin/resources/buildings              a section whose panes have no record
 *     /admin/users/<id>/security?action=reset-password
 *
 * What stays a parameter is what identifies no place: a filter (`q`, `filter`,
 * `status`, `severity`, `kind`, `assignee`), a highlight, a verb (`action`,
 * `id`).
 *
 * ── Why each section DECLARES its shape ──────────────────────────────────────
 *
 * The second segment is an id in `/admin/users/<uuid>` and a pane in
 * `/admin/resources/buildings`. Nothing in those two strings says which — and
 * guessing from the shape of the segment ("it looks like a UUID, so it is an
 * id") holds exactly until the first identifier that is not a UUID, then fails
 * silently on a URL an operator pasted.
 *
 * So the answer is not inferred, it is declared: every section that puts
 * anything after its own id carries an `url` block in `adminNav.ts` — the name
 * of its entity parameter, and the CLOSED list of its pane ids. Reading and
 * writing both go through this module, which reads that declaration; a section
 * that declares nothing simply keeps its parameters in the query string, which
 * is a degradation, never a misreading.
 *
 * Two rules the declaration must respect (both stated in `adminNav.ts`):
 *   • pane ids are stable, untranslated identifiers (`security`, `buildings`) —
 *     an address may not change shape with the interface language;
 *   • no record id may collide with one of the section's pane ids.
 *
 * ── Panes that belong to the record ──────────────────────────────────────────
 *
 * One section addresses panes it cannot enumerate: an installed module splits
 * its administration into pages IT declares (`/admin/modules/mail/filtering`),
 * and the core never knows a module by name. Such a section declares
 * `dynamicPanes: true` next to its `entity`, and the third segment is then
 * taken as a pane whatever it spells.
 *
 * That is still declaring rather than guessing: the shape — a record, then its
 * panes — is what the section states, and the flag only says whose vocabulary
 * fills the last segment. It cannot misread anything, because it is honoured in
 * THIRD position only: the record has already claimed the second segment, so no
 * "record or pane?" question is left to answer. And because a pane read this way
 * may name a page that no longer exists, the section owes a fallback (see
 * `ModuleAdminPage`) — never a blank screen.
 *
 * ── One builder, one reader ──────────────────────────────────────────────────
 *
 * `adminUrl()` is the only place an admin address is spelt: a caller passes
 * `params: { user: id, pane: 'security' }` and never has to know where those two
 * land. `useAdminParams()` does the reverse for the sections, republishing the
 * path segments under their parameter names — so a section keeps asking for
 * `params.get('user')` and knows nothing of any of this.
 *
 * ── Historic addresses ───────────────────────────────────────────────────────
 *
 * `/admin?tab=users&user=<id>&pane=security` is minted in alerts, in e-mails and
 * in operators' bookmarks. `AdminPage` rewrites any non-canonical spelling to
 * the canonical one (`canonicalAdminUrl`) with a history REPLACEMENT — an
 * addition would make the Back button bounce between the two forever.
 */

/** The landing section — the one that owns `/admin` itself, with no segment. */
export const ADMIN_HOME = 'home'

/** Root of the console. */
export const ADMIN_ROOT = '/admin'

/** The parameter carrying a pane. Its VALUE moves to the path; its name never does. */
const PANE_PARAM = 'pane'

/** How `tab` spells its address, as declared next to the menu leaf. */
export const urlShapeOf = (tab: string): AdminUrlShape | null =>
  NAV_INDEX.get(tab)?.item.url ?? null

/** Decodes one path segment, tolerating a malformed escape rather than throwing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** The segments under `/admin`, decoded. */
function adminSegments(pathname: string): string[] {
  if (!pathname.startsWith(ADMIN_ROOT)) return []
  return pathname
    .slice(ADMIN_ROOT.length)
    .split('/')
    .filter(Boolean)
    .map(decodeSegment)
}

/** What a `/admin/...` pathname says, once read through the section's declaration. */
export interface AdminPlace {
  tab:    string
  entity: string | null
  pane:   string | null
}

/**
 * Reads a pathname into a place.
 *
 * A segment the declaration does not account for is DROPPED rather than
 * guessed at — `canonicalAdminUrl` then rewrites the address without it, so a
 * malformed URL heals into a valid one instead of rendering something nobody
 * asked for.
 */
export function placeFromPath(pathname: string): AdminPlace {
  const [tab, second, third] = adminSegments(pathname)
  if (!tab) return { tab: ADMIN_HOME, entity: null, pane: null }

  const shape   = urlShapeOf(tab)
  const isPane  = (v: string | undefined) => !!v && !!shape?.panes?.includes(v)
  const hasEnt  = !!shape?.entity
  // A record's own vocabulary, readable only in third position — never in
  // second, where it would turn the record into a pane (see `dynamicPanes`).
  const dynamic = hasEnt && !!shape?.dynamicPanes

  // Three segments: the record, then one of its panes.
  if (third !== undefined) {
    const pane = isPane(third) || dynamic ? third : null
    return { tab, entity: hasEnt ? second : null, pane }
  }
  // Two: a pane when the section declares that id as one, the record otherwise.
  if (second !== undefined) {
    if (isPane(second)) return { tab, entity: null, pane: second }
    return { tab, entity: hasEnt ? second : null, pane: null }
  }
  return { tab, entity: null, pane: null }
}

/** The section a pathname addresses (the landing when it addresses none). */
export const tabFromPath = (pathname: string): string => placeFromPath(pathname).tab

/**
 * Does this section spell `pane` in the path — and, for a section whose panes
 * belong to its record, is there a record for it to belong to?
 *
 * The `hasRecord` guard is what keeps `dynamicPanes` to third position on the
 * writing side too: `/admin/modules/<something>` must always mean the module
 * `<something>`, never a pane with no module.
 */
function spellsPane(shape: AdminUrlShape | null, pane: string, hasRecord: boolean): boolean {
  if (shape?.panes?.includes(pane)) return true
  return !!shape?.dynamicPanes && !!shape.entity && hasRecord
}

/**
 * Path of a place. The caller passes what it means; where each piece lands is
 * decided here, from the section's declaration.
 */
export function adminPath(tab?: string | null, entity?: string | null, pane?: string | null): string {
  const id = (tab ?? '').trim()
  if (!id || id === ADMIN_HOME) return ADMIN_ROOT

  const shape = urlShapeOf(id)
  const rec   = shape?.entity ? (entity ?? '').trim() : ''
  const p     = pane && spellsPane(shape, pane, !!rec) ? pane : ''

  const segments = [id]
  if (rec) segments.push(rec)
  // A pane without a record is the shape of a section whose panes stand alone
  // (`/admin/resources/buildings`); with one, it reads inside the record.
  if (p) segments.push(p)
  return `${ADMIN_ROOT}/${segments.map(encodeURIComponent).join('/')}`
}

/** Everything a caller may want to address, as one object. */
export interface AdminUrlTarget {
  /** Navigable leaf of ADMIN_NAV. `home` addresses `/admin`. */
  tab:     string
  /** The verb. Omitted for a target that is a place, not a task. */
  action?: string
  /** The resource the verb applies to, when it needs one. */
  id?:     string
  /** What the destination reads — `user`, `pane`, `q`… Placed by the declaration. */
  params?: Record<string, string | number | null | undefined>
}

/**
 * Builds the canonical URL of a target — the single place an admin address is
 * spelt. See `adminUrl` in adminAction.ts, which is the name callers use.
 */
export function buildAdminUrl(target: AdminUrlTarget): string {
  const shape   = urlShapeOf(target.tab)
  const given   = target.params ?? {}
  const value   = (k: string) => {
    const v = given[k]
    return v === null || v === undefined || v === '' ? null : String(v)
  }

  const entity = shape?.entity ? value(shape.entity) : null
  const paneIn = value(PANE_PARAM)
  const pane   = paneIn && spellsPane(shape, paneIn, !!entity) ? paneIn : null

  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(given)) {
    // Whatever went into the path must not be repeated in the query string.
    if (entity !== null && k === shape?.entity) continue
    if (pane !== null && k === PANE_PARAM) continue
    if (v !== null && v !== undefined && v !== '') p.set(k, String(v))
  }
  // Appended last so the verb reads at the end of the address, after the place.
  if (target.action) p.set('action', target.action)
  if (target.id) p.set('id', target.id)

  const qs   = p.toString()
  const base = adminPath(target.tab, entity, pane)
  return qs ? `${base}?${qs}` : base
}

/**
 * The address you are at, with a few parameters changed — "stay here, but open
 * that record" / "switch pane". A `null` (or empty) value drops the parameter.
 *
 * Sections used to spell this by hand (`new URLSearchParams(params)`, then
 * `/admin?…`), which is precisely how a section keeps writing a URL form the
 * console has moved on from.
 */
export function adminUrlWith(
  tab:     string,
  current: URLSearchParams,
  changes: Record<string, string | number | null | undefined>,
): string {
  const params: Record<string, string | number | null | undefined> = {}
  current.forEach((value, key) => { if (key !== 'tab') params[key] = value })
  Object.assign(params, changes)
  return buildAdminUrl({ tab, params })
}

/** The section currently on screen, read from the path. */
export function useAdminTab(): string {
  return tabFromPath(useLocation().pathname)
}

/**
 * The whole place currently on screen — section, open record, pane.
 *
 * What `useAdminTab` gives is enough to highlight a menu SECTION; a menu that
 * also lists records (the installed modules under Applications) has to tell
 * `/admin/modules` from `/admin/modules/drive`, which is the record this reads.
 */
export function useAdminPlace(): AdminPlace {
  const { pathname } = useLocation()
  return useMemo(() => placeFromPath(pathname), [pathname])
}

/**
 * What a section reads: the query string, plus the path segments republished
 * under the parameter names the section already asks for.
 *
 * One translation, here, instead of every section learning where its id is
 * spelt — which is what keeps `params.get('user')` working unchanged.
 */
export function useAdminParams(): URLSearchParams {
  const { pathname } = useLocation()
  const [search]     = useSearchParams()
  const key          = search.toString()
  return useMemo(
    () => sectionParams(pathname, search),
    // `search` is a fresh object on every render; its content is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname, key],
  )
}

/** Non-hook form of `useAdminParams`, for callers that already hold both. */
export function sectionParams(pathname: string, search: URLSearchParams): URLSearchParams {
  const { tab, entity, pane } = placeFromPath(pathname)
  const entityKey = urlShapeOf(tab)?.entity
  if (!(entityKey && entity) && !pane) return search

  const merged = new URLSearchParams(search)
  if (entityKey && entity) merged.set(entityKey, entity)
  if (pane) merged.set(PANE_PARAM, pane)
  return merged
}

/**
 * The canonical spelling of the current address, or `null` when it already is
 * canonical.
 *
 * Covers every historic form in ONE hop — `/admin?tab=users&user=<id>&pane=security`
 * goes straight to `/admin/users/<id>/security`, never through an intermediate —
 * and is idempotent: fed its own output, it returns `null`.
 */
/**
 * Section ids that were renamed, mapped to their current spelling.
 *
 * A renamed section is not a query-param migration `canonicalAdminUrl` already
 * handles — it is a different path segment — so a bookmark to the old id would
 * otherwise land on "Section introuvable". `speech-to-text` became
 * `voice-search` when the feature stopped being framed as a module.
 */
const SECTION_ALIASES: Record<string, string> = {
  'speech-to-text': 'voice-search',
}

export function canonicalAdminUrl(pathname: string, search: URLSearchParams): string | null {
  const legacyTab = search.get('tab')
  const place     = placeFromPath(pathname)
  const rawTab    = legacyTab ?? place.tab
  const tab       = SECTION_ALIASES[rawTab] ?? rawTab

  const params: Record<string, string> = {}
  search.forEach((value, key) => { if (key !== 'tab') params[key] = value })

  // With `?tab=`, the path carried no section, hence no segments to lift: the
  // values can only have come from the query, where `buildAdminUrl` finds them.
  if (legacyTab === null) {
    const entityKey = urlShapeOf(tab)?.entity
    if (entityKey && place.entity) params[entityKey] = place.entity
    if (place.pane) params[PANE_PARAM] = place.pane
  }

  // Both sides are normalised by URLSearchParams, so the comparison sees a
  // difference in CONTENT, never one in spelling.
  const qs      = search.toString()
  const current = qs ? `${pathname}?${qs}` : pathname
  const target  = buildAdminUrl({ tab, params })
  return target === current ? null : target
}
