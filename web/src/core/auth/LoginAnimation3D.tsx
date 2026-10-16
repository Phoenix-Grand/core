import { useEffect, useRef } from 'react'

// "Membranes de soie" - Canvas 2D rendering matching the reference clip: a few
// large translucent films, each bounded by TWO independent bright wavy edges
// that can cross (the ribbon twists → luminous pinch points). The interior is
// nearly transparent, denser toward both edges (nested translucent bands), and
// additive blending + bloom make overlaps and folds glow. Edges travel
// horizontally at different speeds so the folds continuously reshape.
//
// Rollback: LoginPage previously imported ./LoginAnimation (strands style) -
// swap the import back to restore it.

interface EdgeSpec {
  base:   number    // vertical anchor (0–1)
  amps:   number[]  // wave amplitudes (fraction of height)
  freqs:  number[]  // spatial frequencies across the width
  phases: number[]
  vel:    number    // horizontal travel speed (x-units/s)
  omegas: number[]  // per-component phase speeds (rad/s, MIXED signs → the
                    // waveform morphs/undulates instead of sliding rigidly)
  swayPh: number    // phase of the slow vertical sway / amplitude breathing
}

// Interior fold: a soft luminous crease crossing the film DIAGONALLY (its
// position sweeps from one edge toward the other along x), bright at the crest
// with an asymmetric falloff - sharp on one side, long melt on the other - and
// fading in/out along its length. This is the "light catching a fold of the 3D
// fabric" feature of the reference.
interface FoldSpec {
  f0: number; f1: number // interior fraction (0=edge1, 1=edge2) at x=0 → x=1
  bend:   number         // sine bend of the fold path
  wSharp: number         // falloff width on the sharp side (fraction of span)
  wSoft:  number         // falloff width on the soft side
  maxA:   number         // peak extra alpha at the crest
  ph:  number            // path phase
  ph2: number            // envelope phase
}

interface MembraneSpec {
  e1: EdgeSpec
  e2: EdgeSpec
  edgeA:   number // peak alpha AT the edges
  midA:    number // alpha just inside the glow zone
  centerA: number // alpha at the veil center (near-transparent, ~3-5%)
  folds:   FoldSpec[]
}

// The two edges of one membrane drift at DIFFERENT speeds → crossings (twists)
// keep forming and dissolving, like the reference. Two LARGE ribbons only, with
// very low spatial frequencies (one swell ≈ half the width) and wide films.
const MEMBRANES: MembraneSpec[] = [
  // Dominant ribbon.
  {
    e1: { base: 0.55, amps: [0.110, 0.035], freqs: [0.55, 1.25], phases: [0.5, 1.8], vel: 0.020, omegas: [0.11, -0.17], swayPh: 0.4 },
    e2: { base: 0.72, amps: [0.095, 0.040], freqs: [0.70, 1.45], phases: [2.4, 0.7], vel: 0.012, omegas: [-0.13, 0.19], swayPh: 2.6 },
    edgeA: 0.50, midA: 0.065, centerA: 0.035,
    folds: [
      { f0: 0.12, f1: 0.78, bend: 0.10, wSharp: 0.045, wSoft: 0.22, maxA: 0.17, ph: 0.8, ph2: 2.1 },
      { f0: 0.72, f1: 0.25, bend: 0.08, wSharp: 0.050, wSoft: 0.18, maxA: 0.12, ph: 2.6, ph2: 0.5 },
    ],
  },
  // Secondary ribbon, offset, opposite drift.
  {
    e1: { base: 0.62, amps: [0.085, 0.030], freqs: [0.65, 1.50], phases: [1.2, 2.9], vel: -0.017, omegas: [-0.10, 0.16], swayPh: 1.4 },
    e2: { base: 0.80, amps: [0.075, 0.035], freqs: [0.80, 1.70], phases: [0.1, 1.5], vel: -0.024, omegas: [0.14, -0.21], swayPh: 4.2 },
    edgeA: 0.40, midA: 0.055, centerA: 0.028,
    folds: [
      { f0: 0.20, f1: 0.70, bend: 0.09, wSharp: 0.050, wSoft: 0.20, maxA: 0.13, ph: 1.4, ph2: 3.0 },
    ],
  },
]

const SEGMENTS = 200
const BG_TOP: [number, number, number] = [7, 16, 45]
const BG_BOTTOM: [number, number, number] = [2, 5, 14]
const FILL: [number, number, number] = [30, 100, 235]
const EDGE: [number, number, number] = [90, 170, 255]
const BLOOM = { scale: 0.4, blurPx: 10, strength: 1.0 }
const TWO = Math.PI * 2

const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

