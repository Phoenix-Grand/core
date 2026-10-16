import { useRef, useEffect } from 'react'

// All clock faces are canvas-rendered. Square faces (analog, style7 and the
// realistic ones) draw in a fixed 0..100 space centred and scaled by `square()`;
// rectangular faces (digital, flip) draw straight into the widget rectangle.
// The <ClockCanvas> wrapper handles devicePixelRatio and resolves theme colours.

const TAU = Math.PI * 2
const rad = (d: number) => (d * Math.PI) / 180
const P = (a: number, r: number): [number, number] => [50 + r * Math.sin(rad(a)), 50 - r * Math.cos(rad(a))]

function ang(date: Date) {
  const h = date.getHours() % 12, m = date.getMinutes(), s = date.getSeconds()
  return { h: (h + m / 60) * 30, m: (m + s / 60) * 6, s: s * 6 }
}

type Ctx = CanvasRenderingContext2D

function seg(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, w: number, color: string, cap: CanvasLineCap = 'round') {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2)
  ctx.lineWidth = w; ctx.strokeStyle = color; ctx.lineCap = cap; ctx.stroke()
}
function disc(ctx: Ctx, x: number, y: number, r: number, fill: string | CanvasGradient) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = fill; ctx.fill()
}
function ring(ctx: Ctx, x: number, y: number, r: number, w: number, color: string) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.lineWidth = w; ctx.strokeStyle = color; ctx.stroke()
}
function label(ctx: Ctx, str: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'center') {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(str, x, y)
}
function hand(ctx: Ctx, a: number, len: number, w: number, color: string, tail = 6) {
  const [x, y] = P(a, len); const [bx, by] = P(a + 180, tail)
  seg(ctx, bx, by, x, y, w, color)
}
function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r)
  else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }
}

export interface Palette {
  text: string; textSec: string; textTer: string
  surface0: string; surface1: string; surface2: string; border: string; primary: string
}
export interface FaceExtras {
  time?: string; hh?: string; mm?: string; ss?: string; ampm?: string; showSeconds?: boolean
  digital?: string; day?: string; year?: string; month?: string; weekday?: string
  theme?: Palette
}
type Draw100 = (ctx: Ctx, date: Date, ex: FaceExtras) => void
export type FaceDraw = (ctx: Ctx, W: number, H: number, date: Date, ex: FaceExtras) => void

/** Wrap a 0..100-space face so it renders centred inside a W×H canvas. */
function square(fn: Draw100): FaceDraw {
  return (ctx, W, H, date, ex) => {
    const S = Math.min(W, H)
    ctx.save(); ctx.translate((W - S) / 2, (H - S) / 2); ctx.scale(S / 100, S / 100)
    fn(ctx, date, ex); ctx.restore()
  }
}

export function resolveTheme(): Palette {
  const cs = getComputedStyle(document.documentElement)
  const g = (n: string, f: string) => { const v = cs.getPropertyValue(n).trim(); return v || f }
  return {
    text:     g('--color-text-primary', '#202124'),
    textSec:  g('--color-text-secondary', '#5f6368'),
    textTer:  g('--color-text-tertiary', '#80868b'),
    surface0: g('--color-surface-0', '#ffffff'),
    surface1: g('--color-surface-1', '#f8f9fa'),
    surface2: g('--color-surface-2', '#f1f3f4'),
    border:   g('--color-border', '#e0e0e0'),
    primary:  g('--color-primary', '#1a73e8'),
  }
}

// ── Digital ─────────────────────────────────────────────────────────────────────
const drawDigital: FaceDraw = (ctx, W, H, _date, ex) => {
  const T = ex.theme!; const time = ex.time ?? ''
  let fs = Math.min(H * 0.92, W * 0.52)
  ctx.font = `300 ${fs}px 'DM Sans', system-ui, sans-serif`
  const w = ctx.measureText(time).width
  if (w > W * 0.94) fs *= (W * 0.94) / w
  label(ctx, time, W / 2, H / 2, `300 ${fs}px 'DM Sans', system-ui, sans-serif`, T.text)
}

