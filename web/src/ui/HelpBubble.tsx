/**
 * A help bubble in the instance's accent, with an arrow pointing at whatever
 * raised the question.
 *
 * ## Why not a plain popover
 *
 * A white card on a white panel is another panel: it reads as more of the form
 * rather than as an answer to the question just asked. A filled bubble reads as
 * a remark someone made - it is plainly not part of the page - and the arrow
 * says which control it is about, which a floating card never does. That
 * matters most where several little "?" sit near each other.
 *
 * ## It goes on whichever side has room
 *
 * Below the anchor by default, then above it, then to the right, then to the
 * left: the first side that actually fits, and failing that the roomiest. The
 * arrow follows - it is always on the edge facing the anchor, at the anchor's
 * own centre. Near a screen edge the bubble is pushed back into view and the
 * arrow keeps pointing, held only far enough from the corner not to straddle
 * the rounding.
 *
 * Only the TIP of the arrow shows. A rotated square pokes out by its
 * half-diagonal if you let it, which is a whole wedge; the offset here accounts
 * for what the rotation adds, so the amount that shows is the amount asked for.
 * Its corners are square - the one that sticks out IS the point.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { usePortalHost } from './portalHost'

export type HelpBubbleSide = 'top' | 'right' | 'bottom' | 'left'

export interface HelpBubbleProps {
  /** The control the help is about. The arrow points at its centre. */
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  /** The bold opening line. Optional: a bubble may be one paragraph. */
  title?: ReactNode
  children: ReactNode
  /** Label for the dismiss button. Defaults to "OK". */
  okLabel?: ReactNode
  /** An optional second action, shown to the left of the dismiss button. */
  action?: { label: ReactNode; onClick: () => void }
  width?: number
  /** Where to try first. The order after it is always bottom → top → right → left. */
  prefer?: HelpBubbleSide
}

/** The arrow is one square turned on its corner. This is its side. */
const SIDE = 14
/**
 * Turning a square 45° makes its bounding box larger than the square by this
 * much on every side. It has to be subtracted, or the arrow pokes out by its
 * half-diagonal - a whole wedge - instead of by the amount asked for.
 */
const BLEED = SIDE * (Math.SQRT2 - 1) / 2
/** How far the TIP shows beyond the bubble's edge. Just the tip. */
const TIP = 5
/** Anchor ↔ bubble, tip included. */
const GAP = TIP + 3
/** How close to a corner the arrow may sit. */
const MIN = 16
/** Kept off the edge of the screen (or of the host). */
const EDGE = 8

/** The edge of the bubble that faces the anchor, given where the bubble went. */
const facing: Record<HelpBubbleSide, HelpBubbleSide> = {
  bottom: 'top', top: 'bottom', right: 'left', left: 'right',
}

interface Placed {
  /** Which side of the ANCHOR the bubble is on. */
  side: HelpBubbleSide
  left: number
  top: number
  /** Position of the arrow along the facing edge, from that edge's origin. */
  at: number
}

