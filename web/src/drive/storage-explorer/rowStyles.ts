/**
 * Row accents of the list/details views, drawn entirely with inset box-shadows
 * so a contiguous run of selected rows reads as ONE frame (no internal lines,
 * no layout shift).
 */
import type React from 'react'

// Selection border for stacked rows, drawn as per-side inset box-shadows so
// adjacent selected rows collapse their shared edge to a single 2px line: a row
// whose previous sibling is also selected (`mergeTop`) omits its TOP edge - the
// row above already draws that junction with its bottom edge. Non-adjacent edges
// stay 2px (matching a focused <Input>).
const SEL_RING_COLOR = 'var(--color-primary, #1a73e8)'
// Selected row = 2px inset ring drawn with box-shadow (no border). A contiguous
// run of selected rows reads as ONE clean frame with NO internal horizontal
// lines: a row omits its TOP edge when the previous sibling is selected
// (`mergeTop`) and its BOTTOM edge when the next sibling is selected
// (`mergeBottom`). Left/right are always drawn; the block's outer top/bottom keep
// their 2px edge.
function selectionRingShadow(mergeTop?: boolean, mergeBottom?: boolean): string {
  const c = SEL_RING_COLOR
  const parts = [`inset 2px 0 0 0 ${c}`, `inset -2px 0 0 0 ${c}`] // left, right
  if (!mergeTop)    parts.push(`inset 0 2px 0 0 ${c}`)  // top
  if (!mergeBottom) parts.push(`inset 0 -2px 0 0 ${c}`) // bottom
  return parts.join(', ')
}
/** Per-state row accent, drawn entirely with inset box-shadow (no border, so no
 *  layout shift and no border+shadow doubling). */
export function rowAccentShadow(s: { selected?: boolean; preSelected?: boolean; focused?: boolean; dragTarget?: boolean; mergeTop?: boolean; mergeBottom?: boolean }): string | undefined {
  if (s.dragTarget)   return 'inset 3px 0 0 0 var(--color-primary, #1a73e8)'
  if (s.selected)     return selectionRingShadow(s.mergeTop, s.mergeBottom)
  if (s.preSelected)  return 'inset 3px 0 0 0 rgba(26,115,232,0.5)'
  if (s.focused)      return 'inset 3px 0 0 0 rgba(26,115,232,0.4)'
  return undefined
}
/** Merge the pending-state style with a row accent box-shadow (kept if both). */
export function withRowShadow(base: React.CSSProperties | undefined, shadow?: string): React.CSSProperties | undefined {
  if (!shadow) return base
  return { ...base, boxShadow: [base?.boxShadow, shadow].filter(Boolean).join(', ') }
}
