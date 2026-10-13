import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import {
  Building2, Contact, FileText, Package, Search, SlidersHorizontal, type LucideIcon,
} from 'lucide-react'
import { api } from '../../core/api/client'
import type { OrgUnit, User, UserGroup } from '../../core/types'
import { PRIV, type CanFn } from '../../core/authz/types'
import { NAV_INDEX, canSeeTab, firstLeafId, navPathLabels } from '../adminNav'
import { actionUrl, isSoonTarget, visibleActions } from '../adminActions'
import { adminUrl } from '../adminAction'
import { tabForSetting } from '../settings/settingsMap'
import {
  KIND_ORDER, demoteSoon, fold, queryTerms, rankCategory, scoreEntry, scoreLoose,
  type AdminResult, type AdminResultKind, type Folded,
} from './adminSearchIndex'

/**
 * Everything the admin search can find, and the rules that decide what shows.
 *
 * ── Where each category comes from ───────────────────────────────────────────
 *   actions   the static registry (adminActions.ts)
 *   users     the server, debounced — the only source that cannot be held locally
 *   groups    /admin/groups, matched locally
 *   units     /admin/org-units, matched locally
 *   modules   /admin/modules, matched locally
 *   settings  /admin/settings, matched locally (label, key and description)
 *   pages     the navigation tree
 *
 * ── Two deliberate decisions ─────────────────────────────────────────────────
 *
 * NO DEBOUNCE ON LOCAL SOURCES. Debouncing exists to spare the *server*; making
 * a local list wait 200 ms only makes typing feel broken. The server query keeps
 * its debounce, every other category recomputes on the keystroke.
 *
 * PRIVILEGE FIRST, ALWAYS. Every query is `enabled` on the privilege it needs,
 * and every local category is filtered by the same predicate the navigation
 * uses. Not for tidiness: a search that answers "no such user" only when the
 * name is wrong is an enumeration oracle, and a listed setting the caller cannot
 * open still tells them it exists.
 */

/** How many rows each category may contribute. */
export interface Caps { action: number; user: number; group: number; module: number; setting: number; page: number; 'org-unit': number }

export const DESKTOP_CAPS: Caps = { action: 5, user: 4, group: 3, 'org-unit': 4, module: 4, setting: 5, page: 6 }
/** Mobile is not a narrower desktop: fewer rows, so the list stays one thumb-reach. */
export const MOBILE_CAPS:  Caps = { action: 4, user: 3, group: 2, 'org-unit': 2, module: 2, setting: 3, page: 3 }

interface AdminModule { id: string; display_name: string; version: string; description: string | null; is_enabled: boolean }
interface AdminSetting { key: string; label: string | null; description: string | null; category: string }

export interface SearchSourcesArgs {
  /** Raw field content — local categories use it directly, with no delay. */
  query:      string
  /** Debounced copy, for the server-side user search only. */
  debounced:  string
  /** Fetch at all? False until the operator opens the panel. */
  enabled:    boolean
  can:        CanFn
  isSuperuser: boolean
  t:          TFunction
  caps:       Caps
}

export interface SearchSources {
  /** Flat, keyboard-ordered result list (already capped and demoted). */
  results:     AdminResult[]
  /** Actions offered when the field is empty. */
  suggestions: AdminResult[]
  /** Closest entries when nothing matched — the way out of an empty list. */
  nearMisses:  AdminResult[]
  /** A server round trip is still in flight for the current query. */
  usersLoading: boolean
}

