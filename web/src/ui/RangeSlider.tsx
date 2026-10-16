import { cn } from './cn'
import React, { useId, useRef, useState, useEffect } from 'react'

// ── Rolling (odometer) number ─────────────────────────────────────────────────
// Each digit lives on a vertical reel (0-9 stacked); when the value changes the
// reel slides to the new digit, giving the "rolling counter" effect.

function Digit({ d, animate }: { d: number; animate: boolean }) {
  return (
    <span className="inline-block overflow-hidden align-baseline" style={{ height: '1em' }}>
      <span
        className="flex flex-col"
        style={{
          transform: `translateY(-${d}em)`,
          transition: animate ? 'transform 360ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
        }}
      >
        {Array.from({ length: 10 }, (_, n) => (
          <span key={n} style={{ height: '1em', lineHeight: '1em' }}>{n}</span>
        ))}
      </span>
    </span>
  )
}

/** Renders `text` with every digit on an animated reel. Non-digits pass through. */
export function RollingNumber({ text, className }: { text: string; className?: string }) {
  // Skip the entrance animation so the reels don't spin up from 0 on mount.
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true }, [])
  return (
    <span className={`inline-flex items-baseline tabular-nums leading-none ${className ?? ''}`}>
      {[...text].map((ch, i) =>
        /\d/.test(ch)
          ? <Digit key={i} d={Number(ch)} animate={mounted.current} />
          : <span key={i}>{ch}</span>,
      )}
    </span>
  )
}

// ── RangeSlider ───────────────────────────────────────────────────────────────

type Variant = 'bubble' | 'boxed'
type Orientation = 'horizontal' | 'vertical'

export interface RangeSliderProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** 'bubble' = thumb + rolling-counter tooltip; 'boxed' = editable number field. */
  variant?: Variant
  /** Layout direction. 'vertical' only applies to the bubble variant (faders, EQ bands). */
  orientation?: Orientation
  /** Format the displayed value (bubble tooltip / boxed field). */
  format?: (v: number) => string
  /** Boxed variant: labels under the two ends (default = format(min)/format(max)). */
  minLabel?: React.ReactNode
  maxLabel?: React.ReactNode
  /** Bubble variant: always show the value tooltip (not only while dragging). */
  showValue?: boolean
  /** Accent colour for the fill/thumb (defaults to the theme primary). */
  accent?: string
  /** Track (unfilled) colour - set a light value for dark editor themes. */
  trackColor?: string
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
  id?: string
  'aria-label'?: string
}

const clampPct = (v: number, min: number, max: number) =>
  max <= min ? 0 : Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))

