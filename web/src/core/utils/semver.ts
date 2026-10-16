/**
 * Minimal SemVer comparison - no dependency, because the only question we ever
 * ask is "is the catalogue ahead of what is installed?".
 *
 * Comparing versions as plain strings made the Marketplace offer 0.1.8 to an
 * instance already running 0.1.10, because "0.1.10" !== "0.1.8" and the button
 * only checked for a difference. Any comparison that is not numeric, segment by
 * segment, invites an administrator to downgrade.
 */

/** Numeric release segments; anything after `-` or `+` is stripped. */
function segments(version: string): number[] {
  return version
    .trim()
    .replace(/^v/, '')
    .split(/[-+]/, 1)[0]
    .split('.')
    .map((s) => Number.parseInt(s, 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
}

/** `-1`, `0` or `1`, comparing release segments numerically. */
export function compareVersions(a: string, b: string): number {
  const left = segments(a)
  const right = segments(b)
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i++) {
    const d = (left[i] ?? 0) - (right[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  // A pre-release is older than the release of the same number (0.2.0-rc1 < 0.2.0).
  const preA = /[-]/.test(a)
  const preB = /[-]/.test(b)
  if (preA !== preB) return preA ? -1 : 1
  return 0
}

/** True only when `candidate` is strictly newer than `installed`. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  return compareVersions(candidate, installed) > 0
}
