import { describe, expect, it } from 'vitest'

import { flattenTree, initiallyExpanded, itemText, itemValue, moveIndex, select, treeArrow, typeAhead, visibleRange, scrollToShow } from './listCore'

describe('listCore - keyboard moves', () => {
  it('moves one row, a page, to the ends, and clamps', () => {
    expect(moveIndex('ArrowDown', 2, 10, 4)).toBe(3)
    expect(moveIndex('ArrowUp', 0, 10, 4)).toBe(0)
    expect(moveIndex('ArrowDown', 9, 10, 4)).toBe(9)
    expect(moveIndex('PageDown', 2, 10, 4)).toBe(6)
    expect(moveIndex('PageUp', 2, 10, 4)).toBe(0)
    expect(moveIndex('Home', 5, 10, 4)).toBe(0)
    expect(moveIndex('End', 5, 10, 4)).toBe(9)
    expect(moveIndex('ArrowDown', -1, 10, 4)).toBe(0)
    expect(moveIndex('a', 1, 10, 4)).toBeNull()
    expect(moveIndex('ArrowDown', 0, 0, 4)).toBeNull()
  })

  it('moves by columns on tiles, mirrored in RTL', () => {
    expect(moveIndex('ArrowDown', 1, 9, 2, 3)).toBe(4)
    expect(moveIndex('ArrowRight', 1, 9, 2, 3)).toBe(2)
    expect(moveIndex('ArrowRight', 1, 9, 2, 3, true)).toBe(0)
    expect(moveIndex('ArrowLeft', 1, 9, 2, 1)).toBeNull()
  })

  it('type-ahead finds the next match, folds accents, cycles on a repeated letter', () => {
    const labels = ['Abricot', 'Banane', 'Cerise', 'Citron', 'Échalote', 'Écorce']
    expect(typeAhead('c', labels, 0)).toBe(2)
    expect(typeAhead('c', labels, 2)).toBe(3)
    expect(typeAhead('ci', labels, 2)).toBe(3)
    expect(typeAhead('e', labels, 0)).toBe(4)
    expect(typeAhead('ee', labels, 4)).toBe(5)
    expect(typeAhead('z', labels, 0)).toBe(-1)
  })
})

describe('listCore - selection modes', () => {
  const none = { selected: new Set<number>(), anchor: -1 }
  it('One replaces, None ignores', () => {
    expect([...select('One', none, 3).selected]).toEqual([3])
    expect(select('None', none, 3)).toBe(none)
  })
  it('MultiSimple toggles on every choice', () => {
    const a = select('MultiSimple', none, 1)
    const b = select('MultiSimple', a, 4)
    expect([...b.selected].sort()).toEqual([1, 4])
    expect([...select('MultiSimple', b, 1).selected]).toEqual([4])
  })
  it('MultiExtended: plain replaces, Ctrl toggles, Shift extends from the anchor', () => {
    const a = select('MultiExtended', none, 2)
    const b = select('MultiExtended', a, 5, { range: true })
    expect([...b.selected].sort()).toEqual([2, 3, 4, 5])
    const c = select('MultiExtended', b, 7, { toggle: true })
    expect(c.selected.has(7) && c.selected.has(2)).toBe(true)
    expect([...select('MultiExtended', c, 1).selected]).toEqual([1])
  })
})

describe('listCore - virtualisation', () => {
  it('renders the viewport plus the overscan only', () => {
    expect(visibleRange(0, 320, 32, 10_000, 6)).toEqual({ start: 0, end: 16 })
    expect(visibleRange(3200, 320, 32, 10_000, 6)).toEqual({ start: 94, end: 116 })
    expect(visibleRange(0, 320, 32, 5, 6)).toEqual({ start: 0, end: 5 })
  })
  it('scrolls a row into view only when it is outside', () => {
    expect(scrollToShow(0, 64, 320, 32)).toBe(0)
    expect(scrollToShow(20, 0, 320, 32)).toBe(352)
    expect(scrollToShow(5, 0, 320, 32)).toBe(0)
  })
})

describe('listCore - trees', () => {
  const roots = [
    { text: 'A', expanded: true, items: [{ text: 'A1' }, { text: 'A2', items: [{ text: 'A2a' }] }] },
    { Text: 'B', Items: [{ Text: 'B1' }] },
  ]
  it('flattens the open items depth first, with levels and positions', () => {
    const rows = flattenTree(roots, initiallyExpanded(roots))
    expect(rows.map((r) => `${r.path}:${r.level}:${r.posInSet}/${r.setSize}`)).toEqual(['0:1:1/2', '0.0:2:1/2', '0.1:2:2/2', '1:1:2/2'])
    expect(rows[2].hasChildren && !rows[2].expanded).toBe(true)
    expect(itemText(rows[3].item)).toBe('B')
  })
  it('Right expands then enters, Left collapses then goes up (mirrored in RTL)', () => {
    const open = initiallyExpanded(roots)
    const rows = flattenTree(roots, open)
    expect(treeArrow('ArrowRight', rows, 3)).toEqual({ focus: 3, expand: '1' })
    expect(treeArrow('ArrowRight', rows, 0)).toEqual({ focus: 1 })
    expect(treeArrow('ArrowLeft', rows, 1)).toEqual({ focus: 0 })
    expect(treeArrow('ArrowLeft', rows, 0)).toEqual({ focus: 0, collapse: '0' })
    expect(treeArrow('ArrowLeft', rows, 3, true)).toEqual({ focus: 3, expand: '1' })
  })
  it('reads bound rows in either case', () => {
    expect(itemValue({ Value: 'v', Text: 't' })).toBe('v')
    expect(itemValue({ label: 'x' })).toBe('x')
    expect(itemText(7)).toBe('7')
  })
})
