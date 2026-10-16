import { useEffect, useRef } from 'react'

// "Ondes de lumière" - a continuous Canvas 2D aurora used as the background of
// the login branding panel. Parallel sinusoidal strands tighten and spread; with
// additive blending ('lighter') the dense zones build luminous nodes, and a blurred
// copy adds bloom. Sized to its container (not the viewport) and paused for users
// who prefer reduced motion.

type RGB = [number, number, number]

interface Glow { x: number; y: number; r: number; col: RGB; s: number }

interface Ribbon {
  baseY: number; amp: number[]; freqs: number[]; phases: number[]
  strands: number; spreadAmp: number; spreadFreq: number; spreadPhase: number
  slope: number; jitter: number; valMul: number
  _fj?: Float32Array
}

interface Preset {
  bgTop: RGB; bgBottom: RGB; glows: Glow[]
  strand: RGB; strandAlpha: number; lineWidth: number; segments: number
  speedEnv: number; speedSpread: number
  bloom: { scale: number; blurPx: number; strength: number }
  ribbons: Ribbon[]
}

export type LoginAnimationPreset = 'A' | 'B' | 'C' | 'D'

// Coordinates normalised: x ∈ [0,1] over width, y ∈ [0,1] over height. Colours 0–255.
const PRESETS: Record<LoginAnimationPreset, Preset> = {
  // A - Aurora: dynamic ribbon, white-cyan crests (closest to the reference).
  A: {
    bgTop: [8, 23, 77], bgBottom: [3, 9, 26],
    glows: [{ x: 0.70, y: 0.58, r: 0.40, col: [51, 140, 255], s: 0.45 }],
    strand: [92, 162, 255], strandAlpha: 0.11, lineWidth: 1.0, segments: 150,
    speedEnv: 0.16, speedSpread: -0.11,
    bloom: { scale: 0.40, blurPx: 6, strength: 0.85 },
    ribbons: [
      { baseY: 0.60, amp: [0.070, 0.030], freqs: [0.9, 2.3], phases: [0.2, 1.1],
        strands: 90, spreadAmp: 0.085, spreadFreq: 1.1, spreadPhase: 0.0,
        slope: 0.0, jitter: 0.04, valMul: 1.0 },
      { baseY: 0.64, amp: [0.050, 0.025], freqs: [1.3, 3.1], phases: [2.0, 0.3],
        strands: 70, spreadAmp: 0.060, spreadFreq: 1.6, spreadPhase: 1.4,
        slope: 0.0, jitter: 0.05, valMul: 0.8 },
    ],
  },
  // B - Deep Current: calmer, bluer, silky visible strands.
  B: {
    bgTop: [10, 28, 87], bgBottom: [5, 11, 33],
    glows: [{ x: 0.50, y: 0.55, r: 0.55, col: [51, 128, 242], s: 0.30 }],
    strand: [78, 150, 255], strandAlpha: 0.072, lineWidth: 1.0, segments: 150,
    speedEnv: 0.11, speedSpread: -0.07,
    bloom: { scale: 0.40, blurPx: 8, strength: 0.72 },
    ribbons: [
      { baseY: 0.58, amp: [0.045, 0.020], freqs: [0.7, 1.9], phases: [1.2, 0.4],
        strands: 120, spreadAmp: 0.100, spreadFreq: 0.8, spreadPhase: 0.0,
        slope: 0.0, jitter: 0.03, valMul: 1.0 },
      { baseY: 0.60, amp: [0.035, 0.018], freqs: [1.1, 2.4], phases: [2.6, 1.0],
        strands: 90, spreadAmp: 0.075, spreadFreq: 1.2, spreadPhase: 2.0,
        slope: 0.0, jitter: 0.04, valMul: 0.8 },
    ],
  },
  // C - Crosscurrents: two diagonal currents crossing into a central node.
  C: {
    bgTop: [8, 20, 71], bgBottom: [3, 8, 23],
    glows: [{ x: 0.50, y: 0.50, r: 0.34, col: [64, 153, 255], s: 0.55 }],
    strand: [102, 172, 255], strandAlpha: 0.10, lineWidth: 1.0, segments: 150,
    speedEnv: 0.13, speedSpread: -0.09,
    bloom: { scale: 0.40, blurPx: 7, strength: 0.88 },
    ribbons: [
      { baseY: 0.50, amp: [0.050, 0.020], freqs: [1.0, 2.6], phases: [0.5, 1.5],
        strands: 80, spreadAmp: 0.070, spreadFreq: 1.4, spreadPhase: 0.0,
        slope: +0.16, jitter: 0.04, valMul: 1.0 },
      { baseY: 0.50, amp: [0.050, 0.020], freqs: [1.1, 2.9], phases: [2.1, 0.2],
        strands: 80, spreadAmp: 0.070, spreadFreq: 1.4, spreadPhase: 1.6,
        slope: -0.16, jitter: 0.04, valMul: 1.0 },
    ],
  },
  // D - Twilight Helix: spectacular sweep with a hint of violet in the halo.
  D: {
    bgTop: [15, 20, 77], bgBottom: [10, 9, 31],
    glows: [{ x: 0.30, y: 0.42, r: 0.45, col: [77, 140, 255], s: 0.40 },
            { x: 0.80, y: 0.70, r: 0.35, col: [120, 118, 242], s: 0.28 }],
    strand: [122, 150, 255], strandAlpha: 0.10, lineWidth: 1.0, segments: 150,
    speedEnv: 0.12, speedSpread: -0.08,
    bloom: { scale: 0.40, blurPx: 8, strength: 0.80 },
    ribbons: [
      { baseY: 0.55, amp: [0.110, 0.040], freqs: [0.8, 2.0], phases: [1.8, 0.6],
        strands: 90, spreadAmp: 0.090, spreadFreq: 0.9, spreadPhase: 0.0,
        slope: -0.05, jitter: 0.05, valMul: 1.0 },
      { baseY: 0.58, amp: [0.080, 0.030], freqs: [1.2, 2.7], phases: [0.3, 2.0],
        strands: 70, spreadAmp: 0.065, spreadFreq: 1.5, spreadPhase: 1.2,
        slope: -0.04, jitter: 0.05, valMul: 0.85 },
    ],
  },
}

