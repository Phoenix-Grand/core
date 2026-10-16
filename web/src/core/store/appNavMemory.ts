// Per-tab memory of the last visited location within each application, keyed by
// waffle app id (e.g. 'drive', 'paintsharp-apex'). Lets the app launcher bring
// the user back exactly where they left off instead of the app's root route -
// leaving an app within a tab no longer "closes" it.
//
// sessionStorage = scoped to a single tab and survives a reload (F5), matching
// the "same browser tab" requirement.

const KEY = 'kubuno.appNav.v1'

type Store = Record<string, string>

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
    // Ignore quota / private-mode failures: best-effort persistence.
  }
}

export const appNavMemory = {
  /** Last full path (pathname + search + hash) visited within the app, if any. */
  get(appId: string): string | undefined {
    return read()[appId]
  },
  set(appId: string, fullPath: string): void {
    const s = read()
    if (s[appId] === fullPath) return
    s[appId] = fullPath
    write(s)
  },
}
