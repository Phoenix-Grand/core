import { create } from 'zustand'
import { invalidateViews } from '@kubuno/views'
import { modulesApi } from '../api/modules'
import { loadRemoteModules } from '../modules/loadRemoteModules'
import type { ActiveModule, SidebarItem } from '../types'

// The left panel has no default item any more: neither modules nor "Home" (the
// home page stays reachable through the logo). The panel therefore only shows
// when a module provides its own navigation; otherwise it is hidden/collapsed.
const CORE_ITEMS: SidebarItem[] = []

interface ModulesState {
  activeModules: ActiveModule[]
  sidebarItems: SidebarItem[]
  isLoading: boolean
  /** `false` until the FIRST load of the modules has finished. On a hard
   *  reload of a module route (F5 on /drive), the UI bundles are loaded at run
   *  time, asynchronously: while this flag is false the router must NOT show a
   *  404 (the module's route is not registered yet) but a loading screen. */
  modulesReady: boolean
  /** Incremented each time a module bundle is loaded at run time. Components
   *  reading non-reactive registries (RouteRegistry) subscribe to it to render
   *  again once the module's routes are registered. */
  loadedVersion: number

  fetchModules: () => Promise<void>
}

export const useModulesStore = create<ModulesState>((set) => ({
  activeModules: [],
  sidebarItems: CORE_ITEMS,
  isLoading: false,
  modulesReady: false,
  loadedVersion: 0,

  fetchModules: async () => {
    set({ isLoading: true })
    try {
      const { data } = await modulesApi.list()
      // Modules are no longer shown in the left panel by default: only the core
      // items are kept. The modules stay registered (`activeModules`) for routing
      // and for loading their UI bundles.
      set({ activeModules: data.modules, sidebarItems: CORE_ITEMS })
      // Loads the modules' UI bundles at run time (a no-op for those already
      // loaded). Bumps loadedVersion when new routes/slots appeared.
      const n = await loadRemoteModules(data.modules)
      if (n > 0) {
        set((s) => ({ loadedVersion: s.loadedVersion + 1 }))
        // The live `.kbview` screens compute again what they memoized from the registries the modules just filled
        // (home widgets, notification groups, the top bar's settings override): a TSX screen recomputed those on
        // the re-render this bump causes, a view keeps its memos until told - as after a language change.
        invalidateViews()
      }
    } catch {
      // Keep the core items if the API fails
    } finally {
      set({ isLoading: false, modulesReady: true })
    }
  },
}))
