import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'

import { CheckedListBox, ListBox } from './ListBox'
import { ListView } from './ListView'
import { TreeView } from './TreeView'

const items = ['Abricot', 'Banane', 'Cerise', 'Citron'].map((text) => ({ text }))

describe('@ui lists - keyboard and ARIA (jsdom)', () => {
  it('ListBox: arrows select, Enter activates, the active option is announced', () => {
    const onSel = vi.fn()
    const onAct = vi.fn()
    const { getByRole, getAllByRole } = render(<ListBox items={items} aria-label="Fruits" onSelectionChange={onSel} onItemActivate={onAct} />)
    const box = getByRole('listbox')
    fireEvent.focus(box)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(onSel).toHaveBeenLastCalledWith(1, [1])
    fireEvent.keyDown(box, { key: 'End' })
    expect(onSel).toHaveBeenLastCalledWith(3, [3])
    fireEvent.keyDown(box, { key: 'b' })
    expect(onSel).toHaveBeenLastCalledWith(1, [1])
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAct).toHaveBeenCalledWith(items[1], 1)
    const options = getAllByRole('option')
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    expect(box.getAttribute('aria-activedescendant')).toBe(options[1].id)
    expect(options[0].getAttribute('aria-setsize')).toBe('4')
  })

  it('ListBox MultiExtended: Shift extends, the list is multiselectable', () => {
    const onSel = vi.fn()
    const { getByRole } = render(<ListBox items={items} selectionMode="MultiExtended" onSelectionChange={onSel} />)
    const box = getByRole('listbox')
    expect(box.getAttribute('aria-multiselectable')).toBe('true')
    fireEvent.focus(box)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true })
    expect(onSel).toHaveBeenLastCalledWith(1, [1, 2, 3])
  })

  it('CheckedListBox: Space checks, aria-checked follows', () => {
    const onCheck = vi.fn()
    const { getByRole, getAllByRole } = render(<CheckedListBox items={[{ text: 'A', checked: true }, { text: 'B' }]} onItemCheck={onCheck} />)
    const box = getByRole('listbox')
    fireEvent.focus(box)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: ' ' })
    expect(onCheck).toHaveBeenCalledWith(1, true)
    const options = getAllByRole('option')
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['true', 'true'])
  })

  it('TreeView: Right expands, then enters; Left goes back to the parent; levels and positions', () => {
    const onSel = vi.fn()
    const tree = [{ text: 'A', items: [{ text: 'A1' }, { text: 'A2' }] }, { text: 'B' }]
    const { getByRole, getAllByRole } = render(<TreeView items={tree} onSelectionChange={onSel} />)
    const box = getByRole('tree')
    fireEvent.focus(box)
    expect(getAllByRole('treeitem')).toHaveLength(2)
    fireEvent.keyDown(box, { key: 'ArrowRight' })
    const rows = getAllByRole('treeitem')
    expect(rows).toHaveLength(4)
    expect(rows[0].getAttribute('aria-expanded')).toBe('true')
    expect(rows[1].getAttribute('aria-level')).toBe('2')
    expect(rows[2].getAttribute('aria-posinset')).toBe('2')
    fireEvent.keyDown(box, { key: 'ArrowRight' })
    expect(onSel).toHaveBeenLastCalledWith('0.0', ['0.0'])
    fireEvent.keyDown(box, { key: 'ArrowLeft' })
    expect(onSel).toHaveBeenLastCalledWith('0', ['0'])
  })

  it('ListView Details: a grid with column headers and selectable rows', () => {
    const onSel = vi.fn()
    const entries = [{ header: 'Nom' }, { header: 'Ville' }, { text: 'Camille', items: [{ text: 'Paris' }] }, { text: 'Lucas', items: [{ text: 'Lyon' }] }]
    const { getByRole, getAllByRole } = render(<ListView entries={entries} onSelectionChange={onSel} />)
    const grid = getByRole('grid')
    expect(getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Nom', 'Ville'])
    expect(getAllByRole('gridcell').map((c) => c.textContent)).toEqual(['Camille', 'Paris', 'Lucas', 'Lyon'])
    fireEvent.focus(grid)
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(onSel).toHaveBeenLastCalledWith(1, [1])
  })
})
