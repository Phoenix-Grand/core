/**
 * Code-behind of `DataGroup.kbcontrol` (converted from `DataGroup.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"

import { ViewBase } from './DataGroup.kbcontrol'
import * as __parts from './DataGroup.parts'

export class DataGroup extends ViewBase {
  tr!: DataGroupStores['t']

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
    return this.memo('part1_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<Block> is no .kbview element (a local or dynamic component)). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (<Block> is no .kbview element (a local or dynamic component)). */
  get Part2() {
    return __parts.Part2
  }

  /** A part of the screen still written in React (<Block> is no .kbview element (a local or dynamic component)). */
  get Part3() {
    return __parts.Part3
  }

  /** A part of the screen still written in React (<Block> is no .kbview element (a local or dynamic component)). */
  get Part4() {
    return __parts.Part4
  }

  /** A part of the screen still written in React (<Block> is no .kbview element (a local or dynamic component)). */
  get Part5() {
    return __parts.Part5
  }

  /** A part of the screen still written in React (<Block> is no .kbview element (a local or dynamic component)). */
  get Part6() {
    return __parts.Part6
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DataGroupStores = ReturnType<DataGroup['useStores']>

export default DataGroup.component()
