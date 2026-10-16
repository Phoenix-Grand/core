import { useEffect, useRef, useState } from 'react'
import LoginAnimation3D from './LoginAnimation3D'
import { animTuning } from './animTuning'

// WebGL (fragment shader) rendering of the silk membranes - per-pixel gradients
// like Vanta's effects (suggested reference: vanta.halo), so the falloffs are
// perfectly smooth: no columns, no seams, no 8-bit banding (dithered output).
// The model is the same as the canvas fallback (LoginAnimation3D): two large
// translucent films bounded by two luminous wavy edges that cross, plus
// diagonal interior folds. Edges UNDULATE (per-component phase speeds with
// mixed signs + amplitude breathing + slow vertical sway), not just translate.
// Falls back to the Canvas-2D implementation when WebGL is unavailable.

const VERT = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0., 1.); }
`

const FRAG = `
precision highp float;

uniform vec2  uRes;
uniform float uT;
uniform float uShift;
uniform float uSigma; // fold softness
uniform float uGain;  // brightness
uniform float uAmp;   // undulation height
uniform float uTilt;  // vertical spread
uniform float uMod;   // non-uniformity 0..1

const float TAU = 6.2831853;

const vec3 BG_TOP = vec3(  7.,  16.,  45.) / 255.;
const vec3 BG_BOT = vec3(  2.,   5.,  14.) / 255.;
const vec3 FILLC  = vec3( 30., 100., 235.) / 255.;
const vec3 EDGEC  = vec3(140., 195., 255.) / 255.;

