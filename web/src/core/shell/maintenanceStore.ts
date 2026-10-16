import { create } from 'zustand'

/**
 * One active maintenance notice, mirroring the backend `MaintenanceNotice`
 * (served by `/api/v1/config` under `maintenance.notices` and pushed live over
 * the `maintenance` WebSocket channel). `scope` is `"global"` (whole instance)
 * or a module id (that module only).
 */
export interface MaintenanceNotice {
  id: string
  scope: string
  message: string
  kind: string
  started_at: string
}

interface MaintenanceState {
  notices: MaintenanceNotice[]
  /** Replace the whole set - used to seed from `/config` on load and reconnect. */
  seed: (notices: MaintenanceNotice[]) => void
  /** A `start` event: add the notice if not already present. */
  start: (notice: MaintenanceNotice) => void
  /** An `end` event: drop it by id, or by scope when no id is given. */
  end: (id: string | undefined, scope: string | undefined) => void
}

export const useMaintenanceStore = create<MaintenanceState>((set) => ({
  notices: [],
  seed: (notices) => set({ notices: Array.isArray(notices) ? [...notices] : [] }),
  start: (notice) =>
    set((s) =>
      s.notices.some((n) => n.id === notice.id)
        ? s
        : { notices: [...s.notices, notice] },
    ),
  end: (id, scope) =>
    set((s) => ({
      notices: s.notices.filter((n) => (id ? n.id !== id : n.scope !== scope)),
    })),
}))

/** The active instance-wide notice, if any. */
export function useGlobalMaintenance(): MaintenanceNotice | undefined {
  return useMaintenanceStore((s) => s.notices.find((n) => n.scope === 'global'))
}

/** The active notice for one module, if any. */
export function useModuleMaintenance(moduleId: string): MaintenanceNotice | undefined {
  return useMaintenanceStore((s) => s.notices.find((n) => n.scope === moduleId))
}
