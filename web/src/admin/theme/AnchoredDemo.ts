/**
 * Code-behind of `AnchoredDemo.kbcontrol` (converted from `AnchoredDemo.tsx` by @kubuno/views-migrate).
 */
import { useRef } from "react"

import { ViewBase } from './AnchoredDemo.kbcontrol'
import * as __parts from './AnchoredDemo.parts'

export class AnchoredDemo extends ViewBase {
  ref!: AnchoredDemoStores['ref']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const ref = useRef<HTMLButtonElement>(null)
    return { ref }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ ref: s.ref })
  }

  get part1_props() {
    return this.memo('part1_props', [this.ref], () => ({ ref: this.ref }))
  }

  /** A part of the screen still written in React (<button ref>: attribute(s) without a .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (<Popover> anchorRef: a value the property converts (element-ref)). */
  get Part2() {
    return __parts.Part2
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AnchoredDemoStores = ReturnType<AnchoredDemo['useStores']>

export default AnchoredDemo.component()
