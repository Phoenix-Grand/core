// The rules a module's declarative schema imposes on the admin panel, tested
// where they live: without them, a bad value reaches the API and a knob gated
// behind a switched-off feature stays on screen.
import { describe, expect, it } from 'vitest'
import {
  countEntries, isVisible, outOfRange, sameValue, type SettingItem,
} from './moduleSettingSchema'

function item(over: Partial<SettingItem> = {}): SettingItem {
  return {
    key: 'k', scope: 'global', type: 'int', values: null,
    label: null, description: null, category: 'Général',
    default: 0, global: null, user: null, effective: 0,
    editable_by_user: false,
    ...over,
  }
}

describe('outOfRange', () => {
  const bounded = item({ type: 'int', min: 1, max: 65535 })

  it('accepts a value inside the declared bounds, as number or as string', () => {
    expect(outOfRange(bounded, 25)).toBe(false)
    expect(outOfRange(bounded, '25')).toBe(false)
  })

  it('refuses what falls outside them', () => {
    expect(outOfRange(bounded, 0)).toBe(true)
    expect(outOfRange(bounded, 70000)).toBe(true)
  })

  // An int setting saved as "" or "abc" would land in the database as a string.
  it('refuses an empty or non-integer field', () => {
    expect(outOfRange(bounded, '')).toBe(true)
    expect(outOfRange(bounded, null)).toBe(true)
    expect(outOfRange(bounded, 'abc')).toBe(true)
    expect(outOfRange(bounded, 2.5)).toBe(true)
  })

  it('leaves unbounded ints and other types alone', () => {
    expect(outOfRange(item({ type: 'int' }), 999999)).toBe(false)
    expect(outOfRange(item({ type: 'string' }), 'anything')).toBe(false)
    expect(outOfRange(item({ type: 'bool' }), false)).toBe(false)
  })
})

describe('isVisible', () => {
  const gate = item({ key: 'greylisting_enabled', type: 'bool' })
  const child = item({ key: 'greylist_delay_secs', depends_on: 'greylisting_enabled' })
  const known = (k: string) => k === gate.key

  it('hides a setting whose gate is off and shows it back when it opens', () => {
    expect(isVisible(child, () => false, known)).toBe(false)
    expect(isVisible(child, () => true, known)).toBe(true)
  })

  it('shows anything that declares no dependency', () => {
    expect(isVisible(gate, () => false, known)).toBe(true)
  })

  // Never hide a row for a reason the reader cannot check: the gate may be a
  // `global` setting this account is not allowed to see.
  it('ignores a dependency on a setting absent from the list', () => {
    const orphan = item({ key: 'x', depends_on: 'not_here' })
    expect(isVisible(orphan, () => false, known)).toBe(true)
  })
})

describe('countEntries', () => {
  it('counts non-empty lines only', () => {
    expect(countEntries('a.test\n\n b.test \n')).toBe(2)
    expect(countEntries('')).toBe(0)
    expect(countEntries(null)).toBe(0)
  })
})

describe('sameValue', () => {
  it('compares across the JSON round trip', () => {
    expect(sameValue(25, '25')).toBe(true)
    expect(sameValue(null, undefined)).toBe(true)
    expect(sameValue(25, 26)).toBe(false)
  })
})
