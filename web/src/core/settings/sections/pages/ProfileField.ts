/**
 * Code-behind of `ProfileField.kbcontrol` (converted from `Field.tsx` by @kubuno/views-migrate).
 */
import { Fragment } from 'react'
import { type ValueChangedEventArgs } from '@kubuno/views'
import { type Vis } from "../profileFields"

import { ViewBase } from './ProfileField.kbcontrol'

export type FieldProps = {
  label: string; vis?: Vis; onVis?: (v: Vis) => void; hint?: React.ReactNode; action?: React.ReactNode; className?: string; children: React.ReactNode
}

export class ProfileField extends ViewBase {
  get show_vis_on_vis() {
    return this.memo('show_vis_on_vis', [this.props], () => !!(this.props.vis && this.props.onVis))
  }

  /** `<VisToggle Value>`: the current visibility. */
  get visValue() {
    if (!(this.props.vis && this.props.onVis)) return undefined as never
    return this.props.vis
  }

  /** `<VisToggle OnChange>`: the visibility changed. */
  vis_change(_sender: unknown, args: ValueChangedEventArgs) {
    this.props.onVis?.(args.value as Vis)
  }

  get show_action() {
    return this.memo('show_action', [this.props], () => !!(this.props.action))
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_action() {
    return this.memo('content_action', [this.props], () => {
      if (!(this.props.action)) return undefined as never
      return ({ children: this.props.action })
    })
  }

  get content_children() {
    return this.memo('content_children', [this.props], () => ({ children: this.props.children }))
  }

  get show_hint() {
    return this.memo('show_hint', [this.props], () => !!(this.props.hint))
  }

  get content_hint() {
    return this.memo('content_hint', [this.props], () => {
      if (!(this.props.hint)) return undefined as never
      return ({ children: this.props.hint })
    })
  }

}

export default ProfileField.component()
