/* Easing curves for animations driven by hand (canvas, imperative loops) rather than by
 * a CSS transition. Sampling the very curve the stylesheets declare keeps a scripted
 * animation in step with a CSS one playing next to it. */

/* Samples a CSS `cubic-bezier(x1, y1, x2, y2)`. The end points are fixed at (0,0) and
 * (1,1), as in CSS, so only the two control points are given. Returns the progress
 * function: time fraction in, distance fraction out. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  // Polynomial coefficients of the curve, per axis.
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by

  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u
  const slopeX  = (u: number) => (3 * ax * u + 2 * bx) * u + cx

  const EPSILON = 1e-6

  /* The curve is parametric: `t` is a position along the X (time) axis, not the curve
   * parameter, so the parameter has to be solved for first. Newton-Raphson converges in
   * a few steps; bisection takes over where the curve is flat and the derivative gives
   * no usable direction. */
  const solve = (t: number) => {
    let u = t
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(u) - t
      if (Math.abs(dx) < EPSILON) return u
      const slope = slopeX(u)
      if (Math.abs(slope) < EPSILON) break
      u -= dx / slope
    }
    let lo = 0, hi = 1
    u = t
    for (let i = 0; i < 32 && hi - lo > EPSILON; i++) {
      const dx = sampleX(u) - t
      if (Math.abs(dx) < EPSILON) break
      if (dx > 0) hi = u
      else lo = u
      u = (lo + hi) / 2
    }
    return u
  }

  return (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : sampleY(solve(t)))
}

/* The standard curve of the design system - `cubic-bezier(0.4, 0, 0.2, 1)` in the
 * stylesheets. It leaves at once and settles gently: a control responds on the very
 * first frame after a click, which a symmetric ease-in-out does not. */
export const easeStandard = cubicBezier(0.4, 0, 0.2, 1)
