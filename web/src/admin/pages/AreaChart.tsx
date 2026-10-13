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

// ── Courbe / aire lissée (canvas, animée + crosshair) ─────────────────────────
export function AreaChart({
  data, color = '#1e8e3e', height = 160, unit,
}: { data: { label: string; value: number }[]; color?: string; height?: number; unit?: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const W = useWidth(wrap)
  const theme = useUiTheme()
  const [hi, setHi] = useState<number | null>(null)
  const animated = useRef(false)
  const { top, ticks } = axisTicks(Math.max(...data.map((d) => d.value), 0))
  const n = data.length

  const geom = useCallback(() => {
    const x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = height - PAD.b
    const ph = y1 - y0
    const xOf = (i: number) => x0 + (i / Math.max(1, n - 1)) * (x1 - x0)
    const yOf = (v: number) => y1 - (v / top) * ph
    return { x0, x1, y0, y1, ph, xOf, yOf }
  }, [W, height, n, top])

  const draw = useCallback((p: number, hover: number | null) => {
    const cv = canvas.current
    if (!cv || W === 0 || n === 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(W * dpr); cv.height = Math.round(height * dpr)
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, height)
    const ink = chartInk(cv)
    const paint = resolveColor(cv, color)
    const { x0, x1, y1, ph, xOf, yOf } = geom()
    // Grille + axe Y
    ctx.font = '10px system-ui, sans-serif'
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1
    ticks.forEach((tk) => {
      const y = y1 - (tk / top) * ph
      ctx.strokeStyle = ink.grid; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(x0, y + 0.5); ctx.lineTo(x1, y + 0.5); ctx.stroke()
      ctx.setLineDash([]); ctx.fillStyle = ink.label
      ctx.fillText(String(tk), x0 - 6, y)
    })
    // Courbe lissée (Catmull-Rom → bézier), animée en hauteur depuis la ligne de base.
    const pts = data.map((d, i) => [xOf(i), y1 - (y1 - yOf(d.value)) * p] as [number, number])
    const tracePath = () => {
      ctx.beginPath()
      ctx.moveTo(pts[0][0], pts[0][1])
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2
        const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6
        const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1])
      }
    }
    // Aire
    tracePath()
    ctx.lineTo(pts[n - 1][0], y1); ctx.lineTo(pts[0][0], y1); ctx.closePath()
    const g = ctx.createLinearGradient(0, PAD.t, 0, y1)
    g.addColorStop(0, paint + '4d'); g.addColorStop(1, paint + '05')
    ctx.fillStyle = g; ctx.fill()
    // Ligne
    tracePath()
    ctx.strokeStyle = paint; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke()
    // Crosshair + point survolé
    if (hover !== null) {
      const hx = xOf(hover), hy = yOf(data[hover].value)
      ctx.strokeStyle = paint + '88'; ctx.setLineDash([4, 4])
      ctx.beginPath(); ctx.moveTo(hx, PAD.t); ctx.lineTo(hx, y1); ctx.stroke(); ctx.setLineDash([])
      ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2)
      // The surface, not white: a dark theme's card is not a white disc.
      ctx.fillStyle = ink.surface; ctx.fill()
      ctx.lineWidth = 2.5; ctx.strokeStyle = paint; ctx.stroke()
    }
  }, [W, height, data, ticks, top, color, n, geom])

  useEffect(() => {
    if (W === 0) return
    if (animated.current) { draw(1, hi); return }
    let raf = 0; const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 600)
      draw(1 - Math.pow(1 - p, 3), null)
      if (p < 1) raf = requestAnimationFrame(tick); else animated.current = true
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [W, draw]) // eslint-disable-line react-hooks/exhaustive-deps

  // See the note on the bar chart: a theme switch has to repaint the canvas.
  useEffect(() => { if (animated.current) draw(1, hi) }, [hi, theme, draw])

  const onMove = (e: React.MouseEvent) => {
    const { x0, x1 } = geom()
    const mx = e.nativeEvent.offsetX
    const i = Math.round(((mx - x0) / Math.max(1, x1 - x0)) * (n - 1))
    setHi(i >= 0 && i < n ? i : null)
  }
  const tip = hi !== null ? { left: geom().xOf(hi), top: geom().yOf(data[hi].value) } : null

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
