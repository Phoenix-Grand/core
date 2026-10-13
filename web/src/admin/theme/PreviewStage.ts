/**
 * Code-behind of `PreviewStage.kbcontrol` (converted from `PreviewStage.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { type ReactNode } from "react"

import { ViewBase } from './PreviewStage.kbcontrol'
import * as __parts from './PreviewStage.parts'

export type PreviewStageProps = { title: string; width?: number; height?: number; children: ReactNode }

export class PreviewStage extends ViewBase {
  @bind accessor node: HTMLDivElement | null = null

  get width() {
    return this.props.width ?? 340
  }

  get height() {
    return this.props.height ?? 260
  }

  get part1_props() {
    return this.memo('part1_props', [this.memo, this.node, this.width, this.height, this.props], () => ({ setNode: this.memo("setNode:bound", [], () => this.setNode.bind(this)), width: this.width, height: this.height, node: this.node, children: this.props.children }))
  }

  /** A part of the screen still written in React (<div ref>: attribute(s) without a .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  /** `setNode` of the TSX: a value, or an update of the previous one. */
  setNode(value: HTMLDivElement | null | ((prev: HTMLDivElement | null) => HTMLDivElement | null)) {
    this.node = typeof value === 'function' ? (value as (prev: HTMLDivElement | null) => HTMLDivElement | null)(this.node) : value
  }

}

export default PreviewStage.component()