// ── Analog - "radio controlled" wall clock (Helvetica dial, Kubuno brand) ─────────
// Kubuno mark (six aperture blades around a plate holding a cube), vectorised from
// public/kubuno-logo.png in its own 512x567 space. Drawn via Path2D so it scales crisply,
// in a single colour: blades and plate solid, the cube cut out of the plate and its faces
// in lighter tones (alpha), the way the monochrome logo is drawn elsewhere.
const KUBUNO_SOLID = 'M276.44 138.94L395.81 69.41L472.95 113.95A78.09 78.09 0 0 1 512 181.58L512 274.67L391.87 205.92A2 2 0 0 0 391.11 205.14L276.44 138.94ZM392.11 229.32L512 297.93L512 387.01A78.09 78.09 0 0 1 472.95 454.64L392.34 501.19L391.81 362.77A2 2 0 0 0 392.11 361.72L392.11 229.32ZM371.66 374.68L372.19 512.82L295.04 557.36A78.09 78.09 0 0 1 216.96 557.36L136.34 510.81L255.94 441.15A2 2 0 0 0 257 440.88L371.66 374.68ZM235.56 429.66L116.19 499.18L39.05 454.64A78.09 78.09 0 0 1 0 387.01L0 293.92L120.13 362.67A2 2 0 0 0 120.89 363.46L235.56 429.66ZM119.89 339.27L0 270.66L0 181.58A78.09 78.09 0 0 1 39.05 113.95L119.66 67.41L120.19 205.82A2 2 0 0 0 119.89 206.87L119.89 339.27ZM140.34 193.91L139.81 55.78L216.96 11.24A78.09 78.09 0 0 1 295.04 11.24L375.66 57.78L256.06 127.45A2 2 0 0 0 255 127.71L140.34 193.91ZM238.3 160.13A35.4 35.4 0 0 1 273.7 160.13L354.69 206.88A35.4 35.4 0 0 1 372.39 237.54L372.39 331.06A35.4 35.4 0 0 1 354.69 361.71L273.7 408.47A35.4 35.4 0 0 1 238.3 408.47L157.31 361.71A35.4 35.4 0 0 1 139.61 331.06L139.61 237.54A35.4 35.4 0 0 1 157.31 206.88L238.3 160.13ZM243 187.95L180.15 224.23A26 26 0 0 0 167.15 246.75L167.15 319.32A26 26 0 0 0 180.15 341.84L243 378.13A26 26 0 0 0 269 378.13L331.85 341.84A26 26 0 0 0 344.85 319.32L344.85 246.75A26 26 0 0 0 331.85 224.23L269 187.95A26 26 0 0 0 243 187.95Z'
const KUBUNO_FACES: [string, number][] = [
  ['M256 381.61A26 26 0 0 1 243 378.13L180.15 341.84A26 26 0 0 1 167.15 319.32L167.15 246.75A26 26 0 0 1 170.63 233.75L245 276.69A22 22 0 0 0 267 276.69L271.14 274.3A30.28 30.28 0 0 0 256 300.52L256 381.61Z', 0.67],
  ['M341.37 233.75A26 26 0 0 1 344.85 246.75L344.85 319.32A26 26 0 0 1 331.85 341.84L269 378.13A26 26 0 0 1 256 381.61L256 300.52A30.28 30.28 0 0 1 271.14 274.3L341.37 233.75Z', 0.82],
  ['M170.63 233.75A26 26 0 0 1 180.15 224.23L243 187.95A26 26 0 0 1 269 187.95L331.85 224.23A26 26 0 0 1 341.37 233.75L267 276.69A22 22 0 0 1 245 276.69L170.63 233.75Z', 0.43],
]
function drawKubunoLogo(ctx: Ctx, cx: number, cy: number, h: number, color: string) {
  const w = (h * 512) / 567
  ctx.save()
  ctx.translate(cx - w / 2, cy - h / 2); ctx.scale(w / 512, h / 567)
  ctx.fillStyle = color
  ctx.fill(new Path2D(KUBUNO_SOLID))
  for (const [d, alpha] of KUBUNO_FACES) { ctx.globalAlpha = alpha; ctx.fill(new Path2D(d)) }
  ctx.restore()
}
// Tapered pointer hand: small tail, widest just off-centre, sharp tip.
function pointer(ctx: Ctx, a: number, len: number, wMax: number, tail: number, color: string) {
  const ax = Math.sin(rad(a)), ay = -Math.cos(rad(a)), px = Math.cos(rad(a)), py = Math.sin(rad(a))
  const pt = (al: number, sd: number): [number, number] => [50 + al * ax + sd * px, 50 + al * ay + sd * py]
  const base = Math.max(3, len * 0.2)
  const pts = [pt(-tail, 0.6), pt(base, wMax / 2), pt(len, 0), pt(base, -wMax / 2), pt(-tail, -0.6)]
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(p => ctx.lineTo(p[0], p[1])); ctx.closePath()
  ctx.fillStyle = color; ctx.fill()
}
const HELV = "'Helvetica Neue', Helvetica, 'Nimbus Sans', 'Liberation Sans', Arial, sans-serif"
const drawAnalog: Draw100 = (ctx, date) => {
  ctx.save(); ctx.translate(50, 50); ctx.scale(0.93, 0.93); ctx.translate(-50, -50)  // breathing room
  // Thin, uniform flat black bezel with a very faint top sheen.
  disc(ctx, 50, 50, 50, '#101012')
  ctx.save(); ctx.beginPath(); ctx.arc(50, 50, 50, 0, TAU); ctx.clip()
  const sheen = ctx.createLinearGradient(0, 0, 0, 40)
  sheen.addColorStop(0, 'rgba(255,255,255,0.10)'); sheen.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, 100, 40); ctx.restore()
  ring(ctx, 50, 50, 46.7, 0.4, 'rgba(255,255,255,0.18)')  // crisp inner highlight
  disc(ctx, 50, 50, 46.5, '#ffffff')                      // large white face (thin bezel ~3.5)
  // Minute ticks: small squares, bolder at the 5-minute marks.
  for (let i = 0; i < 60; i++) {
    const five = i % 5 === 0
    const [x, y] = P(i * 6, 43.5); const s = five ? 1.5 : 0.8
    ctx.save(); ctx.translate(x, y); ctx.rotate(rad(i * 6)); ctx.fillStyle = '#141414'; ctx.fillRect(-s / 2, -s / 2, s, s); ctx.restore()
  }
  // Numerals - Helvetica, light weight.
  for (let i = 1; i <= 12; i++) { const [x, y] = P(i * 30, 36); label(ctx, String(i), x, y, `300 9.5px ${HELV}`, '#1a1a1a') }
  // Brand mark: the Kubuno mark in grey, below the 12.
  drawKubunoLogo(ctx, 50, 34, 8, '#9aa0a6')
  // Slender tapered hands
  const { h, m, s } = ang(date)
  pointer(ctx, h, 27, 2.1, 3, '#141414')
  pointer(ctx, m, 40, 1.7, 3.5, '#141414')
  const [sx, sy] = P(s, 42); const [tx, ty] = P(s + 180, 11); const [cwx, cwy] = P(s + 180, 7)
  seg(ctx, tx, ty, sx, sy, 0.6, '#141414'); disc(ctx, cwx, cwy, 1.4, '#141414')
  // Brass hub
  disc(ctx, 50, 50, 1.9, '#c9a227'); disc(ctx, 50, 50, 0.85, '#6b5410')
  ctx.restore()
}

