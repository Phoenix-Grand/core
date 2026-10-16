import { useState, useRef, useEffect, useCallback, type ReactNode } from "react"
import { useUiTheme } from "../../core/hooks/useUiTheme"
import { useWidth, axisTicks, PAD, chartInk, resolveColor } from '../DashboardCharts'

// ── Tooltip flottant (HTML, positionné en pixels) ─────────────────────────────
function Tip({ left, top, children }: { left: number; top: number; children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute z-20 rounded-lg bg-[#202124] px-2.5 py-1.5 text-[11px] leading-tight text-white shadow-lg whitespace-nowrap"
      style={{ left, top, transform: 'translate(-50%, calc(-100% - 8px))' }}
    >
      {children}
      <span className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-4 border-transparent border-t-[#202124]" />
    </div>
  )
}

// ── Histogramme en barres (canvas, animé + interactif) ────────────────────────
export function BarChart({
  data, color = '#1a73e8', height = 160, unit, xLabels = false,
}: {
  data: { label: string; value: number }[]
  color?: string
  height?: number
  unit?: string
  /** Writes the category under each bar, thinning them out as far as it must to
   *  keep them from touching. Off by default: where the categories are a series
   *  of days whose exact date adds nothing, the hover tooltip already names the
   *  bar and a row of dates is noise. Turn it on when the reader has to be able
   *  to point at a bar and say *which* one it is - an hour of the day, above
   *  all, is unreadable without it. */
  xLabels?: boolean
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const W = useWidth(wrap)
  const theme = useUiTheme()
  const [hi, setHi] = useState<number | null>(null)
  const progress = useRef(0)
  const animated = useRef(false)
  const { top, ticks } = axisTicks(Math.max(...data.map((d) => d.value), 0))
  const n = data.length || 1

  const geom = useCallback(() => {
    const x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = height - PAD.b
    const slot = (x1 - x0) / n
    return { x0, x1, y0, y1, slot, ph: y1 - y0 }
  }, [W, height, n])

  const draw = useCallback((p: number, hover: number | null) => {
    const cv = canvas.current
    if (!cv || W === 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(W * dpr); cv.height = Math.round(height * dpr)
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, height)
    const ink = chartInk(cv)
    const paint = resolveColor(cv, color)
    const { x0, x1, y1, slot, ph } = geom()
    // Grille + axe Y
    ctx.font = '10px system-ui, sans-serif'
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    ctx.lineWidth = 1
    ticks.forEach((tk) => {
      const y = y1 - (tk / top) * ph
      ctx.strokeStyle = ink.grid
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(x0, y + 0.5); ctx.lineTo(x1, y + 0.5); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = ink.label
      ctx.fillText(String(tk), x0 - 6, y)
    })
    // Barres
    const bw = Math.min(slot * 0.62, 46)
    data.forEach((d, i) => {
      const h = (d.value / top) * ph * p
      const cx = x0 + (i + 0.5) * slot
      const x = cx - bw / 2
      const y = y1 - h
      const isHi = hover === i
      const g = ctx.createLinearGradient(0, y, 0, y1)
      g.addColorStop(0, paint)
      g.addColorStop(1, paint + (isHi ? 'cc' : '99'))
      ctx.fillStyle = g
      const r = Math.min(4, bw / 2)
      ctx.beginPath()
      ctx.moveTo(x, y1); ctx.lineTo(x, y + r)
      ctx.arcTo(x, y, x + r, y, r)
      ctx.lineTo(x + bw - r, y); ctx.arcTo(x + bw, y, x + bw, y + r, r)
      ctx.lineTo(x + bw, y1); ctx.closePath()
      if (isHi) { ctx.shadowColor = color + '55'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2 }
      ctx.fill()
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0
    })
    // Axe X. Le pas est mesuré, pas deviné : on n'écrit qu'une étiquette sur
    // `step` pour qu'aucune n'en touche une autre, quelle que soit la largeur.
    if (xLabels && data.length) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'
      ctx.fillStyle = ink.label
      const widest = Math.max(...data.map((d) => ctx.measureText(d.label).width))
      const step = Math.max(1, Math.ceil((widest + 8) / slot))
      data.forEach((d, i) => {
        if (i % step) return
        ctx.fillText(d.label, x0 + (i + 0.5) * slot, y1 + 5)
      })
    }
  }, [W, height, data, ticks, top, color, geom, xLabels])

  // Animation d'apparition (une seule fois), sinon dessin direct.
  useEffect(() => {
    if (W === 0) return
    if (animated.current) { draw(1, hi); return }
    let raf = 0; const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 550)
      progress.current = 1 - Math.pow(1 - p, 3) // ease-out cubic
      draw(progress.current, null)
      if (p < 1) raf = requestAnimationFrame(tick)
      else animated.current = true
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [W, draw]) // eslint-disable-line react-hooks/exhaustive-deps

  // `theme` is a dependency, not a stray: a theme switch rewrites the variables
  // the canvas resolved at its last paint, and a canvas does not reflow.
  useEffect(() => { if (animated.current) draw(1, hi) }, [hi, theme, draw])

  const onMove = (e: React.MouseEvent) => {
    const { x0, slot } = geom()
    const mx = e.nativeEvent.offsetX
    const i = Math.floor((mx - x0) / slot)
    setHi(i >= 0 && i < n ? i : null)
  }

  const tip = hi !== null ? (() => {
    const { x0, y1, slot, ph } = geom()
    return { left: x0 + (hi + 0.5) * slot, top: y1 - (data[hi].value / top) * ph }
  })() : null

  return (
    <div ref={wrap} className="relative" style={{ height }}>
      <canvas ref={canvas} style={{ width: '100%', height }} onMouseMove={onMove} onMouseLeave={() => setHi(null)} />
      {tip && (
        <Tip left={tip.left} top={tip.top}>
          <div className="font-medium">{data[hi!].value}{unit ? ` ${unit}` : ''}</div>
          <div className="text-white/60">{data[hi!].label}</div>
        </Tip>
      )}
    </div>
  )
}
