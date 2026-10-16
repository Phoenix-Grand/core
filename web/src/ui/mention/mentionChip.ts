import type { MentionItem, MentionMatch } from './types'

const STYLE_ID = 'kb-mention-styles'

// The chip is injected as raw HTML into a contenteditable that may live in ANY
// module bundle, so its look must not depend on a stylesheet shipped elsewhere.
// We inject a single <style> once (idempotent). Colours read the module accent
// tokens (`--color-primary*`, resolved per `[data-module]`), with plain hex
// fallbacks so a chip is always legible even outside a themed subtree.
export function ensureMentionStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  // A SOLID chip, like the label chips elsewhere in the instance: filled with
  // the accent, white text, a small radius rather than a pill. A mention is a
  // single object dropped into a sentence - the solid block reads as one thing
  // at a glance, where the earlier pale pill read as merely coloured words.
  // The × is white and sits slightly apart, so it is a button and not the last
  // letter of the name.
  style.textContent = `
/* The × fills its side of the chip: a square as tall as the line, flush against
   the name and against the chip's inner edge. Sized smaller it left air on
   three sides that no amount of margin-balancing made read as centred - the
   square is measured against the chip but seen against the name, whose letters
   stop well short of their own line box.

   What keeps the square off the outer edge is a 2px BORDER rather than padding:
   padding would push the square inwards and it would no longer be full-bleed.
   The frame is drawn in the accent too, so it reads as the chip's own rim; a
   single colour here is the only thing to change to make it a visible outline.
   A whole number of pixels, deliberately: a fractional rim put the chip's edge
   and the square's edge on different phases of the device pixel grid, so the
   two rasterised differently and the gap READ as bigger below than above even
   though the layout had them equal to a hundredth of a pixel. */
.kb-mention{--kb-mention-line:1.45em;
  display:inline-flex;align-items:center;gap:0;padding:0 0 0 .45em;
  border:2px solid var(--color-primary,#1a73e8);border-radius:4px;
  background:var(--color-primary,#1a73e8);color:#fff;font-weight:600;font-size:.94em;
  line-height:var(--kb-mention-line);white-space:nowrap;vertical-align:baseline;text-decoration:none;}
/* No vertical padding on the label: the line height already gives the text its
   room, and padding here made the chip's content taller than the × beside it -
   which put the leftover above and below that button and broke the equality of
   its three margins. */
.kb-mention__label{padding:0;}
/* The × is DRAWN, not typed. The button box centres exactly, but a glyph's ink
   sits wherever its typeface puts it inside the em box - here, noticeably low -
   so a typed × looked off no matter how the box was aligned, and the offset
   would change with the instance's font. Two bars placed at 50%/50% are centred
   by construction, at any size and in any typeface. The character itself stays
   in the markup (existing saved chips carry it, and it is what a reader without
   CSS sees); a transparent text colour is what hides it here. */
/* A SQUARE exactly as tall as the chip's line, so it fills the rim's inner edge
   on three sides with nothing left over. Both its sides come from the one
   declared line height above, so they cannot drift apart, and it stays square
   at any text size. */
.kb-mention__remove{display:inline-flex;align-items:center;justify-content:center;position:relative;
  flex:none;width:var(--kb-mention-line);height:var(--kb-mention-line);
  border:0;padding:0;margin:0;background:transparent;border-radius:2px;
  font:inherit;font-size:1em;line-height:1;color:transparent;opacity:.9;cursor:pointer;user-select:none;}
.kb-mention__remove::before,.kb-mention__remove::after{content:"";position:absolute;left:50%;top:50%;
  width:.72em;height:.11em;border-radius:.06em;background:#fff;}
.kb-mention__remove::before{transform:translate(-50%,-50%) rotate(45deg);}
.kb-mention__remove::after{transform:translate(-50%,-50%) rotate(-45deg);}
.kb-mention__remove:hover{opacity:1;background:rgba(255,255,255,.28);}
`
  document.head.appendChild(style)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The chip's marker so a delegated click handler can spot the × button. */
export const MENTION_REMOVE_ATTR = 'data-kb-mention-remove'

