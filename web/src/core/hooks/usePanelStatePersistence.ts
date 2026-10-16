import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useUiStore } from '../store/uiStore'
import { useRightPanelStore } from '../store/rightPanelStore'
import { useModulesStore } from '../store/modulesStore'
import { CollapseSidebarRegistry } from '../registry/CollapseSidebarRegistry'
import { panelPrefs, appIdFromPath, SIDEBAR_WIDTH } from '../store/panelPrefs'

/**
 * Persist the expanded/collapsed state of the left and right panels per
 * application AND per tab (sessionStorage). On reload (F5) or when returning to
 * an application later within the same tab, the last state is restored.
 *
 * First visit of an application (no saved state) falls back to the
 * CollapseSidebarRegistry default for the left panel (some apps auto-collapse to
 * maximise workspace), and a closed right panel.
 */
export function usePanelStatePersistence(): void {
  const { pathname } = useLocation()
  // Bumped when module bundles load at runtime - a module may only then register
  // its CollapseSidebarRegistry prefix, changing the default-collapse for its
  // pages (e.g. office). Re-evaluate the default once that happens.
  const loadedVersion = useModulesStore((s) => s.loadedVersion)
  const currentApp = useRef<string | null>(null)
  const lastSig = useRef<string | null>(null)
  // While we apply a saved state, the resulting store updates must not be
  // persisted back as if they were fresh user actions.
  const applying = useRef(false)

  // Restore saved state when the active application - or its default-collapse
  // scope - changes (incl. mount/F5 and late module registration).
  useEffect(() => {
    const app = appIdFromPath(pathname)
    const collapseByDefault = CollapseSidebarRegistry.matches(pathname)
    const sig = `${app}|${collapseByDefault}`
    if (sig === lastSig.current) return
    lastSig.current = sig
    currentApp.current = app

    const prefs = panelPrefs.get(app)
    applying.current = true
    useUiStore.getState().setSidebarCollapsed(prefs.left ?? collapseByDefault)
    useUiStore.getState().setSidebarWidth(prefs.width ?? SIDEBAR_WIDTH.DEFAULT)
    useRightPanelStore.getState().setActive(prefs.right ?? null)
    applying.current = false
  }, [pathname, loadedVersion])

  // Persist user-driven changes under the current application.
  useEffect(() => {
    const unsubLeft = useUiStore.subscribe((state, prev) => {
      if (state.sidebarCollapsed === prev.sidebarCollapsed) return
      if (applying.current || !currentApp.current) return
      panelPrefs.setLeft(currentApp.current, state.sidebarCollapsed)
    })
    const unsubWidth = useUiStore.subscribe((state, prev) => {
      if (state.sidebarWidth === prev.sidebarWidth) return
      if (applying.current || !currentApp.current) return
      panelPrefs.setWidth(currentApp.current, state.sidebarWidth)
    })
    const unsubRight = useRightPanelStore.subscribe((state, prev) => {
      if (state.activeModuleId === prev.activeModuleId) return
      if (applying.current || !currentApp.current) return
      panelPrefs.setRight(currentApp.current, state.activeModuleId)
    })
    return () => {
      unsubLeft()
      unsubWidth()
      unsubRight()
    }
  }, [])
}
