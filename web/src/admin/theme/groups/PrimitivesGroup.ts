/**
 * Code-behind of `PrimitivesGroup.kbcontrol` (converted from `PrimitivesGroup.tsx` by @kubuno/views-migrate).
 */
import { bind, type ValueChangedEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"

import { ViewBase } from './PrimitivesGroup.kbcontrol'
import * as __parts from './PrimitivesGroup.parts'

export class PrimitivesGroup extends ViewBase {
  @bind accessor chk = true
  @bind accessor tgl = true
  @bind accessor slide = 60
  @bind accessor dt: string | null = null
  tr!: PrimitivesGroupStores['t']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
  }

  /** A part of the screen still written in React (<TextField LeftIcon>: an icon size the element cannot take). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.dt, this.memo, this.tr], () => ({ dt: this.dt, setDt: this.memo("setDt:bound", [], () => this.setDt.bind(this)), t: this.tr }))
  }

  /** A part of the screen still written in React (<DatePicker mode="datetime">: no .kbview value). */
  get Part2() {
    return __parts.Part2
  }

  radio_button_checked_changed(_sender: unknown, _args: ValueChangedEventArgs) {
}

  /** `setDt` of the TSX: a value, or an update of the previous one. */
  setDt(value: string | null | ((prev: string | null) => string | null)) {
    this.dt = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.dt) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type PrimitivesGroupStores = ReturnType<PrimitivesGroup['useStores']>

export default PrimitivesGroup.component()
