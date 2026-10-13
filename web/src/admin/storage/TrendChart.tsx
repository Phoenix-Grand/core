import { useEffect, useMemo, useRef, useState } from "react"
import { formatBytes } from "../sections/format"
import { type TrendDatum } from './charts'

/**
 * The two figures this page draws, and nothing else.
 *
 * ## Colour
 *
 * Everything resolves through a theme variable — `var(--color-primary)`,
 * `var(--color-success)`, `var(--color-border)`. No hex is written down, so a
 * theme that remaps its variables recolours both charts, dark mode included.
 *
 * `fill-opacity` on an SVG shape is deliberate and is NOT the banned pattern:
 * the ban is on Tailwind's colour-opacity modifiers (`bg-primary/10`), which
 * compile to a `color-mix()` carrying a **static light-theme hex** as its
 * fallback. An SVG `fill-opacity` composites the *resolved* variable at paint
 * time, so it follows the theme like any other use of the token.
 *
 * ## Marks
 *
 * 2px lines, ≥8px end markers ringed in the surface colour, hairline solid
 * gridlines one step off the surface, a 2px surface gap between touching
 * segments. Values are never printed on every point: the axis, the end label and
 * the hover read-out carry them, and the figures beside each chart repeat the
 * ones that matter so nothing is reachable only through a tooltip.
 */

/** Container width, tracked so a chart reflows on a phone and in a split pane. */
function useWidth<T extends HTMLElement>(ref: React.RefObject<T | null>): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(entries => setW(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

const PAD = { l: 52, r: 12, t: 12, b: 22 }

/** A round-ish ceiling so the axis reads 0 / 2 Go / 4 Go rather than 0 / 1.87 Go. */
function niceCeil(v: number): number {
  if (v <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(v))
  const f = v / pow
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
}

/**
 * A single-series line over time. No legend — one series, and the card title
 * already names it.
 *
 * Days with no sample are absent from `data` rather than zero-filled: a core
 * that was switched off for a week measured nothing that week, and drawing a
 * dip to zero would report a mass deletion that never happened. Points are laid
 * out by their **date**, so a gap in the samples is a gap on the axis.
 */
export function TrendChart({
  data, height = 180, label,
}: {
  data:    TrendDatum[]
  height?: number
  label:   string
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const [hover, setHover] = useState<number | null>(null)

  const geom = useMemo(() => {
    if (data.length < 2 || width === 0) return null
    const t0 = new Date(data[0].day).getTime()
    const t1 = new Date(data[data.length - 1].day).getTime()
    const span = Math.max(t1 - t0, 1)
    const top = niceCeil(Math.max(...data.map(d => d.value), 1))
    const x0 = PAD.l, x1 = Math.max(width - PAD.r, PAD.l + 1)
    const y0 = PAD.t, y1 = height - PAD.b
    const px = (d: TrendDatum) => x0 + ((new Date(d.day).getTime() - t0) / span) * (x1 - x0)
    const py = (v: number) => y1 - (v / top) * (y1 - y0)
    return { t0, span, top, x0, x1, y0, y1, px, py }
  }, [data, width, height])

  const ticks = useMemo(() => {
    if (!geom) return []
    return [0, 0.25, 0.5, 0.75, 1].map(f => geom.top * f)
  }, [geom])

  const points = geom ? data.map(d => `${geom.px(d)},${geom.py(d.value)}`).join(' ') : ''
  const area = geom
    ? `M ${geom.px(data[0])},${geom.y1} L ${points.split(' ').join(' L ')} L ${geom.px(data[data.length - 1])},${geom.y1} Z`
    : ''

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!geom) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    let best = 0
    let bestD = Infinity
    data.forEach((d, i) => {
      const dist = Math.abs(geom.px(d) - x)
      if (dist < bestD) { bestD = dist; best = i }
    })
    setHover(best)
  }

  const hovered = hover != null ? data[hover] : null
  const last = data[data.length - 1]

  return (
    <div ref={wrap} className="relative w-full">
      {geom && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {/* Hairline, solid, one step off the surface. Dashing would read as a
              projection or a threshold when it is only a grid. */}
          {ticks.map(v => (
            <g key={v}>
              <line
                x1={geom.x0} x2={geom.x1} y1={geom.py(v)} y2={geom.py(v)}
                stroke="var(--color-border)" strokeWidth={1}
              />
              <text
                x={geom.x0 - 8} y={geom.py(v) + 4} textAnchor="end"
                fill="var(--color-text-tertiary)"
                style={{ fontSize: 'var(--kb-text-micro)', fontVariantNumeric: 'tabular-nums' }}
              >
                {formatBytes(v)}
              </text>
            </g>
          ))}

          <path d={area} fill="var(--color-primary)" fillOpacity={0.1} />
          <polyline
            points={points}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Only the endpoint is marked. A dot on every sample would be a
              number on every point by another name. */}
          <circle
            cx={geom.px(last)} cy={geom.py(last.value)} r={4}
            fill="var(--color-primary)"
            stroke="var(--color-surface-0)" strokeWidth={2}
          />

          {hovered && (
            <>
              <line
                x1={geom.px(hovered)} x2={geom.px(hovered)}
                y1={geom.y0} y2={geom.y1}
                stroke="var(--color-border-strong)" strokeWidth={1}
              />
              <circle
                cx={geom.px(hovered)} cy={geom.py(hovered.value)} r={4}
                fill="var(--color-primary)"
                stroke="var(--color-surface-0)" strokeWidth={2}
              />
            </>
          )}

          <line
            x1={geom.x0} x2={geom.x1} y1={geom.y1} y2={geom.y1}
            stroke="var(--color-border-strong)" strokeWidth={1}
          />
        </svg>
      )}

      {hovered && geom && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-border bg-surface-0 px-2.5 py-1.5 shadow-md"
          style={{
            left:      Math.min(Math.max(geom.px(hovered), 70), Math.max(width - 70, 70)),
            top:       geom.py(hovered.value),
            transform: 'translate(-50%, calc(-100% - 10px))',
            fontSize:  'var(--kb-text-meta)',
          }}
        >
          <div className="text-text-tertiary">{hovered.day}</div>
          <div className="tabular-nums text-text-primary">{formatBytes(hovered.value)}</div>
        </div>
      )}
    </div>
  )
}
