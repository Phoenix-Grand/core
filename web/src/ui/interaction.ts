import { useRef, useCallback, useEffect, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react'

// Pointer-aware activation helpers.
//
// Desktop file/list UIs use "single click = select, double click = open". On
// touch devices a double-tap is not a natural gesture, so a single tap must
// open directly. These helpers centralise that distinction so every browser /
// list across modules behaves consistently (the @ui package is resolved at
// runtime to the host's single instance, so modules share this logic).

/** True when the primary pointer is coarse (touch) and hovering is unavailable -
 *  i.e. double-click is not a sensible gesture and a tap should "open". */
export function isCoarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    (window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(hover: none)').matches)
  )
}

/** Viewport width below which the shell switches to its mobile layout. Mirrors
 *  Tailwind's `lg` breakpoint, which the shell chrome (MobileNav, MobileFab,
 *  off-canvas sidebar) already keys off, so JS and CSS never disagree. */
export const MOBILE_MAX_WIDTH = 1023

/** True while the viewport is narrower than the `lg` breakpoint. Re-renders on
 *  resize / orientation change. Use it when a mobile layout differs in
 *  STRUCTURE (different components, sheets instead of popovers) and cannot be
 *  expressed with `lg:` utility variants alone. */
export function useIsMobile(): boolean {
  const query = `(max-width: ${MOBILE_MAX_WIDTH}px)`
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches)
    setMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return mobile
}

/** True while the viewport is wider than it is tall. Combined with
 *  {@link useIsMobile} it detects a phone/tablet held in landscape, where the
 *  bottom nav is better placed as a vertical left rail. Re-renders on rotation. */
export function useIsLandscape(): boolean {
  const query = '(orientation: landscape)'
  const [landscape, setLandscape] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : true,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setLandscape(e.matches)
    setLandscape(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return landscape
}

type AnyMouseEvent = { stopPropagation(): void; preventDefault(): void }

/**
 * Build `{ onClick, onDoubleClick }` props for an element whose desktop
 * behaviour is "single click selects, double click opens". On touch UIs the
 * single tap opens directly (and the desktop select handler is skipped).
 *
 *   <div {...openable<React.MouseEvent>({ open, select })} />
 *
 * `select` is optional: items with no selection concept just open on tap (touch)
 * or double-click (mouse).
 */
export function openable<E extends AnyMouseEvent>(opts: {
  open: (e: E) => void
  select?: (e: E) => void
}): { onClick: (e: E) => void; onDoubleClick: (e: E) => void } {
  return {
    onClick: (e) => {
      if (isCoarsePointer()) opts.open(e)
      else opts.select?.(e)
    },
    onDoubleClick: (e) => {
      if (!isCoarsePointer()) opts.open(e)
    },
  }
}

/**
 * Long-press → context menu. Touch UIs have no right-click; a sustained press
 * fires the same `onContextMenu`-style handler with a synthesized event whose
 * `clientX/clientY` is the touch point (so existing menu-positioning code works
 * unchanged). The tap that the browser would emit on touchend is swallowed in
 * the capture phase so the item isn't also opened/selected.
 *
 *   const longPress = useLongPress(onContextMenu)
 *   <div {...longPress} onContextMenu={onContextMenu} />   // mouse keeps right-click
 */
export function useLongPress(
  handler: (e: ReactMouseEvent) => void,
  opts: { ms?: number; moveTolerance?: number } = {},
) {
  const { ms = 500, moveTolerance = 12 } = opts
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)

  const cancel = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    origin.current = null
  }, [])

  const onTouchStart = useCallback((e: ReactTouchEvent) => {
    if (e.touches.length !== 1) { cancel(); return }
    const t = e.touches[0]
    origin.current = { x: t.clientX, y: t.clientY }
    timer.current = setTimeout(() => {
      timer.current = null
      // Swallow the click the browser emits after touchend (capture phase,
      // self-removing, with a timeout fallback if no click follows).
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true } as EventListenerOptions), 700)
      handler({
        clientX: t.clientX, clientY: t.clientY,
        preventDefault() {}, stopPropagation() {},
      } as unknown as ReactMouseEvent)
    }, ms)
  }, [handler, ms, cancel])

  const onTouchMove = useCallback((e: ReactTouchEvent) => {
    if (!origin.current) return
    const t = e.touches[0]
    if (Math.abs(t.clientX - origin.current.x) > moveTolerance ||
        Math.abs(t.clientY - origin.current.y) > moveTolerance) cancel()
  }, [cancel, moveTolerance])

  return { onTouchStart, onTouchMove, onTouchEnd: cancel, onTouchCancel: cancel }
}
