import { useEffect } from 'react'

/**
 * Marks a floating menu panel. Used to tell "inside the menu" from "outside" even across
 * portals: cascading submenus are rendered into `document.body`, so a DOM `contains()`
 * check on the parent panel would wrongly report them as outside.
 */
export const MENU_ATTR = 'data-kb-menu'

function isInsideMenu(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null
  return !!el?.closest(`[${MENU_ATTR}]`)
}

/**
 * Dismisses a floating menu on any interaction that is not aimed at it: a keystroke
 * somewhere else, or the window losing focus (alt-tab, devtools, another app).
 * Escape always closes, even from inside.
 *
 * Outside *clicks* are deliberately NOT handled here: each menu already closes on them,
 * and a generic handler would fight the trigger buttons - the pointerdown would close the
 * menu, then the trigger's click would reopen it, so toggling would look broken.
 */
export function useMenuDismiss(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || !isInsideMenu(e.target)) onClose()
    }
    const onBlur = () => onClose()
    // capture phase: a handler that stops propagation further down must not shield the menu
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [active, onClose])
}
