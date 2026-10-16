import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Outlet } from 'react-router-dom'
import { ThemeScopeContext } from '@ui'
import { ContextMenuProvider } from './ContextMenuProvider'
import { useToolbarStore, resolveToolbarConfig, moduleAreaPaddingStyle, MODULE_AREA_PADDING } from '../../store/toolbarStore'
import { ModuleSettingsRegistry } from '../../slots/SlotRegistry'
import { useAppearanceStore } from '../../store/appearanceStore'
import ModuleMaintenanceBanner from './ModuleMaintenanceBanner'

/** Tracks the OS colour-scheme preference for the `system` appearance mode. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

export default function ModuleArea() {
  const { pathname } = useLocation()
  const { configs }  = useToolbarStore()
  const toolbarConfig = resolveToolbarConfig(configs, pathname)
  // Per-user module settings pages render full-bleed (no padding) and without the
  // module toolbar - they own their chrome (breadcrumb + tab bar), like mail.
  const isSettings    = ModuleSettingsRegistry.isSettingsRoute(pathname)
  const noPadding     = isSettings || toolbarConfig?.noPadding
  const Toolbar       = isSettings ? null : (toolbarConfig?.ToolbarComponent ?? null)
  /* Marge intérieure de la zone centrale : 24px PAR DÉFAUT - le contenu ne doit
   * jamais mourir contre les bords, et surtout pas contre le bas. Un module peut
   * demander une autre valeur (`padding`) ; le mode full-bleed (`noPadding`) reste
   * prioritaire et n'en reçoit aucune, puisqu'il gère son propre chrome. */
  const padStyle      = noPadding
    ? undefined
    : (moduleAreaPaddingStyle(toolbarConfig?.padding) ?? moduleAreaPaddingStyle(MODULE_AREA_PADDING))
  // Identifiant du module actif (1er segment d'URL) → thème par module via CSS
  // (ex: [data-module="calendar"] surcharge --color-primary).
  const moduleId = pathname.split('/').filter(Boolean)[0] || 'home'

  // Per-module appearance (set from the settings menu's "Apparence" dialog). Applied
  // to THIS module's container only, so light/dark/density scope to the module.
  const appearance = useAppearanceStore((s) => s.byModule[moduleId])
  const systemDark = useSystemDark()
  const dark = appearance?.mode === 'dark' || (appearance?.mode === 'system' && systemDark)
  const density = appearance?.density ?? 'responsive'
  const scheme  = appearance?.scheme ?? 'modern'

  return (
    <ThemeScopeContext.Provider value={moduleId}>
    <div
      data-module={moduleId}
      data-kb-appearance={dark ? 'dark' : 'light'}
      data-kb-density={density}
      data-kb-scheme={scheme}
      style={{ colorScheme: dark ? 'dark' : 'light' }}
      className="flex-1 flex flex-col overflow-hidden min-w-0 bg-white rounded-xl">
      {Toolbar && (
        <div className="flex-shrink-0 bg-white no-print">
          <Toolbar />
        </div>
      )}

      {/* Bandeau de maintenance SCOPÉ : visible tant qu'une opération sur la base
          de CE module est en cours (fixe, sous la barre d'outils, hors défilement). */}
      <div className="flex-shrink-0">
        <ModuleMaintenanceBanner moduleId={moduleId} />
      </div>

      <ContextMenuProvider>
        {noPadding
          ? (
            <div className="flex-1 overflow-hidden flex flex-col min-h-0">
              <Outlet />
            </div>
          ) : (
            // `flex flex-col` + `flex-1` on the inner wrapper → it has a defined
            // height (= the content area): an `h-full` child (a module StartPage,
            // say) fills it, while taller content overflows and scrolls through the
            // parent's `overflow-y-auto`.
            // Padding: the shell insets the content ONLY when the active module
            // opts in via ToolbarConfig.padding (default: none). Applied to the
            // scroll container so the inset wraps the content, toolbar excluded.
            <div className="flex-1 overflow-y-auto flex flex-col" style={padStyle}>
              <div className="flex-1 min-h-0"><Outlet /></div>
            </div>
          )}
      </ContextMenuProvider>
    </div>
    </ThemeScopeContext.Provider>
  )
}
