/**
 * Code-behind of `Nothing.kbcontrol` (converted from `Nothing.tsx` by @kubuno/views-migrate).
 */
import { Fragment } from 'react'
import type { ReactNode } from "react"

import { ViewBase } from './Nothing.kbcontrol'

export type NothingProps = { children: ReactNode }

export class Nothing extends ViewBase {
  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_children() {
    return this.memo('content_children', [this.props], () => ({ children: this.props.children }))
  }

}

export default Nothing.component()
