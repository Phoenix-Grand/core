/**
 * Should a control REFUSE the focus a click would hand it?
 *
 * On a native form the answer is never: clicking a select moves the focus to
 * the select, the field the reader has just left goes dark, and the keyboard
 * follows the pointer. That is the behaviour every reader expects, and any
 * control that departs from it produces the same defect - a text field still
 * lit while the reader is visibly working somewhere else.
 *
 * The one place where refusing is right is a TOOLBAR over a DOCUMENT: picking
 * a font for the words highlighted in a document must not take the focus off
 * the document, or the selection it is about to act on is gone. That situation
 * is recognisable from the page itself - the focus is on a contenteditable
 * surface that is not a form field - so a control can decide at the moment of
 * the click rather than being told at every call site, and the default is
 * right for the six hundred places that never said.
 *
 * A rich text FIELD in a form is contenteditable too, and it is exactly the
 * case that must NOT be protected: a list elsewhere in the form is not its
 * toolbar, and leaving the focus in the field kept it lit beside the open list
 * (found by the frame-by-frame test, not by reasoning). Form fields wear
 * `kb-field-focus`; a document does not. That is the line.
 */
export function focusIsWorthKeeping(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return false
  return el.isContentEditable && !el.closest('.kb-field-focus')
}
