import { useEffect, useRef } from 'react'

/* Ctrl+S / ⌘S → save now.
 *
 * Handlers form a STACK and only the innermost one runs. Every consumer listens on
 * `document`, so nesting cannot arbitrate for us: a dialog opened over an editor
 * registers second and, with plain listeners, the editor would still win. Last
 * registered wins instead, which is what "the thing the user is looking at" means. */
type SaveHandler = () => void

const stack: SaveHandler[] = []
let bound = false

function onKeyDown(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
  if (e.key.toLowerCase() !== 's') return
  const top = stack[stack.length - 1]
  if (!top) return
  // Always suppress the browser's "Save page as…" dialog once we own the shortcut.
  e.preventDefault()
  e.stopPropagation()
  top()
}

/**
 * Runs `onSave` on Ctrl+S (⌘S on macOS), immediately.
 *
 * `enabled` is for consumers whose save is conditional (nothing to save, read-only
 * document): pass false and the shortcut falls through to whatever is below in the
 * stack rather than firing a no-op.
 */
export function useSaveShortcut(onSave: SaveHandler, enabled = true): void {
  // A ref keeps a re-created closure from re-registering - and from being stale.
  const handler = useRef(onSave)
  handler.current = onSave

  useEffect(() => {
    if (!enabled) return
    const entry: SaveHandler = () => handler.current()
    stack.push(entry)
    if (!bound) {
      // Capture phase: a text field or code editor may swallow the key on its own.
      document.addEventListener('keydown', onKeyDown, true)
      bound = true
    }
    return () => {
      const i = stack.lastIndexOf(entry)
      if (i !== -1) stack.splice(i, 1)
    }
  }, [enabled])
}
