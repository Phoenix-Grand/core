/**
 * Code-behind of `InstanceCard.kbcontrol` (converted from `InstanceCard.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import type { AccountCounts, InstanceInfo } from "./api"

import { ViewBase } from './InstanceCard.kbcontrol'
import * as __parts from './InstanceCard.parts'

export type InstanceCardProps = {
  instance: InstanceInfo
  accounts: AccountCounts | null
}

export class InstanceCard extends ViewBase {
  @bind accessor copied = false
  tr!: InstanceCardStores['t']
  i18n!: InstanceCardStores['i18n']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    return { t, i18n }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n })
  }

  get canCopy(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.clipboard
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.props], () => ({ t: this.tr, instance: this.props.instance }))
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (./Field#default)). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (./Field#default)). */
  get Part2() {
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.props, this.i18n], () => ({ t: this.tr, instance: this.props.instance, i18n: this.i18n }))
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (./Field#default)). */
  get Part3() {
    return __parts.Part3
  }

  get show_accounts() {
    return this.memo('show_accounts', [this.props], () => !!(this.props.accounts))
  }

  get part4_props() {
    return this.memo('part4_props', [this.tr, this.props], () => {
      if (!(this.props.accounts)) return undefined as never
      return ({ t: this.tr, accounts: this.props.accounts })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (./Field#default)). */
  get Part4() {
    if (!(this.props.accounts)) return undefined as never
    return __parts.Part4
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr, this.props, this.canCopy, this.copied, this.memo], () => ({ t: this.tr, instance: this.props.instance, canCopy: this.canCopy, copied: this.copied, copy: this.memo("copy:bound", [], () => this.copy.bind(this)) }))
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (./Field#default)). */
  get Part5() {
    return __parts.Part5
  }

  copy() {
    void navigator.clipboard.writeText(this.props.instance.instance_id).then(() => {
      this.copied = true
      window.setTimeout(() => this.copied = false, 2000)
    })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type InstanceCardStores = ReturnType<InstanceCard['useStores']>

export default InstanceCard.component()
