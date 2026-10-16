/* Editing primitives behind the default context menu of text entry areas.
 * Kept out of the React host so the clipboard handling can be read on its own -
 * it is where nearly all the browser-specific caveats live. */

export type TextTarget =
  | { kind: 'field'; el: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'rich';  el: HTMLElement }

/* Input types that hold editable text. `number` is included on purpose - it is a text
 * entry area for the user even though it has no selection API (see `selectionOf`).
 * Excluded: checkbox, radio, range, color, file, button, submit, reset, image, hidden
 * and the date/time family, whose native pickers own their interaction. */
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number',
])

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD   = isMac ? '⌘' : 'Ctrl+'
export const SHIFT = isMac ? '⇧' : 'Shift+'

/** Finds the text entry area a `contextmenu` event landed in, if any. */
export function findTextTarget(node: EventTarget | null): TextTarget | null {
  if (!(node instanceof Element)) return null
  if (node instanceof HTMLTextAreaElement) return { kind: 'field', el: node }
  if (node instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has((node.type || 'text').toLowerCase()) ? { kind: 'field', el: node } : null
  }
  /* `closest` rather than a direct check: a right-click inside a rich editor lands on
   * whatever inline element is under the cursor, not on the editable host itself.
   * `isContentEditable` is the reliable test - it is false for `contenteditable="false"`
   * and true for a child inheriting editability. */
  const rich = node.closest<HTMLElement>('[contenteditable]')
  return rich?.isContentEditable ? { kind: 'rich', el: rich } : null
}

/* `selectionStart` throws InvalidStateError on input types without a selection API
 * (`number` being the one that matters here), so the read is guarded rather than
 * feature-detected. */
function selectionOf(el: HTMLInputElement | HTMLTextAreaElement): { start: number; end: number } | null {
  try {
    const { selectionStart: start, selectionEnd: end } = el
    return start === null || end === null ? null : { start, end }
  } catch {
    return null
  }
}

export function isEditable(target: TextTarget): boolean {
  return target.kind === 'field'
    ? !target.el.readOnly && !target.el.disabled
    : target.el.isContentEditable
}

export function hasSelection(target: TextTarget): boolean {
  if (target.kind === 'field') {
    const sel = selectionOf(target.el)
    // Unreadable selection: assume there might be one rather than greying out Cut and
    // Copy, which the browser's own menu keeps enabled on those fields.
    return sel ? sel.end > sel.start : true
  }
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && !!sel.anchorNode && target.el.contains(sel.anchorNode)
}

function selectedText(target: TextTarget): string {
  if (target.kind === 'field') {
    const sel = selectionOf(target.el)
    if (sel) return target.el.value.slice(sel.start, sel.end)
  }
  return window.getSelection()?.toString() ?? ''
}

/** True when the clipboard can be READ. Writing has an execCommand fallback, reading
 *  has none - and `navigator.clipboard` is absent outside a secure context (plain HTTP
 *  on anything other than localhost), so Paste has to be offered conditionally. */
export function canReadClipboard(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.clipboard?.readText
}

/* Inserts at the caret through `insertText` rather than assigning `value`: it keeps the
 * native undo stack and, decisively, emits the `input` event React needs to notice a
 * controlled field changed. Assigning `.value` directly is swallowed by React's own
 * value tracking, which re-renders the previous string. */
function insertText(target: TextTarget, text: string): void {
  if (document.execCommand('insertText', false, text)) return
  if (target.kind !== 'field') return

  // Fallback: go through the prototype setter so React's tracker sees a real change.
  const el = target.el
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  const sel = selectionOf(el) ?? { start: el.value.length, end: el.value.length }
  setter?.call(el, el.value.slice(0, sel.start) + text + el.value.slice(sel.end))
  try { el.setSelectionRange(sel.start + text.length, sel.start + text.length) } catch { /* no selection API */ }
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

export function undo(): void { document.execCommand('undo') }
export function redo(): void { document.execCommand('redo') }
export function deleteSelection(): void { document.execCommand('delete') }

export async function copySelection(target: TextTarget): Promise<void> {
  const text = selectedText(target)
  if (text && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  document.execCommand('copy')   // still works without a secure context
}

export async function cutSelection(target: TextTarget): Promise<void> {
  const text = selectedText(target)
  if (text && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    deleteSelection()
    return
  }
  document.execCommand('cut')
}

export async function pasteInto(target: TextTarget, plain: boolean): Promise<void> {
  // A rich editor takes formatting, but only when the clipboard actually carries an
  // HTML flavour and the caller did not ask for plain text.
  if (!plain && target.kind === 'rich' && navigator.clipboard?.read) {
    try {
      for (const item of await navigator.clipboard.read()) {
        if (!item.types.includes('text/html')) continue
        const html = await (await item.getType('text/html')).text()
        if (document.execCommand('insertHTML', false, html)) return
        break
      }
    } catch {
      // Permission refused, or no HTML flavour - fall through to plain text.
    }
  }
  const text = await navigator.clipboard.readText()
  if (text) insertText(target, text)
}

export function selectAll(target: TextTarget): void {
  if (target.kind === 'field') {
    target.el.focus()
    target.el.select()
    return
  }
  const range = document.createRange()
  range.selectNodeContents(target.el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}