// ONE sheet of silk: a single 3D surface y(x, z) (z = depth into the scene),
// whose undulation is NON-UNIFORM - slow spatial modulations make some regions
// of the fabric swell strongly while others stay almost flat. The screen shows
// the projected optical density of the translucent sheet: folds (where the
// surface turns back on itself, dy/dz ~ 0) naturally concentrate light into
// soft luminous creases; no artificial edges or membranes.
// Returns (y, dy/dz): the height AND the local depth-slope of the sheet.
// The slope drives per-layer adaptive smoothing (see main loop).
vec2 surf(float x, float z) {
  float y = 0.58 + uShift + uTilt * (z - 0.5); // tilt: far side higher on screen
  float g = uTilt;
  // Slow, travelling modulation fields -> non-uniform undulation.
  float m1 = 0.5 + 0.5 * sin(1.7 * x + 2.3 * z + 0.10 * uT + 1.0);
  float m2 = 0.5 + 0.5 * sin(2.6 * x - 1.9 * z + 0.13 * uT + 4.0);
  // Three wave trains crossing the sheet in different directions.
  float a1 = 0.145 * uAmp * mix(1.0, 0.25 + 0.75 * m1, uMod);
  float t1 = TAU * (0.62 * x + 0.85 * z) + 0.14 * uT + 0.5;
  y += a1 * sin(t1); g += a1 * cos(t1) * TAU * 0.85;
  float a2 = 0.090 * uAmp * mix(1.0, 0.25 + 0.75 * m2, uMod);
  float t2 = TAU * (1.10 * x - 1.15 * z) - 0.11 * uT + 2.1;
  y += a2 * sin(t2); g -= a2 * cos(t2) * TAU * 1.15;
  float a3 = 0.038 * uAmp;
  float t3 = TAU * (1.75 * x + 1.60 * z) + 0.17 * uT + 3.7;
  y += a3 * sin(t3); g += a3 * cos(t3) * TAU * 1.60;
  return vec2(y, g);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float x = uv.x;
  float y = 1.0 - uv.y; // top-down

  // Background: vertical gradient + faint upper-right halo.
  vec3 col = mix(BG_TOP, BG_BOT, y);
  float hd = distance(vec2(x, y), vec2(0.70, 0.36));
  col += vec3(40., 105., 230.) / 255. * 0.09 * max(0.0, 1.0 - hd / 0.5);

  // Projected density of the translucent sheet: integrate over depth.
  const int N = 80;
  float dens = 0.0;
  float S = 2.0 * uSigma * uSigma;
  // Adaptive smoothing: each depth layer is smeared over its projected spacing
  // (|dy/dz|/N), normalised to keep total mass - steep regions become a
  // continuous film instead of visible stacked bands, folds stay sharp.
  float K = 0.55 / (float(N) * float(N));
  for (int i = 0; i < N; i++) {
    float z = (float(i) + 0.5) / float(N);
    vec2 sg = surf(x, z);
    float dy = y - sg.x;
    float s2 = S + sg.y * sg.y * K;
    dens += exp(-dy * dy / s2) * sqrt(S / s2);
  }
  dens /= float(N);

  // Tone-map: dim translucent body; folds compress into luminous BANDS (soft
  // knee) instead of clipping to thin needle lines.
  float a = dens * uGain;
  float tc = clamp((a - 0.25) / 1.6, 0.0, 1.0);
  col += mix(FILLC, EDGEC, tc) * (1.0 - exp(-a)) * 1.15;

  // Vignette.
  float vd = distance(uv, vec2(0.5));
  col *= 1.0 - 0.45 * smoothstep(0.35, 0.75, vd);

  // Dither: breaks 8-bit banding on the wide dark gradients.
  col += (hash(gl_FragCoord.xy) - 0.5) * (1.5 / 255.);

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`

export default function LoginAnimationGL({ yShift = 0 }: { yShift?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || fallback) return
    const gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
    if (!gl) { setFallback(true); return }

    function compile(type: number, src: string): WebGLShader | null {
      const sh = gl!.createShader(type)
      if (!sh) return null
      gl!.shaderSource(sh, src)
      gl!.compileShader(sh)
      if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
        // eslint-disable-next-line no-console
        console.error('LoginAnimationGL shader:', gl!.getShaderInfoLog(sh))
        return null
      }
      return sh
    }
    const vs = compile(gl.VERTEX_SHADER, VERT)
    const fs = compile(gl.FRAGMENT_SHADER, FRAG)
    const prog = gl.createProgram()
    if (!vs || !fs || !prog) { setFallback(true); return }
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { setFallback(true); return }
    gl.useProgram(prog)

    // Fullscreen quad.
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(prog, 'uRes')
    const uT = gl.getUniformLocation(prog, 'uT')
    const uShift = gl.getUniformLocation(prog, 'uShift')
    const uSigma = gl.getUniformLocation(prog, 'uSigma')
    const uGain = gl.getUniformLocation(prog, 'uGain')
    const uAmp = gl.getUniformLocation(prog, 'uAmp')
    const uTilt = gl.getUniformLocation(prog, 'uTilt')
    const uMod = gl.getUniformLocation(prog, 'uMod')

    let t = 80, last = 0, raf = 0
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

    function render() {
      const p = animTuning.get()
      gl!.uniform1f(uT, t)
      gl!.uniform1f(uShift, p.shift)
      gl!.uniform1f(uSigma, p.sigma)
      gl!.uniform1f(uGain, p.gain)
      gl!.uniform1f(uAmp, p.amp)
      gl!.uniform1f(uTilt, p.tilt)
      gl!.uniform1f(uMod, p.nonUniform)
      gl!.drawArrays(gl!.TRIANGLES, 0, 3)
    }

    function resize() {
      const rect = cv!.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return
      const DPR = Math.min(2, window.devicePixelRatio || 1)
      cv!.width = Math.max(2, Math.round(rect.width * DPR))
      cv!.height = Math.max(2, Math.round(rect.height * DPR))
      gl!.viewport(0, 0, cv!.width, cv!.height)
      gl!.uniform2f(uRes, cv!.width, cv!.height)
      if (reduced) render()
    }

    function frame(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now
      t += dt * animTuning.get().speed
      render()
      raf = requestAnimationFrame(frame)
    }

    const onVisibility = () => { if (!document.hidden) last = performance.now() }
    document.addEventListener('visibilitychange', onVisibility)
    const onLost = (e: Event) => { e.preventDefault(); setFallback(true) }
    cv.addEventListener('webglcontextlost', onLost)

    const ro = new ResizeObserver(() => resize())
    ro.observe(cv)
    resize()

    // Reduced motion: still reflect slider changes on the static frame.
    const unsubTune = animTuning.subscribe(() => { if (reduced) render() })

    if (!reduced) {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }

    return () => {
      cancelAnimationFrame(raf)
      unsubTune()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      cv.removeEventListener('webglcontextlost', onLost)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [yShift, fallback])

  if (fallback) return <LoginAnimation3D yShift={yShift} />
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 w-full h-full"
      style={{ display: 'block' }}
    />
  )
}
