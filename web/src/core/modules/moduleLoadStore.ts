import { create } from 'zustand'

/**
 * Why a module's UI bundle did not come up.
 *
 * `sdk-mismatch`  the bundle declares an SDK version the host does not speak
 *                 (the explicit version handshake caught it).
 * `import-error`  importing the bundle threw - most often an ES link error
 *                 ("does not provide an export named 'X'") when the module was
 *                 built against a newer SDK surface than the host serves, but
 *                 also any error thrown while the module's top level evaluates.
 * `no-register`   the bundle loaded but exposes no `register()` entry point.
 * `views-mismatch` the bundle's `.kbview` views were compiled for another plan ABI
 *                 (`viewsAbi`) than the host's `@kubuno/views` runtime reads.
 */
export type ModuleLoadFailureReason = 'sdk-mismatch' | 'import-error' | 'no-register' | 'views-mismatch'

export interface ModuleLoadFailure {
  moduleId: string
  reason: ModuleLoadFailureReason
  /** Operator-facing detail (the thrown message, or the version pair). */
  detail: string
  /** When it last happened, for a stable ordering in the feed. */
  at: string
}

interface ModuleLoadState {
  /** One entry per module that failed its LAST load attempt, newest first. */
  failures: ModuleLoadFailure[]
  /**
   * Record that a module failed to load. Keyed by `moduleId`: a later attempt
   * replaces the earlier record rather than stacking, so the feed reflects the
   * current state, not a history.
   */
  recordFailure: (f: Omit<ModuleLoadFailure, 'at'>) => void
  /** Drop a module's failure once it loads successfully (a retry recovered). */
  clearFailure: (moduleId: string) => void
}

/**
 * Client-side registry of modules whose UI bundle failed to load.
 *
 * The loader used to swallow these failures into `console.error`, so a module
 * that silently vanished from the shell left no trace an operator would see
 * without opening the devtools. This store is the trace: `useModuleLoadAlerts`
 * turns it into a bell notification for anyone who may read modules.
 */
export const useModuleLoadStore = create<ModuleLoadState>((set) => ({
  failures: [],
  recordFailure: (f) =>
    set((s) => ({
      failures: [
        { ...f, at: new Date().toISOString() },
        ...s.failures.filter((e) => e.moduleId !== f.moduleId),
      ],
    })),
  clearFailure: (moduleId) =>
    set((s) => {
      if (!s.failures.some((e) => e.moduleId === moduleId)) return s
      return { failures: s.failures.filter((e) => e.moduleId !== moduleId) }
    }),
}))
