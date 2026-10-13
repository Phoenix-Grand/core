/**
 * Code-behind of `ComboboxDemo.kbcontrol` (converted from `ComboboxDemo.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { DEMO_UNITS } from "./fixtures"

import { ViewBase } from './ComboboxDemo.kbcontrol'
import * as __parts from './ComboboxDemo.parts'

export class ComboboxDemo extends ViewBase {
  @bind accessor unit: string | null = 'idf'
  @bind accessor free: string | null = null
  tr!: ComboboxDemoStores['t']

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

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.unit, this.memo], () => ({ t: this.tr, unit: this.unit, setUnit: this.memo("setUnit:bound", [], () => this.setUnit.bind(this)) }))
  }

  /** A part of the screen still written in React (<ComboBox> clearable, onClear: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get items_source() {
    return this.memo('items_source', [], () => DEMO_UNITS.map(u => ({ ...u, group: undefined })))
  }

  /** `setUnit` of the TSX: a value, or an update of the previous one. */
  setUnit(value: string | null | ((prev: string | null) => string | null)) {
    this.unit = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.unit) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ComboboxDemoStores = ReturnType<ComboboxDemo['useStores']>

export default ComboboxDemo.component()
