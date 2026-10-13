import { useModulesStore } from '../store/modulesStore'
import { usePrivileges } from '../authz/usePrivileges'
import { WaffleAppRegistry, type WaffleApp } from '../registry/WaffleAppRegistry'
import { ADMIN_APP_ID } from '../../admin/useAdminConsoleApp'

/**
 * The full set of tiles the app launcher shows, shared by the desktop header
 * and the mobile FAB so neither can drift from the other.
 *
 * It is the active modules' apps (each tagged with its parent module so the
 * launcher can group sub-modules), plus — for anyone who may enter the
 * administration surface — a tile that opens the console. The admin tile is not
 * a module: it is grafted here, exactly as the console's own menu grafts the
 * marketplace link, and only when `isAdmin` grants it, so an ordinary user
 * never sees a door that would only refuse them.
 */
export function useWaffleApps(): WaffleApp[] {
  const { activeModules } = useModulesStore()
  const { isAdmin }       = usePrivileges()

  const apps = activeModules.flatMap((m) => {
    const entry = WaffleAppRegistry.get(m.module_id)
    // moduleId/moduleLabel are attached so the launcher can group a module's
    // sub-modules together (Office, PaintSharp…).
    return entry ? entry.apps.map(a => ({ ...a, moduleId: entry.moduleId, moduleLabel: entry.label })) : []
  })

  // The console's entry is registered by `useAdminConsoleApp` like a module's;
  // it is grafted here by hand because the console is not an active module.
  const admin = WaffleAppRegistry.get(ADMIN_APP_ID)
  if (isAdmin && admin) {
    apps.push(...admin.apps.map(a => ({ ...a, moduleId: admin.moduleId, moduleLabel: admin.label })))
  }

  return apps
}
