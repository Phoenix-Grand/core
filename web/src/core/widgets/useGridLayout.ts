import { useState, useEffect, useCallback, useRef } from 'react'
import { COLS, type GridItem, type GridPos, widgetSizeToDefaultColSpan } from './gridTypes'
import { WidgetRegistry } from './WidgetRegistry'
import { api } from '../api/client'
import { useAuthStore } from '../store/authStore'

const STORAGE_PREFIX = 'kubuno:grid-layout-v2'
const SAVE_DEBOUNCE_MS = 800

interface StoredLayout {
  items:  GridItem[]
  hidden: string[]
  /** Per-widget settings: widgetId → { settingKey: value }. */
  config?: Record<string, Record<string, unknown>>
}

function storageKey(userId: string | undefined): string {
  return userId ? `${STORAGE_PREFIX}:${userId}` : STORAGE_PREFIX
}

function loadFromStorage(userId: string | undefined): StoredLayout | null {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return null
}

function saveToStorage(userId: string | undefined, layout: StoredLayout) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(layout))
  } catch { /* ignore */ }
}

async function saveToServer(layout: StoredLayout): Promise<void> {
  try {
    await api.patch('/me', { preferences: { widget_layout: layout } })
  } catch { /* best-effort */ }
}

// ── Geometry ──────────────────────────────────────────────────────────────────

function overlaps(a: GridPos, b: GridPos): boolean {
  return (
    a.col < b.col + b.colSpan &&
    a.col + a.colSpan > b.col &&
    a.row < b.row + b.rowSpan &&
    a.row + a.rowSpan > b.row
  )
}

/**
 * After placing `priorityId` at its new position, push all colliding widgets
 * downward until no two widgets overlap. The priority widget never moves.
 */
function resolveCollisions(items: GridItem[], priorityId: string): GridItem[] {
  // Priority widget is settled first; others sorted top-to-bottom then left-to-right
  const sorted = [...items].sort((a, b) => {
    if (a.id === priorityId) return -1
    if (b.id === priorityId) return 1
    if (a.pos.row !== b.pos.row) return a.pos.row - b.pos.row
    return a.pos.col - b.pos.col
  })

  const settled: GridItem[] = []

  for (const item of sorted) {
    let pos = { ...item.pos }

    // Push the item down until it doesn't overlap any settled widget
    let moved = true
    while (moved) {
      moved = false
      for (const s of settled) {
        if (overlaps(pos, s.pos)) {
          pos = { ...pos, row: s.pos.row + s.pos.rowSpan }
          moved = true
          break
        }
      }
    }

    settled.push({ ...item, pos })
  }

  return settled
}

/** Première ligne libre sous TOUS les widgets donnés (1 si la grille est vide). */
function bottomRow(items: GridItem[]): number {
  return items.reduce((m, i) => Math.max(m, i.pos.row + i.pos.rowSpan), 1)
}

/**
 * Cherche un emplacement libre (sans chevauchement) à partir de `minRow`.
 * Avec `minRow` = bas du contenu existant, les nouveaux widgets se rangent
 * gauche→droite puis vers le bas, toujours SOUS les widgets déjà présents.
 */
function autoPlace(items: GridItem[], colSpan: number, rowSpan: number, minRow = 1): GridPos {
  for (let row = minRow; row <= minRow + 1000; row++) {
    for (let col = 1; col <= COLS - colSpan + 1; col++) {
      const candidate = { col, row, colSpan, rowSpan }
      if (!items.some(i => overlaps(candidate, i.pos))) {
        return candidate
      }
    }
  }
  return { col: 1, row: minRow, colSpan, rowSpan }
}