export function useAdminSearchSources(args: SearchSourcesArgs): SearchSources {
  const { query, debounced, enabled, can, isSuperuser, t, caps } = args

  // ── Sources ───────────────────────────────────────────────────────────────
  const users = useQuery({
    queryKey: ['admin-user-search', debounced],
    queryFn:  () => api.get<{ users: User[] }>('/admin/users', { params: { search: debounced, limit: 6 } })
      .then(r => r.data.users),
    enabled:   enabled && debounced.length >= 2 && can(PRIV.USERS_READ),
    staleTime: 30_000,
  })

  // Same query keys as the panels themselves, so opening the search warms their
  // cache instead of duplicating it.
  const groups = useQuery({
    queryKey: ['admin-groups'],
    queryFn:  () => api.get<{ groups: UserGroup[] }>('/admin/groups').then(r => r.data.groups),
    enabled:  enabled && can(PRIV.GROUPS_READ), staleTime: 60_000,
  })

  const orgUnits = useQuery({
    queryKey: ['admin-org-units'],
    queryFn:  () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
    enabled:  enabled && can(PRIV.ORG_UNITS_READ), staleTime: 60_000,
  })

  const modules = useQuery({
    queryKey: ['admin-modules'],
    queryFn:  () => api.get<{ modules: AdminModule[] }>('/admin/modules').then(r => r.data.modules),
    enabled:  enabled && can(PRIV.MODULES_READ), staleTime: 60_000,
  })

  const settings = useQuery({
    queryKey: ['admin-settings'],
    queryFn:  () => api.get<{ settings: AdminSetting[] }>('/admin/settings').then(r => r.data.settings),
    enabled:  enabled && can(PRIV.SETTINGS_READ), staleTime: 60_000,
  })

  // ── Catalogues (folded once per language / privilege change) ──────────────
  const actionIndex = useMemo(() => visibleActions(can, isSuperuser).map(a => {
    const label = t(a.labelKey)
    const soon  = isSoonTarget(a.target.tab)
    return {
      folded: fold(label, t(a.keysKey, { defaultValue: '' })),
      result: {
        key: `action:${a.id}`, kind: 'action' as const, label,
        segments: navPathLabels(t, a.target.tab), url: actionUrl(a),
        Icon: a.Icon, soon, score: 0,
      } satisfies AdminResult,
    }
  }), [can, isSuperuser, t])

  const pageIndex = useMemo(() => {
    const out: { folded: Folded; result: AdminResult }[] = []
    for (const meta of NAV_INDEX.values()) {
      const id = meta.item.id
      if (id === 'home') continue
      // Hidden in the menu means hidden here: the search must not enumerate what
      // the navigation deliberately refuses to show.
      if (!canSeeTab(id, can)) continue
      const label    = t(meta.item.labelKey)
      const segments = navPathLabels(t, id)
      out.push({
        // The ancestors are part of the haystack: "sécurité sso" must find the
        // leaf even though its own label says neither.
        folded: fold(label, segments.join(' ')),
        result: {
          key: `page:${id}`, kind: 'page', label, segments, url: adminUrl({ tab: firstLeafId(id) }),
          Icon: NAV_INDEX.get(meta.topId)?.item.Icon, soon: !!meta.item.soon, score: 0,
        },
      })
    }
    return out
  }, [can, t])

  // ── Matching ──────────────────────────────────────────────────────────────
  const terms = useMemo(() => queryTerms(query), [query])

  const matched = useMemo(() => {
    if (terms.length === 0) return [] as AdminResult[]
    const hit = (idx: { folded: Folded; result: AdminResult }[]): AdminResult[] =>
      idx.map(e => ({ ...e.result, score: scoreEntry(e.folded, terms) })).filter(r => r.score > 0)

    const byKind: Record<AdminResultKind, AdminResult[]> = {
      action:     hit(actionIndex),
      page:       hit(pageIndex),
      user:       (users.data ?? []).map((u, i) => ({
        key: `user:${u.id}`, kind: 'user' as const,
        label: u.display_name || u.username, sublabel: u.email, avatarUrl: u.avatar_url,
        url: adminUrl({ tab: 'users', params: { user: u.id } }),
        // The server already ranked and filtered — decreasing scores preserve
        // its order through the generic sort.
        score: 1000 - i,
      })),
      group:      matchLocal(groups.data, g => fold(g.name, g.description ?? ''), g => ({
        key: `group:${g.id}`, kind: 'group', label: g.name, sublabel: g.description ?? undefined,
        url: adminUrl({ tab: 'groups', params: { q: g.name } }), Icon: Contact, score: 0,
      }), terms),
      'org-unit': matchLocal(orgUnits.data, u => fold(u.name, u.description ?? ''), u => ({
        key: `ou:${u.id}`, kind: 'org-unit', label: u.name, sublabel: u.description ?? undefined,
        url: adminUrl({ tab: 'org-units', params: { q: u.name } }), Icon: Building2, score: 0,
      }), terms),
      module:     matchLocal(modules.data, m => fold(m.display_name, `${m.id} ${m.description ?? ''}`), m => ({
        key: `module:${m.id}`, kind: 'module', label: m.display_name, sublabel: `v${m.version}`,
        // Opens that module's settings in place — a verb, not a tab change.
        url: adminUrl({ tab: 'modules', action: 'settings', id: m.id }), Icon: Package, score: 0,
      }), terms),
      // The destination is read from the cartography, never hard-coded: a
      // setting that moves to another page must keep being findable, and the
      // page it lands on is the one that actually paints it.
      setting:    matchLocal(
        // A setting whose page this caller may not open must not be listed:
        // naming it is already telling them it exists, and the link would only
        // land them on a refusal.
        (settings.data ?? []).filter(s => canSeeTab(tabForSetting(s.key), can)),
        s => fold(s.label ?? s.key, `${s.key} ${s.description ?? ''}`), s => ({
        key: `setting:${s.key}`, kind: 'setting', label: s.label ?? s.key, sublabel: s.key,
        url: adminUrl({ tab: tabForSetting(s.key), params: { highlight: s.key } }),
        Icon: SlidersHorizontal, score: 0,
      }), terms),
    }

    const flat: AdminResult[] = []
    for (const kind of KIND_ORDER) flat.push(...rankCategory(byKind[kind], caps[kind]))
    return demoteSoon(flat)
  }, [terms, actionIndex, pageIndex, users.data, groups.data, orgUnits.data, modules.data, settings.data, caps, can])

  // ── Empty field: a few things worth doing ─────────────────────────────────
  const suggestions = useMemo(
    () => actionIndex.filter(a => !a.result.soon).slice(0, 4).map(a => a.result),
    [actionIndex],
  )

  // ── Empty result list: the closest entries, so it is not a dead end ───────
  const nearMisses = useMemo(() => {
    if (terms.length === 0 || matched.length > 0) return []
    return [...actionIndex, ...pageIndex]
      .map(e => ({ ...e.result, score: scoreLoose(e.folded, terms) }))
      .filter(r => r.score > 0 && !r.soon)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
  }, [terms, matched.length, actionIndex, pageIndex])

  return {
    results: matched,
    suggestions,
    nearMisses,
    usersLoading: users.isFetching,
  }
}

