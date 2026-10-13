/**
 * Code-behind of `MockTopbar.kbcontrol` (converted from `MockTopbar.tsx` by @kubuno/views-migrate).
 */
import { KubunoLogo } from "@ui"

import { ViewBase } from './MockTopbar.kbcontrol'

export class MockTopbar extends ViewBase {
  /** `<KubunoLogo>`, rendered by a ReactHost. */
  get KubunoLogo() {
    return KubunoLogo
  }

  get kubuno_logo_props() {
    return this.memo('kubuno_logo_props', [], () => ({ className: "h-6 w-auto shrink-0" }))
  }

}

export default MockTopbar.component()
