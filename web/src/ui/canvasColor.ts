/**
 * Colour resolution for the canvas-drawn controls (`Toggle`, `Radio`, `Checkbox`).
 *
 * A canvas context SILENTLY IGNORES an unparseable colour: `ctx.fillStyle = 'var(--x)'`
 * leaves the previous value in place, which on a fresh context is opaque black. The
 * control then renders as a black blob with no error anywhere - exactly what happened
 * when a caller passed `color="var(--color-primary)"`, perfectly valid for the CSS
 * implementation these replaced.
 *
 * So every colour that reaches a canvas goes through here: `var()` references are
 * resolved against the element (custom properties inherit, so a per-module accent
 * still applies), and anything the context cannot parse falls back instead of
 * silently blacking out.
 */

/** Lazily created, reused: probing costs nothing after the first call. */
let probe: CanvasRenderingContext2D | null | undefined

function parses(value: string): boolean {
  if (probe === undefined) probe = document.createElement('canvas').getContext('2d')
  if (!probe) return true          // no 2d context at all - nothing to protect
  // Assigning an invalid colour is a no-op, so try from two different starting
  // points: only a value the context actually understood lands on the same result.
  probe.fillStyle = '#000000'
  probe.fillStyle = value
  const fromBlack = probe.fillStyle
  probe.fillStyle = '#ffffff'
  probe.fillStyle = value
  return probe.fillStyle === fromBlack
}

/**
 * Resolve a colour for canvas use.
 * @param el       element the custom properties are read from (they inherit)
 * @param value    author-supplied colour; may be `var(--x)`, `var(--x, fallback)`, or plain
 * @param fallback used when `value` is absent, empty, or unparseable
 */
export function resolveCssColor(el: Element, value: string | undefined | null, fallback: string): string {
  const raw = value?.trim()
  if (!raw) return fallback

  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*?)\s*)?\)$/.exec(raw)
  if (m) {
    const resolved = getComputedStyle(el).getPropertyValue(m[1]).trim()
    if (resolved) return parses(resolved) ? resolved : fallback
    // `var()` own fallback, which may itself be a var() - resolve it too.
    return m[2] ? resolveCssColor(el, m[2], fallback) : fallback
  }

  return parses(raw) ? raw : fallback
}
