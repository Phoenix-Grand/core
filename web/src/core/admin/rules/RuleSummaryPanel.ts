/**
 * Code-behind of `RuleSummaryPanel.kbcontrol` (converted from `RuleSummaryPanel.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { type SummaryContext } from "./summary"
import { modeLabel, modeVariant, MODE_FACTS } from "./labels"
import type { UiNode } from "./condition"
import type { RuleInput } from "./types"
import type { ScopePreview } from "./useDirectory"

import { ViewBase } from './RuleSummaryPanel.kbcontrol'
import * as __parts from './RuleSummaryPanel.parts'

interface Props {
  input:   RuleInput
  tree:    UiNode
  ctx:     SummaryContext
  preview?: ScopePreview
  /** Rendered as a plain block instead of a sticky column (mobile, dialogs). */
  flat?:   boolean
}

export type { Props }

export class RuleSummaryPanel extends ViewBase {
  tr!: RuleSummaryPanelStores['t']

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

  get facts() {
    return this.memo('facts', [this.props], () => MODE_FACTS[this.props.input.mode])
  }

  get aside_class() {
    return this.props.flat ? 'min-w-0' : 'min-w-0 lg:sticky lg:top-4'
  }

  get variant() {
    return modeVariant(this.props.input.mode)
  }

  get badge_text() {
    return modeLabel(this.tr, this.props.input.mode)
  }

  get show_input_mode_simulate() {
    return this.props.input.mode === 'simulate'
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.props], () => {
      if (!(this.props.input.mode === 'simulate')) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Callout> icon: a value the property converts (null-when-false)). */
  get Part1() {
    if (!(this.props.input.mode === 'simulate')) return undefined as never
    return __parts.Part1
  }

  get show_input_mode_enforce() {
    return this.props.input.mode === 'enforce'
  }

  get li_text() {
    return this.tr(this.facts.evaluates ? 'admin.rl_fact_evaluates_yes' : 'admin.rl_fact_evaluates_no')
  }

  get li_text2() {
    return this.tr(this.facts.acts ? 'admin.rl_fact_acts_yes' : 'admin.rl_fact_acts_no')
  }

  get li_text3() {
    return this.tr(`admin.rl_fact_alerts_${this.facts.alerts}`)
  }

  get show_preview() {
    return this.memo('show_preview', [this.props], () => !!(this.props.preview))
  }

  get span_text() {
    if (!(this.props.preview)) return undefined as never
    return !this.props.preview.available
                ? this.tr('admin.rl_scope_preview_denied')
                : this.props.preview.isLoading
                  ? this.tr('common.loading')
                  : this.props.preview.everyone
                    ? this.tr('admin.rl_scope_preview_all', { n: this.props.preview.total })
                    : this.props.preview.partial
                      ? this.tr('admin.rl_scope_preview_partial', { count: this.props.preview.count, loaded: 200, total: this.props.preview.total })
                      : this.tr('admin.rl_scope_preview', { count: this.props.preview.count })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type RuleSummaryPanelStores = ReturnType<RuleSummaryPanel['useStores']>

export default RuleSummaryPanel.component()
