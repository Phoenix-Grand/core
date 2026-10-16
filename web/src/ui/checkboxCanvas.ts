import { resolveCssColor } from './canvasColor'

/* Canvas painter for the `Checkbox` - pure drawing, no React. Same split as
 * `toggleCanvas.ts` / `radioCanvas.ts`: the geometry and the paint pass can be read
 * (and tested) on their own. All lengths are in CSS pixels; the device pixel ratio is
 * applied at paint time. */

export interface CheckboxGeometry {
  /** Overall box, square. */
  size:   number
  /** Border thickness when unchecked. */
  border: number
  /** Corner radius of the box. */
  radius: number
  /** Side of the square the tick is drawn inside. */
  tick:   number
}

/* Matches the CSS control it replaces to the pixel: 18px box, 2px border, 11px tick.
 * The radius follows the project scale (`--radius-sm`, 4px). */
export const CHECKBOX_GEOMETRY: CheckboxGeometry = { size: 18, border: 2, radius: 4, tick: 11 }

export interface CheckboxPalette {
  /** Box fill when unchecked. `null` = transparent. */
  fill:        string | null
  border:      string
  borderHover: string
  /** Fill and border when checked, and the indeterminate dash. */
  accent:      string
  /** The tick itself, drawn over the accent fill. */
  mark:        string
}

export type CheckboxVariant = 'default' | 'dark'

/* Colours come from the theme tokens rather than being hard-coded, so a runtime
 * theme or a per-module accent (`[data-module="<id>"]`) still applies. `dark` stays
 * literal - it is fixed editor chrome (VS Code tones), not the dark theme. */
export function readCheckboxPalette(el: Element, variant: CheckboxVariant, color?: string): CheckboxPalette {
  const cs = getComputedStyle(el)
  const token = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  if (variant === 'dark') {
    return { fill: '#3c3c3c', border: '#555555', borderHover: '#808080', accent: resolveCssColor(el, color, '#007acc'), mark: '#ffffff' }
  }
  return {
    fill:        null,
    border:      token('--color-border',        '#e0e0e0'),
    borderHover: token('--color-border-strong', '#bdc1c6'),
    // Through `resolveCssColor`: a caller may hand us `var(--color-primary)`, which a
    // canvas cannot parse and would silently render BLACK.
    accent:      resolveCssColor(el, color, token('--color-primary', '#1a73e8')),
    mark:        '#ffffff',
  }
}

/* The tick, as the fraction-of-the-box polygon the CSS `clip-path` used. Kept
 * identical so the mark is the very same shape it has always been. */
const TICK: ReadonlyArray<readonly [number, number]> = [
  [0.14, 0.44], [0, 0.65], [0.50, 1], [1, 0.16], [0.80, 0], [0.43, 0.62],
]

export interface PaintCheckboxOptions {
  geometry: CheckboxGeometry
  palette:  CheckboxPalette
  /** 0 = unchecked, 1 = checked. Intermediate values are the mark scaling in. */
  progress: number
  /** Tri-state: drawn as a dash instead of a tick. Wins over `progress`. */
  indeterminate?: boolean
  hovered?: boolean
  /** Defaults to `window.devicePixelRatio`; injectable for tests. */
  dpr?:     number
}

export function paintCheckbox(canvas: HTMLCanvasElement, opts: PaintCheckboxOptions): void {
  const { geometry: g, palette: p } = opts
  const progress = Math.min(1, Math.max(0, opts.progress))
  const dpr = opts.dpr ?? window.devicePixelRatio ?? 1
  // An indeterminate box is filled like a checked one, whatever `checked` says.
  const filled = opts.indeterminate ? 1 : progress

  /* The backing store is sized in device pixels and the context scaled, otherwise the
   * edges blur on a HiDPI screen. Reassigning width/height also clears the bitmap, so
   * it is only done when the ratio actually changed. */
  const b = Math.round(g.size * dpr)
  if (canvas.width !== b || canvas.height !== b) {
    canvas.width  = b
    canvas.height = b
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, g.size, g.size)

  // A 2px stroke straddles the path, so the box is inset by half of it.
  const half = g.border / 2
  const boxPath = () => {
    ctx.beginPath()
    ctx.roundRect(half, half, g.size - g.border, g.size - g.border, g.radius - half)
  }

  // Unchecked box: optional fill, then the border.
  if (p.fill) { boxPath(); ctx.fillStyle = p.fill; ctx.fill() }
  boxPath()
  ctx.lineWidth   = g.border
  ctx.strokeStyle = opts.hovered ? p.borderHover : p.border
  ctx.stroke()

  /* Checked box painted OVER it at `filled` alpha. Cross-fading replaces
   * interpolating the two colours, which would mean parsing them - and a theme is
   * free to express them as hex, rgb() or oklch(). */
  if (filled > 0) {
    ctx.globalAlpha = filled
    boxPath()
    ctx.fillStyle = p.accent
    ctx.fill()
    ctx.strokeStyle = p.accent
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  if (opts.indeterminate) {
    // Dash - the tri-state the DOM property carried but nothing ever drew.
    const w = g.tick, h = Math.max(2, Math.round(g.border))
    const x = (g.size - w) / 2, y = (g.size - h) / 2
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, h / 2)
    ctx.fillStyle = p.mark
    ctx.fill()
    return
  }

  // Tick - scales from the centre, like the CSS `transform: scale()` it replaces.
  if (progress > 0) {
    const s = g.tick * progress
    const ox = (g.size - s) / 2
    const oy = (g.size - s) / 2
    ctx.beginPath()
    TICK.forEach(([fx, fy], i) => {
      const x = ox + fx * s, y = oy + fy * s
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.fillStyle = p.mark
    ctx.fill()
  }
}
