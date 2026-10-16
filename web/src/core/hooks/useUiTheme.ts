import { useEffect, useState } from 'react'
import type { MenuTheme } from '@ui'

function read(): MenuTheme {
  if (typeof document === 'undefined') return 'light'
  // `themeStore.applyThemeDef` writes the active theme's colour scheme onto the
  // root element; the computed value also covers the OS-driven `system` mode.
  const scheme = getComputedStyle(document.documentElement).colorScheme
  return scheme.includes('dark') ? 'dark' : 'light'
}

/**
 * Light or dark, for the `@ui` surfaces that paint themselves in JavaScript
 * (`MenuDropdown` and friends) instead of through theme variables.
 *
 * Those components default to `light`, so a menu opened on a dark theme comes
 * out white-on-white unless the caller says otherwise - this hook is that
 * answer, in one place rather than re-derived at every call site.
 */
export function useUiTheme(): MenuTheme {
  const [theme, setTheme] = useState<MenuTheme>(read)

  useEffect(() => {
    const sync = () => setTheme(read())
    // A theme switch rewrites the root element's inline style; the OS toggle
    // moves the media query without touching the DOM. Both are watched.
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme'],
    })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', sync)
    return () => {
      observer.disconnect()
      mq.removeEventListener('change', sync)
    }
  }, [])

  return theme
}
