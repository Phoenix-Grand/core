/**
 * The data of the shell's user controls `WaffleMenu` and `AccountMenu`, and the services a host may hand
 * them - the web side of the shared contract (vskubuno `docs/SHELL-CONTROLS.md`): the same names and shapes
 * as the desktop's `kubuno-header` crate, plus the web-only fields marked below.
 */
import type { ComponentType } from 'react'

/** At most 9 favourites: the white card holds a 3×3 grid (`FAV_MAX`). */
export const FAVORITES_MAX = 9

/** One app of the launcher. */
export interface LauncherApp {
  /** The server's `sidebar_items[].id`: the key favourites are stored under. */
  id: string
  label: string
  /** A Kubuno icon name (a module logo such as `DriveLogo`, or a glyph); unknown → `Cloud`. */
  icon?: string
  /** A logo the server serves (its URL); wins over `icon`. */
  logo?: string
  /** Web only: the icon component a module registered (`WaffleAppRegistry`); wins over `icon` and `logo`. */
  Icon?: ComponentType<{ size?: number; className?: string }>
  /** Web only: the address the tile opens (a link: middle click opens it in a new tab). */
  href?: string
  /** The module the app belongs to: a module with several apps groups them under its label. */
  module?: string
  moduleLabel?: string
}

/** Where the launcher's data comes from and what it does with a launch or an edit. */
export interface LauncherService {
  apps(): LauncherApp[]
  /** The favourites exactly as the server holds them (unknown ids included). */
  favorites(): string[]
  launch(id: string): void
  saveFavorites(favorites: string[]): void
}

/** The active account. */
export interface AccountUser {
  /** The display name: the greeting uses its first word. */
  name: string
  email: string
  initials: string
  /** The photo's URL; absent → the initials on the accent. */
  avatar?: string
}

/** Another account the account panel lists. */
export interface AccountEntry {
  /** What `OpenAccount` / `RemoveAccount` report. */
  id: string
  name: string
  email: string
  /** The instance's host (`kubuno.asso-exemple.org`). */
  server: string
  initials?: string
  avatar?: string
  /** A usable session; false shows « Déconnecté » and a reconnect button. */
  connected: boolean
  /** Web only: an account of another Kubuno instance (opened in a new tab, its host shown on the row). */
  remote?: boolean
  /** Web only: that account's unread notifications (its own bucket, last known). */
  unread?: number
}

export interface AccountService {
  user(): AccountUser
  accounts(): AccountEntry[]
  canAdminister(): boolean
}

/** Args of `AppLaunched` (`TileInvoked` inside the grid). */
export interface AppEventArgs { id: string }
/** Args of `FavoritesEdited`. */
export interface FavoritesEventArgs { favorites: string[] }
/** Args of `EditModeChanged`. */
export interface EditModeEventArgs { editing: boolean }
/** Args of `ContentHeightChanged`. */
export interface ContentHeightEventArgs { height: number }
/** Args of `OpenAccount` / `RemoveAccount`. */
export interface AccountEventArgs { id: string }

/**
 * The favourites an « OK » saves: the shown ones in order, then the ids of no app of this launcher, kept from
 * the server's list (a launcher that knows fewer apps must not delete another one's favourites).
 */
export function savedFavorites(shown: readonly string[], server: readonly string[], apps: readonly LauncherApp[]): string[] {
  const known = new Set(apps.map((a) => a.id))
  return [...shown, ...server.filter((id) => !known.has(id) && !shown.includes(id))]
}

/**
 * A function of some inputs that returns the SAME result while the inputs are the same objects. A view's
 * bindings are read on every check of its elements: a getter building a new array each time would make
 * every check see a change (and React's external store loop forever).
 */
export function memoize<A extends readonly unknown[], R>(compute: (...args: A) => R): (...args: A) => R {
  let last: { args: A; result: R } | null = null
  return (...args: A): R => {
    if (last && last.args.length === args.length && last.args.every((a, k) => Object.is(a, args[k]))) return last.result
    const result = compute(...args)
    last = { args, result }
    return result
  }
}

/** Initials of a display name (« Camille Martin » → « CM »). */
export function initialsOf(name: string): string {
  return name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
}
