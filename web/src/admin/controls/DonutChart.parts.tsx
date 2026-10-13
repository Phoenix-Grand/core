/**
 * The parts of `DonutChart.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { DonutChart } from './DonutChart'

export function Part1({ size, setHi, r, stroke, total, data, hi, c, offset, active, centerValue, centerLabel }: { size: NonNullable<DonutChart['size']>; setHi: NonNullable<DonutChart['setHi']>; r: NonNullable<DonutChart['r']>; stroke: NonNullable<DonutChart['stroke']>; total: NonNullable<DonutChart['total']>; data: NonNullable<DonutChart['props']['data']>; hi: DonutChart['hi']; c: NonNullable<DonutChart['c']>; offset: NonNullable<DonutChart['offset']>; active: NonNullable<DonutChart['active']>; centerValue: DonutChart['props']['centerValue']; centerLabel: DonutChart['props']['centerLabel'] }) {
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }} onMouseLeave={() => setHi(null)}>
            <svg width={size} height={size} className="-rotate-90">
              <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-2)" strokeWidth={stroke} />
              {total > 0 && data.map((d, i) => {
                const frac = d.value / total
                const dim = hi !== null && hi !== i
                const seg = (
                  <circle
                    key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={d.color}
                    strokeWidth={hi === i ? stroke + 5 : stroke}
                    strokeDasharray={`${frac * c} ${c}`} strokeDashoffset={-offset * c}
                    opacity={dim ? 0.35 : 1}
                    style={{ transition: 'stroke-width .15s ease, opacity .15s ease', cursor: 'pointer' }}
                    onMouseEnter={() => setHi(i)}
                  />
                )
                offset += frac
                return seg
              })}
            </svg>
            {/* The hole of a ring is a fixed, small circle: a segment name never fits
                in it, and truncating one there produced a clipped grey string lying
                across the arc. The legend beside it already carries every name, and
                the row of the hovered segment is highlighted — so the centre states
                the NUMBER, and on hover its share. Two facts that always fit. */}
            <div className="absolute inset-0 flex flex-col items-center justify-center px-[18%] text-center">
              <span className="font-semibold text-text-primary leading-none"
                style={{ fontSize: 'var(--kb-text-title)' }}>
                {active ? active.value : (centerValue ?? total)}
              </span>
              <span className="mt-1 leading-tight text-text-tertiary"
                style={{ fontSize: 'var(--kb-text-meta)' }}>
                {active
                  ? `${total > 0 ? Math.round((active.value / total) * 100) : 0} %`
                  : (centerLabel ?? '')}
              </span>
            </div>
          </div>
  )
}

export function Part2({ d }: { d: NonNullable<DonutChart['rows_data']>[number]['d'] }) {
  return (
    <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: d.color }} />
  )
}
