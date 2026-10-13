/**
 * Code-behind of `EmptyStatesDemo.kbcontrol` (converted from `EmptyStatesDemo.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"

import { ViewBase } from './EmptyStatesDemo.kbcontrol'
import * as __parts from './EmptyStatesDemo.parts'

export class EmptyStatesDemo extends ViewBase {
  tr!: EmptyStatesDemoStores['t']

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

  get box(): "rounded-xl border border-border bg-surface-0" {
    return 'rounded-xl border border-border bg-surface-0'
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<EmptyState> action.icon: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (<EmptyState> docHref: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
}

  empty_state_action2(_sender: unknown, _args: EventArgs) {
}

}

/** What `useStores()` gives (the types of the fields it fills). */
export type EmptyStatesDemoStores = ReturnType<EmptyStatesDemo['useStores']>

export default EmptyStatesDemo.component()
