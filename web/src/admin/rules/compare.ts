// A faithful browser-side copy of `rules::condition`'s comparison semantics.
//
// ── Why it is duplicated at all ──────────────────────────────────────────────
// "Test the condition" must light up EVERY node — including the ones a matching
// parent short-circuits away — and answer while the operator is typing. A round
// trip per keystroke is not that.
//
// ── What it must keep in step with ───────────────────────────────────────────
// String comparisons are case-insensitive; a number written as a string still
// compares numerically; an absent field satisfies nothing but `not_exists`; a
// nonsensical comparison answers false rather than throwing. Diverge on any of
// those and the tester becomes a liar, which is worse than having no tester.

import type { Operator } from './types'

export type Json = unknown

/** Walks a dotted path. `null` counts as absent, exactly like the server. */
export function lookup(facts: Json, path: string): Json | undefined {
  let cursor: Json = facts
  for (const segment of path.split('.')) {
    if (segment === '') return undefined
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, Json>)[segment]
    if (cursor === undefined) return undefined
  }
  return cursor === null ? undefined : cursor
}

/** Numeric reading, accepting the decimal notation of a number given as text. */
function num(value: Json): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function equals(actual: Json, expected: Json): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toLowerCase() === expected.toLowerCase()
  }
  // A number compared against its own decimal notation as a string is the single
  // most common way to write a rule that silently never fires — so it matches.
  const mixed = (typeof actual === 'number' && typeof expected === 'string')
    || (typeof actual === 'string' && typeof expected === 'number')
  if (typeof actual === 'number' && typeof expected === 'number') return actual === expected
  if (mixed) {
    const a = num(actual)
    const b = num(expected)
    return a !== undefined && b !== undefined && a === b
  }
  if (typeof actual !== typeof expected) return false
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function textPair(actual: Json, expected: Json): [string, string] | undefined {
  if (typeof actual !== 'string' || typeof expected !== 'string') return undefined
  return [actual.toLowerCase(), expected.toLowerCase()]
}

function memberOf(actual: Json, expected: Json): boolean {
  return Array.isArray(expected) && expected.some(item => equals(actual, item))
}

/** One comparison, with the server's exact semantics. */
export function compare(actual: Json | undefined, op: Operator, expected: Json): boolean {
  // Presence operators answer before anything is read.
  if (op === 'exists')     return actual !== undefined
  if (op === 'not_exists') return actual === undefined
  // An absent field satisfies nothing else: `not_exists` is the only way to
  // assert absence, which keeps "missing" from silently meaning "differs".
  if (actual === undefined) return false

  switch (op) {
    case 'is_true':  return actual === true
    case 'is_false': return actual === false
    case 'eq':       return equals(actual, expected)
    case 'ne':       return !equals(actual, expected)
    case 'lt': case 'lte': case 'gt': case 'gte': {
      const a = num(actual)
      const b = num(expected)
      let cmp: number | undefined
      if (a !== undefined && b !== undefined) {
        cmp = a < b ? -1 : a > b ? 1 : 0
      } else if (typeof actual === 'string' && typeof expected === 'string') {
        const la = actual.toLowerCase()
        const lb = expected.toLowerCase()
        cmp = la < lb ? -1 : la > lb ? 1 : 0
      }
      if (cmp === undefined) return false
      if (op === 'lt')  return cmp < 0
      if (op === 'lte') return cmp <= 0
      if (op === 'gt')  return cmp > 0
      return cmp >= 0
    }
    case 'contains': {
      const pair = textPair(actual, expected)
      return pair ? pair[0].includes(pair[1]) : false
    }
    case 'not_contains': {
      const pair = textPair(actual, expected)
      // A non-textual pair cannot be said to "not contain" anything either.
      return pair ? !pair[0].includes(pair[1]) : false
    }
    case 'starts_with': {
      const pair = textPair(actual, expected)
      return pair ? pair[0].startsWith(pair[1]) : false
    }
    case 'ends_with': {
      const pair = textPair(actual, expected)
      return pair ? pair[0].endsWith(pair[1]) : false
    }
    case 'in':     return memberOf(actual, expected)
    // `not_in` against a non-list is meaningless; refusing to match is safer
    // than the alternative, which would fire on everything.
    case 'not_in': return Array.isArray(expected) ? !memberOf(actual, expected) : false
    default:       return false
  }
}
