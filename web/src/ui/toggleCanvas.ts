/* Canvas painter for the `Toggle` switch - pure drawing, no React. Kept apart from
 * the component so the geometry and the paint pass can be read (and reused) on their
 * own. All lengths are in CSS pixels; the device pixel ratio is applied at paint time. */

export interface ToggleGeometry {
  width:       number
  height:      number
  trackRadius: number
  thumbSize:   number
  thumbRadius: number
  /** Gap between the track edge and the thumb, on all four sides. */
  thumbInset:  number
}

/* Rounded-rectangle switch rather than a pill: the radius scales with the size so the
 * `sm` variant does not read as proportionally rounder than `md`. */
export const TOGGLE_GEOMETRY: Record<'sm' | 'md', ToggleGeometry> = {
  sm: { width: 28, height: 16, trackRadius: 5, thumbSize: 12, thumbRadius: 3, thumbInset: 2 },
  md: { width: 36, height: 20, trackRadius: 6, thumbSize: 14, thumbRadius: 4, thumbInset: 3 },
}

export interface TogglePalette {
  /** Track fill when off. */
  off:    string
  /** Track outline when off. */
  border: string
  /** Track fill and outline when on. */
  on:     string
  thumb:  string
}

/* Colours come from the theme tokens rather than being hard-coded, so a runtime theme
 * or a per-module accent (`[data-module="<id>"]`) still applies. Read from the canvas
 * itself: custom properties inherit, so it sees whatever its ancestors resolved to. */
export function readTogglePalette(el: Element): TogglePalette {
  const cs = getComputedStyle(el)
  const token = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    off:    token('--color-surface-3', '#e8eaed'),
    border: token('--color-border',    '#e0e0e0'),
    on:     token('--color-primary',   '#1a73e8'),
    thumb:  '#ffffff',
  }
}

export interface PaintToggleOptions {
  geometry: ToggleGeometry
  palette:  TogglePalette
  /** 0 = off, 1 = on. Intermediate values are the sliding animation. */
  progress: number
  /** Defaults to `window.devicePixelRatio`; injectable for tests. */
  dpr?:     number
}

export function paintToggle(canvas: HTMLCanvasElement, opts: PaintToggleOptions): void {
  const { geometry: g, palette: p } = opts
  const progress = Math.min(1, Math.max(0, opts.progress))
  const dpr = opts.dpr ?? window.devicePixelRatio ?? 1

  /* The backing store is sized in device pixels and the context scaled, otherwise the
   * edges blur on a HiDPI screen. Reassigning width/height also clears the bitmap, so
   * it is only done when the ratio actually changed. */
  const bw = Math.round(g.width * dpr)
  const bh = Math.round(g.height * dpr)
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width  = bw
    canvas.height = bh
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, g.width, g.height)

  /* Track. The off state is painted first, then the on state over it at `progress`
   * alpha. Cross-fading replaces interpolating the two colours, which would mean
   * parsing them - and a theme is free to express them as hex, rgb() or oklch(). */
  const half = 0.5   // a 1px stroke straddles the path, so inset the rect by half of it
  const paintTrack = (fill: string, stroke: string, alpha: number) => {
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.roundRect(half, half, g.width - 1, g.height - 1, g.trackRadius - half)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth   = 1
    ctx.strokeStyle = stroke
    ctx.stroke()
  }
  paintTrack(p.off, p.border, 1)
  if (progress > 0) paintTrack(p.on, p.on, progress)
  ctx.globalAlpha = 1

  // Thumb - travels the free space left inside the track.
  const travel = g.width - g.thumbSize - g.thumbInset * 2
  ctx.save()
  ctx.shadowColor   = 'rgb(0 0 0 / 12%)'
  ctx.shadowBlur    = 2
  ctx.shadowOffsetY = 1
  ctx.beginPath()
  ctx.roundRect(g.thumbInset + travel * progress, g.thumbInset, g.thumbSize, g.thumbSize, g.thumbRadius)
  ctx.fillStyle = p.thumb
  ctx.fill()
  ctx.restore()
}
