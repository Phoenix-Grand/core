/**
 * Code-behind of `RibbonMock.kbcontrol` (converted from `RibbonMock.tsx` by @kubuno/views-migrate).
 */
import { Fragment } from 'react'
import type { ReactNode } from "react"
import { Copy, FileText, Pencil } from "lucide-react"

import { ViewBase } from './RibbonMock.kbcontrol'
import * as __parts from './RibbonMock.parts'

export class RibbonMock extends ViewBase {
  get groupLabel(): { color: string; } {
    return this.memo('groupLabel', [], () => ({ color: 'var(--kbn-ws-text-dim, #5f6368)' }))
  }

  get sep(): { width: number; background: string; } {
    return this.memo('sep', [], () => ({ width: 1, background: 'var(--kbn-ws-border, #dadce0)' }))
  }

  /** The rows of the Repeater over `['Insertion', 'Mise en page', 'Affichage']`. */
  get rows_items() {
    return this.memo('rows_items', [], () => ['Insertion', 'Mise en page', 'Affichage'].map((l) => {
      return { l, key: l }
    }))
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_small_btn_copy_size() {
    return this.memo('content_small_btn_copy_size', [], () => ({ children: this.smallBtn(<Copy size={13} />, 'Copier') }))
  }

  get content_small_btn_pencil_size() {
    return this.memo('content_small_btn_pencil_size', [], () => ({ children: this.smallBtn(<Pencil size={13} />, 'Coller') }))
  }

  get part1_props() {
    return this.memo('part1_props', [this.groupLabel], () => ({ groupLabel: this.groupLabel }))
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.sep], () => ({ sep: this.sep }))
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part2() {
    return __parts.Part2
  }

  get content_small_btn_span_class_name() {
    return this.memo('content_small_btn_span_class_name', [], () => ({ children: this.smallBtn(<span className="font-bold text-xs">G</span>, 'Gras', true) }))
  }

  get content_small_btn_span_class_name2() {
    return this.memo('content_small_btn_span_class_name2', [], () => ({ children: this.smallBtn(<span className="italic text-xs">I</span>, 'Italique') }))
  }

  get content_small_btn_span_class_name3() {
    return this.memo('content_small_btn_span_class_name3', [], () => ({ children: this.smallBtn(<span className="underline text-xs">S</span>, 'Souligné') }))
  }

  get content_small_btn_file_text_size() {
    return this.memo('content_small_btn_file_text_size', [], () => ({ children: this.smallBtn(<FileText size={13} />, 'Styles') }))
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part3() {
    return __parts.Part3
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part4() {
    return __parts.Part4
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part5() {
    return __parts.Part5
  }

  smallBtn(icon: ReactNode, label: string, active = false) {
    return (
    <div
      className="flex items-center h-[22px] px-1.5 gap-1 rounded text-[11px] whitespace-nowrap cursor-default"
      style={active
        ? { background: 'var(--kbn-office-item-active-bg, #1a73e822)', color: 'var(--kbn-office-item-active-text, #1a73e8)' }
        : { color: 'var(--kbn-ws-text, #202124)' }}
    >
      <span className="flex items-center justify-center w-4 h-4">{icon}</span>{label}
    </div>
  )
  }

}

export default RibbonMock.component()
