/**
 * The host side of the design page: exactly what the running web gives a view - the host CSS (`index.css`, its
 * theme tokens and the production fonts at `fonts/`), the `@kubuno/views` host registrations (`viewsHost`: `@ui`,
 * the sdk workspace components, icons, `{Res}` through i18next), i18next with the core's translations, and the
 * Kubuno themes applied through the core's own theme store (`themeStore.applyTheme`: the theme's CSS variables,
 * colour scheme and global stylesheet).
 *
 * Imported first by both entries (project and bundled).
 */
import type { ComponentType } from 'react'
import * as lucide from 'lucide-react'

import '../../index.css'
import i18n from '../../core/i18n'
import '../../core/viewsHost'
import { setIconResolver } from '@kubuno/views'
import { useThemeStore, type ThemeDef } from '../../core/store/themeStore'
import { findIcon } from '../../core/utils/iconMap'

// The core's i18n sets the document's direction from the detected language; on the design page only the view's
// frame follows the design-time language (the surface's own chrome stays left-to-right).
document.documentElement.dir = 'ltr'

/**
 * Icons by name, as compiled views get them: a compiled plan imports any Lucide icon it names (`Icon="Pencil"` →
 * `import { Pencil } from 'lucide-react'`, aliases `trash` → `Trash2`, `close` → `X`), while the host's resolver
 * (`viewsHost`) only knows the Kubuno icon map. The designer renders interpreted plans, so it resolves the whole
 * Lucide set (the design page only; production bundles are not affected).
 */
const ICON_ALIASES: Readonly<Record<string, string>> = { trash: 'Trash2', close: 'X' }
type IconComponent = ComponentType<{ size?: number; color?: string; className?: string }>
const LUCIDE = lucide as unknown as Readonly<Record<string, IconComponent | undefined>>
setIconResolver((name) => (findIcon(name) as IconComponent | null) ?? LUCIDE[ICON_ALIASES[name] ?? name] ?? undefined)

export { i18n }

/** The languages the designer's toolbar offers. */
export const DESIGN_LANGUAGES = ['fr', 'en', 'ar'] as const
export const RTL_LANGUAGES = new Set(['ar', 'he'])

export type KubunoThemeMode = 'light' | 'dark'

/** The Kubuno theme of each mode (the core's built-in themes). */
export const THEME_IDS: Readonly<Record<KubunoThemeMode, string>> = { light: 'kubuno-reference', dark: 'kubuno-dark' }

const loading = new Map<string, Promise<ThemeDef | null>>()

/** Loads a theme definition from `<base>/<id>/theme.json` (its assets are served next to it). */
function loadTheme(base: string, id: string): Promise<ThemeDef | null> {
  let p = loading.get(id)
  if (!p) {
    p = fetch(`${base}/${id}/theme.json`)
      .then((r) => (r.ok ? (r.json() as Promise<ThemeDef>) : null))
      .then((def) => (def ? { ...def, id, builtin: true, assets_base: `${base}/${id}`, scripts_enabled: false } : null))
      .catch(() => null)
    loading.set(id, p)
  }
  return p
}

/**
 * Applies the Kubuno theme of `mode` with the core's theme store. Returns false when the theme files are not
 * available (the page keeps the default tokens of `theme.css`, which are the reference theme's).
 */
export async function applyKubunoTheme(base: string, mode: KubunoThemeMode): Promise<boolean> {
  const id = THEME_IDS[mode]
  const def = await loadTheme(base, id)
  if (!def) return false
  const store = useThemeStore.getState()
  const themes = [...store.themes.filter((t) => t.id !== id), def]
  useThemeStore.setState({ themes, isLoaded: true })
  useThemeStore.getState().applyTheme(id)
  return true
}
