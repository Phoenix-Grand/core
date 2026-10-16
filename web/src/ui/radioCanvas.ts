import { resolveCssColor } from './canvasColor'

/* Canvas painter for the `Radio` control - pure drawing, no React. Same split as
 * `toggleCanvas.ts`: the geometry and the paint pass can be read (and tested) on
 * their own. All lengths are in CSS pixels; the device pixel ratio is applied at
 * paint time. */

export interface RadioGeometry {
  /** Overall box, square. */
  size: number
  /** Ring thickness. */
  ring: number
  /** Diameter of the inner dot when fully checked. */
  dot:  number
}

/* Matches the CSS control it replaces to the pixel: 18px box, 2px ring, 10px dot. */
export const RADIO_GEOMETRY: RadioGeometry = { size: 18, ring: 2, dot: 10 }

export interface RadioPalette {
  /** Ring when unchecked. */
  border:      string
  /** Ring when unchecked and hovered. */
  borderHover: string
  /** Ring when checked, and the dot. */
  accent:      string
}

export type RadioVariant = 'default' | 'dark'

/* Colours come from the theme tokens rather than being hard-coded, so a runtime
 * theme or a per-module accent (`[data-module="<id>"]`) still applies. Read from the
 * canvas itself: custom properties inherit, so it sees what its ancestors resolved.
 * `dark` stays literal - it is fixed editor chrome, not the dark theme. */
export function readRadioPalette(el: Element, variant: RadioVariant, color?: string): RadioPalette {
  const cs = getComputedStyle(el)
  const token = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  if (variant === 'dark') {
    return { border: '#555555', borderHover: '#808080', accent: resolveCssColor(el, color, '#007acc') }
  }
  return {
    border:      token('--color-border',        '#e0e0e0'),
    borderHover: token('--color-border-strong', '#bdc1c6'),
    // Through `resolveCssColor`: a caller may hand us `var(--color-primary)`, which a
    // canvas cannot parse and would silently render BLACK.
    accent:      resolveCssColor(el, color, token('--color-primary', '#1a73e8')),
  }
}

export interface PaintRadioOptions {
  geometry: RadioGeometry
  palette:  RadioPalette
  /** 0 = unchecked, 1 = checked. Intermediate values are the dot growing in. */
  progress: number
  hovered?: boolean
  /** Defaults to `window.devicePixelRatio`; injectable for tests. */
  dpr?:     number
}

export function paintRadio(canvas: HTMLCanvasElement, opts: PaintRadioOptions): void {
  const { geometry: g, palette: p } = opts
  const progress = Math.min(1, Math.max(0, opts.progress))
  const dpr = opts.dpr ?? window.devicePixelRatio ?? 1

  /* The backing store is sized in device pixels and the context scaled, otherwise the
   * circle's edge blurs on a HiDPI screen. Reassigning width/height also clears the
   * bitmap, so it is only done when the ratio actually changed. */
  const bw = Math.round(g.size * dpr)
  const bh = Math.round(g.size * dpr)
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width  = bw
    canvas.height = bh
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, g.size, g.size)

  const c = g.size / 2
  // A stroke straddles its path, so the ring's centre line sits half a thickness in.
  const ringRadius = (g.size - g.ring) / 2

  /* Ring. The unchecked colour is painted first, then the accent over it at `progress`
   * alpha. Cross-fading replaces interpolating the two colours, which would mean
   * parsing them - and a theme is free to express them as hex, rgb() or oklch(). */
  const strokeRing = (colour: string, alpha: number) => {
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.arc(c, c, ringRadius, 0, Math.PI * 2)
    ctx.lineWidth   = g.ring
    ctx.strokeStyle = colour
    ctx.stroke()
  }
  strokeRing(opts.hovered ? p.borderHover : p.border, 1)
  if (progress > 0) strokeRing(p.accent, progress)
  ctx.globalAlpha = 1

  // Dot - grows from the centre, so only its RADIUS is animated.
  if (progress > 0) {
    ctx.beginPath()
    ctx.arc(c, c, (g.dot / 2) * progress, 0, Math.PI * 2)
    ctx.fillStyle = p.accent
    ctx.fill()
  }
}
