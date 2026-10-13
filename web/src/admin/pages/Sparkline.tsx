import { useId } from "react"

// ── Sparkline (mini-courbe dans une carte) ────────────────────────────────────
export function Sparkline({ data, color = '#1a73e8', width = 80, height = 28 }: { data: number[]; color?: string; width?: number; height?: number }) {
  const gid = useId()
  if (!data.length) return null
  const max = Math.max(1, ...data)
  const pts = data.map((v, i) => [(i / Math.max(1, data.length - 1)) * width, height - (v / max) * (height - 3) - 1.5])
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#spark-${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
