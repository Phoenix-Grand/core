// The scoped reading of ONE module's instance settings.
//
// A module's admin panel used to know a single value per setting — the one the
// whole instance runs on. But a setting a module declares `overridable` may
// legitimately differ from one organisational unit to the next, and the core
// has resolved settings per scope since migration `000060`
// (`GET /admin/settings/resolved`). What was missing was a way to ask that
// route about a MODULE rather than about the core, and a way to line the answer
// up with the module's own declarative schema.
//
// This file is that join, and nothing else — no React tree, no markup:
//
//   • the module's schema (`GET /modules/:id/config`) carries the PRESENTATION:
//     type, bounds, unit, placeholder, risk, `advanced`, `depends_on`, category;
//   • the resolved route carries the VALUE and its PROVENANCE: what applies at
//     the scope on screen, whether this scope holds its own row, what reverting
//     would restore, and which scopes below override it.
//
// Keys do not match on the two sides: a module declares `autosave_interval_s`,
// the core stores `notes.autosave_interval_s`. The prefix is added and stripped
// here, once, rather than at every call site.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../core/api/client'
import type { ActiveScope, ResolvedSetting, ResolvedSettingsResponse } from './scopeTypes'
import type { SettingItem } from './moduleSettingSchema'

/** `notes` + `autosave_interval_s` → `notes.autosave_interval_s`. */
export const prefixedKey = (moduleId: string, key: string) => `${moduleId}.${key}`

/**
 * Resolved values for one module at one scope, indexed by the SHORT key the
 * module's own schema uses.
 *
 * Disabled outright when the module has nothing that can vary by scope: asking
 * the core to resolve fifty keys that are instance-wide by declaration would
 * cost a request per scope change and answer nothing the schema did not already
 * say.
 */
export function useResolvedModuleSettings(
  moduleId: string,
  scope: ActiveScope,
  enabled: boolean,
) {
  const query = useQuery({
    queryKey: ['module-settings-resolved', moduleId, scope.type, scope.id] as const,
    queryFn: () =>
      api
        .get<ResolvedSettingsResponse>('/admin/settings/resolved', {
          params: {
            module_id:  moduleId,
            scope_type: scope.type,
            scope_id:   scope.id ?? undefined,
          },
        })
        .then(r => r.data.settings),
    enabled,
    // The panel re-reads on every save; a stale window only shortens the flicker
    // between two pages of the same module.
    staleTime: 5_000,
  })

  const byKey = useMemo(() => {
    const map = new Map<string, ResolvedSetting>()
    const head = `${moduleId}.`
    for (const s of query.data ?? []) {
      if (s.key.startsWith(head)) map.set(s.key.slice(head.length), s)
    }
    return map
  }, [query.data, moduleId])

  return { byKey, isLoading: query.isLoading, isError: query.isError }
}

/**
 * Can this setting hold a different value from one unit to the next?
 *
 * The module says so itself: `overridable` means "an administrator may pin this
 * for part of the instance", `global` means the value is the instance's and has
 * no per-unit meaning (a listener's port, a retry delay). The console must not
 * offer to override what the module cannot read per user.
 */
export const isScopable = (item: SettingItem) => item.scope === 'overridable'

/** Does this module expose anything at all that a unit could override? */
export const hasScopableSettings = (items: SettingItem[]) => items.some(isScopable)

/**
 * The three states a scoped value can be in, named once so the chip, the row
 * and the section counter cannot drift apart.
 *
 *  • `own`       — this scope holds its own row: the value was decided HERE.
 *  • `inherited` — the value comes from a level above and will keep following it.
 *  • `locked`    — a level above pinned it; the control is read-only here.
 */
export type Inheritance = 'own' | 'inherited' | 'locked'

export function inheritanceOf(resolved: ResolvedSetting | undefined): Inheritance | null {
  if (!resolved) return null
  if (resolved.locked_above) return 'locked'
  return resolved.has_own_value ? 'own' : 'inherited'
}
