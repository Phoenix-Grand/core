import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'
import type { ThemeDef } from '../../core/store/themeStore'

/**
 * Renders its children inside a **Shadow DOM** so the theme preview is fully
 * isolated from the live (active) theme's global stylesheet.
 *
 * Why a shadow root rather than an <iframe>: it shares the page's realm, so
 * native scrolling works, and components that attach `document`/`window` drag
 * listeners (RangeSlider, ResizeHandle) keep working — an iframe would trap the
 * wheel and swallow those events. Style isolation still holds: the active theme's
 * `<link data-kbtheme>` is excluded, and outer rules cannot pierce the boundary.
 *
 * The shadow root is seeded with the app's base stylesheets (Tailwind utilities)
 * cloned from <head> — except the active theme. Tailwind v4 emits its design
 * tokens on `:root, :host`, so cloning makes `:host` (this shadow host) receive
 * them. The PREVIEWED theme is then applied to the host alone: its variables as
 * inline custom properties (overriding the `:host` defaults) plus its own
 * `global.css` injected inside the shadow root. Children mount through a nested
 * React root attached inside the shadow, so React events resolve correctly.
 */
export default function PreviewFrame({ theme, children }: { theme: ThemeDef; children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<Root | null>(null)
  const mountRef = useRef<HTMLDivElement | null>(null)
  const linkRef = useRef<HTMLLinkElement | null>(null)
  const [ready, setReady] = useState(false)

  // Build the shadow root once: clone base stylesheets (minus the active theme),
  // add a placeholder link for the previewed theme, and a mount node for React.
  useEffect(() => {
    const host = hostRef.current
    if (!host || host.shadowRoot) return
    const shadow = host.attachShadow({ mode: 'open' })

    const reset = document.createElement('style')
    reset.textContent =
      ':host{display:block;-webkit-font-smoothing:antialiased}' +
      '.kb-preview-mount{padding:1.25rem;background:var(--body-bg,#f8fafd)}'
    shadow.appendChild(reset)

    // Clone the app's stylesheets — skip the live theme so it cannot leak in.
    document
      .querySelectorAll<HTMLLinkElement | HTMLStyleElement>('head link[rel="stylesheet"], head style')
      .forEach((node) => {
        if (node instanceof HTMLLinkElement && node.dataset.kbtheme != null) return
        shadow.appendChild(node.cloneNode(true))
      })

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.setAttribute('data-preview-theme', '')
    shadow.appendChild(link)
    linkRef.current = link

    const mount = document.createElement('div')
    mount.className = 'kb-preview-mount'
    shadow.appendChild(mount)
    mountRef.current = mount

    rootRef.current = createRoot(mount)
    setReady(true)

    return () => {
      // Defer unmount: React forbids unmounting synchronously from inside an effect.
      const root = rootRef.current
      rootRef.current = null
      queueMicrotask(() => root?.unmount())
    }
  }, [])

  // Apply the PREVIEWED theme to the shadow host: variables + its global.css.
  useEffect(() => {
    const host = hostRef.current
    const link = linkRef.current
    if (!host) return
    host.removeAttribute('style')
    for (const [k, v] of Object.entries(theme.vars ?? {})) host.style.setProperty(k, v)
    host.style.colorScheme = theme.color_scheme
    if (link) {
      if (theme.assets_base && theme.global?.css) link.href = `${theme.assets_base}/${theme.global.css}`
      else link.removeAttribute('href')
    }
  }, [theme.id, theme.vars, theme.assets_base, theme.color_scheme, theme.global?.css])

  // (Re)render children into the nested root whenever they change.
  useEffect(() => {
    if (ready) rootRef.current?.render(children)
  }, [ready, children])

  return <div ref={hostRef} />
}
