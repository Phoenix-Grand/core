/**
 * The parts of `RightPanel.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { cn } from "../../../ui/cn"
import { ExternalLink, GripVertical, X } from "lucide-react"
import { panelPrefs, RIGHT_PANEL_WIDTH } from "../../store/panelPrefs"
import type { RightPanel } from './RightPanel'

export function Part1({ overlay, dragging, isOpen, width, activeEntry, t, onResizeDown, onResizeMove, endResize, applyWidth, appId, navigate, chromeBtn, closePanel }: { overlay: NonNullable<RightPanel['overlay']>; dragging: NonNullable<RightPanel['dragging']>; isOpen: NonNullable<RightPanel['isOpen']>; width: NonNullable<RightPanel['width']>; activeEntry: NonNullable<RightPanel['activeEntry']>; t: NonNullable<RightPanel['tr']>; onResizeDown: NonNullable<RightPanel['onResizeDown']>; onResizeMove: NonNullable<RightPanel['onResizeMove']>; endResize: NonNullable<RightPanel['endResize']>; applyWidth: NonNullable<RightPanel['applyWidth']>; appId: NonNullable<RightPanel['appId']>; navigate: NonNullable<RightPanel['navigate']>; chromeBtn: NonNullable<RightPanel['chromeBtn']>; closePanel: NonNullable<RightPanel['closePanel']> }) {
  return (
    <div
            data-right-panel
            data-overlay={overlay ? '' : undefined}
            /* No `overflow-hidden` here: the resize handle lives OUTSIDE this box
               (`right-full`, in the gutter) and would be clipped away by it. This element
               only sizes and positions; the visible card below does the clipping. */
            className={cn(
              'flex flex-shrink-0 flex-col',
              overlay
                ? 'fixed bottom-1 right-16 top-16 z-50 shadow-[0_6px_18px_rgb(0_0_0/25%)]'
                // The width transition animates the OPEN/CLOSE, but during a drag it makes
                // every pixel lag 200ms behind the cursor - the handle then stutters and the
                // line appears to flicker. Off while dragging.
                : dragging ? 'relative' : 'relative transition-[width] duration-200 ease-in-out',
              // 16px of air between the central area and the panel. The row already puts a
              // 4px gap between its children, so 12px here lands exactly on 16 - and only
              // when the panel is actually open, otherwise a closed panel would leave a
              // 16px hole against the rail.
              !overlay && isOpen && 'ml-3',
            )}
            style={{
              width: isOpen ? width : 0,
              // A floating panel that is closed must not intercept clicks on the content.
              ...(overlay && !isOpen ? { display: 'none' } : null),
            }}
          >
            {isOpen && activeEntry && (
              <>
                {/* Resize joint - the SAME control as the left sidebar's, mirrored: it sits
                    just OUTSIDE the panel (`right-full`), in the 16px gutter between the
                    central area and the panel, rather than tight against the card. Hidden
                    while floating: the panel is then detached from the row and dragging its
                    edge means nothing. */}
                {!overlay && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('shell.resize_panel', { defaultValue: 'Redimensionner le panneau' })}
                    onPointerDown={onResizeDown}
                    onPointerMove={onResizeMove}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    /* Safety net: a capture lost for any other reason (window blur, the node
                       being re-parented) would otherwise leave the panel stuck in the
                       dragging state - blue line, and no open/close animation any more. */
                    onLostPointerCapture={endResize}
                    onDoubleClick={() => { applyWidth(RIGHT_PANEL_WIDTH.DEFAULT); panelPrefs.setRightWidth(appId, RIGHT_PANEL_WIDTH.DEFAULT) }}
                    /* `right-full` alone butts the 12px strip against the panel, leaving it 2px
                       off the centre of the 16px gutter. `mr-[2px]` pushes it onto the
                       exact middle: (16 - 12) / 2 = 2 on each side. */
                    className="group absolute top-0 right-full mr-[2px] hidden h-full w-3 cursor-col-resize lg:block z-[60]"
                  >
                    {/* Hairline - discreet at rest, tinted on hover and while dragging. */}
                    <div className={`absolute inset-y-0 left-1/2 w-[5px] -translate-x-1/2 rounded-full transition-colors
                                ${dragging ? 'bg-primary' : 'bg-transparent group-hover:bg-border'}`} />
                    {/* Grip pill - invisible at rest, materialises as the pointer approaches. */}
                    <div className={`absolute left-1/2 top-1/2 flex h-9 w-3.5 -translate-x-1/2 -translate-y-1/2
                                items-center justify-center rounded-full border bg-surface-0 shadow-sm transition
                                ${dragging
                                  ? 'border-primary/40 bg-primary-light text-primary opacity-100'
                                  : 'border-border text-text-tertiary opacity-0 group-hover:opacity-100'}`}>
                      <GripVertical size={13} />
                    </div>
                  </div>
                )}
    
                {/* The visible card: white surface, rounded corners, and the clipping. */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl"
                     style={{ background: 'var(--color-surface-0)' }}>
                {/* Panel section title: 14px bold, no forced caps and no letter-spacing. */}
                <div className="flex h-11 flex-shrink-0 items-center gap-1 border-b border-border/60 px-4">
                  <span className="flex-1 truncate text-sm font-bold text-text-secondary">
                    {activeEntry.label}
                  </span>
                  {activeEntry.openPath && (
                    <button
                      type="button"
                      onClick={() => navigate(activeEntry.openPath!)}
                      className={chromeBtn}
                      aria-label={t('shell.open')}
                    >
                      <ExternalLink size={15} />
                    </button>
                  )}
                  <button type="button" onClick={closePanel} className={chromeBtn} aria-label={t('common.close')}>
                    <X size={15} />
                  </button>
                </div>
    
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <activeEntry.panelComponent />
                </div>
                </div>
              </>
            )}
          </div>
  )
}
