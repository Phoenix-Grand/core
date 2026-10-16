import { useRef, useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, RotateCcw } from 'lucide-react'
import ConfirmDialog from '@ui/ConfirmDialog'
import { COLS, ROW_H, GAP, type GridPos, type DragState, type ResizeState, type GhostState } from './gridTypes'
import { useGridLayout } from './useGridLayout'
import { useConfirm } from '../hooks/useConfirm'
import { useModulesStore } from '../store/modulesStore'
import { resolveWidgetPresentation, widgetSizeLabel } from './widgetCatalog'
import GridWidget from './GridWidget'
import type { WidgetDef } from './WidgetRegistry'

interface Props {
  allWidgets:  WidgetDef[]
  activeIds:   Set<string>
  editMode:    boolean
}

const MIN_COL_SPAN = 2
const MIN_ROW_SPAN = 2

export default function GridDashboard({ allWidgets, activeIds, editMode }: Props) {
  const { t } = useTranslation()
  const { activeModules } = useModulesStore()
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
  const {
    gridItems, hiddenWidgets,
    moveWidget, resizeWidget, removeWidget, addWidget, resetLayout,
    getConfig, setConfig,
  } = useGridLayout(activeIds)

  const handleReset = useCallback(async () => {
    const ok = await confirm({
      title:        t('home.reset_title'),
      message:      t('home.reset_confirm'),
      confirmLabel: t('home.reset'),
      variant:      'warning',
    })
    if (ok) resetLayout()
  }, [confirm, resetLayout, t])

  const gridRef     = useRef<HTMLDivElement>(null)
  const ghostRef    = useRef<HTMLDivElement>(null)
  const dragRef     = useRef<DragState | null>(null)
  const resizeRef   = useRef<ResizeState | null>(null)

  // Mobile: the 12-column grid is unusable (each column ~30px); reflow to a
  // single full-width stacked column. Drag/resize is disabled there.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const on = () => setIsMobile(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const gridEditMode = editMode && !isMobile

  const [ghost, setGhost]       = useState<GhostState | null>(null)
  const [landingId, setLandingId] = useState<string | null>(null)

  // The grid hugs its content exactly (no dead space below the last widget).
  // Spare rows are only added while a drag/resize is in progress, so there's
  // always a landing zone below the content to drop a widget into.
  const contentRows = gridItems.reduce((m, i) => Math.max(m, i.pos.row + i.pos.rowSpan - 1), 1)
  const ghostBottom = ghost ? ghost.row + ghost.rowSpan - 1 : 0
  const gridRows = Math.max(contentRows, ghostBottom) + (ghost ? 2 : 0)

  function getCellWidth(): number {
    if (!gridRef.current) return 80
    return (gridRef.current.clientWidth - (COLS - 1) * GAP) / COLS
  }

  function mouseToCell(clientX: number, clientY: number): { col: number; row: number } {
    if (!gridRef.current) return { col: 1, row: 1 }
    const rect = gridRef.current.getBoundingClientRect()
    const cellW = getCellWidth()
    const cellH = ROW_H + GAP
    const col = Math.max(1, Math.min(COLS, Math.floor((clientX - rect.left) / cellW) + 1))
    const row = Math.max(1, Math.floor((clientY - rect.top + gridRef.current.scrollTop) / cellH) + 1)
    return { col, row }
  }

  function clampPos(col: number, row: number, colSpan: number, rowSpan: number): GridPos {
    const safeCol = Math.max(1, Math.min(col, COLS - colSpan + 1))
    const safeRow = Math.max(1, row)
    return { col: safeCol, row: safeRow, colSpan, rowSpan }
  }

  // ── Drag ────────────────────────────────────────────────────────────────────

  const handleDragStart = useCallback((e: React.PointerEvent, widgetId: string) => {
    if (!editMode) return
    e.preventDefault()
    e.stopPropagation()

    const item = gridItems.find(i => i.id === widgetId)
    if (!item) return

    const { col, row } = mouseToCell(e.clientX, e.clientY)

    dragRef.current = {
      widgetId,
      colSpan:     item.pos.colSpan,
      rowSpan:     item.pos.rowSpan,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startCol:    col,
      startRow:    row,
      originCol:   item.pos.col,
      originRow:   item.pos.row,
    }
    setGhost({ col: item.pos.col, row: item.pos.row, colSpan: item.pos.colSpan, rowSpan: item.pos.rowSpan, visible: true })
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [editMode, gridItems, mouseToCell])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!editMode) return

    if (dragRef.current) {
      const ds = dragRef.current
      const { col, row } = mouseToCell(e.clientX, e.clientY)
      const deltaCol = col - ds.startCol
      const deltaRow = row - ds.startRow
      const newCol = Math.max(1, Math.min(COLS - ds.colSpan + 1, ds.originCol + deltaCol))
      const newRow = Math.max(1, ds.originRow + deltaRow)
      setGhost({ col: newCol, row: newRow, colSpan: ds.colSpan, rowSpan: ds.rowSpan, visible: true })
      return
    }

    if (resizeRef.current) {
      const rs = resizeRef.current
      const cellW = getCellWidth()
      const cellH = ROW_H + GAP
      const dxCells = Math.round((e.clientX - rs.startMouseX) / cellW)
      const dyCells = Math.round((e.clientY - rs.startMouseY) / cellH)

      let newColSpan = rs.startColSpan
      let newRowSpan = rs.startRowSpan

      if (rs.edge === 'right' || rs.edge === 'corner') {
        newColSpan = Math.max(MIN_COL_SPAN, Math.min(COLS - rs.col + 1, rs.startColSpan + dxCells))
      }
      if (rs.edge === 'bottom' || rs.edge === 'corner') {
        newRowSpan = Math.max(MIN_ROW_SPAN, rs.startRowSpan + dyCells)
      }

      setGhost({ col: rs.col, row: rs.row, colSpan: newColSpan, rowSpan: newRowSpan, visible: true })
    }
  }, [editMode, mouseToCell, getCellWidth])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!editMode) return

    if (dragRef.current) {
      const ds = dragRef.current
      const { col, row } = mouseToCell(e.clientX, e.clientY)
      const deltaCol = col - ds.startCol
      const deltaRow = row - ds.startRow
      const newPos = clampPos(ds.originCol + deltaCol, ds.originRow + deltaRow, ds.colSpan, ds.rowSpan)
      moveWidget(ds.widgetId, newPos)
      setLandingId(ds.widgetId)
      setTimeout(() => setLandingId(null), 350)
      dragRef.current = null
      setGhost(null)
    }

    if (resizeRef.current) {
      const rs = resizeRef.current
      if (ghost) {
        resizeWidget(rs.widgetId, { col: rs.col, row: rs.row, colSpan: ghost.colSpan, rowSpan: ghost.rowSpan })
        setLandingId(rs.widgetId)
        setTimeout(() => setLandingId(null), 350)
      }
      resizeRef.current = null
      setGhost(null)
    }
  }, [editMode, ghost, moveWidget, resizeWidget, mouseToCell, clampPos])

  // ── Resize ───────────────────────────────────────────────────────────────────

  const handleResizeStart = useCallback((e: React.PointerEvent, widgetId: string, edge: 'right' | 'bottom' | 'corner') => {
    if (!editMode) return
    e.preventDefault()
    e.stopPropagation()

    const item = gridItems.find(i => i.id === widgetId)
    if (!item) return

    resizeRef.current = {
      widgetId,
      startMouseX:  e.clientX,
      startMouseY:  e.clientY,
      startColSpan: item.pos.colSpan,
      startRowSpan: item.pos.rowSpan,
      col:          item.pos.col,
      row:          item.pos.row,
      edge,
    }
    setGhost({ ...item.pos, visible: true })
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [editMode, gridItems])

  // ── Manual resize buttons ────────────────────────────────────────────────────

  const handleManualResize = useCallback((id: string, delta: 'col+' | 'col-' | 'row+' | 'row-') => {
    const item = gridItems.find(i => i.id === id)
    if (!item) return
    const p = item.pos
    let { col, row, colSpan, rowSpan } = p
    if (delta === 'col+') colSpan = Math.min(COLS - col + 1, colSpan + 1)
    if (delta === 'col-') colSpan = Math.max(MIN_COL_SPAN, colSpan - 1)
    if (delta === 'row+') rowSpan = rowSpan + 1
    if (delta === 'row-') rowSpan = Math.max(MIN_ROW_SPAN, rowSpan - 1)
    resizeWidget(id, { col, row, colSpan, rowSpan })
    setLandingId(id)
    setTimeout(() => setLandingId(null), 350)
  }, [gridItems, resizeWidget])

  // ── Ghost style ──────────────────────────────────────────────────────────────

  const ghostStyle = ghost ? {
    gridColumn: `${ghost.col} / span ${ghost.colSpan}`,
    gridRow:    `${ghost.row} / span ${ghost.rowSpan}`,
  } : undefined

  return (
    <div>
      {/* Grid */}
      <div
        ref={gridRef}
        onPointerMove={gridEditMode ? handlePointerMove : undefined}
        onPointerUp={gridEditMode ? handlePointerUp : undefined}
        style={isMobile ? {
          display:       'flex',
          flexDirection: 'column',
          gap:           `${GAP}px`,
          position:      'relative',
        } : {
          display:             'grid',
          gridTemplateColumns: `repeat(${COLS}, 1fr)`,
          gridAutoRows:        `${ROW_H}px`,
          gap:                 `${GAP}px`,
          gridTemplateRows:    `repeat(${gridRows}, ${ROW_H}px)`,
          position:            'relative',
        }}
        className="w-full"
      >
        {/* Ghost preview */}
        {gridEditMode && ghost?.visible && (
          <div
            ref={ghostRef}
            style={ghostStyle}
            className="pointer-events-none z-30 transition-none relative"
          >
            <div className="absolute top-4 inset-x-0 bottom-0 rounded-xl border-2 border-dashed border-primary bg-primary/10" />
          </div>
        )}

        {/* Widgets - on mobile, render top-to-bottom (row then col) for a natural
            stacked reading order. */}
        {(isMobile
          ? [...gridItems].sort((a, b) => a.pos.row - b.pos.row || a.pos.col - b.pos.col)
          : gridItems
        ).map(item => {
          const widgetDef = allWidgets.find(w => w.id === item.id)
          if (!widgetDef) return null
          return (
            <GridWidget
              key={item.id}
              widget={widgetDef}
              pos={item.pos}
              editMode={gridEditMode}
              isLanding={landingId === item.id}
              config={getConfig(item.id)}
              mobile={isMobile}
              onConfigChange={setConfig}
              onDragStart={handleDragStart}
              onResizeStart={handleResizeStart}
              onRemove={removeWidget}
              onManualResize={handleManualResize}
            />
          )
        })}
      </div>

      {/* Widget catalog (edit mode) */}
      {editMode && (
        <div className="mt-8">
          <div className="flex items-end justify-between mb-3 gap-3">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">{t('home.catalog_title')}</h2>
              <p className="text-xs text-text-tertiary mt-0.5">
                {hiddenWidgets.length > 0 ? t('home.add_widgets_desc') : t('home.all_widgets_shown')}
              </p>
            </div>
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border
                         text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors shrink-0"
            >
              <RotateCcw size={13} />
              {t('home.reset_layout')}
            </button>
          </div>

          {hiddenWidgets.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {hiddenWidgets.map(w => {
                const p = resolveWidgetPresentation(w, activeModules, t)
                const accent = p.accent ?? 'var(--color-primary)'
                return (
                  <button
                    key={w.id}
                    onClick={() => addWidget(w.id)}
                    className="group flex items-center gap-3 p-3 border border-border rounded-xl bg-surface-0
                               text-left hover:border-primary hover:shadow-sm transition-all"
                  >
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: p.accent ? `${p.accent}1a` : 'var(--color-primary-light)', color: accent }}
                    >
                      <p.Icon size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary truncate">{p.title}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-2 text-text-tertiary shrink-0">
                          {widgetSizeLabel(w.size, t)}
                        </span>
                      </div>
                      {p.description && <p className="text-xs text-text-tertiary truncate mt-0.5">{p.description}</p>}
                    </div>
                    <span className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-text-tertiary
                                     bg-surface-1 group-hover:bg-primary group-hover:text-white transition-colors">
                      <Plus size={14} />
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-xl">
              <Plus size={20} className="text-text-tertiary mb-1.5" />
              <p className="text-sm text-text-secondary">{t('home.all_widgets_shown')}</p>
            </div>
          )}
        </div>
      )}

      {confirmState && (
        <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
      )}
    </div>
  )
}
