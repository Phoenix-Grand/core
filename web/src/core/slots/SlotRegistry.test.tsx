/**
 * The shell's `app-dialogs` slot as a `.kbview` screen renders it (core `0b661a0`): a `ReactHost` hosting `<Slot>`
 * with memoised props. A module registers its dialogs when its bundle loads - after the shell's first render - and
 * they must appear (WEB-VIEWS §22.4, defect 1).
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KbView, ReactHost, createViewBase, type ViewPlan } from '@kubuno/views'
import { useModulesStore } from '../store/modulesStore'
import { Slot, SlotRegistry } from './SlotRegistry'

afterEach(() => cleanup())

function Box(props: { children?: ReactNode }): ReactNode {
  return createElement('div', { 'data-testid': 'shell' }, props.children)
}

// The plan the compiler emits for `<Panel><ReactHost Component="{Binding Slot}" Props="{Binding slot_props}"/></Panel>`.
const plan = (file: string): ViewPlan => ({
  abi: 1, file, kind: 'view', names: {}, handlers: [],
  root: {
    id: '', el: 'Panel', at: [1, 1], c: Box as never, content: 'children',
    children: [{
      id: '0', el: 'ReactHost', at: [2, 3], m: '@kubuno/views', x: 'ReactHost', c: ReactHost as never, dom: 'wrapper',
      props: [
        { n: 'Component', to: { prop: 'component' }, kind: 'String', at: [2, 13], b: { path: 'Slot', mode: 'OneWay', at: [2, 24] } },
        { n: 'Props', to: { prop: 'props' }, kind: 'String', at: [2, 40], b: { path: 'slot_props', mode: 'OneWay', at: [2, 47] } },
      ],
    }],
  },
} as unknown as ViewPlan)

type Memo = { memo<T>(k: string, d: unknown[], f: () => T): T }

describe('app-dialogs slot in a converted screen', () => {
  beforeEach(() => {
    SlotRegistry.unregisterModule('drive')
    useModulesStore.setState({ activeModules: [{ module_id: 'drive' }] as never })
  })

  it('renders a dialog a module registers after the first render', async () => {
    const Base = createViewBase(plan('test/ShellSlot.kbview'))
    class Shell extends (Base as unknown as new () => Memo) {
      get Slot() { return Slot }
      get slot_props() { return this.memo('slot_props', [], () => ({ name: 'app-dialogs' })) }
    }
    render(createElement(KbView, { view: Shell as never }))
    expect(screen.getByTestId('shell').textContent).toBe('')

    // The module's bundle loads: its register() adds its dialogs, nothing else renders again.
    await act(async () => {
      SlotRegistry.register('app-dialogs', 'drive', () => createElement('p', null, 'open dialog'))
      SlotRegistry.register('app-dialogs', 'drive', () => createElement('p', null, 'save dialog'))
    })
    expect(screen.getByText('open dialog')).toBeTruthy()
    expect(screen.getByText('save dialog')).toBeTruthy()

    // Switched off: gone again.
    await act(async () => { SlotRegistry.unregisterModule('drive') })
    expect(screen.queryByText('open dialog')).toBeNull()
  })

  it('renders a hosted component again when its view root renders again (as a TSX child did)', async () => {
    // A hosted component reading module state nothing notifies the view of.
    let label = 'first'
    function Reader(): ReactNode { return createElement('span', null, label) }
    const Base = createViewBase(plan('test/HostRerender.kbview'))
    class Screen extends (Base as unknown as new () => Memo) {
      get Slot() { return Reader }
      get slot_props() { return this.memo('slot_props', [], () => ({})) }
    }
    const { rerender } = render(createElement(KbView, { view: Screen as never }))
    expect(screen.getByText('first')).toBeTruthy()
    label = 'second'
    // The parent renders the screen again (App renders again on `loadedVersion`).
    rerender(createElement(KbView, { view: Screen as never }))
    expect(screen.getByText('second')).toBeTruthy()
  })
})
