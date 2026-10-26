// Core UI primitive: a gradient builder that reuses the ColorPicker primitive for
// each stop. Usable by every module (PaintSharp/Apex, Office documents/spreadsheets/
// presentations…). `t` and `C` are optional with sensible defaults.
//
//   <GradientField value={grad} onChange={setGrad} />   // swatch → popover
//   <GradientPicker value={grad} onChange={setGrad} />  // the panel alone
import { useState, useRef, useLayoutEffect, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { TFunction } from 'i18next'
import type { CSSProperties } from 'react'
import { Trash2, Plus } from 'lucide-react'
import { ColorField } from './ColorField'
import { RangeSlider } from './RangeSlider'
import { useAppPickerTheme, type PickerTheme } from './ColorPicker'
import { hexToRgb, rgbToHex } from './color'
import { type Gradient, type GradientStop, gradientToCss, DEFAULT_GRADIENT } from './gradient'

const FALLBACK: Record<string, string> = {
  gradient_linear:   "Linear",
  gradient_radial:   "Radial",
  gradient_angle:    "Angle",
  gradient_position: "Position",
  gradient_opacity:  "Opacity",
  gradient_add_stop: "Add a stop",
}

// Colour sampled along the gradient at position `p` (0..1) - used when inserting
// a stop, so the new stop blends in instead of jumping.
function sampleStop(stops: GradientStop[], p: number): GradientStop {
  const s = [...stops].sort((a, b) => a.position - b.position)
  if (p <= s[0].position) return { ...s[0], position: p }
  if (p >= s[s.length - 1].position) return { ...s[s.length - 1], position: p }
  let i = 0
  while (i < s.length - 1 && s[i + 1].position < p) i++
  const a = s[i], b = s[i + 1]
  const t = (p - a.position) / ((b.position - a.position) || 1)
  const [ar, ag, ab] = hexToRgb(a.color), [br, bg, bb] = hexToRgb(b.color)
  const color = rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t)
  const opacity = Math.round(a.opacity + (b.opacity - a.opacity) * t)
  return { color, position: p, opacity }
}

