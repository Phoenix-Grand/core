import { useId } from "react"
import { axisTicks } from '../DashboardCharts'

// ── Série chronologique en SVG (pour les rapports imprimables) ────────────────

/**
 * The same series as {@link BarChart} and {@link AreaChart}, drawn in SVG.
 *
 * ## Why a second implementation, and only for reports
 *
 * A `<canvas>` is a BITMAP composited at draw time. Two consequences a printed
 * report cannot live with:
 *
 *   • It resolves its theme variables when it paints (see the note at the top of
 *     this file). Under a dark theme the axis labels are painted in the dark
 *     theme's pale ink — and printing does not repaint a canvas, so a print
 *     stylesheet forcing black text has no effect whatsoever on it. The chart
 *     comes out as pale grey on white, or invisible.
 *   • It is rasterised at the screen's pixel ratio, then scaled to the printer's
 *     much higher one. A 132-pixel-tall chart enlarged to a page width prints
 *     visibly soft.
 *
 * SVG has neither problem: it is part of the document, so `@media print` reaches
 * it, and it is resolution-independent. The interactive charts stay on canvas —
 * they are hovered, animated and redrawn constantly, which is the one thing
 * canvas is better at — and reports take this one.
 *
 * ## No measurement, deliberately
 *
 * There is no `ResizeObserver` here. The drawing is laid out in a fixed
 * `viewBox` and scaled by CSS, so it needs no width to render — which matters
 * because the browser lays a page out again for the printer, and a chart that
 * waits for an observer to fire can be measured at zero on the sheet it is being
 * printed onto.
 */
export function ReportSeriesChart({
  data, color = 'var(--kb-chart-1)', shape = 'bars', unit,
}: {
  data:   { label: string; value: number }[]
  color?: string
  /** `bars` for counts of discrete events, `area` for continuous activity. */
  shape?: 'bars' | 'area'
  /** Spells a value in the panel's own unit (counts, or bytes). */
  unit?:  (v: number) => string
}) {
  const gid = useId()
  // A fixed drawing surface: the printed sheet and the screen show the same
  // geometry, only at different sizes.
  const W = 800, H = 280
  const pad = { l: 74, r: 12, t: 14, b: 46 }
  const x0 = pad.l, x1 = W - pad.r, y0 = pad.t, y1 = H - pad.b
  const plotW = x1 - x0, plotH = y1 - y0

  const n = data.length
  if (n === 0) return null

  const { top, ticks } = axisTicks(Math.max(...data.map(d => d.value), 0))
  const yOf = (v: number) => y1 - (v / top) * plotH

  // At most a dozen labels on the axis: forty daily dates printed side by side
  // are a grey band, not a reading. The rows below the chart carry every one.
  const every = Math.max(1, Math.ceil(n / 12))

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      className="w-full text-text-tertiary"
      style={{ height: 'auto' }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id={`rep-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0.04} />
        </linearGradient>
      </defs>

      {/* Grid and the value axis.
          The rules take the theme's own border colour rather than the ink at a
          reduced opacity: an alpha over a theme colour composites against
          whatever is behind it, which is a different surface in each theme and
          white on paper. The LABELS take `currentColor`, so one print rule on
          the container blackens them. */}
      {ticks.map(tk => (
        <g key={tk}>
          <line
            x1={x0} x2={x1} y1={yOf(tk)} y2={yOf(tk)}
            stroke="var(--color-border)" strokeDasharray="3 3"
          />
          <text
            x={x0 - 8} y={yOf(tk)} textAnchor="end" dominantBaseline="middle"
            fontSize={14} fill="currentColor"
          >
            {unit ? unit(tk) : tk}
          </text>
        </g>
      ))}

      {shape === 'area' ? (() => {
        const xOf = (i: number) => x0 + (i / Math.max(1, n - 1)) * plotW
        const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(d.value).toFixed(1)}`).join(' ')
        return (
          <>
            <path d={`${line} L${xOf(n - 1)},${y1} L${xOf(0)},${y1} Z`} fill={`url(#rep-${gid})`} />
            <path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" />
          </>
        )
      })() : (() => {
        const slot = plotW / n
        const bw = Math.min(slot * 0.66, 46)
        return data.map((d, i) => {
          const h = (d.value / top) * plotH
          return (
            <rect
              key={i} x={x0 + (i + 0.5) * slot - bw / 2} y={y1 - h}
              width={bw} height={Math.max(0, h)} rx={2} fill={color}
            />
          )
        })
      })()}

      {/* The baseline, and the instants under it. */}
      <line x1={x0} x2={x1} y1={y1} y2={y1} stroke="var(--color-border-strong)" />
      {data.map((d, i) => {
        if (i % every !== 0) return null
        const x = shape === 'area'
          ? x0 + (i / Math.max(1, n - 1)) * plotW
          : x0 + (i + 0.5) * (plotW / n)
        return (
          <text
            key={i} x={x} y={y1 + 22} textAnchor="middle" fontSize={14} fill="currentColor"
          >
            {d.label}
          </text>
        )
      })}
    </svg>
  )
}
