import { MM } from './geometry'
import type { PageGeometry } from './geometry'

/**
 * The stamp across a report's sheets — text or image, and never an element.
 *
 * ## Why it is painted, not placed
 *
 * The first version was an absolutely positioned `<div>`. It looked right on
 * screen and printed wrong: a 22-sheet report came out on 17 pages. Bisecting
 * the CSS cleared the rotation, the overflow and the size in turn — only
 * removing the element restored the count. An out-of-flow box inside a
 * page-broken document perturbs this engine's fragmentation, full stop.
 *
 * So the stamp is a BACKGROUND: one SVG, sized to the sheet, handed over as a
 * `data:` URL. A background paints and takes part in no layout, so it cannot
 * move a cut by construction, and it lands behind the text for free.
 *
 * ⚠ The consumer must set `background-COLOR` on the sheet, never the `background`
 * shorthand: the shorthand resets `background-image` and silently erased this.
 */

export type WatermarkKind = 'none' | 'text' | 'image'

export interface WatermarkSpec {
  kind: WatermarkKind
  /** The words, when `kind` is `text`. */
  text:  string
  /** A `data:` URL, when `kind` is `image`. Never a remote one — see `readImage`. */
  image: string | null
  /** Multiplier on the size that fits the sheet by itself. 1 = that size. */
  scale:   number
  /** 0.02 … 0.6. Low enough to read through, high enough to see. */
  opacity: number
  /** Degrees. Negative turns anticlockwise, the usual direction for a stamp. */
  angle:   number
}

export const NO_WATERMARK: WatermarkSpec = {
  kind: 'none', text: '', image: null, scale: 1, opacity: 0.15, angle: -32,
}

/** Is there anything to paint? A kind without its content is not a watermark. */
export function hasWatermark(w: WatermarkSpec): boolean {
  if (w.kind === 'text')  return w.text.trim() !== ''
  if (w.kind === 'image') return !!w.image
  return false
}

/**
 * The type size that makes one line of text span the sheet on its own.
 *
 * A fixed size cannot work: it suits one word and sends a sentence off the edge
 * of the paper. The line is fitted to the sheet's DIAGONAL — the longest
 * straight run a rotated stamp can use — from a rough average glyph advance
 * (0.58 em for a bold sans), which is close enough for something drawn at 15 %
 * opacity.
 */
function fittedTextSize(g: PageGeometry, text: string): number {
  const chars = Math.max(1, text.trim().length)
  const diagonal = Math.hypot(g.contentWidthPx, g.contentHeightPx)
  return Math.min(160, Math.max(10, (diagonal * 0.92) / (chars * 0.58)))
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The stamp as a CSS `url(...)`, or `undefined` when there is nothing to paint.
 *
 * The SVG is an isolated document: it cannot reach the page's web fonts, so the
 * family is named for the SYSTEM to resolve and falls back to whatever sans it
 * has. On something drawn at 15 % opacity that is not worth an embedded font.
 * ⚠ Kept in step with the platform stack (`--font-family-sans`, `index.css`) by
 * hand — it is the one place in this feature where a font is named statically
 * rather than measured, so a change of stack has to be copied here.
 */
export function stampUrl(g: PageGeometry, w: WatermarkSpec): string | undefined {
  if (!hasWatermark(w)) return undefined

  const width  = Math.round(g.widthMm * MM)
  const height = Math.round(g.heightMm * MM)
  const cx = width / 2
  const cy = height / 2
  const turn = `rotate(${w.angle} ${cx} ${cy})`

  let body: string
  if (w.kind === 'text') {
    const size = fittedTextSize(g, w.text) * w.scale
    body =
      `<text x="${cx}" y="${cy}" transform="${turn}" text-anchor="middle" ` +
      `dominant-baseline="central" ` +
      `font-family="Outfit, Roboto, Arial, sans-serif" ` +
      `font-size="${size.toFixed(1)}" font-weight="700" letter-spacing="2" ` +
      `fill="black" fill-opacity="${w.opacity}">${escapeXml(w.text)}</text>`
  } else {
    // Half the sheet's width at scale 1 — a stamp, not a background photograph.
    // `meet` keeps the picture's own proportions whatever box it is given.
    const box = Math.min(width, height) * 0.55 * w.scale
    body =
      `<image href="${escapeXml(w.image ?? '')}" x="${cx - box / 2}" y="${cy - box / 2}" ` +
      `width="${box.toFixed(1)}" height="${box.toFixed(1)}" ` +
      `preserveAspectRatio="xMidYMid meet" transform="${turn}" opacity="${w.opacity}"/>`
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${width}" height="${height}">${body}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/** Longest edge kept for an uploaded stamp, in pixels. */
const MAX_EDGE = 1400

/**
 * Read a picked file into a `data:` URL, downscaled first.
 *
 * Downscaling is not politeness: the URL is inlined in a CSS property that every
 * sheet and every thumbnail reads, so a 6-megapixel photograph would be carried
 * around dozens of times. 1400 px on the longest edge prints at ~120 dpi across
 * an A4, which is more than a watermark ever needs.
 *
 * Rejects anything that is not an image, and keeps PNG for pictures with an
 * alpha channel (a logo on transparent) — re-encoding those as JPEG would paint
 * the transparency black.
 */
export function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('not-an-image'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('unreadable'))
    reader.onload = () => {
      const src = String(reader.result)
      const img = new Image()
      img.onerror = () => reject(new Error('undecodable'))
      img.onload = () => {
        const ratio = Math.min(1, MAX_EDGE / Math.max(img.width, img.height))
        if (ratio === 1 && src.length < 400_000) { resolve(src); return }
        const canvas = document.createElement('canvas')
        canvas.width  = Math.max(1, Math.round(img.width  * ratio))
        canvas.height = Math.max(1, Math.round(img.height * ratio))
        const ctx = canvas.getContext('2d')
        if (!ctx) { resolve(src); return }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const alpha = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/svg+xml'
        resolve(canvas.toDataURL(alpha ? 'image/png' : 'image/jpeg', 0.82))
      }
      img.src = src
    }
    reader.readAsDataURL(file)
  })
}
