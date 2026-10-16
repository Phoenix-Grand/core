import { useMemo } from 'react'
import { useAuthStore } from '../store/authStore'
import { useModulesStore } from '../store/modulesStore'
import { WaffleAppRegistry, type WaffleApp } from '../registry/WaffleAppRegistry'
import type { User } from '../types'

// Same source of truth as the waffle app launcher (WaffleMenu): favourites live
// in the user's preferences, with a localStorage cache as an offline fallback.
const FAV_KEY = 'kubuno-waffle-favorites'

function favsFromUser(user: User | null): string[] | null {
  const v = user?.preferences?.waffle_favorites
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
}

function loadFav(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

/**
 * The user's favourite apps (from the waffle launcher), resolved to live
 * WaffleApp entries and ordered as saved. Empty until module bundles register
 * their apps - recomputed when `loadedVersion` bumps.
 */
export function useFavoriteApps(): WaffleApp[] {
  const user = useAuthStore(s => s.user)
  const activeModules = useModulesStore(s => s.activeModules)
  const loadedVersion = useModulesStore(s => s.loadedVersion)

  const allApps = useMemo(() => activeModules.flatMap(m => {
    const entry = WaffleAppRegistry.get(m.module_id)
    return entry ? entry.apps.map(a => ({ ...a, moduleId: entry.moduleId, moduleLabel: entry.label })) : []
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [activeModules, loadedVersion])

  const favIds = favsFromUser(user) ?? loadFav()

  return useMemo(() => {
    const byId = new Map(allApps.map(a => [a.id, a]))
    return favIds.map(id => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a)
  }, [allApps, favIds.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
}