// ── Style 7 (pink) ──────────────────────────────────────────────────────────────
const SANS7 = "Arial, 'Liberation Sans', 'Helvetica Neue', system-ui, sans-serif"
const drawStyle7: Draw100 = (ctx, date, ex) => {
  const PINK = '#ff0d8c', BLACK = '#1a1a1a'
  // Shrink the dial so a pink margin remains around it - the year arc lives there.
  ctx.save(); ctx.translate(50, 50); ctx.scale(0.86, 0.86); ctx.translate(-50, -50)
  disc(ctx, 50, 50, 49, '#333333'); disc(ctx, 50, 50, 46, '#ffffff')
  for (let i = 0; i < 60; i++) {
    const h = i % 5 === 0; const [x1, y1] = P(i * 6, h ? 39.5 : 43); const [x2, y2] = P(i * 6, 46.5)
    seg(ctx, x1, y1, x2, y2, h ? 2 : 0.7, BLACK, 'butt')
  }
  for (let i = 1; i <= 12; i++) { const [x, y] = P(i * 30, 33); label(ctx, String(i), x, y, `700 8.5px ${SANS7}`, BLACK) }
  label(ctx, 'STYLE 7', 50, 34, `600 4.3px ${SANS7}`, '#7a7a7a')
  roundRectPath(ctx, 63.5, 45.5, 12.5, 11, 1.4); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 0.6; ctx.strokeStyle = '#c2c2c2'; ctx.stroke()
  label(ctx, ex.day ?? '', 69.75, 51.3, `800 6.4px ${SANS7}`, PINK)
  label(ctx, ex.digital ?? '', 50, 66, `700 8px ${SANS7}`, PINK)
  const { h, m, s } = ang(date)
  // Black hand shapes with an inset pink fill (black border + black base/tip).
  hand(ctx, h, 26, 4.6, BLACK, 7); { const [x, y] = P(h, 22); const [px, py] = P(h, 9); seg(ctx, px, py, x, y, 2.8, PINK) }
  hand(ctx, m, 35, 3.4, BLACK, 8); { const [x, y] = P(m, 31); const [px, py] = P(m, 11); seg(ctx, px, py, x, y, 2, PINK) }
  { const [sx, sy] = P(s, 40); const [tx, ty] = P(s + 180, 10); seg(ctx, tx, ty, sx, sy, 1, PINK) }
  disc(ctx, 50, 50, 2.8, BLACK); disc(ctx, 50, 50, 1.1, PINK)
  ctx.restore()
  // Year on a circular arc over the top-right pink margin (white, soft shadow).
  const yr = ex.year ?? ''
  ctx.font = `italic 800 10px ${SANS7}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff'
  ctx.shadowColor = 'rgba(80,0,40,0.55)'; ctx.shadowBlur = 1.4; ctx.shadowOffsetX = 0.7; ctx.shadowOffsetY = 1.2
  const R = 46, center = 49.5, step = 8.5, start = center - ((yr.length - 1) / 2) * step
  for (let i = 0; i < yr.length; i++) {
    const a = start + i * step; const [x, y] = P(a, R)
    ctx.save(); ctx.translate(x, y); ctx.rotate(rad(a)); ctx.fillText(yr[i], 0, 0); ctx.restore()
  }
  ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0
}

// Holly-leaf outline points: 4 shallow spikes per side on a plump, full body
// (shallow notches → a real leaf, not a spiky star). Axis up (local -y).
function leafPts(len: number, halfW: number): [number, number][] {
  const n = 8, pts: [number, number][] = []
  const push = (s: number, i: number) => {
    const t = i / n, env = halfW * Math.pow(Math.sin(Math.PI * t), 0.5)
    pts.push([s * env * (i % 2 === 1 ? 1.12 : 0.82), -len * t])
  }
  for (let i = 0; i <= n; i++) push(1, i)
  for (let i = n; i >= 0; i--) push(-1, i)
  return pts
}
const VEIN = 'rgba(9,18,74,0.9)'
const LEAF_FILLS = ['#2c4db2', '#26429a', '#33558f']
// A solid, veined holly leaf outlined in dark navy (stained-glass separation).
// `lobed` smooths the outline into rounded lobes instead of sharp spikes.
function veinedLeaf(ctx: Ctx, cx: number, cy: number, ang: number, len: number, halfW: number, fill: string, lobed = false) {
  const pts = leafPts(len, halfW)
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rad(ang))
  ctx.beginPath()
  if (lobed) {
    const last = pts[pts.length - 1]
    ctx.moveTo((last[0] + pts[0][0]) / 2, (last[1] + pts[0][1]) / 2)
    for (let i = 0; i < pts.length; i++) { const c = pts[i], nx = pts[(i + 1) % pts.length]; ctx.quadraticCurveTo(c[0], c[1], (c[0] + nx[0]) / 2, (c[1] + nx[1]) / 2) }
  } else {
    ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
  }
  ctx.closePath()
  ctx.fillStyle = fill; ctx.fill()
  ctx.lineJoin = 'round'; ctx.lineWidth = 0.5; ctx.strokeStyle = VEIN; ctx.stroke()
  // Midrib + side veins
  ctx.beginPath(); ctx.moveTo(0, -len * 0.06); ctx.lineTo(0, -len * 0.9); ctx.lineWidth = 0.55; ctx.strokeStyle = VEIN; ctx.stroke()
  for (let i = 1; i <= 3; i++) {
    const t = i / 4.2, y = -len * t, w = halfW * Math.pow(Math.sin(Math.PI * t), 0.6)
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w * 0.8, y - len * 0.06); ctx.moveTo(0, y); ctx.lineTo(-w * 0.8, y - len * 0.06)
    ctx.lineWidth = 0.3; ctx.stroke()
  }
  ctx.restore()
}
// Dial motif: 6 sprays of large, full holly leaves radiating from the centre -
// a big central leaf flanked by two side leaves, plus a small inner rosette.
function drawHollyMandala(ctx: Ctx) {
  const spray = (a: number) => {
    const [bx, by] = P(a, 3)
    veinedLeaf(ctx, bx, by, a - 30, 20, 4.6, LEAF_FILLS[1])   // left side leaf
    veinedLeaf(ctx, bx, by, a + 30, 20, 4.6, LEAF_FILLS[2])   // right side leaf
    veinedLeaf(ctx, bx, by, a, 28, 6, LEAF_FILLS[0])          // big centre leaf on top
  }
  for (let k = 0; k < 6; k++) spray(k * 60)
  for (let k = 0; k < 6; k++) veinedLeaf(ctx, 50, 50, k * 60 + 30, 11, 2.8, LEAF_FILLS[1])  // inner rosette
  disc(ctx, 50, 50, 2.2, '#20357e')
  for (let k = 0; k < 6; k++) { const [x, y] = P(k * 60 + 30, 13); disc(ctx, x, y, 1.3, '#5578da') }
}

// ── Navy + gold Roman ───────────────────────────────────────────────────────────
const ROMAN = ['I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']
const drawRomanGold: Draw100 = (ctx, date) => {
  const GOLD = '#e6c565'
  const bez = ctx.createLinearGradient(15, 5, 85, 95)
  bez.addColorStop(0, '#fff2c2'); bez.addColorStop(0.28, '#d9ad4e'); bez.addColorStop(0.55, '#9c7729')
  bez.addColorStop(0.78, '#e7c169'); bez.addColorStop(1, '#7d5f1f')
  disc(ctx, 50, 50, 49, bez)
  disc(ctx, 50, 50, 43.5, '#6b511d')
  const face = ctx.createRadialGradient(50, 42, 4, 50, 52, 46)
  face.addColorStop(0, '#1c318f'); face.addColorStop(0.7, '#0e1e6b'); face.addColorStop(1, '#081348')
  disc(ctx, 50, 50, 42.5, face)
  drawHollyMandala(ctx)
  for (let i = 0; i < 60; i++) {
    const [x1, y1] = P(i * 6, i % 5 === 0 ? 39 : 41); const [x2, y2] = P(i * 6, 42)
    seg(ctx, x1, y1, x2, y2, i % 5 === 0 ? 1.1 : 0.5, GOLD, 'butt')
  }
  for (let i = 0; i < 12; i++) {
    const [x, y] = P((i + 1) * 30, 33)
    label(ctx, ROMAN[i], x, y, "700 7px Georgia, 'Times New Roman', serif", GOLD)
  }
  const { h, m, s } = ang(date)
  hand(ctx, h, 22, 2.6, GOLD); hand(ctx, m, 33, 1.9, GOLD)
  for (const [a, r] of [[h, 18], [m, 27]] as const) {
    const [lx, ly] = P(a, r)
    for (const off of [40, -40]) {
      ctx.save(); ctx.translate(lx, ly); ctx.rotate(rad(a + off)); ctx.beginPath(); ctx.ellipse(0, 0, 1.6, 3.4, 0, 0, TAU)
      ctx.fillStyle = GOLD; ctx.fill(); ctx.restore()
    }
  }
  const [sx, sy] = P(s, 36); const [stx, sty] = P(s + 180, 8); seg(ctx, stx, sty, sx, sy, 0.7, GOLD)
  disc(ctx, 50, 50, 2.6, GOLD); disc(ctx, 50, 50, 1.1, '#7a5c1e')
}

// ── Gorgy Timing (railway) ──────────────────────────────────────────────────────
const drawGorgy: Draw100 = (ctx, date) => {
  const Y = '#e9e70f'
  disc(ctx, 50, 50, 49, '#0b0b0c'); disc(ctx, 50, 50, 45, '#1c1d20'); disc(ctx, 50, 50, 30, '#34373d')
  ring(ctx, 50, 50, 41.5, 0.3, 'rgba(200,204,210,0.6)')
  for (let i = 0; i < 60; i++) {
    if (i % 5 === 0) continue
    const [x1, y1] = P(i * 6, 38.5); const [x2, y2] = P(i * 6, 42); seg(ctx, x1, y1, x2, y2, 0.8, Y, 'butt')
  }
  for (let i = 0; i < 12; i++) { const [x1, y1] = P(i * 30, 33); const [x2, y2] = P(i * 30, 42); seg(ctx, x1, y1, x2, y2, i === 0 ? 3.6 : 3, Y, 'butt') }
  const bar = (a: number, len: number, wB: number, wT: number, tail: number) => {
    const ax = Math.sin(rad(a)), ay = -Math.cos(rad(a)), px = Math.cos(rad(a)), py = Math.sin(rad(a))
    const c = (al: number, sd: number): [number, number] => [50 + al * ax + sd * px, 50 + al * ay + sd * py]
    const pts = [c(-tail, wB / 2), c(-tail, -wB / 2), c(len, -wT / 2), c(len, wT / 2)]
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(p => ctx.lineTo(p[0], p[1])); ctx.closePath()
    ctx.fillStyle = Y; ctx.fill()
  }
  const { h, m, s } = ang(date)
  bar(h, 24, 4.4, 3, 7); bar(m, 39, 3.4, 2, 8)
  const [sx, sy] = P(s, 34); const [rx, ry] = P(s, 37.5); const [tx, ty] = P(s + 180, 10)
  seg(ctx, tx, ty, sx, sy, 1, Y); ring(ctx, rx, ry, 2.6, 1, Y)
  label(ctx, 'GORGY', 47.5, 65.5, "700 4px system-ui, sans-serif", '#e8eaed', 'right')
  disc(ctx, 51.5, 64.9, 2, '#d8dade'); disc(ctx, 51.5, 64.9, 0.9, '#2a2a2a')
  label(ctx, 'TIMING', 54.5, 65.5, "700 4px system-ui, sans-serif", '#e8eaed', 'left')
  disc(ctx, 50, 50, 2.4, Y); disc(ctx, 50, 50, 1, '#1c1d20')
}

// ── Style Seven (square, blue) ──────────────────────────────────────────────────
const drawStyleSevenSquare: Draw100 = (ctx, date, ex) => {
  const BLUE = '#1f74ff', RED = '#e11414'
  roundRectPath(ctx, 1.5, 1.5, 97, 97, 15); ctx.fillStyle = '#1b1b1b'; ctx.fill()
  roundRectPath(ctx, 5, 5, 90, 90, 10); ctx.fillStyle = '#ffffff'; ctx.fill()
  for (let i = 0; i < 60; i++) {
    const [x1, y1] = P(i * 6, i % 5 === 0 ? 40 : 42.5); const [x2, y2] = P(i * 6, 44.5)
    seg(ctx, x1, y1, x2, y2, i % 5 === 0 ? 1.4 : 0.5, '#111', 'butt')
  }
  for (let i = 1; i <= 12; i++) { const [x, y] = P(i * 30, 34); label(ctx, String(i), x, y, "700 8.5px 'Trebuchet MS', system-ui, sans-serif", '#111') }
  label(ctx, 'STYLE SEVEN', 50, 31.5, "700 4px 'DM Mono', monospace", '#333')
  const box = (x: number, y: number, w: number, h: number, txt: string, fs: number) => {
    roundRectPath(ctx, x, y, w, h, 1); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 0.4; ctx.strokeStyle = '#b8c6e0'; ctx.stroke()
    label(ctx, txt, x + w / 2, y + h / 2 + 0.2, `700 ${fs}px 'DM Mono', monospace`, BLUE)
  }
  box(24, 40, 13, 6.6, '100%', 4); box(24, 47, 13, 6.6, ex.month ?? '', 4); box(24, 54, 13, 6.6, ex.weekday ?? '', 4)
  box(63, 43.5, 13, 9, ex.day ?? '', 6)
  label(ctx, ex.year ?? '', 50, 64, "700 7px 'DM Mono', monospace", RED)
  const { h, m, s } = ang(date)
  const twoTone = (a: number, len: number, w: number, from: number) => {
    hand(ctx, a, len, w, '#111'); const [x, y] = P(a, len); const [px, py] = P(a, from); seg(ctx, px, py, x, y, w, BLUE)
  }
  twoTone(h, 24, 3.4, 14); twoTone(m, 34, 2.6, 22)
  const [sx, sy] = P(s, 40); const [tx, ty] = P(s + 180, 9); seg(ctx, tx, ty, sx, sy, 1, BLUE)
  disc(ctx, 50, 50, 2.6, '#111'); disc(ctx, 50, 50, 1.2, BLUE)
}

// ── Sapling (square minimalist) ─────────────────────────────────────────────────
const drawSapling: Draw100 = (ctx, date) => {
  roundRectPath(ctx, 1.5, 1.5, 97, 97, 13); ctx.fillStyle = '#3a3d42'; ctx.fill()
  roundRectPath(ctx, 4.5, 4.5, 91, 91, 10); ctx.fillStyle = '#ffffff'; ctx.fill()
  roundRectPath(ctx, 6.5, 6.5, 87, 87, 8.5); ctx.lineWidth = 0.6; ctx.strokeStyle = '#e6e8ec'; ctx.stroke()
  for (let i = 0; i < 60; i++) {
    if (i % 5 === 0) { const [x1, y1] = P(i * 6, 33); const [x2, y2] = P(i * 6, 37); seg(ctx, x1, y1, x2, y2, 1.3, '#111') }
    else { const [dx, dy] = P(i * 6, 36); disc(ctx, dx, dy, 0.6, '#111') }
  }
  for (let i = 1; i <= 12; i++) { const [x, y] = P(i * 30, 43); label(ctx, String(i), x, y, "700 9px 'DM Sans', system-ui, sans-serif", '#111') }
  label(ctx, 'sapling', 51.5, 61, "700 4.2px 'DM Sans', system-ui, sans-serif", '#8a9099')
  const { h, m, s } = ang(date)
  hand(ctx, h, 22, 3.2, '#111', 7); hand(ctx, m, 32, 2.4, '#111', 7)
  const [sx, sy] = P(s, 33); const [tx, ty] = P(s + 180, 11); const [rx, ry] = P(s + 180, 8)
  seg(ctx, tx, ty, sx, sy, 0.9, '#d21f1f'); ring(ctx, rx, ry, 1.6, 0.9, '#d21f1f')
  disc(ctx, 50, 50, 2.3, '#111')
}

// ── Blue round (embossed white numerals) ────────────────────────────────────────
const BLUE_BIG = [12, 3, 6, 9]
const drawBlueRound: Draw100 = (ctx, date) => {
  disc(ctx, 50, 50, 49, '#f4f6f8'); disc(ctx, 50, 50, 47.5, '#ffffff')
  const blue = ctx.createRadialGradient(50, 44, 6, 50, 52, 47)
  blue.addColorStop(0, '#3f8bf2'); blue.addColorStop(1, '#2168d6')
  disc(ctx, 50, 50, 47, blue)
  for (let i = 0; i < 60; i++) {
    const [x1, y1] = P(i * 6, i % 5 === 0 ? 42 : 43.5); const [x2, y2] = P(i * 6, 45.5)
    seg(ctx, x1, y1, x2, y2, i % 5 === 0 ? 1 : 0.5, 'rgba(255,255,255,0.9)', 'butt')
  }
  ctx.save(); ctx.shadowColor = 'rgba(0,20,60,0.35)'; ctx.shadowBlur = 0.8; ctx.shadowOffsetY = 0.6
  for (let i = 1; i <= 12; i++) {
    const [x, y] = P(i * 30, 34); const big = BLUE_BIG.includes(i)
    label(ctx, String(i), x, y, `700 ${big ? 12 : 6.5}px 'DM Sans', system-ui, sans-serif`, '#ffffff')
  }
  ctx.restore()
  const { h, m, s } = ang(date)
  hand(ctx, h, 24, 1.8, '#ffffff', 7); hand(ctx, m, 34, 1.4, '#ffffff', 7)
  const [sx, sy] = P(s, 38); const [tx, ty] = P(s + 180, 9); seg(ctx, tx, ty, sx, sy, 0.7, '#eaf1ff')
  disc(ctx, 50, 50, 1.8, '#ffffff'); disc(ctx, 50, 50, 0.8, '#2168d6')
}

// ── Registry ────────────────────────────────────────────────────────────────────
export interface FaceDef { draw: FaceDraw; chrome: 'card' | 'bleed'; bg?: string }
export const CLOCK_FACES: Record<string, FaceDef> = {
  digital:            { draw: drawDigital,                  chrome: 'card' },
  analog:             { draw: square(drawAnalog),           chrome: 'card' },
  style7:             { draw: square(drawStyle7),           chrome: 'bleed', bg: '#ff0d8c' },
  roman_blue_gold:    { draw: square(drawRomanGold),        chrome: 'bleed', bg: '#ffffff' },
  gorgy:              { draw: square(drawGorgy),            chrome: 'bleed', bg: '#ffffff' },
  style_seven_square: { draw: square(drawStyleSevenSquare), chrome: 'bleed', bg: '#e9f1fc' },
  sapling:            { draw: square(drawSapling),          chrome: 'bleed', bg: '#ffffff' },
  blue_round:         { draw: square(drawBlueRound),        chrome: 'bleed', bg: '#eef1f5' },
}

// ── Flip clock (animated split-flap) ────────────────────────────────────────────
// Dedicated component: unlike the once-per-second faces it drives its own
// requestAnimationFrame loop so the flap actually folds when a digit changes.
const FLIP_MS = 480
export function FlipClockCanvas({ width, height, hh, mm, ss, showSeconds, ampm }: {
  width: number; height: number; hh: string; mm: string; ss: string; showSeconds: boolean; ampm?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const shown = useRef<string[]>([])                                   // fully-settled value per group
  const anims = useRef<Record<number, { from: string; start: number }>>({})
  const raf = useRef(0)
  const values = showSeconds ? [hh, mm, ss] : [hh, mm]

  useEffect(() => {
    const T = resolveTheme()
    const W = Math.max(1, Math.round(width)), H = Math.max(1, Math.round(height))
    const dpr = window.devicePixelRatio || 1

    // A single card face (rounded dark rect + 2 digits), clipped+squashed to one half.
    const flap = (ctx: Ctx, x: number, y: number, w: number, h: number, txt: string, half: 'top' | 'bottom', sy: number) => {
      if (sy <= 0) return
      const mid = y + h / 2
      ctx.save()
      ctx.beginPath()
      if (half === 'top') ctx.rect(x - 1, y - 1, w + 2, h / 2 + 1)
      else ctx.rect(x - 1, mid, w + 2, h / 2 + 1)
      ctx.clip()
      ctx.translate(x + w / 2, mid); ctx.scale(1, sy); ctx.translate(-(x + w / 2), -mid)
      roundRectPath(ctx, x, y, w, h, w * 0.14); ctx.fillStyle = '#1f2024'; ctx.fill()
      label(ctx, txt, x + w / 2, y + h / 2 + h * 0.02, `600 ${h * 0.5}px 'DM Sans', system-ui, sans-serif`, '#f3f4f6')
      // Shade the leaf as it folds away for depth.
      const shade = half === 'top' ? (1 - sy) * 0.5 : (1 - sy) * 0.35
      if (shade > 0) { ctx.fillStyle = `rgba(0,0,0,${shade})`; ctx.fill() }
      ctx.restore()
    }

    const tick = () => {
      const cvs = ref.current; if (!cvs) return
      if (cvs.width !== W * dpr) { cvs.width = W * dpr; cvs.height = H * dpr }
      const ctx = cvs.getContext('2d'); if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H)

      const now = Date.now()
      const n = values.length
      const colonW = W * 0.05
      const cardW = Math.min(((W - (n - 1) * colonW) / n) * 0.94, (H * 0.86) / 1.25)
      const cardH = cardW * 1.25
      const total = n * cardW + (n - 1) * colonW
      let x = (W - total) / 2
      const y = (H - cardH) / 2
      let animating = false

      for (let i = 0; i < n; i++) {
        const a = anims.current[i]
        let cur = values[i], prev = values[i], p = 1
        if (a) {
          p = (now - a.start) / FLIP_MS
          if (p >= 1) { shown.current[i] = values[i]; delete anims.current[i] }
          else { cur = values[i]; prev = a.from; animating = true }
        }
        // Background: top = new, bottom = old; then the folding leaf on top.
        flap(ctx, x, y, cardW, cardH, cur, 'top', 1)
        flap(ctx, x, y, cardW, cardH, prev, 'bottom', 1)
        if (p < 0.5) flap(ctx, x, y, cardW, cardH, prev, 'top', Math.cos(p * Math.PI))
        else flap(ctx, x, y, cardW, cardH, cur, 'bottom', Math.sin((p - 0.5) * Math.PI))
        seg(ctx, x, y + cardH / 2, x + cardW, y + cardH / 2, Math.max(0.8, cardH * 0.02), 'rgba(0,0,0,0.55)', 'butt')
        if (i < n - 1) {
          const cx = x + cardW + colonW / 2
          disc(ctx, cx, y + cardH * 0.37, cardW * 0.055, T.textSec)
          disc(ctx, cx, y + cardH * 0.63, cardW * 0.055, T.textSec)
        }
        x += cardW + colonW
      }
      if (ampm) label(ctx, ampm, W / 2, y + cardH + Math.min(H * 0.08, cardH * 0.2), `600 ${cardH * 0.2}px 'DM Sans', system-ui, sans-serif`, T.textSec)

      if (animating) raf.current = requestAnimationFrame(tick)
    }

    // Seed on first run, then start flips for any group whose value changed.
    if (shown.current.length !== values.length) shown.current = values.slice()
    values.forEach((v, i) => {
      if (shown.current[i] !== v && !anims.current[i]) anims.current[i] = { from: shown.current[i], start: Date.now() }
    })
    cancelAnimationFrame(raf.current)
    tick()
    return () => cancelAnimationFrame(raf.current)
  }, [width, height, hh, mm, ss, showSeconds, ampm])

  return <canvas ref={ref} style={{ display: 'block', width, height }} />
}

// ── Canvas wrapper ──────────────────────────────────────────────────────────────
export function ClockCanvas({ draw, width, height, date, extras }: {
  draw: FaceDraw; width: number; height: number; date: Date; extras: FaceExtras
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cvs = ref.current; if (!cvs) return
    const W = Math.max(1, Math.round(width)), H = Math.max(1, Math.round(height))
    const dpr = window.devicePixelRatio || 1
    cvs.width = W * dpr; cvs.height = H * dpr
    const ctx = cvs.getContext('2d'); if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    draw(ctx, W, H, date, { ...extras, theme: extras.theme ?? resolveTheme() })
  })
  return <canvas ref={ref} style={{ display: 'block', width, height }} />
}
