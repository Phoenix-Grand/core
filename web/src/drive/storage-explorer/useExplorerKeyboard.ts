/**
 * Keyboard of the explorer.
 *
 * 1. Shortcuts - Ctrl/Cmd+A (select all), Escape (clear), Suppr/Retour arrière
 *    (trash, or permanent delete with Shift).
 * 2. Cursor - arrows move the focused item and Enter opens it. Works in EVERY
 *    view (icons/list/details/tiles/content) because folders AND files carry
 *    `data-selectable-id`; up/down picks the closest geometric neighbour, which
 *    handles grids, lists and the folders↔files boundary alike.
 */
import { useEffect } from 'react'
import type React from 'react'
import type { PendingItem } from '@kubuno/sdk'
import type { Folder, FileItem } from '../api'

export function useExplorerKeyboard({
  orderedIds, selectedIds, setSelectedIds, cursorId, setCursorId, lastSelectedIdxRef,
  itemTypeMap, canDelete, hasPlayingInSelection, scheduleDelete,
  sortedFolders, filteredFiles, navigateTo, openFile, containerRef,
}: {
  orderedIds: string[]
  selectedIds: Set<string>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
  cursorId: string | null
  setCursorId: (id: string | null) => void
  lastSelectedIdxRef: React.MutableRefObject<number>
  itemTypeMap: Map<string, 'file' | 'folder'>
  canDelete: boolean
  hasPlayingInSelection: boolean
  scheduleDelete: (items: PendingItem[], forcePermanent?: boolean) => void
  sortedFolders: Folder[]
  filteredFiles: FileItem[]
  navigateTo: (folder: Folder) => void
  openFile: (file: FileItem) => void
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        if (orderedIds.length === 0) return
        e.preventDefault(); setSelectedIds(new Set(orderedIds))
      } else if (e.key === 'Escape' && selectedIds.size > 0) {
        setSelectedIds(new Set())
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0 && canDelete && !hasPlayingInSelection) {
        // Suppr → corbeille (ou suppression définitive si la source n'a pas de corbeille).
        // Maj+Suppr → suppression définitive forcée.
        e.preventDefault()
        const items: PendingItem[] = [...selectedIds].map(id => ({ id, type: itemTypeMap.get(id) === 'file' ? 'file' : 'folder' }))
        scheduleDelete(items, e.shiftKey)
        setSelectedIds(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [orderedIds, selectedIds]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const openItem = (id: string) => {
      const folder = sortedFolders.find(f => f.id === id)
      if (folder) { navigateTo(folder); return }
      const file = filteredFiles.find(f => f.id === id)
      if (file) openFile(file)
    }
    const focusCursor = (id: string, additive: boolean) => {
      setCursorId(id)
      lastSelectedIdxRef.current = orderedIds.indexOf(id)
      setSelectedIds(prev => { if (!additive) return new Set([id]); const n = new Set(prev); n.add(id); return n })
      requestAnimationFrame(() => {
        try { const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id; document.querySelector(`[data-selectable-id="${sel}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* ignore */ }
      })
    }
    const vertical = (id: string, dir: 1 | -1): string | null => {
      const root = containerRef.current
      if (!root) return null
      const els = [...root.querySelectorAll('[data-selectable-id]')] as HTMLElement[]
      const cur = els.find(e => e.dataset.selectableId === id)
      if (!cur) return null
      const cr = cur.getBoundingClientRect(); const cx = cr.left + cr.width / 2
      let best: string | null = null, bestScore = Infinity
      for (const e of els) {
        if (e === cur) continue
        const r = e.getBoundingClientRect()
        const ok = dir === 1 ? (r.top - cr.top > 4) : (cr.top - r.top > 4)
        if (!ok) continue
        const score = Math.abs(r.top - cr.top) * 100000 + Math.abs((r.left + r.width / 2) - cx)
        if (score < bestScore) { bestScore = score; best = e.dataset.selectableId ?? null }
      }
      return best
    }
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) return
      if (orderedIds.length === 0) return
      e.preventDefault()
      // Anchor on the cursor, else on the current selection, so arrows continue
      // from the selected object.
      const selectionAnchor = (): string | null => {
        if (selectedIds.size === 0) return null
        const li = lastSelectedIdxRef.current
        if (li >= 0 && li < orderedIds.length && selectedIds.has(orderedIds[li])) return orderedIds[li]
        for (let i = orderedIds.length - 1; i >= 0; i--) if (selectedIds.has(orderedIds[i])) return orderedIds[i]
        return null
      }
      const anchor = (cursorId && orderedIds.includes(cursorId) ? cursorId : null) ?? selectionAnchor()
      if (e.key === 'Enter') { openItem(anchor ?? orderedIds[0]); return }
      if (!anchor) { focusCursor(orderedIds[0], false); return }
      const idx = orderedIds.indexOf(anchor)
      let next = anchor
      if (e.key === 'ArrowRight') next = orderedIds[Math.min(orderedIds.length - 1, idx + 1)]
      else if (e.key === 'ArrowLeft') next = orderedIds[Math.max(0, idx - 1)]
      else next = vertical(anchor, e.key === 'ArrowDown' ? 1 : -1) ?? anchor
      focusCursor(next, e.shiftKey)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [orderedIds, cursorId, selectedIds, sortedFolders, filteredFiles]) // eslint-disable-line react-hooks/exhaustive-deps
}
