/**
 * Where the project's tooltip goes: BELOW the mouse pointer and aligned with it
 * on the left, whenever there is room. That is the house rule - it keeps the
 * bubble out of the way of what the pointer is over, and reading always starts
 * at the same spot as the cursor.
 *
 * Falls back gracefully: above the pointer when the bottom edge is too close,
 * and shifted left when the bubble would run past the right edge.
 */
export interface TooltipPlacement {
  left: number
  top:  number
  /** Which side of the pointer the bubble ended up on. */
  below: boolean
}

export const TOOLTIP_GAP = 14   // clears the mouse cursor itself
const MARGIN = 8                // keeps the bubble off the viewport edges

export function placeTooltip(
  pointerX: number,
  pointerY: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): TooltipPlacement {
  const below = pointerY + TOOLTIP_GAP + size.height + MARGIN <= viewport.height
  const top   = below ? pointerY + TOOLTIP_GAP : pointerY - TOOLTIP_GAP - size.height

  // Left-aligned with the pointer, pulled back only if it would overflow.
  let left = pointerX
  if (left + size.width + MARGIN > viewport.width) left = viewport.width - size.width - MARGIN
  if (left < MARGIN) left = MARGIN

  return { left, top: Math.max(MARGIN, top), below }
}
