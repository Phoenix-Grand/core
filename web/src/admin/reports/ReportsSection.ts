/**
 * Code-behind of `ReportsSection.kbview` (converted from `ReportsSection.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { findPanel } from "../panels/catalog"
import type { AdminSectionProps } from "../sections/registry"

import { ViewBase } from './ReportsSection.kbview'
import * as __parts from './ReportsSection.parts'

export type { AdminSectionProps }

export class ReportsSection extends ViewBase {
  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    this.useStores()
  }

  get panelId(): string {
    return this.props.params.get('panel') ?? ''
  }

  get asked(): string | null {
    return this.props.params.get('source')
  }

  get found() {
    return this.memo('found', [this.panelId, this.asked], () => this.panelId ? findPanel(this.panelId, this.asked) : null)
  }

  get show_case_1() {
    return !!(!this.panelId)
  }

  /** `<ReportIndex>`, rendered by a ReactHost. */
  get ReportIndex() {
    if (!(!this.panelId)) return undefined as never
    return __parts.ReportIndex
  }

  get report_index_props() {
    return this.memo('report_index_props', [this.props, this.panelId], () => {
      if (!(!this.panelId)) return undefined as never
      return ({ navigate: this.props.navigate })
    })
  }

  get show_case_2() {
    return !(!this.panelId) && !!(!this.found)
  }

  get show_main() {
    return !(!this.panelId) && !(!this.found)
  }

  /** `<OneReport>`, rendered by a ReactHost. */
  get OneReport() {
    if (!(!(!this.panelId)) || !(!(!this.found))) return undefined as never
    return __parts.OneReport
  }

  get one_report_props() {
    return this.memo('one_report_props', [this.found, this.props, this.panelId], () => {
      if (!(!(!this.panelId)) || !(!(!this.found))) return undefined as never
      return ({ source: this.found.source, panelId: this.found.def.id, def: this.found.def, params: this.props.params, navigate: this.props.navigate })
    })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ReportsSectionStores = ReturnType<ReportsSection['useStores']>

export default ReportsSection.component()
