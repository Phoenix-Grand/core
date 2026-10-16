// Core UI primitive: a popover that PORTALS to <body> and is fixed-positioned next
// to an anchor element. Use it for menus/pickers that live inside a toolbar with
// `overflow-x-auto` (which forces overflow-y → clipping): an absolutely-positioned
// child would be cut off by that overflow box, but a portal'd fixed element escapes
// it. Position is measured from the anchor and clamped to the viewport on every edge.
import { useState, useRef, useLayoutEffect, useEffect, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { usePortalHost } from './portalHost'

export type PopoverPlacement = 'bottom' | 'top' | 'left' | 'right'
export type PopoverAlign = 'left' | 'right' | 'center'

/**
 * Where the panel goes (`left` / `top` in the coordinate space): on the `placement` side of the anchor when it fits
 * (else the opposite side), aligned on `align` along that side, clamped `margin` px inside the space.
 */
export function placePopover(
  anchor: { left: number; top: number; right: number; bottom: number },
  panel: { width: number; height: number },
  space: { width: number; height: number },
  placement: PopoverPlacement,
  align: PopoverAlign,
  gap: number,
  margin = 8,
): { left: number; top: number } {
  const PW = panel.width, PH = panel.height
  const clamp = (v: number, size: number, room: number) => Math.max(margin, Math.min(v, room - size - margin))
  if (placement === 'left' || placement === 'right') {
    let left = placement === 'right' ? anchor.right + gap : anchor.left - PW - gap
    if (placement === 'right' && left + PW > space.width - margin) left = anchor.left - PW - gap
    if (placement === 'left' && left < margin) left = anchor.right + gap
    const top = align === 'center' ? (anchor.top + anchor.bottom - PH) / 2 : align === 'right' ? anchor.bottom - PH : anchor.top
    return { left: clamp(left, PW, space.width), top: clamp(top, PH, space.height) }
  }
  let top = placement === 'top' ? anchor.top - PH - gap : anchor.bottom + gap
  if (placement === 'bottom' && top + PH > space.height - margin) top = anchor.top - PH - gap
  if (placement === 'top' && top < margin) top = anchor.bottom + gap
  const left = align === 'center' ? (anchor.left + anchor.right - PW) / 2 : align === 'right' ? anchor.right - PW : anchor.left
  return { left: clamp(left, PW, space.width), top: clamp(top, PH, space.height) }
}

export function AnchoredPopover({
  anchorRef, open, onClose, children, gap = 4, align = 'left', placement = 'bottom', width, height,
  lightDismiss = true, onOpen,
}: {
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  children: ReactNode
  gap?: number
  /** Which edges of the popover and the anchor line up (`center`: centred on the anchor). */
  align?: PopoverAlign
  /** The anchor's side it opens on when there is room (default below). */
  placement?: PopoverPlacement
  /** Fixed size in px; absent: the content's. */
  width?: number
  height?: number
  /** `true` (default): a click outside or Escape closes it (the focus goes back to the anchor on Escape). */
  lightDismiss?: boolean
  /** Raised once each time it opens. */
  onOpen?: () => void
}) {
  const popRef = useRef<HTMLDivElement>(null)
  // null until measured → render hidden for one frame so we can read the true size.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // When scoped to a bounded portal host, mount into it and position with
  // `absolute` in the host's coordinate space (subtract its origin, clamp to its
  // box) instead of viewport-relative `fixed`.
  const { host, scoped } = usePortalHost()
  const posCls = scoped ? 'absolute' : 'fixed'

  const reposition = () => {
    const a = anchorRef.current, p = popRef.current
    if (!a || !p) return
    const r = a.getBoundingClientRect()
    // Coordinate space: the viewport, or the bounded host when scoped.
    const b = scoped && host ? host.getBoundingClientRect() : null
    const ox = b ? b.left : 0, oy = b ? b.top : 0
    const space = { width: b ? b.width : window.innerWidth, height: b ? b.height : window.innerHeight }
    const anchor = { left: r.left - ox, top: r.top - oy, right: r.right - ox, bottom: r.bottom - oy }
    setPos(placePopover(anchor, { width: p.offsetWidth || 232, height: p.offsetHeight || 300 }, space, placement, align, gap))
  }

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    reposition()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) onOpen?.()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep it anchored if the window resizes or any ancestor scrolls while open.
  useEffect(() => {
    if (!open) return
    const f = () => reposition()
    window.addEventListener('resize', f)
    window.addEventListener('scroll', f, true)
    return () => { window.removeEventListener('resize', f); window.removeEventListener('scroll', f, true) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes a light-dismiss popover and gives the focus back to its anchor.
  useEffect(() => {
    if (!open || !lightDismiss) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      onClose()
      anchorRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, lightDismiss]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null
  return createPortal(
    <>
      {/* 9999 is what every other portal'd overlay uses (MenuDropdown, Combobox;
          Tooltip sits one layer above at 10000). This used to be 200, which is
          below a FloatingWindow - the popover was in the DOM, correctly
          positioned, and painted UNDER the window that opened it. Measured. */}
      {lightDismiss && <div className={`${posCls} inset-0`} style={{ zIndex: 9998 }} onMouseDown={onClose} />}
      <div ref={popRef} className={posCls}
           style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: width || undefined, height: height || undefined, overflow: height ? 'auto' : undefined, zIndex: 9999, visibility: pos ? 'visible' : 'hidden' }}>
        {children}
      </div>
    </>,
    host ?? document.body,
  )
}
