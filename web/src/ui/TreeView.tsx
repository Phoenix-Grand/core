import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from './cn'
import {
  flattenTree, initiallyExpanded, itemText, listRows, moveIndex, treeArrow, typeAhead, type ListItemDef,
} from './listCore'
import { LIST_MAX_HEIGHT, LIST_ROW_HEIGHT } from './ListBox'
import { useVirtualList } from './useVirtualList'

export interface TreeViewProps {
  /** The `Item` children (nested `Item`s make sub-trees). */
  items?: ListItemDef[]
  /** `ItemsSource`: rows to show instead of the items; a row's `items` / `Items` / `children` list nests. */
  source?: unknown[]
  /** The selected item, as indexes separated by dots (`0.2.1`); `''` = none. Controlled when given. */
  selectedPath?: string
  onSelectionChange?: (path: string, selected: string[]) => void
  multiSelect?: boolean
  /** Enter or a double click on an item: the item and its position among the shown rows. */
  onItemActivate?: (item: unknown, index: number) => void
  /** Row height in pixels; 0 = standard. */
  itemHeight?: number
  /** Height of the tree in pixels; unset = the rows' height up to 320 px, then it scrolls. */
  height?: number
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
  'aria-label'?: string
}

const INDENT = 16

/** The paths of an item's ancestors (`0.2.1` → `0`, `0.2`). */
function ancestors(path: string): string[] {
  const parts = path.split('.')
  return parts.slice(0, -1).map((_, k) => parts.slice(0, k + 1).join('.'))
}

/**
 * A tree of items that expand (the `.kbview` `TreeView`): WAI-ARIA tree pattern - `role="tree"`, treeitems with
 * `aria-level`, `aria-setsize`, `aria-posinset`, `aria-expanded`; Up / Down, Home / End, Page Up / Page Down,
 * Right (Left in RTL) expands then enters, Left collapses then goes to the parent, Enter activates, type-ahead.
 * Virtualised over the shown rows.
 */
