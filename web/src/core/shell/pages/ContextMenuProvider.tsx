import React, { createContext, useCallback, useContext, useState } from 'react'
import { MenuDropdown, type MenuItem } from '../../../ui/index'
import { findTextTarget } from '../../../ui/textFieldMenu'
import { ExtensionRegistry } from '../../registry/ExtensionRegistry'
import { CONTEXT_MENU_ITEMS, type ContextMenuItemsProvider } from '../../registry/contextMenu'
import { useModulesStore } from '../../store/modulesStore'

interface ContextMenuCtx {
  close: () => void
}

const Ctx = createContext<ContextMenuCtx>({ close: () => {} })
export const useContextMenu = () => useContext(Ctx)

/** @deprecated The background context menu is DATA now: contribute `MenuItem[]`
 *  to the `shell.context-menu-items` extension point (see `registry/contextMenu.ts`)
 *  and the shell renders them with @ui's MenuDropdown. Kept exported so the
 *  published SDK surface stays unbroken; no longer rendered by the provider. */
export function ContextMenuItem({
  onClick,
  icon,
  label,
}: {
  onClick: () => void
  icon?: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className="group flex items-center gap-3 w-full px-2.5 py-1.5 text-sm rounded-md
                 text-text-primary hover:bg-primary hover:text-white cursor-pointer outline-none text-left"
    >
      {icon && <span className="text-primary group-hover:text-white">{icon}</span>}
      {label}
    </button>
  )
}

/** @deprecated Use `{ type: 'separator' }` in the contributed `MenuItem[]`. */
export function ContextMenuSeparator() {
  return <div className="my-[5px] h-px mx-1.5" style={{ background: 'var(--kb-black-12)' }} />
}

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  // Position + the items resolved for THIS right-click. Items are built on open
  // (fresh labels/state) and kept for the lifetime of the menu.
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  const activeModules = useModulesStore(s => s.activeModules)

  const close = useCallback(() => setMenu(null), [])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    /* A text entry area owns its own default menu (TextFieldMenuHost). Bail out before
     * touching the event: `stopPropagation` here would keep it from ever reaching the
     * document-level listener that opens the field menu. */
    if (findTextTarget(e.target)) return

    /* A dialog or floating window is its own surface, and the module's background
     * menu has no business there. React bubbles synthetic events along the
     * COMPONENT tree rather than the DOM one, so a window portalled into <body>
     * still reaches this handler from whichever module opened it — which is how
     * right-clicking a form in the "Stockages distants" window raised Drive's
     * folder menu. `role="dialog"` is what every FloatingWindow and modal sets. */
    const el = e.target instanceof Element ? e.target : null
    if (el?.closest('[role="dialog"]')) return

    // Only ACTIVE modules contribute (ExtensionRegistry, unlike Slot, does not
    // filter). Building here rather than on every render also means a provider
    // reads the CURRENT path/state.
    const activeIds = new Set(activeModules.map(m => m.module_id))
    const items = ExtensionRegistry.getAll<ContextMenuItemsProvider>(CONTEXT_MENU_ITEMS)
      .filter(p => activeIds.has(p.moduleId))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .flatMap(p => { try { return p.items() } catch { return [] } })

    // Nothing to show → let the browser's own menu through, and never flash an
    // empty panel (what the old post-render "is it empty?" check guarded against).
    if (items.length === 0) return

    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }, [activeModules])

  return (
    <Ctx.Provider value={{ close }}>
      <div className="contents" onContextMenu={handleContextMenu}>
        {children}
      </div>
      {/* THE project's menu component: same surface, submenus, dismiss handling
          and touch bottom-sheet as every other menu. It clamps itself to the
          viewport, so the manual 220x200 clamp is gone. */}
      {menu && (
        <MenuDropdown
          items={menu.items}
          pos={{ top: menu.y, left: menu.x }}
          onClose={close}
        />
      )}
    </Ctx.Provider>
  )
}
