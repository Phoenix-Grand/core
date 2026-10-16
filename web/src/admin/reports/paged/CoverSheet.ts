/**
 * Code-behind of `CoverSheet.kbcontrol` (converted from `CoverSheet.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { InstanceLogo } from "../../../core/shell/controls/InstanceLogo"
import type { ReportModel } from "../model"

import { ViewBase } from './CoverSheet.kbcontrol'
import * as __parts from './CoverSheet.parts'

export type CoverSheetProps = {
  instance:    string
  title:       string
  about:       string
  periodLabel: string
  generatedAt: string
  generatedBy: string
  model:       ReportModel
}

export class CoverSheet extends ViewBase {
  tr!: CoverSheetStores['t']

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
    return this.memo('instance_logo_props', [], () => ({ size: 26, className: "text-primary" }))
  }

  get p_text() {
    return this.memo('p_text', [this.props, this.tr], () => String(this.props.periodLabel) + " - " + this.tr('admin.rep_window_value', { from: this.props.model.from, to: this.props.model.to }))
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.props], () => ({ t: this.tr, model: this.props.model, generatedAt: this.props.generatedAt, generatedBy: this.props.generatedBy }))
  }

  /** A part of the screen still written in React (<dl> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type CoverSheetStores = ReturnType<CoverSheet['useStores']>

export default CoverSheet.component()
