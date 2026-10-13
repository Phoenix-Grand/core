/**
 * Code-behind of `ResizeHandleDemo.kbcontrol` (converted from `ResizeHandleDemo.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { ResizeHandle } from "@ui"

import { ViewBase } from './ResizeHandleDemo.kbcontrol'
import * as __parts from './ResizeHandleDemo.parts'

export class ResizeHandleDemo extends ViewBase {
  @bind accessor w = 120

  get part1_props() {
    return this.memo('part1_props', [this.w], () => ({ w: this.w }))
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part1() {
    return __parts.Part1
  }

  /** `<ResizeHandle>`, rendered by a ReactHost. */
  get ResizeHandle() {
    return ResizeHandle
  }

  get resize_handle_props() {
    return this.memo('resize_handle_props', [this.w, this.memo], () => ({ position: this.w, onResize: this.memo("setW:bound", [], () => this.setW.bind(this)), min: 80, max: 220 }))
  }

  /** `setW` of the TSX: a value, or an update of the previous one. */
  setW(value: ResizeHandleDemo['w'] | ((prev: ResizeHandleDemo['w']) => ResizeHandleDemo['w'])) {
    this.w = typeof value === 'function' ? (value as (prev: ResizeHandleDemo['w']) => ResizeHandleDemo['w'])(this.w) : value
  }

}

export default ResizeHandleDemo.component()
