/**
 * Code-behind of `InlineEditField.kbcontrol` (converted from `Field.tsx` by @kubuno/views-migrate).
 */
import type { ReactNode } from "react"

import { ViewBase } from './InlineEditField.kbcontrol'
import * as __parts from './InlineEditField.parts.tsx'

export function orDash(value: ReactNode | null | undefined): ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span className="text-text-tertiary">—</span>
  }
  return value
}

export type FieldProps = { label: ReactNode; children: ReactNode }

export class InlineEditField extends ViewBase {
  get part1_props() {
    return this.memo('part1_props', [this.props], () => ({ label: this.props.label }))
  }

  /** A part of the screen still written in React (<dt> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.props], () => ({ children: this.props.children }))
  }

  /** A part of the screen still written in React (<dd> has no .kbview element yet). */
  get Part2() {
    return __parts.Part2
  }

}

export default InlineEditField.component()