// Deterministic PRNG → stable per-strand jitter across frames.
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let s = Math.imul(a ^ (a >>> 15), 1 | a)
    s = (s + Math.imul(s ^ (s >>> 7), 61 | s)) ^ s
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296
  }
}

// `yShift` (normalised 0–1) pushes the luminous wave and its halo downward while
// leaving the full-height background gradient intact - keeps the upper area clear
// for the branding text.
function buildRuntime(key: LoginAnimationPreset, yShift: number): Preset {
  const r: Preset = JSON.parse(JSON.stringify(PRESETS[key]))
  if (yShift) {
    for (const rb of r.ribbons) rb.baseY += yShift
    for (const gl of r.glows) gl.y = Math.min(1, gl.y + yShift)
  }
  for (const rb of r.ribbons) {
    const rnd = mulberry32(0x9E37 ^ key.charCodeAt(0) ^ Math.round(rb.baseY * 1000))
    rb._fj = new Float32Array(rb.strands)
    for (let i = 0; i < rb.strands; i++) rb._fj[i] = 1 + (rnd() * 2 - 1) * rb.jitter
  }
  return r
}

const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

interface Layer { c: HTMLCanvasElement; x: CanvasRenderingContext2D }
function makeLayer(): Layer {
  const c = document.createElement('canvas')
  return { c, x: c.getContext('2d')! }
}