export function GradientPicker({ t, value, onChange, onClose, C: CProp }: {
  t?: TFunction
  value: Gradient
  onChange: (g: Gradient) => void
  onClose?: () => void
  C?: PickerTheme
}) {
  // Sans thème explicite, on suit le thème de l'APPLICATION (clair/sombre).
  const appTheme = useAppPickerTheme()
  const C = CProp ?? appTheme
  const tr = (k: string) => (t ? t(k, { defaultValue: FALLBACK[k] ?? k }) : (FALLBACK[k] ?? k))
  const grad: Gradient = value ?? DEFAULT_GRADIENT
  const [sel, setSel] = useState(0)
  const barRef = useRef<HTMLDivElement>(null)
  const dragIdx = useRef<number | null>(null)

  const sorted = [...grad.stops].map((s, i) => ({ s, i })).sort((a, b) => a.s.position - b.s.position)
  const selStop = grad.stops[Math.min(sel, grad.stops.length - 1)] ?? grad.stops[0]

  const patch = (g: Partial<Gradient>) => onChange({ ...grad, ...g })
  const patchStop = (idx: number, s: Partial<GradientStop>) =>
    patch({ stops: grad.stops.map((st, i) => (i === idx ? { ...st, ...s } : st)) })

  const posFromEvent = (clientX: number) => {
    const el = barRef.current; if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }
  useEffect(() => {
    const move = (e: PointerEvent) => { if (dragIdx.current != null) patchStop(dragIdx.current, { position: posFromEvent(e.clientX) }) }
    const up = () => { dragIdx.current = null }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }) // eslint-disable-line react-hooks/exhaustive-deps

  const addStop = (p = 0.5) => {
    const ns = sampleStop(grad.stops, p)
    const stops = [...grad.stops, ns]
    onChange({ ...grad, stops })
    setSel(stops.length - 1)
  }
  const removeStop = (idx: number) => {
    if (grad.stops.length <= 2) return
    patch({ stops: grad.stops.filter((_, i) => i !== idx) })
    setSel(0)
  }

  const css = gradientToCss(grad)

  return (
    <div className="shadow-2xl p-3" style={{ width: 260, background: C.toolbar, border: `1px solid ${C.border}`, borderRadius: 4 }}
         onPointerDown={e => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex gap-1">
          {(['linear', 'radial'] as const).map(ty => (
            <button key={ty} onClick={() => patch({ type: ty })}
                    className="px-2 py-0.5 text-[10px] font-medium" style={{ borderRadius: 3,
                      background: grad.type === ty ? C.accent : (C.surface ?? '#2c2c2c'), color: grad.type === ty ? '#fff' : C.textDim,
                      border: `1px solid ${C.border}` }}>
              {tr(ty === 'linear' ? 'gradient_linear' : 'gradient_radial')}
            </button>
          ))}
        </div>
        {onClose && <button onClick={onClose} className="text-[11px] px-1 rounded hover:bg-white/10" style={{ color: C.textDim }}>✕</button>}
      </div>

      {/* Preview bar + draggable stop markers (chequerboard shows transparency) */}
      <div className="relative mb-3" style={{ height: 22 }}>
        <div ref={barRef}
             onPointerDown={e => { const p = posFromEvent(e.clientX); addStop(p) }}
             className="absolute inset-0 cursor-copy"
             style={{
               borderRadius: 3, border: `1px solid ${C.border}`,
               backgroundImage: `${css}, repeating-conic-gradient(#bbb 0% 25%, #fff 0% 50%)`,
               backgroundSize: 'auto, 10px 10px',
             }} />
        {sorted.map(({ s, i }) => (
          <div key={i}
               onPointerDown={e => { e.stopPropagation(); dragIdx.current = i; setSel(i) }}
               title={`${Math.round(s.position * 100)}%`}
               className="absolute -bottom-1 cursor-ew-resize"
               style={{ left: `calc(${s.position * 100}% - 6px)`, width: 12, height: 12,
                        background: s.color, borderRadius: 2,
                        border: `2px solid ${i === sel ? C.accent : '#fff'}`,
                        boxShadow: '0 0 0 1px rgba(0,0,0,.5)' }} />
        ))}
      </div>

      {/* Angle (linear only) */}
      {grad.type === 'linear' && (
        <label className="flex items-center gap-2 mb-2">
          <span className="text-[10px] uppercase flex-shrink-0" style={{ color: C.textDim, width: 48 }}>{tr('gradient_angle')}</span>
          <RangeSlider min={0} max={360} className="flex-1" value={grad.angle}
                       onChange={angle => patch({ angle })}
                       accent={C.accent} trackColor={C.border} aria-label={tr('gradient_angle')} />
          <input type="number" min={0} max={360} value={Math.round(grad.angle)}
                 onChange={e => patch({ angle: Math.max(0, Math.min(360, Number(e.target.value))) })}
                 className="w-14 px-1.5 py-0.5 text-[11px] outline-none"
                 style={{ background: C.surface, color: C.text, border: `1px solid ${C.border}`, borderRadius: 2 }} />
        </label>
      )}

      {/* Selected stop editor */}
      {selStop && (
        <div className="flex flex-col gap-2 pt-2" style={{ borderTop: `1px solid ${C.border}` }}>
          <div className="flex items-center gap-2">
            <ColorField t={t} C={C} width={32} height={24} className="flex-shrink-0"
                        color={selStop.color}
                        onChange={hex => patchStop(grad.stops.indexOf(selStop), { color: hex })} />
            <label className="flex items-center gap-1 flex-1">
              <span className="text-[10px] uppercase" style={{ color: C.textDim }}>{tr('gradient_position')}</span>
              <input type="number" min={0} max={100} value={Math.round(selStop.position * 100)}
                     onChange={e => patchStop(grad.stops.indexOf(selStop), { position: Math.max(0, Math.min(1, Number(e.target.value) / 100)) })}
                     className="w-12 px-1.5 py-0.5 text-[11px] outline-none"
                     style={{ background: C.surface, color: C.text, border: `1px solid ${C.border}`, borderRadius: 2 }} />
            </label>
            {grad.stops.length > 2 && (
              <button onClick={() => removeStop(grad.stops.indexOf(selStop))} title="" style={{ color: C.textDim }}>
                <Trash2 size={13} />
              </button>
            )}
          </div>
          <label className="flex items-center gap-2">
            <span className="text-[10px] uppercase flex-shrink-0" style={{ color: C.textDim, width: 48 }}>{tr('gradient_opacity')}</span>
            <RangeSlider min={0} max={100} className="flex-1" value={selStop.opacity}
                         onChange={opacity => patchStop(grad.stops.indexOf(selStop), { opacity })}
                         accent={C.accent} trackColor={C.border} aria-label={tr('gradient_opacity')} />
            <input type="number" min={0} max={100} value={Math.round(selStop.opacity)}
                   onChange={e => patchStop(grad.stops.indexOf(selStop), { opacity: Math.max(0, Math.min(100, Number(e.target.value))) })}
                   className="w-14 px-1.5 py-0.5 text-[11px] outline-none"
                   style={{ background: C.surface, color: C.text, border: `1px solid ${C.border}`, borderRadius: 2 }} />
          </label>
        </div>
      )}

      <button onClick={() => addStop()}
              className="flex items-center gap-1 px-1.5 py-1 mt-2 text-[10px] rounded"
              style={{ background: C.surface, color: C.textDim }}>
        <Plus size={11} /> {tr('gradient_add_stop')}
      </button>
    </div>
  )
}

// Swatch button (shows the gradient) that opens the GradientPicker in a floating,
// always-on-screen popover - same clamp behaviour as ColorField.
export function GradientField({ t, C: CProp, value, onChange, className, style, width = 32, height = 24 }: {
  t?: TFunction
  C?: PickerTheme
  value: Gradient
  onChange: (g: Gradient) => void
  className?: string
  style?: CSSProperties
  width?: number
  height?: number
}) {
  // Sans thème explicite, on suit le thème de l'APPLICATION (clair/sombre).
  const C = CProp ?? useAppPickerTheme()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const reposition = () => {
    const btn = btnRef.current, pop = popRef.current
    if (!btn || !pop) return
    const r = btn.getBoundingClientRect()
    const PW = pop.offsetWidth || 264, PH = pop.offsetHeight || 360, M = 8
    const vw = window.innerWidth, vh = window.innerHeight
    let left = r.left - PW - M
    if (left < M) left = r.right + M
    if (left + PW > vw - M) left = vw - PW - M
    if (left < M) left = M
    let top = r.top
    if (top + PH > vh - M) top = vh - PH - M
    if (top < M) top = M
    setPos({ left, top })
  }
  useLayoutEffect(() => { if (!open) { setPos(null); return } reposition() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const on = () => reposition()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen(v => !v)} className={className}
              style={{ width, height, backgroundImage: gradientToCss(value), backgroundColor: '#fff',
                       border: `1px solid ${open ? C.accent : C.border}`, borderRadius: 4, cursor: 'pointer', ...style }} />
      {open && createPortal(
        <>
          <div className="fixed inset-0" style={{ zIndex: 199 }} onPointerDown={() => setOpen(false)} />
          <div ref={popRef} className="fixed"
               style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, zIndex: 200, visibility: pos ? 'visible' : 'hidden' }}>
            <GradientPicker t={t} C={C} value={value} onChange={onChange} onClose={() => setOpen(false)} />
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
