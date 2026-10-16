// Per-tab (sessionStorage), per-application persistence of the left/right panel
// expand state. `sessionStorage` is scoped to a single tab and survives a reload
// (F5), which matches the requirement: each tab remembers, per application, the
// last expanded/collapsed state of both panels - restored on reload or when
// returning to the application later within the same tab.

const KEY = 'kubuno.panelPrefs.v1'

/* Left sidebar width bounds (desktop, expanded only).
 * MIN = the historical width (`lg:w-64`) and the default. MAX stays close to the
 * content: a navigation panel rarely needs more, and going far beyond would just add
 * blank space. The user can drag between the two; the choice is remembered per app. */
export const SIDEBAR_WIDTH = { MIN: 256, MAX: 360, DEFAULT: 256 } as const

/* Right panel width bounds. DEFAULT is the historical fixed 320px. MAX is generous
 * because this panel holds CONTENT (notes, tasks, an agenda), not navigation - the
 * reason the left rail stops at 360 does not apply here. */
export const RIGHT_PANEL_WIDTH = { MIN: 280, MAX: 560, DEFAULT: 320 } as const

export interface AppPanelPrefs {
  /** Left sidebar collapsed. */
  left?: boolean
  /** Right panel: id of the open module panel, or `null` when closed. */
  right?: string | null
  /** Left sidebar width in px (expanded state), clamped to SIDEBAR_WIDTH bounds. */
  width?: number
  /** Right panel width in px, clamped to RIGHT_PANEL_WIDTH bounds. */
  rightWidth?: number
}

type Store = Record<string, AppPanelPrefs>

function read(): Store {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || '{}') as Store
  } catch {
    return {}
  }
}

function write(store: Store): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // Ignore quota / private-mode failures: persistence is best-effort.
  }
}

/** Identify the current "application" by the first path segment ('home' for '/'). */
export function appIdFromPath(pathname: string): string {
  return pathname.split('/').filter(Boolean)[0] || 'home'
}

export const panelPrefs = {
  get(appId: string): AppPanelPrefs {
    return read()[appId] ?? {}
  },
  setLeft(appId: string, collapsed: boolean): void {
    const s = read()
    s[appId] = { ...s[appId], left: collapsed }
    write(s)
  },
  setRight(appId: string, moduleId: string | null): void {
    const s = read()
    s[appId] = { ...s[appId], right: moduleId }
    write(s)
  },
  setWidth(appId: string, width: number): void {
    const s = read()
    s[appId] = { ...s[appId], width }
    write(s)
  },
  setRightWidth(appId: string, rightWidth: number): void {
    const s = read()
    s[appId] = { ...s[appId], rightWidth }
    write(s)
  },
}
