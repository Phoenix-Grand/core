/**
 * Code-behind of `RuleSentence.kbcontrol` (converted from `RuleSentence.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { describeRule, splitEmphasis, type SummaryContext } from "./summary"
import type { UiNode } from "./condition"
import type { RuleInput } from "./types"

import { ViewBase } from './RuleSentence.kbcontrol'
import * as __parts from './RuleSentence.parts'

export type RuleSentenceProps = { input: RuleInput; tree: UiNode; ctx: SummaryContext }

export class RuleSentence extends ViewBase {
  tr!: RuleSentenceStores['t']

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

  get parts(): { text: string; strong: boolean; }[] {
    return this.memo('parts', [this.props, this.tr], () => splitEmphasis(describeRule(this.props.input, this.props.tree, this.props.ctx, this.tr)))
  }

  get part1_props() {
    return this.memo('part1_props', [this.parts], () => ({ parts: this.parts }))
  }

  /** A part of the screen still written in React (a list whose item is not a single element). */
  get Part1() {
    return __parts.Part1
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type RuleSentenceStores = ReturnType<RuleSentence['useStores']>

export default RuleSentence.component()
