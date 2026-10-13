/**
 * Code-behind of `Figure.kbcontrol` (converted from `Figure.tsx` by @kubuno/views-migrate).
 */
import { Fragment } from 'react'
import { type ReactNode } from "react"

import { ViewBase } from './Figure.kbcontrol'

export type FigureProps = { label: string; children: ReactNode }

export class Figure extends ViewBase {
  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_children() {
    return this.memo('content_children', [this.props], () => ({ children: this.props.children }))
  }

}

export default Figure.component()