export function RangeSlider({
  value, onChange, min = 0, max = 100, step = 1,
  variant = 'bubble', orientation = 'horizontal', format, minLabel, maxLabel, showValue = false,
  accent, trackColor, disabled, className, style, id, ...rest
}: RangeSliderProps) {
  const autoId = useId()
  const [dragging, setDragging] = useState(false)
  const sliderId = id ?? autoId
  const fmt = format ?? ((v: number) => String(v))
  const pct = clampPct(value, min, max)
  const fill = accent ?? 'var(--color-primary, #1a73e8)'
  const track = trackColor ?? 'rgba(0,0,0,0.10)'

  const setFromInput = (raw: string) => {
    const n = Number(raw)
    if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)))
  }

  // The native range input (transparent, full-width) drives keyboard + drag a11y;
  // the visible track/thumb are rendered on top with pointer-events disabled.
  // These are plain elements/factories (NOT inner components) so the native
  // input keeps its drag state across re-renders.
  const nativeRange = (
    <input
      id={sliderId}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      onMouseDown={(e) => e.stopPropagation()}
      aria-label={rest['aria-label']}
      className="absolute inset-0 m-0 w-full h-full cursor-pointer appearance-none bg-transparent
                 focus:outline-none disabled:cursor-not-allowed
                 [&::-webkit-slider-runnable-track]:appearance-none [&::-webkit-slider-runnable-track]:bg-transparent
                 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:bg-transparent
                 [&::-moz-range-track]:bg-transparent
                 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent"
      style={{ WebkitAppearance: 'none', appearance: 'none' }}
    />
  )

  const thumb = (size = 12) => (
    <span
      aria-hidden
      className="absolute top-1/2 rounded-full pointer-events-none"
      style={{
        left: `${pct}%`,
        width: size,
        height: size,
        transform: 'translate(-50%, -50%)',
        background: fill,
        boxShadow: `0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,0.35)`,
      }}
    />
  )

  // ── Boxed variant (editable number inside a bordered box) ───────────────────
  if (variant === 'boxed') {
    return (
      <div className={cn('select-none', disabled && 'opacity-60', className)} style={style}>
        <div
          className="relative rounded-xl border-2 bg-surface-0 px-4 pt-3 pb-5 transition-colors focus-within:border-primary"
          style={{ borderColor: 'var(--color-border, #dadce0)' }}
        >
          <input
            type="text"
            inputMode="numeric"
            value={fmt(value)}
            disabled={disabled}
            onChange={(e) => setFromInput(e.target.value.replace(/[^\d.-]/g, ''))}
            className="w-full bg-transparent text-2xl font-medium text-text-primary tabular-nums
                       focus:outline-none disabled:cursor-not-allowed"
            aria-label={rest['aria-label']}
          />
          {/* Slider sitting on the bottom edge of the box */}
          <div className="absolute left-3 right-3 bottom-0 h-0 translate-y-1/2">
            <div className="relative h-1.5 rounded-full" style={{ background: track }}>
              <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: fill }} />
              {thumb(14)}
              {nativeRange}
            </div>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-xs text-text-tertiary">
          <span>{minLabel ?? fmt(min)}</span>
          <span>{maxLabel ?? fmt(max)}</span>
        </div>
      </div>
    )
  }

  // ── Vertical bubble variant (faders / EQ bands) ─────────────────────────────
  if (orientation === 'vertical') {
    // The native range is rotated via writing-mode so up = max; it overlays a
    // vertical track filled from the bottom.
    const verticalRange = (
      <input
        id={sliderId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label={rest['aria-label']}
        className="absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none bg-transparent
                   focus:outline-none disabled:cursor-not-allowed
                   [&::-webkit-slider-runnable-track]:appearance-none [&::-webkit-slider-runnable-track]:bg-transparent
                   [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-transparent
                   [&::-moz-range-track]:bg-transparent
                   [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent"
        style={{ writingMode: 'vertical-lr', direction: 'rtl', WebkitAppearance: 'none', appearance: 'none' } as React.CSSProperties}
      />
    )
    return (
      <div className={cn('relative h-full select-none', disabled && 'opacity-60', className)} style={style}>
        <div className="relative mx-auto h-full w-1.5 rounded-full" style={{ background: track }}>
          <div className="absolute inset-x-0 bottom-0 rounded-full" style={{ height: `${pct}%`, background: fill }} />
          <span
            aria-hidden
            className="absolute left-1/2 h-3 w-3 rounded-full pointer-events-none"
            style={{ bottom: `${pct}%`, transform: 'translate(-50%, 50%)', background: fill, boxShadow: `0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,0.35)` }}
          />
          {verticalRange}
        </div>
      </div>
    )
  }

  // ── Bubble variant (track + thumb + rolling-counter tooltip) ────────────────
  const showBubble = showValue || dragging
  return (
    <div
      className={cn('relative w-full select-none', disabled && 'opacity-60', className)}
      style={style}
      onPointerDown={() => !disabled && setDragging(true)}
      onPointerUp={() => setDragging(false)}
      onPointerLeave={() => setDragging(false)}
    >
      {/* Value bubble */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-1 -translate-y-full transition-[opacity,transform] duration-150"
        style={{
          left: `${pct}%`,
          transform: `translate(-50%, ${showBubble ? '-100%' : '-80%'})`,
          opacity: showBubble ? 1 : 0,
        }}
      >
        <span
          className="inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-semibold text-white shadow"
          style={{ background: fill }}
        >
          <RollingNumber text={fmt(value)} />
        </span>
      </div>
      {/* Track */}
      <div className="relative h-1.5 rounded-full" style={{ background: track }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: fill }} />
        {thumb()}
        {nativeRange}
      </div>
    </div>
  )
}
