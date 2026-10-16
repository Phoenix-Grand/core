/**
 * Runtime behaviours added for the bulk migration of the core screens (WEB-VIEWS §21): nested object fields (a
 * window's footer), the host's translator for `@ui` elements (`HostStrings`), and hooks returning a new object on
 * every render.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { KbView, createViewBase, registerElements, setTranslator, type ViewPlan } from './index'

afterEach(() => cleanup())

interface Footer { confirm?: { label?: string; disabled?: boolean; onClick?: () => void }; cancel?: { label?: string } }
let lastFooter: Footer | undefined
let renders = 0
function Win(props: { actions?: Footer; t?: (k: string) => string; children?: ReactNode }): ReactNode {
  renders++
  lastFooter = props.actions
  return createElement('div', { 'data-close': props.t ? props.t('ui.close') : 'Close' },
    createElement('button', { onClick: props.actions?.confirm?.onClick, disabled: props.actions?.confirm?.disabled }, props.actions?.confirm?.label),
    props.children)
}
registerElements('bulk-ui', { Win })

const plan: ViewPlan = {
  abi: 1, file: 'test/Bulk.kbview', kind: 'view', names: {}, handlers: ['confirm'],
  root: {
    id: '', el: 'Win', at: [1, 1], m: 'bulk-ui', x: 'Win', content: 'children',
    props: [
      { n: 'ConfirmText', to: { prop: 'actions', field: 'confirm.label' }, kind: 'String', at: [1, 6], v: 'Save' },
      { n: 'ConfirmEnabled', to: { prop: 'actions', field: 'confirm.disabled', convert: 'invert' }, kind: 'Bool', at: [1, 20], b: { path: 'ready', mode: 'OneWay', at: [1, 30] } },
      { n: 'CancelText', to: { prop: 'actions', field: 'cancel.label' }, kind: 'String', at: [1, 40], v: 'No' },
      { n: 'HostStrings', to: { prop: 't', convert: 'host-t' }, kind: 'Bool', at: [1, 50], v: true },
    ],
    events: [{ n: 'OnConfirm', h: 'confirm', from: { prop: 'actions', field: 'confirm.onClick', args: 'none' }, args_type: 'EventArgs', at: [1, 60] }],
  },
}

describe('views runtime - bulk migration additions', () => {
  it('builds nested object props field by field, events included', async () => {
    setTranslator((k) => (k === 'ui.close' ? 'Fermer' : k))
    const Base = createViewBase(plan)
    let confirmed = 0
    class V extends (Base as unknown as new () => Record<string, unknown>) {
      ready = false
      confirm(): void { confirmed++ }
    }
    render(createElement(KbView, { view: V as never }))
    expect(lastFooter).toMatchObject({ confirm: { label: 'Save', disabled: true }, cancel: { label: 'No' } })
    expect(typeof lastFooter?.confirm?.onClick).toBe('function')
    await act(async () => lastFooter?.confirm?.onClick?.())
    expect(confirmed).toBe(1)
    // HostStrings: the host's translator as `t`.
    expect(screen.getByText('Save').parentElement?.getAttribute('data-close')).toBe('Fermer')
    setTranslator(undefined)
  })

  it('passes classes as className to a component whose className lands on its root (no wrapper)', async () => {
    function Boxed(props: { className?: string }): ReactNode {
      return createElement('section', { className: ['boxed', props.className].filter(Boolean).join(' ') })
    }
    ;(Boxed as { kbRootClass?: boolean }).kbRootClass = true
    registerElements('bulk-ui', { Boxed })
    const Base = createViewBase({
      abi: 1, file: 'test/Boxed.kbview', kind: 'view', names: {}, handlers: [],
      root: { id: '', el: 'Boxed', at: [1, 1], m: 'bulk-ui', x: 'Boxed', props: [{ n: 'Class', to: { runtime: 'class' }, kind: 'String', at: [1, 8], v: 'p-5 mt-2' }] },
    })
    const { container } = render(createElement(KbView, { view: Base as never }))
    const first = container.firstElementChild as HTMLElement
    expect(first.tagName).toBe('SECTION')
    expect(first.className).toBe('boxed p-5 mt-2')
  })

  it('hides an element whose Visible binding gives no value (undefined or null)', async () => {
    const { Panel } = await import('./index')
    registerElements('bulk-ui', { Panel })
    const Base = createViewBase({
      abi: 1, file: 'test/Shown.kbview', kind: 'view', names: {}, handlers: [],
      root: {
        id: '', el: 'Panel', at: [1, 1], m: 'bulk-ui', x: 'Panel', content: 'children',
        children: [
          { id: 'a', el: 'Label', at: [2, 1], m: 'bulk-ui', x: 'Boxed', props: [
            { n: 'Visible', to: { runtime: 'visible' }, kind: 'Bool', at: [2, 8], b: { path: 'maybe', mode: 'OneWay', at: [2, 16] } },
            { n: 'Class', to: { runtime: 'class' }, kind: 'String', at: [2, 30], v: 'hidden-one' },
          ] },
          { id: 'b', el: 'Label', at: [3, 1], m: 'bulk-ui', x: 'Boxed', props: [
            { n: 'Visible', to: { runtime: 'visible' }, kind: 'Bool', at: [3, 8], b: { path: 'yes', mode: 'OneWay', at: [3, 16] } },
            { n: 'Class', to: { runtime: 'class' }, kind: 'String', at: [3, 30], v: 'shown-one' },
          ] },
        ],
      },
    } as ViewPlan)
    class V extends (Base as unknown as new () => Record<string, unknown>) {
      maybe: boolean | undefined = undefined
      yes = true
    }
    const { container } = render(createElement(KbView, { view: V as never }))
    expect(container.querySelector('.hidden-one')).toBeNull()
    expect(container.querySelector('.shown-one')).not.toBeNull()
  })

  it('renders a Fragment through a ReactHost, and nothing for designer sample texts', async () => {
    const { ReactHost } = await import('./index')
    const { Fragment } = await import('react')
    const { container, rerender } = render(createElement(ReactHost, { component: Fragment as never, props: { children: 'held' } }))
    expect(container.textContent).toBe('held')
    rerender(createElement(ReactHost, { component: 'part2 1' as never, props: 'part2_props 1' as never }))
    expect(container.textContent).toBe('')
  })

  it('does not render the view again and again when a hook gives a new object on every render', async () => {
    const Base = createViewBase({ ...plan, file: 'test/Loop.kbview' })
    class V extends (Base as unknown as new () => Record<string, unknown> & { publish(v: Record<string, unknown>): void }) {
      ready = true
      stepper?: { next: () => void }
      confirm(): void {}
      use(): void {
        // A hook result with a new function every time (`useStepper`): published, then read by the elements.
        this.publish({ stepper: { next: () => {} } })
      }
    }
    renders = 0
    await act(async () => { render(createElement(KbView, { view: V as never })) })
    expect(renders).toBeLessThan(5)
  })
})

describe('DataAttributes', () => {
  it('reads names and name=value entries, and ignores what is no attribute name', async () => {
    const { dataAttributesOf } = await import('./layout')
    expect(dataAttributesOf('app-chrome; module=drive ;data-x=1; Bad Name; ')).toEqual({ 'data-app-chrome': '', 'data-module': 'drive', 'data-x': '1' })
  })
})

describe('memos and the language', () => {
  it('computes memoized values again after a language change', async () => {
    const { invalidateResources } = await import('./index')
    let lang = 'en'
    const Base = createViewBase({
      abi: 1, file: 'test/Memo.kbview', kind: 'view', names: {}, handlers: [],
      root: { id: '', el: 'Boxed', at: [1, 1], m: 'bulk-ui', x: 'Boxed', props: [{ n: 'Class', to: { runtime: 'class' }, kind: 'String', at: [1, 8], b: { path: 'label', mode: 'OneWay', at: [1, 16] } }] },
    })
    class V extends (Base as unknown as new () => Record<string, unknown> & { memo<T>(k: string, d: unknown[], f: () => T): T }) {
      get label(): string { return this.memo('label', [], () => `label-${lang}`) }
    }
    const { container } = render(createElement(KbView, { view: V as never }))
    expect(container.querySelector('.label-en')).not.toBeNull()
    lang = 'fr'
    await act(async () => invalidateResources())
    expect(container.querySelector('.label-fr')).not.toBeNull()
  })
})

describe('display: contents wrappers', () => {
  it("gives the wrapped element the margin its parent's child selectors give the wrapper (space-y-*)", async () => {
    const style = document.createElement('style')
    style.textContent = '.stacked > :not(:last-child) { margin-bottom: 8px; }'
    document.head.appendChild(style)
    try {
      function Column(props: { children?: ReactNode }): ReactNode {
        return createElement('div', { className: 'stacked' }, props.children)
      }
      // A control whose root is a wrapper of its own (`TextField`: a div around the input) and takes no ref.
      function Field(): ReactNode {
        return createElement('div', { className: 'field' }, createElement('input'))
      }
      registerElements('bulk-ui', { Column, Field })
      const Base = createViewBase({
        abi: 1, file: 'test/Wrapped.kbview', kind: 'view', names: {}, handlers: ['keyed'],
        root: {
          id: '', el: 'Column', at: [1, 1], m: 'bulk-ui', x: 'Column', content: 'children',
          children: [
            // A DOM event: the runtime needs the element's DOM root, hence the wrapper.
            { id: '0', el: 'TextField', at: [2, 1], m: 'bulk-ui', x: 'Field', events: [{ n: 'OnKeyDown', h: 'keyed', from: { dom: 'keydown', args: 'key' }, args_type: 'KeyEventArgs', at: [2, 20] }] },
            { id: '1', el: 'TextField', at: [3, 1], m: 'bulk-ui', x: 'Field' },
          ],
        },
      } as ViewPlan)
      class V extends (Base as unknown as new () => Record<string, unknown>) { keyed(): void {} }
      const { container } = render(createElement(KbView, { view: V as never }))
      const wrapper = container.querySelector('.stacked')!.firstElementChild as HTMLElement
      expect(wrapper.style.display).toBe('contents')
      expect((wrapper.firstElementChild as HTMLElement).style.marginBottom).toBe('8px')
      // The last child gets nothing (the selector does not match it), as without the wrapper.
      expect((container.querySelector('.stacked')!.lastElementChild as HTMLElement).style.marginBottom).toBe('')
    } finally {
      style.remove()
    }
  })
})
