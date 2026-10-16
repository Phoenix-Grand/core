import { create } from 'zustand'
import axios from 'axios'
import { getPublicConfig } from '../api/publicConfig'
import * as React from 'react'
import * as UI from '@ui'
import { ComponentRegistry } from '@ui'

/** A CSS/JS pair a theme provides, globally or for a targeted module. */
export interface ThemeAsset {
  css?:    string
  script?: string
}

export interface ThemeDef {
  id:                 string
  name:               string
  color_scheme:       'light' | 'dark' | string
  version?:           string
  theme_api_version?: number
  vars:               Record<string, string>
  /** Global skin (applies everywhere). */
  global?:            ThemeAsset
  /** Per-module skins - only the listed modules are affected. */
  modules?:           Record<string, ThemeAsset>
  builtin?:           boolean
  /** True if the bundle ships JS overrides. */
  has_scripts?:       boolean
  /** True if the admin trusts this theme to run its JS. */
  scripts_enabled?:   boolean
  /** Base URL for bundled assets, e.g. `/api/v1/themes/<id>`. */
  assets_base?:       string
}

interface ThemeState {
  themes:        ThemeDef[]
  activeThemeId: string
  isLoaded:      boolean

  fetchThemes:             () => Promise<void>
  applyTheme:              (id: string) => void
  /** Inject the active theme's overrides for a module that just loaded. */
  applyThemeModuleAssets:  (moduleId: string) => void
  /** Load a theme's component overrides into the ISOLATED preview scope (admin
   *  pane) without applying it to the live app. Only loads JS for trusted themes. */
  loadThemePreview:        (theme: ThemeDef) => void
  clearThemePreview:       () => void
}

const STORAGE_KEY = 'kubuno_theme'

// Theme API contract version. A theme declares `theme_api_version`; the host
// refuses to run scripts built against an incompatible contract.
const THEME_API_VERSION = 1

// ── Runtime bookkeeping (module-level: survives store recreation) ──────────────

let currentTheme: ThemeDef | null = null
// CSS variable names set by the current theme - cleared when switching away.
const appliedVarNames = new Set<string>()
// `${themeId}:${moduleId}` for module scripts already imported (idempotence).
const loadedModuleScripts = new Set<string>()
// Whether the current theme's global script has already been imported.
let globalScriptLoaded = false

function scriptsAllowed(theme: ThemeDef): boolean {
  if (!theme.scripts_enabled) return false
  const v = theme.theme_api_version ?? THEME_API_VERSION
  if (v !== THEME_API_VERSION) {
    console.warn(`[theme] ${theme.id} : theme_api v${v} ≠ host v${THEME_API_VERSION} - scripts ignorés`)
    return false
  }
  return true
}

/** Object handed to a theme's script so it can register overrides without
 *  importing anything (shares the host's React/@ui singletons). When `preview`
 *  is set, overrides land in the isolated preview scope instead of the live app. */
function makeThemeApi(theme: ThemeDef, moduleId?: string, preview = false) {
  return {
    React,
    ui: UI,
    components: {
      register:   (key: string, Component: React.ComponentType<unknown>, opts?: { moduleId?: string }) =>
        preview
          ? ComponentRegistry.registerPreview(key, Component)
          : ComponentRegistry.register(key, Component, opts),
      unregister: (key: string, opts?: { moduleId?: string }) =>
        preview ? undefined : ComponentRegistry.unregister(key, opts),
    },
    theme: {
      id:          theme.id,
      name:        theme.name,
      colorScheme: theme.color_scheme,
      vars:        theme.vars,
    },
    moduleId,
  }
}

function injectCss(url: string, key: string) {
  if (document.querySelector(`link[data-kbtheme="${key}"]`)) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = url
  link.dataset.kbtheme = key
  document.head.appendChild(link)
}

async function loadThemeScript(url: string, api: ReturnType<typeof makeThemeApi>) {
  try {
    const mod = await import(/* @vite-ignore */ url)
    const reg = (mod.register ?? mod.default) as ((api: unknown) => void) | undefined
    if (typeof reg === 'function') reg(api)
    else console.warn(`[theme] ${url} : pas d'export register() - ignoré`)
  } catch (err) {
    console.error(`[theme] échec du script ${url}`, err)
  }
}

