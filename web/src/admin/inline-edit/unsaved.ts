import { useEffect } from 'react'
import type { TFunction } from 'i18next'
import type { ConfirmOptions } from '@ui/ConfirmDialog'

/**
 * "Something on this screen is half-edited."
 *
 * A record sheet that edits in place has no dialog to close, so nothing stands
 * between an unsaved field and the Back button. This is the counterweight: every
 * card that is dirty registers here, and the two ways of leaving a sheet ask
 * before discarding.
 *
 * The counter is module-level rather than a context on purpose — the cards that
 * register are scattered across tabs and sub-components, and the only consumers
 * are the "leave" handlers of the sheets themselves. A provider would have to be
 * threaded through every one of them to answer a single boolean.
 */

let dirtyCount = 0

/** Are there in-place edits nobody has saved? */
export function hasUnsavedEdits(): boolean {
  return dirtyCount > 0
}

/**
 * Registers an editing card for as long as it holds unsaved changes, and asks
 * the browser to confirm a reload or a tab close while it does.
 */
export function useUnsavedEditor(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    dirtyCount += 1

    const beforeUnload = (e: BeforeUnloadEvent) => {
      // The wording is the browser's own — no page may choose it — but the
      // prompt itself is the point: a reload must not silently drop the field.
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)

    return () => {
      dirtyCount = Math.max(0, dirtyCount - 1)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [dirty])
}

/**
 * Guards an in-app departure (a Back link, a tab switch). Returns `true` when
 * the caller may proceed.
 *
 * Takes the sheet's own `confirm` so the dialog it opens is the one the sheet
 * already renders — this file owns no UI.
 */
export async function confirmLeave(
  confirm: (options: ConfirmOptions) => Promise<boolean>,
  t: TFunction,
): Promise<boolean> {
  if (!hasUnsavedEdits()) return true
  return confirm({
    title:        t('admin.inline_leave_title'),
    message:      t('admin.inline_leave_msg'),
    confirmLabel: t('admin.inline_leave_discard'),
    cancelLabel:  t('admin.inline_leave_stay'),
    variant:      'danger',
  })
}
