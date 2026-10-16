import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardPaste, ClipboardType, Copy, Redo2, Scissors, TextSelect, Trash2, Undo2 } from 'lucide-react'
import { MenuDropdown, useMenuDropdown, type MenuItem } from '../../../ui/MenuDropdown'
import {
  MOD, SHIFT, canReadClipboard, copySelection, cutSelection, deleteSelection,
  findTextTarget, hasSelection, isEditable, pasteInto, redo, selectAll, undo,
  type TextTarget,
} from '../../../ui/textFieldMenu'

/* Default context menu for every text entry area - the `@ui` primitives (Input,
 * Textarea, NumberInput, Editable, RichText), the search bars, and any field a module
 * renders. Mounted once at the app root rather than wired into each primitive: a single
 * document-level listener covers fields the core does not even know about, and cannot
 * drift out of sync between primitives. */
export function TextFieldMenuHost() {
  const { t } = useTranslation()
  const { pos, openAt, close } = useMenuDropdown()
  const [target, setTarget] = useState<TextTarget | null>(null)
  const openAtRef = useRef(openAt)
  openAtRef.current = openAt

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      /* Bubble phase, plus this guard: a field or editor that provides its own context
       * menu calls preventDefault on the way up and keeps priority. Listening in capture
       * would silently steal those menus. */
      if (e.defaultPrevented) return
      const found = findTextTarget(e.target)
      if (!found) return
      e.preventDefault()
      setTarget(found)
      openAtRef.current(e.clientX, e.clientY)
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])

  const items = useMemo<MenuItem[]>(() => {
    if (!target) return []
    const editable  = isEditable(target)
    const selected  = hasSelection(target)
    const canPaste  = editable && canReadClipboard()
    const run = (fn: () => void | Promise<void>) => () => { void fn(); close() }

    const list: MenuItem[] = []
    if (editable) list.push(
      { type: 'action', label: t('textmenu.undo', { defaultValue: 'Annuler' }), shortcut: `${MOD}Z`,          icon: <Undo2 size={14} />, onClick: run(undo) },
      { type: 'action', label: t('textmenu.redo', { defaultValue: 'Rétablir' }), shortcut: `${MOD}${SHIFT}Z`, icon: <Redo2 size={14} />, onClick: run(redo) },
      { type: 'separator' },
      { type: 'action', label: t('textmenu.cut', { defaultValue: 'Couper' }), shortcut: `${MOD}X`, icon: <Scissors size={14} />, disabled: !selected, onClick: run(() => cutSelection(target)) },
    )
    list.push(
      { type: 'action', label: t('textmenu.copy', { defaultValue: 'Copier' }), shortcut: `${MOD}C`, icon: <Copy size={14} />, disabled: !selected, onClick: run(() => copySelection(target)) },
    )
    if (editable) {
      list.push({
        type: 'action', label: t('textmenu.paste', { defaultValue: 'Coller' }), shortcut: `${MOD}V`,
        icon: <ClipboardPaste size={14} />, disabled: !canPaste,
        onClick: run(() => pasteInto(target, false)),
      })
      // Only a rich editor can paste WITH formatting, so only there does dropping it
      // mean anything.
      if (target.kind === 'rich') list.push({
        type: 'action', label: t('textmenu.paste_plain', { defaultValue: 'Coller sans mise en forme' }),
        shortcut: `${MOD}${SHIFT}V`, icon: <ClipboardType size={14} />, disabled: !canPaste,
        onClick: run(() => pasteInto(target, true)),
      })
      list.push({
        type: 'action', label: t('common.delete'), icon: <Trash2 size={14} />,
        disabled: !selected, onClick: run(deleteSelection),
      })
    }
    list.push(
      { type: 'separator' },
      { type: 'action', label: t('textmenu.select_all', { defaultValue: 'Tout sélectionner' }), shortcut: `${MOD}A`, icon: <TextSelect size={14} />, onClick: run(() => selectAll(target)) },
    )
    return list
  }, [target, t, close])

  if (!pos || !target) return null
  return (
    /* Suppressing the default on mousedown keeps focus and the selection in the field:
     * every action below operates on the live selection, so losing focus to the menu
     * would make Cut, Copy and Paste act on nothing. */
    <div onMouseDown={e => e.preventDefault()}>
      <MenuDropdown items={items} pos={pos} onClose={close} minWidth={220} />
    </div>
  )
}
