import { create } from 'zustand'

/* Per-module appearance preference (light/dark/system + colour scheme + density).
 * Distinct from the GLOBAL theme (themeStore): this is a per-module override the user
 * sets from the settings menu's "Apparence" dialog. Applied by ModuleArea to the
 * module's own `[data-module]` container, so it scopes to that module's rendering only.
 * Persisted in localStorage (durable, per browser) keyed by module id. */

export type AppearanceMode = 'light' | 'dark' | 'system'

export interface ModuleAppearance {
  mode:    AppearanceMode
  /** Colour scheme id - modules/themes may honour it via [data-kb-scheme]. */
  scheme:  string
  /** Information density - honoured via [data-kb-density]. */
  density: string
}

export const APPEARANCE_DEFAULT: ModuleAppearance = { mode: 'system', scheme: 'modern', density: 'responsive' }

// Choices surfaced by the Apparence dialog. Kept here so the dialog and any consumer
// share one source of truth.
export const APPEARANCE_SCHEMES  = ['modern', 'classic', 'high-contrast'] as const
export const APPEARANCE_DENSITIES = ['responsive', 'comfortable', 'compact'] as const

const KEY = 'kubuno.appearance.v1'

function read(): Record<string, ModuleAppearance> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
}
function write(store: Record<string, ModuleAppearance>): void {
  try { localStorage.setItem(KEY, JSON.stringify(store)) } catch { /* best-effort */ }
}

interface AppearanceState {
  byModule: Record<string, ModuleAppearance>
  get: (moduleId: string) => ModuleAppearance
  set: (moduleId: string, patch: Partial<ModuleAppearance>) => void
}

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  byModule: read(),
  get: (moduleId) => get().byModule[moduleId] ?? APPEARANCE_DEFAULT,
  set: (moduleId, patch) => set((s) => {
    const next = { ...s.byModule, [moduleId]: { ...(s.byModule[moduleId] ?? APPEARANCE_DEFAULT), ...patch } }
    write(next)
    return { byModule: next }
  }),
}))
