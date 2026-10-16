/**
 * WV-7: extracting a user control's `x:Props` type from its code-behind - non-function fields become
 * bindable properties, function fields become events - and threading the schema through `userControlsOf`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { userControlsOf } from '../src/project.js'
import { extractUserControlProps, propsTypeOf } from '../src/uc-props.js'

const work = mkdtempSync(join(tmpdir(), 'kbview-ucprops-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function control(name: string, kbcontrol: string, codeBehind: string): { kb: string; cb: string } {
  const kb = join(work, `${name}.kbcontrol`)
  const cb = join(work, `${name}.ts`)
  writeFileSync(kb, kbcontrol)
  writeFileSync(cb, codeBehind)
  return { kb, cb }
}

describe('user control x:Props extraction', () => {
  it('classifies object fields as bindable properties and function fields as events', () => {
    const { kb, cb } = control(
      'SearchResultRow',
      '<UserControl x:Props="SearchResultRowProps"><Panel/></UserControl>',
      `export type FileItem = { id: string }
       export type SearchResultRowProps = {
         file: { id: string; name: string }
         label: string
         count: number
         active: boolean
         onOpen: (file: FileItem) => void
         onClear: () => void
       }
       export default null as unknown`,
    )
    const props = extractUserControlProps(kb, cb)
    expect(props).toBeDefined()
    const by = Object.fromEntries((props ?? []).map((p) => [p.name, p]))
    expect(by.file).toEqual({ name: 'file', event: false, kind: 'object' })
    expect(by.label).toEqual({ name: 'label', event: false, kind: 'string' })
    expect(by.count).toEqual({ name: 'count', event: false, kind: 'number' })
    expect(by.active).toEqual({ name: 'active', event: false, kind: 'boolean' })
    expect(by.onOpen).toEqual({ name: 'onOpen', event: true, args: 'value' })
    expect(by.onClear).toEqual({ name: 'onClear', event: true, args: 'none' })
  })

  it('reads the x:Props type name and returns undefined for a control without one', () => {
    const { kb, cb } = control('Plain', '<UserControl><Panel/></UserControl>', 'export default null')
    expect(propsTypeOf(kb)).toBeNull()
    expect(extractUserControlProps(kb, cb)).toBeUndefined()
  })

  it('threads the schema through userControlsOf, but leaves pass-through controls without props', () => {
    const typed = control('Typed', '<UserControl x:Props="TypedProps"><Panel/></UserControl>', 'export type TypedProps = { title: string }\nexport default null')
    control('Pass', '<UserControl><Panel/></UserControl>', 'export default null')
    const refs = userControlsOf(work, [typed.kb, join(work, 'Pass.kbcontrol')])
    const typedRef = refs.find((r) => r.name === 'Typed')
    const passRef = refs.find((r) => r.name === 'Pass')
    expect(typedRef?.props).toEqual([{ name: 'title', event: false, kind: 'string' }])
    expect(passRef?.props).toBeUndefined()
  })
})
