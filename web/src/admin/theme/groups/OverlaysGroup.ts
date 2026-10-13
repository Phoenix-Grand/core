/**
 * Code-behind of `OverlaysGroup.kbcontrol` (converted from `OverlaysGroup.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"

import { ViewBase } from './OverlaysGroup.kbcontrol'
import * as __parts from './OverlaysGroup.parts'

export class OverlaysGroup extends ViewBase {
  tr!: OverlaysGroupStores['t']

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

  /** A part of the screen still written in React (<PreviewStage> is no .kbview element (../PreviewStage#default)). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (<PreviewStage> is no .kbview element (../PreviewStage#default)). */
  get Part2() {
    return __parts.Part2
  }

  /** A part of the screen still written in React (<PreviewStage> is no .kbview element (../PreviewStage#default)). */
  get Part3() {
    return __parts.Part3
  }

  /** A part of the screen still written in React (<PreviewStage> is no .kbview element (../PreviewStage#default)). */
  get Part4() {
    return __parts.Part4
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type OverlaysGroupStores = ReturnType<OverlaysGroup['useStores']>

export default OverlaysGroup.component()
