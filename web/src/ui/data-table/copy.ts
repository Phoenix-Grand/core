/**
 * Clipboard helpers for the table's context menu - pure functions, no React.
 *
 * Values are read from the RENDERED CELLS rather than from the row objects. A
 * column declares `cell` as a ReactNode (a badge, an icon plus a label, a
 * formatted date), so the object field is often not what is on screen - and it
 * is what is on screen that somebody right-clicking means to copy. Reading the
 * DOM also keeps the current sort and the current column order for free.
 *
 * Consequence worth knowing: copying a column copies the CURRENT PAGE, because
 * that is all the DOM holds. Rows on other pages were never rendered.
 *
 * Cells are found by `data-col`, never by index: the selection checkbox and the
 * row-actions cell would otherwise shift every offset by one.
 */

/** Text of one cell, whitespace-collapsed - `innerText` already skips hidden nodes. */
export function cellText(td: Element): string {
  return (td as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
}

/** One row, tab-separated: pastes into a spreadsheet as separate columns. */
export function rowText(tr: Element): string {
  return [...tr.querySelectorAll('[data-col]')].map(cellText).join('\t')
}

/** Every rendered row for one column, one value per line. */
export function columnText(table: Element, colId: string): string {
  const sel = `[data-col="${CSS.escape(colId)}"]`
  return [...table.querySelectorAll(`tbody ${sel}`)].map(cellText).join('\n')
}

/** Current text selection, if the user highlighted something before right-clicking. */
export function selectionText(): string {
  return (window.getSelection?.()?.toString() ?? '').trim()
}

/**
 * Write to the clipboard. `navigator.clipboard` is undefined outside a secure
 * context - the app served over plain http on a LAN address, for instance - so
 * the textarea + `execCommand` path is a real fallback here, not legacy noise.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* falls through - permission denied or insecure context */ }
  }
  const el = document.createElement('textarea')
  el.value = text
  el.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(el)
  el.focus()
  el.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  document.body.removeChild(el)
  return ok
}
