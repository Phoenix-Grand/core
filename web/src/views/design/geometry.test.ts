import { afterEach, describe, expect, it } from 'vitest'

import {
  buildLayoutMap,
  domMeasures,
  handleAt,
  hitTest,
  isAncestorOrSelf,
  makeLayoutMap,
  ordinalOf,
  parentIdOf,
  rect,
  resizeRect,
  selectionFrame,
  topLevelIds,
  type LayoutEntry,
  type Rect,
} from './geometry'

const entry = (id: string, r: Rect, order: number, clip: Rect | null = null): LayoutEntry => ({
  id, parentId: parentIdOf(id), bounds: r, clip, order, rtl: false, bare: false,
})

describe('element ids', () => {
  it('walk up the dot path, the root being ""', () => {
    expect(parentIdOf('0.1.2')).toBe('0.1')
    expect(parentIdOf('3')).toBe('')
    expect(parentIdOf('')).toBeNull()
    expect(ordinalOf('0.12')).toBe(12)
    expect(isAncestorOrSelf('0', '0.1')).toBe(true)
    expect(isAncestorOrSelf('0', '01.1')).toBe(false)
    expect(isAncestorOrSelf('', '4.2')).toBe(true)
  })

  it('keep only the top-level ids of a group (never the root)', () => {
    expect(topLevelIds(['0.1', '0', '1', '', '1.0.2'])).toEqual(['0', '1'])
  })
})

describe('hit-testing', () => {
  const map = makeLayoutMap([
    entry('', rect(0, 0, 400, 300), 0),
    entry('0', rect(10, 10, 200, 200), 1),
    entry('0.0', rect(20, 20, 100, 60), 2),
    entry('0.1', rect(20, 70, 100, 110), 3),
    entry('1', rect(150, 150, 300, 250), 4), // overlaps "0" (painted later)
    entry('2', rect(50, 50, 50, 90), 5), // zero width: skipped
  ])

  it('returns the deepest element under the point', () => {
    expect(hitTest(map, 30, 30)?.id).toBe('0.0')
    expect(hitTest(map, 30, 80)?.id).toBe('0.1')
    expect(hitTest(map, 15, 150)?.id).toBe('0')
    expect(hitTest(map, 390, 290)?.id).toBe('')
    expect(hitTest(map, 500, 10)).toBeNull()
  })

  it('lets the later-painted sibling win where siblings overlap', () => {
    expect(hitTest(map, 170, 170)?.id).toBe('1')
  })

  it('skips degenerate entries and the ids it is told to', () => {
    expect(hitTest(map, 50, 55)?.id).toBe('0.0')
    expect(hitTest(map, 30, 30, (id) => id.startsWith('0.'))?.id).toBe('0')
  })

  it('never hits the part of an element its clipping ancestor hides (a scrolled list)', () => {
    const scrolled = makeLayoutMap([
      entry('', rect(0, 0, 200, 100), 0),
      entry('0', rect(0, 0, 200, 100), 1),
      entry('0.0', rect(0, -50, 200, 20), 2, rect(0, 0, 200, 100)),
      entry('0.1', rect(0, 80, 200, 160), 3, rect(0, 0, 200, 100)),
    ])
    expect(hitTest(scrolled, 10, 90)?.id).toBe('0.1')
    expect(hitTest(scrolled, 10, 150)).toBeNull() // below the viewport of the scroll area
  })
})

describe('the layout map built from [data-kb-id]', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const place = (el: Element, r: Rect): void => {
    ;(el as HTMLElement).getBoundingClientRect = () => ({
      left: r.left, top: r.top, right: r.right, bottom: r.bottom, x: r.left, y: r.top,
      width: r.right - r.left, height: r.bottom - r.top, toJSON: () => ({}),
    })
  }

  it('records every element in document order with its parent, clip and direction - portals included', () => {
    document.body.innerHTML = `
      <div id="frame" style="overflow: hidden">
        <div data-kb-id="">
          <div data-kb-id="0" style="overflow: auto; direction: rtl">
            <div style="display: contents"><span data-kb-id="0.0">a</span></div>
            <span data-kb-id="0.1">b</span>
          </div>
        </div>
      </div>
      <div id="portal"><div data-kb-id="0.2" style="background-color: rgb(255, 255, 255)">menu</div></div>`
    const q = (s: string): Element => document.querySelector(s)!
    place(q('#frame'), rect(0, 0, 300, 200))
    place(q('[data-kb-id=""]'), rect(0, 0, 300, 200))
    place(q('[data-kb-id="0"]'), rect(10, 10, 210, 110))
    place(q('[data-kb-id="0.0"]'), rect(10, 10, 210, 40))
    place(q('[data-kb-id="0.1"]'), rect(10, 90, 210, 140)) // overflows its scroll area
    place(q('[data-kb-id="0.2"]'), rect(50, 50, 150, 150)) // a <body> portal, over the view
    const map = buildLayoutMap(document, domMeasures(window), (id) => id === '0' || id === '0.2')
    expect(map.entries.map((e) => e.id)).toEqual(['', '0', '0.0', '0.1', '0.2'])
    expect(map.byId.get('0.1')![0]).toMatchObject({ parentId: '0', clip: rect(10, 10, 210, 110) })
    expect(map.byId.get('0')![0]).toMatchObject({ parentId: '', clip: rect(0, 0, 300, 200), rtl: true, bare: true })
    expect(map.byId.get('0.2')![0]).toMatchObject({ clip: null, bare: false })
    // The portal is painted last: it wins over the view under it.
    expect(hitTest(map, 60, 60)?.id).toBe('0.2')
    expect(hitTest(map, 20, 100)?.id).toBe('0.1')
    expect(hitTest(map, 20, 130)?.id).toBe('') // the clipped part of 0.1 is not hit
  })
})

describe('adorner geometry', () => {
  it('frames 3 px outside, finds its handles, resizes from them', () => {
    const b = rect(100, 100, 200, 150)
    const f = selectionFrame(b)
    expect(f).toEqual(rect(97, 97, 203, 153))
    expect(handleAt(f, 203, 153)).toBe('se')
    expect(handleAt(f, 150, 97)).toBe('n')
    expect(handleAt(f, 150, 125)).toBeNull()
    expect(resizeRect(b, 'se', 20, 10)).toEqual(rect(100, 100, 220, 160))
    expect(resizeRect(b, 'nw', -10, -5)).toEqual(rect(90, 95, 200, 150))
    // Never below the minimum size, the opposite edge never moves.
    expect(resizeRect(b, 'w', 500, 0)).toEqual(rect(192, 100, 200, 150))
  })
})
