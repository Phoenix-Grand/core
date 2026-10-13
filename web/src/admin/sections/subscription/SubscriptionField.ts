/**
 * Code-behind of `SubscriptionField.kbcontrol` (converted from `Field.tsx` by @kubuno/views-migrate).
 */
import { Fragment } from 'react'
import type { ReactNode } from "react"

import { ViewBase } from './SubscriptionField.kbcontrol'

export type FieldProps = {
  label:    string
  children: ReactNode
  /** Renders the value in the monospace face — for identifiers read aloud. */
  mono?:    boolean
}

export class SubscriptionField extends ViewBase {
  get div_class() {
    return `mt-0.5 min-w-0 break-words text-text-primary${this.props.mono ? ' font-mono' : ''}`
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_children() {
    return this.memo('content_children', [this.props], () => ({ children: this.props.children }))
  }

}

export default SubscriptionField.component()