const EMPTY_LAYOUT: StoredLayout = { items: [], hidden: [] }

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useGridLayout(activeModuleIds: Set<string>) {
  const { user, updateUser } = useAuthStore()
  const userId = user?.id

  const [layout, setLayout] = useState<StoredLayout>(() => {
    return loadFromStorage(userId) ?? EMPTY_LAYOUT
  })

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isInitialized = useRef(false)

  // Load from server (authoritative) on mount / user change
  useEffect(() => {
    if (!user) return
    const serverLayout = (user.preferences as Record<string, unknown> | undefined)
      ?.widget_layout as StoredLayout | undefined
    if (serverLayout?.items) {
      setLayout(serverLayout)
      saveToStorage(userId, serverLayout)
    }
    isInitialized.current = true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Persist on every change
  useEffect(() => {
    if (!isInitialized.current) return
    saveToStorage(userId, layout)

    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(async () => {
      await saveToServer(layout)
      if (user) {
        updateUser({ preferences: { ...(user.preferences as object | undefined), widget_layout: layout } })
      }
    }, SAVE_DEBOUNCE_MS)

    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  // ── Derived state ─────────────────────────────────────────────────────────

  const allWidgets = WidgetRegistry.getAll().filter(w => w.moduleId === 'core' || activeModuleIds.has(w.moduleId))

  const gridItems: GridItem[] = (() => {
    const storedById = new Map(layout.items.map(i => [i.id, i]))
    const visible = allWidgets.filter(w => !layout.hidden.includes(w.id))

    // Pass 1: honour the saved position of every widget that already has one.
    // These must all be placed before auto-placing newcomers, otherwise a
    // freshly registered widget (e.g. a new core widget absent from the saved
    // layout) would be auto-placed into a cell already taken by a stored widget
    // it hasn't "seen" yet, producing an overlap.
    const result: GridItem[] = visible
      .map(w => storedById.get(w.id))
      .filter((i): i is GridItem => i !== undefined)

    // Pass 2: auto-place widgets without a saved position TOUT EN BAS, sous les
    // widgets déjà positionnés - un module fraîchement activé n'intercale jamais
    // ses widgets au milieu de l'agencement existant.
    const startRow = bottomRow(result)
    for (const w of visible) {
      if (storedById.has(w.id)) continue
      const colSpan = widgetSizeToDefaultColSpan(w.size)
      const pos = autoPlace(result, colSpan, 3, startRow)
      result.push({ id: w.id, pos })
    }
    return result
  })()

  const hiddenWidgets = allWidgets.filter(w => layout.hidden.includes(w.id))

  // ── Mutations ─────────────────────────────────────────────────────────────

  /** Upsert helper - adds the item if it's not yet in layout.items */
  function upsert(items: GridItem[], id: string, pos: GridPos): GridItem[] {
    const exists = items.some(i => i.id === id)
    if (exists) return items.map(i => i.id === id ? { ...i, pos } : i)
    return [...items, { id, pos }]
  }

  const moveWidget = useCallback((id: string, newPos: GridPos) => {
    setLayout(prev => {
      const updated = upsert(prev.items, id, newPos)
      const resolved = resolveCollisions(updated, id)
      return { ...prev, items: resolved }
    })
  }, [])

  const resizeWidget = useCallback((id: string, newPos: GridPos) => {
    setLayout(prev => {
      const updated = upsert(prev.items, id, newPos)
      const resolved = resolveCollisions(updated, id)
      return { ...prev, items: resolved }
    })
  }, [])

  const removeWidget = useCallback((id: string) => {
    setLayout(prev => ({
      ...prev,
      hidden: [...prev.hidden.filter(h => h !== id), id],
    }))
  }, [])

  const addWidget = useCallback((id: string) => {
    setLayout(prev => {
      const hidden = prev.hidden.filter(h => h !== id)
      if (prev.items.some(i => i.id === id)) return { ...prev, hidden }
      const w = WidgetRegistry.getAll().find(w => w.id === id)
      const colSpan = widgetSizeToDefaultColSpan(w?.size)
      const pos = autoPlace(prev.items, colSpan, 3, bottomRow(prev.items))
      return { ...prev, hidden, items: [...prev.items, { id, pos }] }
    })
  }, [])

  /** Wipe the saved layout so every available widget returns to its default,
   *  auto-placed position (order/size from the registry). */
  const resetLayout = useCallback(() => {
    setLayout({ items: [], hidden: [] })
  }, [])

  const getConfig = useCallback(
    (id: string): Record<string, unknown> => layout.config?.[id] ?? {},
    [layout.config],
  )

  const setConfig = useCallback((id: string, key: string, value: unknown) => {
    setLayout(prev => ({
      ...prev,
      config: { ...prev.config, [id]: { ...prev.config?.[id], [key]: value } },
    }))
  }, [])

  return { gridItems, hiddenWidgets, moveWidget, resizeWidget, removeWidget, addWidget, resetLayout, getConfig, setConfig }
}