export function HelpBubble({
  anchorRef, open, onClose, title, children, okLabel = 'OK', action,
  width = 320, prefer = 'bottom',
}: HelpBubbleProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [p, setP] = useState<Placed | null>(null)
  const { host, scoped } = usePortalHost()

  const place = () => {
    const a = anchorRef.current, b = boxRef.current
    if (!a || !b) return
    const ra = a.getBoundingClientRect()
    // Measured from the box's own layout, not from its rect: the rect moves
    // with the position being computed here, and feeding that back in would
    // make the bubble walk across the screen one frame at a time.
    const w = b.offsetWidth || width
    const h = b.offsetHeight

    // The space to work in: the viewport, or the bounded host when scoped.
    const rh = scoped && host ? host.getBoundingClientRect() : null
    const ox = rh ? rh.left : 0, oy = rh ? rh.top : 0
    const vw = rh ? rh.width : window.innerWidth
    const vh = rh ? rh.height : window.innerHeight
    // The anchor, in that space.
    const ax = ra.left - ox, ay = ra.top - oy
    const acx = ax + ra.width / 2, acy = ay + ra.height / 2

    const room: Record<HelpBubbleSide, number> = {
      bottom: vh - (ay + ra.height) - GAP - EDGE,
      top:    ay - GAP - EDGE,
      right:  vw - (ax + ra.width) - GAP - EDGE,
      left:   ax - GAP - EDGE,
    }
    const needs = (s: HelpBubbleSide) => (s === 'bottom' || s === 'top') ? h : w
    const order: HelpBubbleSide[] = [prefer, 'bottom', 'top', 'right', 'left']
      .filter((s, i, all) => all.indexOf(s) === i) as HelpBubbleSide[]
    // The first side it fits on; failing that, the one it overflows least.
    const side = order.find(s => room[s] >= needs(s))
      ?? order.reduce((best, s) => (room[s] - needs(s) > room[best] - needs(best) ? s : best), order[0])

    let left: number, top: number
    if (side === 'bottom')     { top = ay + ra.height + GAP; left = acx - w / 2 }
    else if (side === 'top')   { top = ay - GAP - h;         left = acx - w / 2 }
    else if (side === 'right') { left = ax + ra.width + GAP; top = acy - h / 2 }
    else                       { left = ax - GAP - w;        top = acy - h / 2 }
    left = Math.min(Math.max(left, EDGE), Math.max(EDGE, vw - w - EDGE))
    top  = Math.min(Math.max(top, EDGE),  Math.max(EDGE, vh - h - EDGE))

    // The arrow: on the facing edge, at the anchor's centre along it, and never
    // so near a corner that it straddles the rounding.
    const edge = facing[side]
    const along = (edge === 'top' || edge === 'bottom') ? acx - left : acy - top
    const span  = (edge === 'top' || edge === 'bottom') ? w : h
    const at = Math.min(Math.max(along, MIN), Math.max(MIN, span - MIN))
    setP({ side, left, top, at })
  }

  // Measured over a few frames rather than once: the box has to exist, and be
  // laid out, before its height means anything - and a web font arriving a
  // frame later changes that height.
  useLayoutEffect(() => {
    if (!open) { setP(null); return }
    let raf = 0, tries = 0, last = ''
    const tick = () => {
      const b = boxRef.current
      const now = b ? `${b.offsetWidth}x${b.offsetHeight}` : ''
      place()
      if ((now !== last || !now) && ++tries < 12) { last = now; raf = requestAnimationFrame(tick) }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const f = () => place()
    window.addEventListener('resize', f)
    window.addEventListener('scroll', f, true)
    return () => { window.removeEventListener('resize', f); window.removeEventListener('scroll', f, true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open || !host) return null

  const fill = 'var(--color-primary, #1a73e8)'
  const posCls = scoped ? 'absolute' : 'fixed'
  // The arrow's own box, placed on the facing edge. Written inline rather than
  // with utility classes: a utility written in a MODULE loses to the host's own
  // layer, and a square that fails to turn is just a square.
  const edge = p ? facing[p.side] : 'top'
  const flat = edge === 'top' || edge === 'bottom'
  const arrowStyle: CSSProperties = {
    position: 'absolute', background: fill, width: SIDE, height: SIDE, borderRadius: 0,
    transform: flat ? 'translateX(-50%) rotate(45deg)' : 'translateY(-50%) rotate(45deg)',
    ...(flat ? { left: p?.at ?? 0 } : { top: p?.at ?? 0 }),
    [edge]: BLEED - TIP,
  }

  return createPortal(
    <>
      {/* Same layer as every other portal'd overlay; a lower one paints under
          any floating window that opened it. */}
      <div className={`${posCls} inset-0`} style={{ zIndex: 9998 }} onMouseDown={onClose} />
      <div ref={boxRef} role="dialog" data-help-bubble={p ? facing[p.side] : undefined}
        className={`${posCls} rounded-lg p-4 text-sm text-white shadow-xl`}
        style={{
          width, background: fill, zIndex: 9999,
          left: p?.left ?? 0, top: p?.top ?? 0,
          visibility: p ? 'visible' : 'hidden',
        }}
        /* The press must not reach the window underneath, which would read it
           as "raise me" and close this. */
        onMouseDown={e => e.stopPropagation()}>
        <span aria-hidden style={arrowStyle} />
        {title && <p className="relative font-semibold leading-snug">{title}</p>}
        <div className={`relative text-white/90 ${title ? 'mt-2' : ''}`}>{children}</div>
        <div className="relative mt-3 flex justify-end gap-1">
          {action && (
            <button type="button" onClick={action.onClick}
              className="rounded px-2 py-1 text-white hover:bg-white/15">
              {action.label}
            </button>
          )}
          <button type="button" autoFocus onClick={onClose}
            className="rounded px-2 py-1 text-white hover:bg-white/15">
            {okLabel}
          </button>
        </div>
      </div>
    </>,
    host,
  )
}
