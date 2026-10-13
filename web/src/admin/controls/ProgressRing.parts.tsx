/**
 * The parts of `ProgressRing.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { ProgressRing } from './ProgressRing'

export function Part1({ size, r, stroke, color, c, clamped, value, label }: { size: NonNullable<ProgressRing['size']>; r: NonNullable<ProgressRing['r']>; stroke: NonNullable<ProgressRing['stroke']>; color: NonNullable<ProgressRing['color']>; c: NonNullable<ProgressRing['c']>; clamped: NonNullable<ProgressRing['clamped']>; value: NonNullable<ProgressRing['props']['value']>; label: NonNullable<ProgressRing['props']['label']> }) {
  return (
    <div className="relative" style={{ width: size, height: size }}>
            <svg width={size} height={size} className="-rotate-90">
              <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-3)" strokeWidth={stroke} />
              <circle
                cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
                strokeLinecap="round" strokeDasharray={c}
                strokeDashoffset={c - (clamped / 100) * c}
                style={{ transition: 'stroke-dashoffset .6s ease' }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xl font-semibold text-text-primary leading-none">{value}</span>
              {label && <span className="text-[11px] text-text-tertiary mt-1">{label}</span>}
            </div>
          </div>
  )
}
