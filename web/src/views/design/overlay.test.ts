import { afterEach, describe, expect, it } from 'vitest'

import { rect, type Rect } from './geometry'
import { drawAdorners, type AdornerSpec } from './overlay'

const origin = { left: 0, top: 0 }

function layer(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const empty: AdornerSpec = { outlines: [], hover: null, parent: null, selected: [] }

afterEach(() => {
  document.body.replaceChildren()
})

describe('drawAdorners', () => {
  it('tags each outline with the parity of its nesting depth so neighbours differ', () => {
    const l = layer()
    drawAdorners(l, origin, {
      ...empty,
      outlines: [
        { rect: rect(0, 0, 100, 100), depth: 1 },
        { rect: rect(10, 10, 90, 90), depth: 2 },
      ],
    })
    const outs = l.querySelectorAll<HTMLElement>('.kbd-outline')
    expect(outs).toHaveLength(2)
    expect(outs[0].dataset.depth).toBe('1')
    expect(outs[1].dataset.depth).toBe('0')
  })

  it('draws a name tag with the type and x:Name on hover', () => {
    const l = layer()
    drawAdorners(l, origin, { ...empty, hover: { rect: rect(20, 40, 120, 80), label: { type: 'TextField', name: 'email' } } })
    const tag = l.querySelector<HTMLElement>('.kbd-tag.kbd-tag-hover')
    expect(tag).not.toBeNull()
    expect(tag?.textContent).toContain('TextField')
    expect(tag?.querySelector('.kbd-tag-name')?.textContent).toBe('email')
    // 40px from the top leaves room: the tag hangs above the frame.
    expect(tag?.dataset.above).toBe('true')
  })

  it('shows only the type when a control has no x:Name, and drops the tag inside near the top edge', () => {
    const l = layer()
    drawAdorners(l, origin, { ...empty, hover: { rect: rect(0, 2, 100, 30), label: { type: 'Panel' } } })
    const tag = l.querySelector<HTMLElement>('.kbd-tag')
    expect(tag?.textContent).toBe('Panel')
    expect(tag?.querySelector('.kbd-tag-name')).toBeNull()
    // The selection frame sits 3px out, but a raw 2px top would be clipped: the tag stays inside.
    expect(tag?.dataset.above).toBeUndefined()
  })

  it('tags each selected element, marking the primary one', () => {
    const l = layer()
    const sel = (b: Rect, primary: boolean, type: string): AdornerSpec['selected'][number] => ({
      bounds: b,
      primary,
      resizable: new Set(),
      label: { type },
    })
    drawAdorners(l, origin, {
      ...empty,
      selected: [sel(rect(50, 50, 150, 100), true, 'Button'), sel(rect(200, 50, 260, 90), false, 'Label')],
    })
    const tags = l.querySelectorAll<HTMLElement>('.kbd-tag-sel')
    expect(tags).toHaveLength(2)
    expect(l.querySelectorAll('.kbd-tag-primary')).toHaveLength(1)
    expect(tags[0].textContent).toContain('Button')
  })

  it('labels the primary selection parent frame', () => {
    const l = layer()
    drawAdorners(l, origin, { ...empty, parent: { rect: rect(0, 0, 300, 300), label: { type: 'Panel', name: 'form' } } })
    const tag = l.querySelector<HTMLElement>('.kbd-tag-parent')
    expect(tag?.textContent).toContain('Panel')
    expect(tag?.querySelector('.kbd-tag-name')?.textContent).toBe('form')
  })

  it('draws no tag when a rect carries no label', () => {
    const l = layer()
    drawAdorners(l, origin, { ...empty, hover: { rect: rect(20, 40, 120, 80) } })
    expect(l.querySelector('.kbd-hover')).not.toBeNull()
    expect(l.querySelector('.kbd-tag')).toBeNull()
  })
})