export default function LoginAnimation(
  { preset = 'A', yShift = 0 }: { preset?: LoginAnimationPreset; yShift?: number },
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    const P = buildRuntime(preset, yShift)
    const bg = makeLayer()
    const lines = makeLayer()
    const bloom = makeLayer()

    let W = 0, H = 0, DPR = 1
    let vigGrad: CanvasGradient | null = null
    let grainPattern: CanvasPattern | null = null
    let t = 0, last = 0, raf = 0
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

    function buildBackground() {
      const g = bg.x
      const lin = g.createLinearGradient(0, 0, 0, H)
      lin.addColorStop(0, rgba(P.bgTop, 1))
      lin.addColorStop(1, rgba(P.bgBottom, 1))
      g.globalCompositeOperation = 'source-over'
      g.fillStyle = lin; g.fillRect(0, 0, W, H)
      g.globalCompositeOperation = 'lighter'
      for (const gl of P.glows) {
        const R = gl.r * W, cx = gl.x * W, cy = gl.y * H
        const rg = g.createRadialGradient(cx, cy, 0, cx, cy, R)
        rg.addColorStop(0, rgba(gl.col, gl.s))
        rg.addColorStop(1, rgba(gl.col, 0))
        g.fillStyle = rg; g.fillRect(0, 0, W, H)
      }
      g.globalCompositeOperation = 'source-over'
    }

    function buildVignette() {
      const cx = W / 2, cy = H / 2, outer = Math.hypot(W, H) * 0.62
      vigGrad = ctx!.createRadialGradient(cx, cy, outer * 0.42, cx, cy, outer)
      vigGrad.addColorStop(0, 'rgba(2,4,16,0)')
      vigGrad.addColorStop(1, 'rgba(2,4,16,0.55)')
    }

    function buildGrain() {
      const N = 128
      const tile = document.createElement('canvas'); tile.width = tile.height = N
      const tx = tile.getContext('2d')!
      const img = tx.createImageData(N, N); const d = img.data
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.random() * 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255
      }
      tx.putImageData(img, 0, 0)
      grainPattern = ctx!.createPattern(tile, 'repeat')
    }

    function drawStrands(time: number) {
      const g = lines.x
      g.clearRect(0, 0, W, H)
      g.globalCompositeOperation = 'lighter'
      g.lineCap = 'round'; g.lineJoin = 'round'
      g.lineWidth = P.lineWidth * DPR
      const tEnv = time * P.speedEnv, tSpr = time * P.speedSpread
      const TWO = Math.PI * 2
      for (const rb of P.ribbons) {
        g.strokeStyle = rgba(P.strand, P.strandAlpha * (rb.valMul ?? 1))
        const N = rb.strands, SEG = P.segments, fjArr = rb._fj!
        for (let i = 0; i < N; i++) {
          const u = (i / (N - 1)) - 0.5, fj = fjArr[i]
          g.beginPath()
          for (let s = 0; s <= SEG; s++) {
            const x = -0.1 + 1.2 * (s / SEG)
            let env = 0
            for (let k = 0; k < rb.freqs.length; k++)
              env += rb.amp[k] * Math.sin(TWO * rb.freqs[k] * x + rb.phases[k] + tEnv)
            const cy = rb.baseY + env + rb.slope * (x - 0.5)
            const spread = (0.5 + 0.5 * Math.sin(TWO * rb.spreadFreq * x + rb.spreadPhase + tSpr)) * rb.spreadAmp
            const extra = 0.004 * Math.sin(TWO * (rb.freqs[0] * fj) * x + rb.phases[0] + i * 0.05)
            const X = x * W, Y = (cy + spread * u * 2 + extra) * H
            if (s === 0) g.moveTo(X, Y); else g.lineTo(X, Y)
          }
          g.stroke()
        }
      }
      g.globalCompositeOperation = 'source-over'
    }

    function buildBloom() {
      const bw = bloom.c.width, bh = bloom.c.height, b = bloom.x
      b.clearRect(0, 0, bw, bh)
      b.filter = `blur(${P.bloom.blurPx}px)`
      b.drawImage(lines.c, 0, 0, bw, bh)
      b.filter = 'none'
    }

    function composite() {
      const c = ctx!
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1
      c.drawImage(bg.c, 0, 0)
      c.globalCompositeOperation = 'lighter'
      c.drawImage(lines.c, 0, 0)
      c.globalAlpha = P.bloom.strength
      c.drawImage(bloom.c, 0, 0, W, H)
      c.globalAlpha = 1
      c.globalCompositeOperation = 'source-over'
      if (vigGrad) { c.fillStyle = vigGrad; c.fillRect(0, 0, W, H) }
      if (grainPattern) {
        c.save()
        c.globalCompositeOperation = 'overlay'
        c.globalAlpha = 0.05
        c.translate((Math.random() * 2 - 1) * 8, (Math.random() * 2 - 1) * 8)
        c.fillStyle = grainPattern
        c.fillRect(-16, -16, W + 32, H + 32)
        c.restore()
      }
    }

    function renderFrame() { drawStrands(t); buildBloom(); composite() }

    function resize() {
      const rect = cv!.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return
      DPR = Math.min(2, window.devicePixelRatio || 1)
      W = Math.max(2, Math.round(rect.width * DPR))
      H = Math.max(2, Math.round(rect.height * DPR))
      for (const el of [cv!, bg.c, lines.c]) { el.width = W; el.height = H }
      bloom.c.width = Math.max(2, Math.round(W * P.bloom.scale))
      bloom.c.height = Math.max(2, Math.round(H * P.bloom.scale))
      buildBackground(); buildVignette(); buildGrain()
      if (reduced) renderFrame() // a crisp still image when not animating
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
  }, [preset, yShift])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 w-full h-full"
      style={{ display: 'block' }}
    />
  )
}
