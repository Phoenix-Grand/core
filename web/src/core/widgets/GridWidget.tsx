import React, { useRef, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { GripVertical, X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Settings2 } from 'lucide-react'
import { WidgetSizeContext } from './WidgetSizeContext'
import { WidgetConfigContext } from './WidgetConfigContext'
import WidgetSettingsPopover from './WidgetSettingsPopover'
import { posToWidgetSize, COLS, ROW_H, GAP, type GridPos } from './gridTypes'
import type { WidgetDef } from './WidgetRegistry'

interface Props {
  widget:       WidgetDef
  pos:          GridPos
  editMode:     boolean
  isLanding:    boolean
  config:       Record<string, unknown>
  // On mobile the grid reflows to a single stacked column: each widget spans the
  // full width with an explicit height (rowSpan rows), positioned in flow.
  mobile?:      boolean
  onConfigChange: (id: string, key: string, value: unknown) => void
  onDragStart:  (e: React.PointerEvent, widgetId: string) => void
  onResizeStart:(e: React.PointerEvent, widgetId: string, edge: 'right' | 'bottom' | 'corner') => void
  onRemove:     (id: string) => void
  onManualResize: (id: string, delta: 'col+' | 'col-' | 'row+' | 'row-') => void
}

const MIN_COL_SPAN = 2
const MAX_COL_SPAN = COLS
const MIN_ROW_SPAN = 2

function GridWidget({
  widget, pos, editMode, isLanding, config, mobile = false, onConfigChange,
  onDragStart, onResizeStart, onRemove, onManualResize,
}: Props) {
  const { t } = useTranslation()
  // On mobile, treat every widget as full-width so its inner layout uses the
  // roomy "large/medium" rendering rather than the cramped "small" one.
  const widgetSize = mobile ? posToWidgetSize(COLS) : posToWidgetSize(pos.colSpan)
  const nodeRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const hasSettings = !!widget.settings?.length

  const configCtx = useMemo(
    () => ({ value: config, set: (key: string, value: unknown) => onConfigChange(widget.id, key, value) }),
    [config, onConfigChange, widget.id],
  )

  return (
    <div
      ref={nodeRef}
      data-widget-id={widget.id}
      style={mobile ? {
        // Stacked full-width; explicit height from the widget's row span.
        width:    '100%',
        height:   `${pos.rowSpan * ROW_H + (pos.rowSpan - 1) * GAP}px`,
        position: 'relative',
      } : {
        gridColumn: `${pos.col} / span ${pos.colSpan}`,
        gridRow:    `${pos.row} / span ${pos.rowSpan}`,
        position:   'relative',
      }}
      className={`transition-shadow ${isLanding ? 'ring-2 ring-primary ring-offset-2' : ''}`}
    >
      {/* Control bar */}
      {editMode && (
        <div className="absolute -top-3 left-0 right-0 z-20 flex items-center justify-between px-2 gap-1">
          {/* Drag handle */}
          <div
            onPointerDown={e => onDragStart(e, widget.id)}
            className="flex items-center gap-1 bg-white border border-border rounded-full
                       shadow-sm px-2 py-0.5 cursor-grab active:cursor-grabbing select-none touch-none"
          >
            <GripVertical size={13} className="text-text-tertiary" />
            <span className="text-[11px] text-text-secondary">{t('shell.move')}</span>
          </div>

          {/* Size controls */}
          <div className="flex items-center gap-0.5 bg-white border border-border rounded-full shadow-sm px-1 py-0.5">
            <button
              onClick={() => onManualResize(widget.id, 'col-')}
              disabled={pos.colSpan <= MIN_COL_SPAN}
              className="p-0.5 rounded-full hover:bg-surface-2 disabled:opacity-30 transition-colors"
              title={t('widgets.narrower')}
            ><ChevronLeft size={11} /></button>
            <span className="text-[10px] text-text-tertiary px-0.5 select-none tabular-nums">{pos.colSpan}</span>
            <button
              onClick={() => onManualResize(widget.id, 'col+')}
              disabled={pos.col + pos.colSpan - 1 >= MAX_COL_SPAN}
              className="p-0.5 rounded-full hover:bg-surface-2 disabled:opacity-30 transition-colors"
              title={t('widgets.wider')}
            ><ChevronRight size={11} /></button>
            <div className="w-px h-3 bg-border mx-0.5" />
            <button
              onClick={() => onManualResize(widget.id, 'row-')}
              disabled={pos.rowSpan <= MIN_ROW_SPAN}
              className="p-0.5 rounded-full hover:bg-surface-2 disabled:opacity-30 transition-colors"
              title={t('widgets.shorter')}
            ><ChevronUp size={11} /></button>
            <span className="text-[10px] text-text-tertiary px-0.5 select-none tabular-nums">{pos.rowSpan}</span>
            <button
              onClick={() => onManualResize(widget.id, 'row+')}
              className="p-0.5 rounded-full hover:bg-surface-2 disabled:opacity-30 transition-colors"
              title={t('widgets.taller')}
            ><ChevronDown size={11} /></button>
          </div>

          <div className="flex items-center gap-1">
            {/* Settings (only when the widget declares any) */}
            {hasSettings && (
              <button
                onClick={() => setSettingsOpen(o => !o)}
                className={`flex items-center justify-center w-5 h-5 bg-white border rounded-full shadow-sm
                            transition-colors ${settingsOpen ? 'border-primary text-primary' : 'border-border text-text-secondary hover:bg-surface-2'}`}
                title={t('shell.widget_settings')}
              ><Settings2 size={11} /></button>
            )}

            {/* Remove */}
            <button
              onClick={() => onRemove(widget.id)}
              className="flex items-center justify-center w-5 h-5 bg-white border border-border
                         rounded-full shadow-sm text-danger hover:bg-danger/10 transition-colors"
              title={t('shell.widget_remove')}
            ><X size={11} /></button>
          </div>
        </div>
      )}

      {/* Settings popover */}
      {editMode && hasSettings && settingsOpen && (
        <WidgetSettingsPopover
          fields={widget.settings!}
          value={config}
          onChange={(key, value) => onConfigChange(widget.id, key, value)}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <WidgetSizeContext.Provider value={widgetSize}>
        <WidgetConfigContext.Provider value={configCtx}>
          <div
            className={`absolute top-4 inset-x-0 bottom-0 ${editMode ? 'pointer-events-none select-none' : ''}`}
          >
            {editMode && (
              <div className="absolute inset-0 z-10 rounded-xl ring-2 ring-primary/30 pointer-events-none" />
            )}
            <widget.Component />
          </div>
        </WidgetConfigContext.Provider>
      </WidgetSizeContext.Provider>

      {/* Resize handles (edit mode only) */}
      {editMode && (
        <>
          {/* Right edge */}
          <div
            onPointerDown={e => onResizeStart(e, widget.id, 'right')}
            className="absolute top-4 right-0 w-2 bottom-0 cursor-ew-resize z-20
                       flex items-center justify-center group"
          >
            <div className="w-1 h-8 rounded-full bg-primary/40 group-hover:bg-primary transition-colors" />
          </div>
          {/* Bottom edge */}
          <div
            onPointerDown={e => onResizeStart(e, widget.id, 'bottom')}
            className="absolute bottom-0 left-0 right-2 h-2 cursor-ns-resize z-20
                       flex items-center justify-center group"
          >
            <div className="h-1 w-8 rounded-full bg-primary/40 group-hover:bg-primary transition-colors" />
          </div>
          {/* Corner */}
          <div
            onPointerDown={e => onResizeStart(e, widget.id, 'corner')}
            className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize z-30
                       flex items-end justify-end p-0.5"
          >
            <div className="w-2 h-2 rounded-sm bg-primary/50 hover:bg-primary transition-colors" />
          </div>
        </>
      )}
    </div>
  )
}

export default React.memo(GridWidget)