function edgeY(e: EdgeSpec, x: number, time: number, yShift: number): number {
  // Slow vertical sway keeps the whole edge breathing up and down.
  let v = e.base + yShift + 0.014 * Math.sin(0.19 * time + e.swayPh * 1.7)
  for (let i = 0; i < e.amps.length; i++) {
    // Amplitude breathing + independent phase speed per component: the two
    // sines beat against each other, so the shape truly undulates.
    const breath = 0.76 + 0.24 * Math.sin((i === 0 ? 0.11 : 0.151) * time + e.swayPh + i * 2.1)
    v += e.amps[i] * breath
       * Math.sin(TWO * e.freqs[i] * (x - e.vel * time) + e.phases[i] + e.omegas[i] * time)
  }
  return v
}

interface Layer { c: HTMLCanvasElement; x: CanvasRenderingContext2D }
function makeLayer(): Layer {
  const c = document.createElement('canvas')
  return { c, x: c.getContext('2d')! }
}

export default function LoginAnimation3D({ yShift = 0 }: { yShift?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    const bg = makeLayer()
    const film = makeLayer()
    const memb = makeLayer() // scratch layer: one membrane at a time (source-over)
    const bloom = makeLayer()

    let W = 0, H = 0
    let vigGrad: CanvasGradient | null = null
    let t = 80, last = 0, raf = 0 // start mid-flow: first frame already organic
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

    const xs = new Float32Array(SEGMENTS + 1)
    const y1 = new Float32Array(SEGMENTS + 1)
    const y2 = new Float32Array(SEGMENTS + 1)

    function buildBackground() {
      const g = bg.x
      const lin = g.createLinearGradient(0, 0, 0, H)
      lin.addColorStop(0, rgba(BG_TOP, 1))
      lin.addColorStop(1, rgba(BG_BOTTOM, 1))
      g.globalCompositeOperation = 'source-over'
      g.fillStyle = lin; g.fillRect(0, 0, W, H)
      g.globalCompositeOperation = 'lighter'
      const hg = g.createRadialGradient(W * 0.70, H * 0.36, 0, W * 0.70, H * 0.36, W * 0.5)
      hg.addColorStop(0, 'rgba(40,105,230,0.09)')
      hg.addColorStop(1, 'rgba(40,105,230,0)')
      g.fillStyle = hg; g.fillRect(0, 0, W, H)
      g.globalCompositeOperation = 'source-over'
    }

    function buildVignette() {
      const cx = W / 2, cy = H / 2, outer = Math.hypot(W, H) * 0.60
      vigGrad = ctx!.createRadialGradient(cx, cy, outer * 0.45, cx, cy, outer)
      vigGrad.addColorStop(0, 'rgba(2,4,14,0)')
      vigGrad.addColorStop(1, 'rgba(2,4,14,0.5)')
    }

    function computeEdges(m: MembraneSpec, time: number) {
      for (let s = 0; s <= SEGMENTS; s++) {
        const x = -0.06 + 1.12 * (s / SEGMENTS)
        xs[s] = x * W
        y1[s] = edgeY(m.e1, x, time, yShift) * H
        y2[s] = edgeY(m.e2, x, time, yShift) * H
      }
    }

    // Column-gradient rendering: each vertical strip of the membrane is filled
    // with ONE true LinearGradient spanning edge→center→edge. The profile peaks
    // AT each edge, melts to a near-transparent center (~3-5%), and is smooth at
    // pixel precision - no stacked bands, no visible steps. Edge brightness
    // waxes/wanes along x (animated) like the reference. Adjacent strips share
    // exact boundaries, so antialiasing leaves no seams.
    function drawMembrane(
      g: CanvasRenderingContext2D, m: MembraneSpec, mi: number, time: number,
    ) {
      computeEdges(m, time)
      const glowPx = 0.055 * H // absolute glow reach inward from each edge
      for (let s = 0; s < SEGMENTS; s++) {
        const yT = (y1[s] + y1[s + 1]) / 2
        const yB = (y2[s] + y2[s + 1]) / 2
        const span = Math.abs(yB - yT)
        if (span < 1.5) continue // pinch point: edges meet, nothing between
        const xm = (s + 0.5) / SEGMENTS
        // Per-edge brightness modulation travelling along the edge.
        const wA = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(TWO * 0.85 * xm + mi * 2.7 + 0.4 + 0.13 * time))
        const wB = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(TWO * 0.85 * xm + mi * 2.7 + 3.5 + 0.13 * time))
        const k = Math.min(0.42, glowPx / span) // glow fraction of this column
        // Compose the full alpha profile as a CONTINUOUS function of the film
        // fraction f (baseline edge→center→edge + one asymmetric bump per fold),
        // then sample it at fixed offsets. Sampling a smooth function keeps
        // adjacent columns coherent - merging discrete stop lists caused hard
        // steps whenever fold stops crossed each other or the structural stops.
        const folds = m.folds.map((fd) => ({
          ff: fd.f0 + (fd.f1 - fd.f0) * xm + fd.bend * Math.sin(TWO * 0.4 * xm + fd.ph + 0.10 * time),
          af: fd.maxA
            * Math.pow(Math.max(0, Math.sin(Math.PI * xm)), 1.3)
            * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(TWO * 0.5 * xm + fd.ph2 + 0.12 * time))),
          wSharp: fd.wSharp, wSoft: fd.wSoft,
        }))
        const profile = (f: number): number => {
          // Baseline: edge peak → mid → airy center, mirrored.
          let a: number
          if (f < k) a = m.edgeA * wA + (m.midA - m.edgeA * wA) * (f / k)
          else if (f < 0.5) a = m.midA + (m.centerA - m.midA) * ((f - k) / (0.5 - k))
          else if (f < 1 - k) a = m.centerA + (m.midA - m.centerA) * ((f - 0.5) / (0.5 - k))
          else a = m.midA + (m.edgeA * wB - m.midA) * ((f - (1 - k)) / k)
          // Fold bumps: sharp rise on one side, long melt on the other.
          for (const fd of folds) {
            const d = f - fd.ff
            if (d >= -fd.wSharp && d <= 0) a += fd.af * Math.pow(1 + d / fd.wSharp, 1.2)
            else if (d > 0 && d <= fd.wSoft) a += fd.af * Math.pow(1 - d / fd.wSoft, 1.6)
          }
          return a
        }
        const grad = g.createLinearGradient(0, yT, 0, yB)
        const N = 22
        for (let i = 0; i <= N; i++) {
          const f = i / N
          const a = profile(f)
          // Brighter zones shift from body blue toward the light edge blue.
          const tCol = Math.min(1, Math.max(0, (a - 0.06) / 0.45))
          const col: [number, number, number] = [
            FILL[0] + (EDGE[0] - FILL[0]) * tCol,
            FILL[1] + (EDGE[1] - FILL[1]) * tCol,
            FILL[2] + (EDGE[2] - FILL[2]) * tCol,
          ]
          grad.addColorStop(f, rgba(col, a))
        }
        g.beginPath()
        g.moveTo(xs[s], y1[s])
        g.lineTo(xs[s + 1], y1[s + 1])
        g.lineTo(xs[s + 1], y2[s + 1])
        g.lineTo(xs[s], y2[s])
        g.closePath()
        g.fillStyle = grad
        g.fill()
      }
    }

    function drawFilm(time: number) {
      const g = film.x
      g.clearRect(0, 0, W, H)
      // Each membrane is rendered alone with source-over into the scratch layer
      // (adjacent column strips blend seamlessly - no additive self-overlap, so
      // no vertical seams), then composited additively so MEMBRANES brighten
      // each other where they overlap, like real translucent films.
      MEMBRANES.forEach((m, mi) => {
        memb.x.clearRect(0, 0, W, H)
        drawMembrane(memb.x, m, mi, time)
        g.globalCompositeOperation = 'lighter'
        // Whisper of blur when compositing: fuses any residual per-column
        // gradient discontinuity on steep slopes (invisible otherwise).
        g.filter = 'blur(1.2px)'
        g.drawImage(memb.c, 0, 0)
        g.filter = 'none'
      })
      g.globalCompositeOperation = 'source-over'
    }

    function buildBloom() {
      const bw = bloom.c.width, bh = bloom.c.height, b = bloom.x
      b.clearRect(0, 0, bw, bh)
      b.filter = `blur(${BLOOM.blurPx}px)`
      b.drawImage(film.c, 0, 0, bw, bh)
      b.filter = 'none'
    }

    function composite() {
      const c = ctx!
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1
      c.drawImage(bg.c, 0, 0)
      c.globalCompositeOperation = 'lighter'
      c.drawImage(film.c, 0, 0)
      c.globalAlpha = BLOOM.strength
      c.drawImage(bloom.c, 0, 0, W, H)
      c.globalAlpha = 1
      c.globalCompositeOperation = 'source-over'
      if (vigGrad) { c.fillStyle = vigGrad; c.fillRect(0, 0, W, H) }
    }

    function renderFrame() { drawFilm(t); buildBloom(); composite() }

    function resize() {
      const rect = cv!.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return
      const DPR = Math.min(2, window.devicePixelRatio || 1)
      W = Math.max(2, Math.round(rect.width * DPR))
      H = Math.max(2, Math.round(rect.height * DPR))
      for (const el of [cv!, bg.c, film.c, memb.c]) { el.width = W; el.height = H }
      bloom.c.width = Math.max(2, Math.round(W * BLOOM.scale))
      bloom.c.height = Math.max(2, Math.round(H * BLOOM.scale))
      buildBackground(); buildVignette()
      if (reduced) renderFrame()
    }

    function frame(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now
      t += dt
      renderFrame()
      raf = requestAnimationFrame(frame)
    }

    const onVisibility = () => { if (!document.hidden) last = performance.now() }
    document.addEventListener('visibilitychange', onVisibility)

    const ro = new ResizeObserver(() => resize())
    ro.observe(cv)
    resize()

    if (!reduced) {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [yShift])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 w-full h-full"
      style={{ display: 'block' }}
    />
  )
}
