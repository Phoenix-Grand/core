/**
 * Code-behind of `ReportHeader.kbcontrol` (converted from `ReportHeader.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { InstanceLogo } from "../../core/shell/controls/InstanceLogo"
import type { ReportModel } from "./model"

import { ViewBase } from './ReportHeader.kbcontrol'
import * as __parts from './ReportHeader.parts'

export type ReportHeaderProps = {
  /** What the instance calls itself, or its host name as a last resort. */
  instance:    string
  title:       string
  about:       string
  /** The window's own name — "30 derniers jours", "mois dernier". */
  periodLabel: string
  generatedAt: string
  generatedBy: string
  model:       ReportModel
}

export class ReportHeader extends ViewBase {
  tr!: ReportHeaderStores['t']

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

  /** `<InstanceLogo>`, rendered by a ReactHost. */
  get InstanceLogo() {
    return InstanceLogo
  }

  get instance_logo_props() {
    return this.memo('instance_logo_props', [], () => ({ size: 20, className: "text-primary" }))
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.props], () => ({ t: this.tr, periodLabel: this.props.periodLabel, model: this.props.model, generatedAt: this.props.generatedAt, generatedBy: this.props.generatedBy }))
  }

  /** A part of the screen still written in React (<dl> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ReportHeaderStores = ReturnType<ReportHeader['useStores']>

export default ReportHeader.component()
