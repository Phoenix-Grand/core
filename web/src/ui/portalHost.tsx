import { createContext, useContext } from 'react'

/**
 * Optional portal host for overlay primitives (FloatingWindow, AnchoredPopover).
 *
 * By default these primitives `createPortal` into `<body>` and position
 * themselves with `position: fixed` (relative to the viewport). When a host
 * element is provided through this context they portal INTO that element and
 * position with `position: absolute` (relative to the host) instead - so they
 * stay confined to it.
 *
 * The host element MUST be `position: relative; overflow: hidden` for the
 * confinement to hold. Used by the admin theme preview to render real dialogs
 * and popovers inside a bounded stage they cannot escape from.
 */
export const PortalHostContext = createContext<HTMLElement | null>(null)

/** Resolve the active portal host: a scoped element if provided, else `<body>`. */
export function usePortalHost(): { host: HTMLElement | null; scoped: boolean } {
  const el = useContext(PortalHostContext)
  if (el) return { host: el, scoped: true }
  return { host: typeof document !== 'undefined' ? document.body : null, scoped: false }
}