function teardownCurrentTheme() {
  // Remove every theme-injected stylesheet/style and drop component overrides.
  document
    .querySelectorAll('link[data-kbtheme], style[data-kbtheme]')
    .forEach((n) => n.remove())
  ComponentRegistry.clearAll()
  const root = document.documentElement
  for (const name of appliedVarNames) root.style.removeProperty(name)
  appliedVarNames.clear()
  loadedModuleScripts.clear()
  globalScriptLoaded = false
  currentTheme = null
}

/** Active modules = those whose bundle stylesheet is mounted (`data-kbmod`). */
function activeModuleIds(): string[] {
  return Array.from(document.querySelectorAll('link[data-kbmod]'))
    .map((n) => (n as HTMLElement).dataset.kbmod)
    .filter((id): id is string => !!id)
}

function applyModuleAssetsFor(theme: ThemeDef, moduleId: string) {
  const asset = theme.modules?.[moduleId]
  if (!asset || !theme.assets_base) return
  if (asset.css) injectCss(`${theme.assets_base}/${asset.css}`, `m:${moduleId}`)
  if (asset.script && scriptsAllowed(theme)) {
    const tag = `${theme.id}:${moduleId}`
    if (loadedModuleScripts.has(tag)) return
    loadedModuleScripts.add(tag)
    void loadThemeScript(`${theme.assets_base}/${asset.script}`, makeThemeApi(theme, moduleId))
  }
}

/** Apply a theme end-to-end: CSS variables, global stylesheet/script, then the
 *  per-module skins for every module currently loaded. */
function applyThemeDef(theme: ThemeDef) {
  teardownCurrentTheme()

  const root = document.documentElement
  for (const [prop, value] of Object.entries(theme.vars ?? {})) {
    root.style.setProperty(prop, value)
    appliedVarNames.add(prop)
  }
  root.style.colorScheme = theme.color_scheme

  if (theme.assets_base && theme.global?.css) {
    injectCss(`${theme.assets_base}/${theme.global.css}`, 'global')
  }
  if (theme.assets_base && theme.global?.script && scriptsAllowed(theme) && !globalScriptLoaded) {
    globalScriptLoaded = true
    void loadThemeScript(`${theme.assets_base}/${theme.global.script}`, makeThemeApi(theme))
  }

  currentTheme = theme
  for (const id of activeModuleIds()) applyModuleAssetsFor(theme, id)
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  themes:        [],
  activeThemeId: localStorage.getItem(STORAGE_KEY) ?? 'kubuno-reference',
  isLoaded:      false,

  fetchThemes: async () => {
    try {
      const [themesRes, configRes] = await Promise.all([
        axios.get<{ themes: ThemeDef[] }>('/api/v1/themes'),
        getPublicConfig().catch(() => ({}) as Record<string, unknown>),
      ])

      const themes = themesRes.data.themes
      const config: Record<string, unknown> = configRes
      const serverThemeId = (config['appearance.theme'] as string | undefined) ?? 'kubuno-reference'

      const localId  = localStorage.getItem(STORAGE_KEY)
      const targetId = localId ?? serverThemeId
      const active =
        themes.find((t) => t.id === targetId) ??
        themes.find((t) => t.id === 'kubuno-reference') ??
        themes[0]

      set({ themes, activeThemeId: active?.id ?? targetId, isLoaded: true })
      if (active) applyThemeDef(active)
    } catch {
      set({ isLoaded: true })
    }
  },

  applyTheme: (id: string) => {
    const theme = get().themes.find((t) => t.id === id)
    if (!theme) return
    applyThemeDef(theme)
    localStorage.setItem(STORAGE_KEY, id)
    set({ activeThemeId: id })
  },

  applyThemeModuleAssets: (moduleId: string) => {
    if (currentTheme) applyModuleAssetsFor(currentTheme, moduleId)
  },

  loadThemePreview: (theme: ThemeDef) => {
    ComponentRegistry.clearPreview()
    // Colours/vars are previewed via scoped inline styles in the pane; here we
    // only load the theme's component overrides - and only if trusted (opt-in JS).
    if (!theme.assets_base || !scriptsAllowed(theme)) return
    const urls: string[] = []
    if (theme.global?.script) urls.push(`${theme.assets_base}/${theme.global.script}`)
    if (theme.modules) {
      for (const a of Object.values(theme.modules)) {
        if (a.script) urls.push(`${theme.assets_base}/${a.script}`)
      }
    }
    for (const url of urls) void loadThemeScript(url, makeThemeApi(theme, undefined, true))
  },

  clearThemePreview: () => ComponentRegistry.clearPreview(),
}))
