// Login-animation parameters. Source of truth = the server setting
// `appearance.login_animation` (tuned from the admin console, served publicly):
// the login page seeds this in-memory store from the public config, and the
// admin panel binds its sliders + live preview to it before saving.

export interface AnimParams {
  sigma:      number // fold softness (blur) - kernel sigma, fraction of height
  gain:       number // overall brightness
  amp:        number // undulation height multiplier
  speed:      number // animation speed multiplier
  tilt:       number // vertical spread of the sheet (depth tilt)
  nonUniform: number // 0 = uniform waves, 1 = strongly zone-dependent
  shift:      number // vertical position offset
}

// Values tuned live by the user (2026-07) - mirrored in migration 000031.
export const ANIM_DEFAULTS: AnimParams = {
  sigma: 0.004,
  gain: 4.7,
  amp: 0.75,
  speed: 3.55,
  tilt: 0.08,
  nonUniform: 1.0,
  shift: 0.17,
}

/** Slider definitions shared by the admin tuning panel. */
export const ANIM_SLIDERS: { key: keyof AnimParams; label: string; min: number; max: number; step: number }[] = [
  { key: 'sigma',      label: 'Flou des plis',       min: 0.003, max: 0.03, step: 0.0005 },
  { key: 'gain',       label: 'Luminosité',          min: 1.5,   max: 12,   step: 0.1 },
  { key: 'amp',        label: 'Hauteur ondulations', min: 0.2,   max: 2.2,  step: 0.05 },
  { key: 'nonUniform', label: 'Non-uniformité',      min: 0,     max: 1,    step: 0.05 },
  { key: 'tilt',       label: 'Étendue verticale',   min: 0.08,  max: 0.65, step: 0.01 },
  { key: 'speed',      label: 'Vitesse',             min: 0,     max: 4,    step: 0.05 },
  { key: 'shift',      label: 'Position verticale',  min: -0.15, max: 0.30, step: 0.01 },
]

/** Parse a raw config value (object from JSONB) into AnimParams, with defaults. */
export function parseAnimParams(raw: unknown): AnimParams {
  if (raw && typeof raw === 'object') {
    return { ...ANIM_DEFAULTS, ...(raw as Partial<AnimParams>) }
  }
  return { ...ANIM_DEFAULTS }
}

let current: AnimParams = { ...ANIM_DEFAULTS }
const listeners = new Set<() => void>()

export const animTuning = {
  get(): AnimParams {
    return current
  },
  set(partial: Partial<AnimParams>): void {
    current = { ...current, ...partial }
    listeners.forEach((fn) => fn())
  },
  reset(): void {
    current = { ...ANIM_DEFAULTS }
    listeners.forEach((fn) => fn())
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
