import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { placeTooltip } from './tooltipPlacement'

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left'

export interface TooltipProps {
  /** Text shown in the bubble. Nothing renders when empty. */
  label:    ReactNode
  /** The element the tooltip describes. Cloned to attach pointer handlers. */
  children: ReactElement
  /** Kept for compatibility; placement now follows the pointer. */
  side?:    TooltipSide
  /** Milliseconds before it appears. */
  delay?:   number
  disabled?: boolean
}

/** Shared bubble styling - also used by the shell's `title` interceptor. */
export const TOOLTIP_STYLE: React.CSSProperties = {
  position:      'fixed',
  background:    'rgba(60, 64, 67, 0.95)',
  color:         '#fff',
  fontSize:      12,
  lineHeight:    '16px',
  fontWeight:    500,
  padding:       '6px 10px',
  borderRadius:  4,
  boxShadow:     '0 1px 3px rgba(0,0,0,.3), 0 4px 8px rgba(0,0,0,.15)',
  maxWidth:      280,
  whiteSpace:    'pre-line',
  zIndex:        10000,
  pointerEvents: 'none',
  userSelect:    'none',
}

/**
 * The project's tooltip. Modules use THIS (or a plain `title`, which the shell
 * upgrades automatically) rather than the browser's native bubble: the native
 * one cannot be styled, waits a long fixed delay and never shows on touch.
 *
 * It is anchored to the POINTER, not the trigger: below it and left-aligned with
 * it, flipping above when the bottom edge is too close.
 */
export function Tooltip({ label, children, delay = 400, disabled }: TooltipProps) {
  // `ready` gates visibility: the bubble is laid out once invisibly so it can be
  // measured, then revealed at its final spot. Showing it first and moving it
  // afterwards produced a visible jump.
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean } | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const timer     = useRef<number | null>(null)
  const point     = useRef({ x: 0, y: 0 })

  const hide = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    setPos(null)
  }, [])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // Measure and place BEFORE the browser paints: useLayoutEffect runs after the
  // DOM is updated but before painting, so the correction is never seen.
  useLayoutEffect(() => {
    if (!pos || pos.ready || !bubbleRef.current) return
    const r = bubbleRef.current.getBoundingClientRect()
    const p = placeTooltip(point.current.x, point.current.y, { width: r.width, height: r.height })
    setPos({ left: p.left, top: p.top, ready: true })
  }, [pos])

  if (disabled || label == null || label === '') return children

  const onEnter = (e: ReactMouseEvent) => {
    point.current = { x: e.clientX, y: e.clientY }
    if (timer.current) clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const p = placeTooltip(point.current.x, point.current.y, { width: 0, height: 0 })
      setPos({ left: p.left, top: p.top, ready: false })
    }, delay)
  }
  const onMove = (e: ReactMouseEvent) => { point.current = { x: e.clientX, y: e.clientY } }

  const trigger = cloneElement(children, {
    onMouseEnter: (e: ReactMouseEvent) => { onEnter(e); (children.props as { onMouseEnter?: (e: ReactMouseEvent) => void }).onMouseEnter?.(e) },
    onMouseMove:  (e: ReactMouseEvent) => { onMove(e);  (children.props as { onMouseMove?:  (e: ReactMouseEvent) => void }).onMouseMove?.(e) },
    onMouseLeave: (e: ReactMouseEvent) => { hide();     (children.props as { onMouseLeave?: (e: ReactMouseEvent) => void }).onMouseLeave?.(e) },
    onMouseDown:  (e: ReactMouseEvent) => { hide();     (children.props as { onMouseDown?:  (e: ReactMouseEvent) => void }).onMouseDown?.(e) },
  } as Partial<React.HTMLAttributes<HTMLElement>>)

  return (
    <>
      {trigger}
      {pos && createPortal(
        <div ref={bubbleRef} role="tooltip" data-kb-tooltip
          style={{ ...TOOLTIP_STYLE, left: pos.left, top: pos.top,
                   visibility: pos.ready ? 'visible' : 'hidden' }}>
          {label}
        </div>,
        document.body,
      )}
    </>
  )
}