export const TreeView = React.forwardRef<HTMLDivElement, TreeViewProps>(function TreeView(
  { items, source, selectedPath, onSelectionChange, multiSelect = false, onItemActivate, itemHeight, height, disabled, className, style, ...aria },
  ref,
) {
  const roots = listRows(source, items)
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = initiallyExpanded(roots)
    if (selectedPath) for (const a of ancestors(selectedPath)) open.add(a)
    return open
  })
  const rows = useMemo(() => flattenTree(roots, expanded), [roots, expanded])
  const labels = useMemo(() => rows.map((r) => itemText(r.item)), [rows])
  const rowHeight = itemHeight && itemHeight > 0 ? itemHeight : LIST_ROW_HEIGHT
  const id = useId()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(selectedPath ? [selectedPath] : []))
  const [anchor, setAnchor] = useState(selectedPath ?? '')
  const [activePath, setActivePath] = useState(selectedPath ?? '')
  const [focused, setFocused] = useState(false)
  const typed = useRef({ text: '', at: 0 })
  const host = useRef<HTMLDivElement | null>(null)
  const vl = useVirtualList(rows.length, rowHeight)
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    host.current = el
    vl.ref(el)
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }, [vl.ref, ref]) // eslint-disable-line react-hooks/exhaustive-deps
  const active = rows.findIndex((r) => r.path === activePath)

  // A controlled selection (binding, code): shown, its ancestors expanded.
  useEffect(() => {
    if (selectedPath === undefined || (selected.size <= 1 && selected.has(selectedPath)) || (!selectedPath && selected.size === 0)) return
    setSelected(new Set(selectedPath ? [selectedPath] : []))
    setAnchor(selectedPath)
    if (selectedPath) {
      setActivePath(selectedPath)
      setExpanded((e) => new Set([...e, ...ancestors(selectedPath)]))
    }
  }, [selectedPath]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (next: Set<string>, at: string) => {
    const same = next.size === selected.size && [...next].every((p) => selected.has(p)) && at === anchor
    if (same) return
    setSelected(next)
    setAnchor(at)
    onSelectionChange?.(next.size ? at : '', [...next])
  }
  const choose = (index: number, mods: { toggle?: boolean; range?: boolean } = {}) => {
    const row = rows[index]
    if (!row) return
    if (multiSelect && mods.range) {
      const from = Math.max(0, rows.findIndex((r) => r.path === anchor))
      const [a, b] = from < index ? [from, index] : [index, from]
      const next = mods.toggle ? new Set(selected) : new Set<string>()
      for (let k = a; k <= b; k++) next.add(rows[k].path)
      commit(next, anchor || row.path)
      return
    }
    if (multiSelect && mods.toggle) {
      const next = new Set(selected)
      if (next.has(row.path)) next.delete(row.path)
      else next.add(row.path)
      commit(next, row.path)
      return
    }
    commit(new Set([row.path]), row.path)
  }
  const focusRow = (index: number) => {
    const row = rows[index]
    if (!row) return
    setActivePath(row.path)
    vl.reveal(index)
  }
  const toggle = (path: string) => setExpanded((e) => {
    const next = new Set(e)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || rows.length === 0) return
    const rtl = host.current ? getComputedStyle(host.current).direction === 'rtl' : false
    const arrow = treeArrow(e.key, rows, active < 0 ? 0 : active, rtl)
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      if (!arrow) return
      if (arrow.expand) setExpanded((x) => new Set([...x, arrow.expand!]))
      if (arrow.collapse) setExpanded((x) => { const n = new Set(x); n.delete(arrow.collapse!); return n })
      if (arrow.focus !== active) {
        focusRow(arrow.focus)
        if (!(multiSelect && (e.ctrlKey || e.metaKey))) choose(arrow.focus)
      }
      return
    }
    const to = moveIndex(e.key, active, rows.length, vl.pageRows)
    if (to !== null) {
      e.preventDefault()
      focusRow(to)
      if (!(multiSelect && (e.ctrlKey || e.metaKey))) choose(to, { range: multiSelect && e.shiftKey })
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      if (active >= 0) choose(active, { toggle: multiSelect, range: multiSelect && e.shiftKey })
      return
    }
    if (e.key === 'Enter') {
      if (active >= 0) {
        e.preventDefault()
        onItemActivate?.(rows[active].item, active)
      }
      return
    }
    if (e.key === '*') {
      // Expands every sibling of the focused item (WAI-ARIA tree pattern).
      const row = rows[active]
      if (row) setExpanded((x) => new Set([...x, ...rows.filter((r) => r.parent === row.parent && r.hasChildren).map((r) => r.path)]))
      return
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now()
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key, at: now }
      const at = typeAhead(typed.current.text, labels, active)
      if (at >= 0) {
        focusRow(at)
        choose(at)
      }
    }
  }

  const itemId = (path: string) => `${id}-t${path}`
  const out: React.ReactNode[] = []
  for (let k = vl.start; k < vl.end; k++) {
    const row = rows[k]
    const it = row.item as ListItemDef
    const Icon = row.item && typeof row.item === 'object' ? it.icon : undefined
    const isSel = selected.has(row.path)
    out.push(
      <div
        key={row.path}
        id={itemId(row.path)}
        role="treeitem"
        aria-level={row.level}
        aria-setsize={row.setSize}
        aria-posinset={row.posInSet}
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        aria-selected={isSel}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          if (disabled) return
          setActivePath(row.path)
          if ((e.target as Element).closest?.('[data-kb-twisty]')) { toggle(row.path); return }
          choose(k, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })
        }}
        onDoubleClick={(e) => {
          if (disabled || (e.target as Element).closest?.('[data-kb-twisty]')) return
          if (row.hasChildren) toggle(row.path)
          onItemActivate?.(row.item, k)
        }}
        className={cn(
          'absolute inset-x-0 flex items-center gap-1.5 pe-3 select-none',
          isSel ? 'bg-primary-light text-text-primary' : 'hover:bg-surface-1',
          focused && k === active && 'outline outline-2 -outline-offset-2 outline-primary',
        )}
        style={{ top: k * rowHeight, height: rowHeight, paddingInlineStart: 4 + (row.level - 1) * INDENT }}
      >
        <span data-kb-twisty="" aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center text-text-secondary">
          {row.hasChildren && (
            <ChevronRight size={14} className={cn('transition-transform', row.expanded ? 'rotate-90' : 'rtl:-scale-x-100')} />
          )}
        </span>
        {Icon && <Icon size={16} className="shrink-0 text-text-secondary" />}
        <span className="min-w-0 truncate">{labels[k]}</span>
      </div>,
    )
  }
  const box: React.CSSProperties = height ? { height } : { maxHeight: LIST_MAX_HEIGHT }
  return (
    <div
      ref={setRoot}
      role="tree"
      tabIndex={disabled ? -1 : 0}
      aria-multiselectable={multiSelect || undefined}
      aria-activedescendant={focused && active >= 0 ? itemId(rows[active].path) : undefined}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      onScroll={vl.onScroll}
      onFocus={() => { setFocused(true); if (active < 0 && rows.length) setActivePath(rows[0].path) }}
      onBlur={() => setFocused(false)}
      className={cn(
        'relative overflow-y-auto rounded-md border border-border bg-surface-0 text-sm text-text-primary focus:outline-none',
        focused && 'border-primary',
        disabled && 'opacity-50',
        className,
      )}
      style={{ ...box, ...style }}
      {...aria}
    >
      <div style={{ position: 'relative', height: rows.length * rowHeight }}>{out}</div>
    </div>
  )
})

TreeView.displayName = 'TreeView'
