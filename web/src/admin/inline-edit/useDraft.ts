import { useCallback, useState } from 'react'

/**
 * The working copy of one card's fields while it is being edited.
 *
 * Two things it exists for, and both are correctness rather than convenience:
 *
 * - **Cancel restores.** The draft is a copy; the record on screen is never
 *   mutated, so abandoning an edit is simply throwing the copy away.
 * - **Save sends only what moved.** `changed` is the subset of fields that
 *   actually differ from the record. A `PATCH` that echoes an unchanged value
 *   back is not harmless here: `core.users.update` writes an audit entry with a
 *   before/after snapshot, and the trail would then announce a modification that
 *   never happened.
 *
 * Values are compared with `Object.is` after a `JSON` round trip for arrays and
 * objects, which covers everything a form field produces (strings, numbers,
 * booleans, null, and the string arrays a privilege picker builds).
 */

/** Structural equality, deliberately shallow-ish: enough for form values. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    return ka.length === kb.length
      && ka.every(k => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return false
}

export interface Draft<T extends Record<string, unknown>> {
  /** What the fields currently show. */
  value: T
  /** Sets one field. */
  set: <K extends keyof T>(key: K, next: T[K]) => void
  /** Back to the record — what Cancel does, and what entering edit mode does. */
  reset: (to?: T) => void
  /** Only the fields that differ from the record. Empty when nothing moved. */
  changed: Partial<T>
  /** `changed` is not empty. */
  dirty: boolean
}

/**
 * @param initial the values held by the record — recomputed on every render from
 *        the query data, so a refetch that changes the record also changes what
 *        "unchanged" means.
 */
export function useDraft<T extends Record<string, unknown>>(initial: T): Draft<T> {
  const [value, setValue] = useState<T>(initial)

  const set = useCallback(<K extends keyof T>(key: K, next: T[K]) => {
    setValue(prev => ({ ...prev, [key]: next }))
  }, [])

  // `initial` is a fresh object literal on every render; capturing it in the
  // callback rather than memoising keeps `reset()` honest without a dependency
  // that changes identity constantly.
  const reset = (to?: T) => setValue(to ?? initial)

  const changed: Partial<T> = {}
  for (const key of Object.keys(initial) as (keyof T)[]) {
    if (!same(initial[key], value[key])) changed[key] = value[key]
  }

  return { value, set, reset, changed, dirty: Object.keys(changed).length > 0 }
}
