/**
 * Code-behind of `ColorsGroup.kbcontrol` (converted from `ColorsGroup.tsx` by @kubuno/views-migrate).
 */

import { ViewBase } from './ColorsGroup.kbcontrol'
import * as __parts from './ColorsGroup.parts'

export class ColorsGroup extends ViewBase {
  /** `<Swatch>`, rendered by a ReactHost. */
  get Swatch() {
    return __parts.Swatch
  }

  get swatch_props() {
    return this.memo('swatch_props', [], () => ({ varName: "--color-primary", label: "primary" }))
  }

  get swatch_props2() {
    return this.memo('swatch_props2', [], () => ({ varName: "--color-surface-0", label: "surface" }))
  }

  get swatch_props3() {
    return this.memo('swatch_props3', [], () => ({ varName: "--color-surface-2", label: "surface-2" }))
  }

  get swatch_props4() {
    return this.memo('swatch_props4', [], () => ({ varName: "--color-text-primary", label: "texte" }))
  }

  get swatch_props5() {
    return this.memo('swatch_props5', [], () => ({ varName: "--color-border", label: "bordure" }))
  }

  get swatch_props6() {
    return this.memo('swatch_props6', [], () => ({ varName: "--color-danger", label: "danger" }))
  }

  get swatch_props7() {
    return this.memo('swatch_props7', [], () => ({ varName: "--color-success", label: "succès" }))
  }

  get swatch_props8() {
    return this.memo('swatch_props8', [], () => ({ varName: "--color-warning", label: "alerte" }))
  }

}

export default ColorsGroup.component()
