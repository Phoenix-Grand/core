// Core UI primitive: a colour swatch button that opens the shared ColorPicker in a
// FLOATING popover (portal to <body>, fixed-positioned next to the swatch).
// Like the context menu, the popover is ALWAYS kept fully on-screen: its real
// rendered size is measured, then the position is clamped to the viewport on every
// edge (and recomputed on resize). Usable by every module - `t`/`C` are optional.
import { useState, useRef, useLayoutEffect, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { TFunction } from 'i18next'
import type { CSSProperties } from 'react'
import { ColorPicker, useAppPickerTheme, type PickerTheme, type PickerTool } from './ColorPicker'

export function ColorField({ t, C, color, onChange, history, onPickHistory, className, style, width = 32, height = 24, leftTools }: {
  t?: TFunction
  C?: PickerTheme
  color: string
  onChange: (hex: string) => void
  history?: string[]
  onPickHistory?: (hex: string) => void
  className?: string
  style?: CSSProperties
  width?: number
  height?: number
  // Extra tool buttons injected into the picker's left column (see PickerTool).
  leftTools?: PickerTool[]
}) {
  // Sans thème explicite, le picker suit le thème de l'APPLICATION (clair/sombre).
  const appTheme = useAppPickerTheme()
  const theme = C ?? appTheme
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  // null until measured → render the popover hidden for one frame so we can read
  // its true size, then place it. useLayoutEffect makes this flicker-free.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const reposition = () => {
    const btn = btnRef.current, pop = popRef.current
    if (!btn || !pop) return
    const r = btn.getBoundingClientRect()
    const PW = pop.offsetWidth || 244
    const PH = pop.offsetHeight || 480
    const M = 8
    const vw = window.innerWidth, vh = window.innerHeight
    // Prefer to the LEFT of the swatch (swatches usually sit in right-hand panels);
    // fall back to the right if there isn't room. Then clamp to the viewport.
    let left = r.left - PW - M
    if (left < M) left = r.right + M
    if (left + PW > vw - M) left = vw - PW - M
    if (left < M) left = M
    // Align the top with the swatch, but never let the bottom go off-screen; if the
    // picker is taller than the viewport, pin it to the top.
    let top = r.top
    if (top + PH > vh - M) top = vh - PH - M
    if (top < M) top = M
    setPos({ left, top })
  }

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    reposition()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep it on-screen if the window resizes while open.
  useEffect(() => {
    if (!open) return
    const onResize = () => reposition()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen(v => !v)} className={className}
              style={{ width, height, background: color, border: `1px solid ${open ? theme.accent : theme.border}`, borderRadius: 4, cursor: 'pointer', ...style }} />
      {open && createPortal(
        <>
          <div className="fixed inset-0" style={{ zIndex: 199 }} onPointerDown={() => setOpen(false)} />
          <div
            ref={popRef}
            className="fixed"
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              zIndex: 200,
              // Hidden until measured, so it never flashes at the wrong spot.
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            <ColorPicker t={t} C={theme} color={color} onChange={onChange} onClose={() => setOpen(false)} history={history} onPickHistory={onPickHistory} leftTools={leftTools} />
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
