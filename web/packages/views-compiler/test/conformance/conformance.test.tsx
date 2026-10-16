import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, createElement, type ComponentType } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import * as UI from '@ui'
import { KbView, Panel, Repeater, ScrollArea, Stack, UserControl, registerElements, setResourceResolver, type ViewPlan } from '@kubuno/views'

import { loadNodeCompiler, projectRegistryJson } from '../../src/project.js'
import FormComponent, { Form } from './Form'

const here = process.env.KBVIEW_CONFORMANCE_DIR!
const CELL = Symbol.for('kubuno.views.cell')
type Cell = { plan: ViewPlan }

let interpreted: ViewPlan

beforeAll(async () => {
  // The interpreted path: the same view compiled by the WASM compiler to plain JSON (no functions, no
  // imports): components resolved by name, bindings walked by path - what the designer renders.
  const compiler = await loadNodeCompiler()
  compiler.addRegistry(readFileSync(join(here, '..', '..', '..', 'ui', 'kbview-registry.web.json'), 'utf8'), 'ui', true)
  compiler.addRegistry(projectRegistryJson(here, join(here, 'controls.json')), 'controls.json', false)
  const out = compiler.compile(readFileSync(join(here, 'Form.kbview'), 'utf8'), { file: 'Form.kbview', code_behind: './Form' })
  expect(out.ok, JSON.stringify(out.diagnostics)).toBe(true)
  interpreted = JSON.parse(JSON.stringify(out.plan)) as ViewPlan
  registerElements('@ui', UI as unknown as Record<string, unknown>)
  // The runtime's own elements (Stack, Repeater…), as the host registers them (viewsHost).
  registerElements('@kubuno/views', { Panel, Repeater, ScrollArea, Stack, UserControl })
  setResourceResolver((key) => `[${key}]`)
})

afterEach(() => cleanup())

/** The DOM, with React's `useId` values (a per-process counter, different for every root) normalised. */
const html = (): string => document.body.innerHTML.replace(/_r_[0-9a-z]+_/g, '_r_id_')

/** Runs the scenario and returns the DOM after each step. */
async function scenario(): Promise<string[]> {
  const steps: string[] = []
  render(createElement(StrictMode, null, createElement(FormComponent as ComponentType)))
  steps.push(html())
  // 1. A click runs the handler: count, the getter bound to the button, a growing repeater.
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /Compter/ })))
  expect(screen.getByText('1 clics')).toBeTruthy()
  expect(screen.getByText('Item 1')).toBeTruthy()
  steps.push(html())
  // 2. Typing in a two-way bound field: the source, the getter bound elsewhere, a Visible binding.
  const input = screen.getByPlaceholderText('Nom') as HTMLInputElement
  await act(async () => fireEvent.change(input, { target: { value: 'Bob' } }))
  expect((screen.getByLabelText('Majuscules') as HTMLInputElement).value).toBe('BOB')
  expect(screen.getByText('Attention')).toBeTruthy()
  steps.push(html())
  // 3. An event field of an object prop (Callout action.onClick) changes the source; the callout hides.
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Corriger' })))
  expect((screen.getByPlaceholderText('Nom') as HTMLInputElement).value).toBe('Ada Lovelace')
  expect(screen.queryByText('Attention')).toBeNull()
  steps.push(html())
  // 4. A two-way check box, mirrored by a switch bound one-way to the same source.
  const box = screen.getAllByRole('checkbox')[0]
  await act(async () => fireEvent.click(box))
  steps.push(html())
  // 5. The selected tab (index ↔ key adapter, content rendered after the strip).
  expect(screen.getByText('premier onglet')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Deux' })))
  expect(screen.getByText('second onglet')).toBeTruthy()
  expect(screen.queryByText('premier onglet')).toBeNull()
  steps.push(html())
  // 6. A slot button whose handler writes an element handle (`this.reset.text`).
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Réinitialiser' })))
  expect(screen.getByRole('button', { name: 'Fait' })).toBeTruthy()
  expect(screen.getByText('0 clics')).toBeTruthy()
  steps.push(html())
  cleanup()
  return steps
}

describe('conformance: compiled and interpreted plans render the same DOM (StrictMode)', () => {
  it('Form.kbview, step by step', async () => {
    const cell = (Form as unknown as Record<symbol, Cell>)[CELL]
    const compiled = cell.plan
    // The compiled plan really is the compiled one (accessors, imported components).
    expect(compiled.root.c).toBe(Stack)
    const compiledSteps = await scenario()
    cell.plan = interpreted
    let interpretedSteps: string[]
    try {
      interpretedSteps = await scenario()
    } finally {
      cell.plan = compiled
    }
    expect(compiledSteps.length).toBe(7)
    for (let k = 0; k < compiledSteps.length; k++) expect(interpretedSteps[k], `step ${k}`).toBe(compiledSteps[k])
    // Something real was rendered (not two empty documents).
    expect(compiledSteps[0]).toContain('Compter (0)')
    expect(compiledSteps[0]).toContain('[card_title]')
  })

  it('KbView renders a view class with props', () => {
    render(createElement(KbView, { view: Form as never }))
    expect(screen.getByRole('button', { name: /Compter/ })).toBeTruthy()
  })
})