/** Build the chip HTML (contenteditable=false island + clickable ×). */
export function buildMentionChipHtml(item: MentionItem): string {
  const attrs = [
    `data-mention-id="${esc(item.id)}"`,
    item.email ? `data-email="${esc(item.email)}"` : '',
    item.kubunoUserId ? `data-user-id="${esc(item.kubunoUserId)}"` : '',
  ].filter(Boolean).join(' ')
  return (
    `<span class="kb-mention" contenteditable="false" ${attrs}>` +
      `<span class="kb-mention__label">${esc(item.label)}</span>` +
      `<button type="button" class="kb-mention__remove" tabindex="-1" aria-label="Retirer" ${MENTION_REMOVE_ATTR}="1">×</button>` +
    `</span>`
  )
}

/**
 * Replace the typed `@query` before the caret with a mention chip, inside the
 * current selection's contenteditable. Uses `execCommand('insertHTML', …)` on a
 * range that spans `@query`, which keeps the NATIVE undo stack intact (a manual
 * DOM splice would sever it - the lesson from the chat editor). Returns whether
 * the replacement succeeded.
 */
export function replaceMentionQueryWithChip(match: MentionMatch, item: MentionItem): boolean {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return false
  const range = sel.getRangeAt(0)
  const node = range.startContainer
  const caret = range.startOffset
  const span = match.query.length + match.trigger.length
  if (node.nodeType !== Node.TEXT_NODE || caret < span) return false

  // Select the `@query` slice ending at the caret, then overwrite it.
  const sub = document.createRange()
  sub.setStart(node, caret - span)
  sub.setEnd(node, caret)
  sel.removeAllRanges()
  sel.addRange(sub)

  const html = buildMentionChipHtml(item) + ' '
  const ok = document.execCommand('insertHTML', false, html)
  return ok
}

/**
 * Wire a delegated listener that removes a chip when its × is clicked. Returns a
 * cleanup function. Removal goes through `execCommand('delete')` on a range that
 * covers the chip so it too stays on the undo stack.
 */
export function bindMentionChipRemoval(root: HTMLElement, onAfterRemove?: () => void): () => void {
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    const btn = target?.closest?.(`[${MENTION_REMOVE_ATTR}]`)
    if (!btn) return
    const chip = btn.closest('.kb-mention')
    if (!chip || !root.contains(chip)) return
    e.preventDefault()
    e.stopPropagation()
    const range = document.createRange()
    range.selectNode(chip)
    // Extend over a trailing NBSP/space so the chip and its pad vanish together.
    const next = chip.nextSibling
    if (next && next.nodeType === Node.TEXT_NODE) {
      const txt = next.textContent ?? ''
      if (/^[ \s]/.test(txt)) range.setEnd(next, 1)
    }
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    if (!document.execCommand('delete')) {
      // Fallback if execCommand is unavailable.
      range.deleteContents()
    }
    onAfterRemove?.()
  }
  root.addEventListener('click', onClick)
  return () => root.removeEventListener('click', onClick)
}

/**
 * Post-process mention HTML for storage/transport.
 *  - `'mailto'` (default): each `.kb-mention[data-email]` becomes
 *    `<a href="mailto:…">label</a>` (used by mail); chips without an email
 *    collapse to their plain label.
 *  - `'plain'`: every chip collapses to its plain label text.
 * Other modes are intentionally left for later (id-based refs, etc.).
 */
export function serializeMentions(html: string, mode: 'mailto' | 'plain' = 'mailto'): string {
  if (typeof document === 'undefined') return html
  const holder = document.createElement('div')
  holder.innerHTML = html
  holder.querySelectorAll('.kb-mention').forEach((el) => {
    const label = el.querySelector('.kb-mention__label')?.textContent ?? el.textContent ?? ''
    const email = el.getAttribute('data-email')
    if (mode === 'mailto' && email) {
      const a = document.createElement('a')
      a.setAttribute('href', `mailto:${email}`)
      a.textContent = label
      el.replaceWith(a)
    } else {
      el.replaceWith(document.createTextNode(label))
    }
  })
  return holder.innerHTML
}