/** Folds, scores and keeps the hits of one locally-held collection. */
function matchLocal<T>(
  rows:  T[] | undefined,
  key:   (row: T) => Folded,
  build: (row: T) => AdminResult,
  terms: string[],
): AdminResult[] {
  if (!rows?.length) return []
  const out: AdminResult[] = []
  for (const row of rows) {
    const score = scoreEntry(key(row), terms)
    if (score > 0) out.push({ ...build(row), score })
  }
  return out
}

/** Fallback glyph when a result carries none. */
export const KIND_ICON: Record<AdminResultKind, LucideIcon> = {
  action:     Search,
  user:       Contact,
  group:      Contact,
  'org-unit': Building2,
  module:     Package,
  setting:    SlidersHorizontal,
  page:       FileText,
}

/** Category headings, in paint order. */
export const KIND_LABEL_KEY: Record<AdminResultKind, string> = {
  action:     'admin.search_cat_actions',
  user:       'admin.search_cat_users',
  group:      'admin.search_cat_groups',
  'org-unit': 'admin.nav_org_units',
  module:     'admin.search_cat_modules',
  setting:    'admin.search_cat_settings',
  page:       'admin.search_cat_pages',
}

/** "View all" destination of a category header, when one makes sense. */
export const KIND_VIEW_ALL: Partial<Record<AdminResultKind, (q: string) => string>> = {
  user:       q => adminUrl({ tab: 'users',     params: { q } }),
  group:      q => adminUrl({ tab: 'groups',    params: { q } }),
  'org-unit': q => adminUrl({ tab: 'org-units', params: { q } }),
  module:     () => adminUrl({ tab: 'modules' }),
}
