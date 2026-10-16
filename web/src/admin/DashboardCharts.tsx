// Graphiques du tableau de bord admin - zéro dépendance externe.
// Séries temporelles dessinées en CANVAS (HiDPI, animées, interactives :
// survol, surbrillance, crosshair, tooltip) ; donut/jauge en SVG (net, rond).
import { useState, useEffect } from 'react'
import { useUiTheme } from '../core/hooks/useUiTheme'

export const CHART_COLORS = ['#1a73e8', '#1e8e3e', '#f9ab00', '#d93025', '#9c27b0', '#0b8043', '#e8710a', '#12b5cb']

/**
 * The categorical scale, as theme VARIABLES rather than literals.
 *
 * `CHART_COLORS` above is the historical literal set, still used by the general
 * dashboard. Anything drawn for both themes takes this one instead: the dark
 * steps are a separately-validated set, not a filter over the light ones, and
 * the choice is made in JS because Kubuno applies themes by writing variables,
 * not through `prefers-color-scheme` (see `theme.css`).
 */
export const CHART_SERIES_LIGHT = [
  'var(--kb-chart-1)', 'var(--kb-chart-2)', 'var(--kb-chart-3)', 'var(--kb-chart-4)',
  'var(--kb-chart-5)', 'var(--kb-chart-6)', 'var(--kb-chart-7)', 'var(--kb-chart-8)',
] as const

export const CHART_SERIES_DARK = [
  'var(--kb-chart-1-dark)', 'var(--kb-chart-2-dark)', 'var(--kb-chart-3-dark)', 'var(--kb-chart-4-dark)',
  'var(--kb-chart-5-dark)', 'var(--kb-chart-6-dark)', 'var(--kb-chart-7-dark)', 'var(--kb-chart-8-dark)',
] as const

/** The categorical scale for the theme actually in force. */
export function useChartSeries(): readonly string[] {
  return useUiTheme() === 'dark' ? CHART_SERIES_DARK : CHART_SERIES_LIGHT
}

// ── Reading theme variables from a canvas ────────────────────────────────────
//
// A canvas composites literal colours: `var(--…)` means nothing to
// `ctx.fillStyle`. Everything painted below therefore RESOLVES its variables
// against the live element at draw time, which is also what makes a theme switch
// (a rewrite of those variables) repaint correctly - the draw effects depend on
// `useUiTheme()` so they run again when it happens.

/** Last-resort ink, used only if a theme forgot to define a variable at all. */
const FALLBACK_INK = '#5f6368'

function cssVar(el: Element | null, name: string, fallback: string): string {
  if (!el) return fallback
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * A CSS colour expression → the literal the canvas can paint.
 *
 * Accepts either a literal (returned as-is) or a single `var(--token)`. The
 * resolved value is a 6-digit hex in every theme Kubuno ships, which is what
 * lets the callers below append an alpha pair to it.
 */
export function resolveColor(el: Element | null, color: string): string {
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(color)
  return m ? cssVar(el, m[1], FALLBACK_INK) : color
}

/** The chrome every canvas chart paints: grid, tick labels, surface. */
export function chartInk(el: Element | null) {
  return {
    grid:    cssVar(el, '--color-border', '#eceef1'),
    label:   cssVar(el, '--color-text-tertiary', FALLBACK_INK),
    surface: cssVar(el, '--color-surface-0', '#ffffff'),
  }
}

/** Octets → chaîne lisible (Ko/Mo/Go…). */
export function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 o'
  const u = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / Math.pow(1024, i)
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

// Arrondit à un « joli » palier (1/2/5 × 10ⁿ) pour l'échelle des axes.
function niceCeil(v: number): number {
  if (v <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / pow
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
}

// Graduations entières et régulières de l'axe Y (0 → max arrondi).
export function axisTicks(max: number): { top: number; ticks: number[] } {
  const nm = niceCeil(Math.max(1, max))
  const step = nm <= 5 ? 1 : niceCeil(nm / 4)
  const ticks: number[] = []
  for (let v = 0; v <= nm + 1e-9; v += step) ticks.push(Math.round(v))
  const uniq = [...new Set(ticks)]
  return { top: uniq[uniq.length - 1], ticks: uniq }
}

// Largeur responsive d'un conteneur (ResizeObserver).
export function useWidth<T extends HTMLElement>(ref: React.RefObject<T | null>): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

export const PAD = { l: 38, r: 8, t: 10, b: 20 }

