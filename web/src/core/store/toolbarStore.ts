import { create } from 'zustand'
import type React from 'react'

/**
 * Marge intérieure que la zone module (`ModuleArea`) applique au contenu du
 * module. Le shell n'en met AUCUNE par défaut. Trois formes :
 *  - `number`  → px, uniforme (ex. `24`)
 *  - `string`  → raccourci CSS `padding` (ex. `"1.5rem"`, `"1rem 2rem"`, `"0 24px"`)
 *  - objet     → par côté (nombre = px, chaîne = valeur CSS libre)
 * La marge n'entoure QUE le contenu défilant - pas la barre d'outils du module.
 */
export type ModuleAreaPadding =
  | number
  | string
  | {
      top?:    number | string
      right?:  number | string
      bottom?: number | string
      left?:   number | string
    }

export interface ToolbarConfig {
  moduleId:          string
  // Préfixe de route (most-specific wins)
  routePrefix:       string
  ToolbarComponent?: React.ComponentType
  // true → contenu full-bleed : aucune marge, le module gère son propre chrome
  // (pages de réglages, éditeurs immersifs…). Ignore `padding` s'il est aussi posé.
  noPadding?:        boolean
  // Marge intérieure de la zone module appliquée au contenu (cf. ModuleAreaPadding).
  // Défaut : aucune. Sans effet si `noPadding` est true.
  padding?:          ModuleAreaPadding
}

/** Convertit une `ModuleAreaPadding` en style CSS pour `ModuleArea`. */
/** Marge intérieure par défaut de la zone module, en px. */
export const MODULE_AREA_PADDING = 24

export function moduleAreaPaddingStyle(
  p: ModuleAreaPadding | undefined,
): React.CSSProperties | undefined {
  if (p == null) return undefined
  const len = (v: number | string) => (typeof v === 'number' ? `${v}px` : v)
  if (typeof p === 'number' || typeof p === 'string') return { padding: len(p) }
  return {
    paddingTop:    p.top    == null ? undefined : len(p.top),
    paddingRight:  p.right  == null ? undefined : len(p.right),
    paddingBottom: p.bottom == null ? undefined : len(p.bottom),
    paddingLeft:   p.left   == null ? undefined : len(p.left),
  }
}

interface ToolbarState {
  configs:   ToolbarConfig[]
  register:  (config: ToolbarConfig) => void
  unregister: (moduleId: string) => void
}

export const useToolbarStore = create<ToolbarState>((set) => ({
  configs: [],
  register: (config) =>
    set((s) => ({
      configs: [...s.configs.filter((c) => c.moduleId !== config.moduleId), config],
    })),
  unregister: (moduleId) =>
    set((s) => ({ configs: s.configs.filter((c) => c.moduleId !== moduleId) })),
}))

export function resolveToolbarConfig(
  configs: ToolbarConfig[],
  pathname: string,
): ToolbarConfig | null {
  return (
    configs
      .filter((c) => pathname === c.routePrefix || pathname.startsWith(c.routePrefix + '/'))
      .sort((a, b) => b.routePrefix.length - a.routePrefix.length)[0] ?? null
  )
}
